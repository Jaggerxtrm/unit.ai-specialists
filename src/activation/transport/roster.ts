/**
 * Claude Code session roster — a discovery surface, and NOT a liveness oracle.
 *
 * `docs/design/claude-transport-decision.md` §4 measured this on the authoring host: of 20
 * registrations under `~/.claude/sessions/<pid>.json`, 10 named PIDs with no `/proc` entry
 * while still advertising `status: "idle"` with their socket file present, and 128 socket
 * files existed for those 20 registrations. The socket directory accumulates garbage and
 * is never a membership list.
 *
 * Three rules follow, and this module exists to enforce them:
 *
 *   1. Liveness is `/proc/<pid>` plus `procStart` — never socket existence, never the
 *      registration's own `status` field. `status` is written by the session and is stale
 *      exactly when the session died, which is the case that matters.
 *   2. `procStart` is mandatory, not optional hardening. Without it, PID reuse routes a
 *      Specialist's question into an unrelated process.
 *   3. Reachability is asymmetric and can lapse mid-session. This module answers "is this
 *      registration a usable route right now?" and never "is this peer gone?" — a failed
 *      send is not evidence about the peer, and nothing here consumes send outcomes.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The wire version this adapter understands. Every observed entry carried `1`. */
export const SUPPORTED_PEER_PROTOCOL = 1;

/** A registration as written by a session. Every field is a claim, not a fact. */
export interface SessionRegistration {
  pid: number;
  sessionId: string;
  cwd?: string;
  startedAt?: number;
  /**
   * Either raw `/proc/<pid>/stat` field 22 (clock ticks since boot, written by Claude Code
   * itself) or a `ps`-style local time string such as `Mon Sep  7 11:10:29 2026` (written
   * by `pi-claude-link`). Both forms occur on the same host; see `procStartMatches`.
   */
  procStart?: string | number;
  peerProtocol?: number;
  kind?: string;
  entrypoint?: string;
  messagingSocketPath?: string;
  name?: string;
  nameSource?: 'derived' | 'user' | string;
  /** Self-reported and unreliable. Never used for liveness; only to choose a send verb. */
  status?: string;
}

/** Why a registration was rejected as a route. Each maps to a rule in §4. */
export type RouteRejection =
  | 'unparsable'
  | 'no_proc_entry'
  | 'missing_proc_start'
  | 'proc_start_mismatch'
  | 'unsupported_peer_protocol'
  | 'no_socket_path';

/**
 * A registration that passed every liveness rule.
 *
 * `routeRef` is the route identity and is built from `pid` and `sessionId` only. The
 * display name is deliberately excluded: `nameSource` is `derived` or `user`, so the name
 * is not stable identity and must never be what a message is addressed to.
 */
export interface LiveRoute {
  routeRef: string;
  pid: number;
  sessionId: string;
  socketPath: string;
  cwd?: string;
  /** Display only. Never an address. */
  name?: string;
  /** Self-reported. Used only to pick `sendUserMessage` versus `steer`. */
  reportedStatus?: string;
}

export interface RejectedRoute {
  pid?: number;
  file: string;
  reason: RouteRejection;
}

export interface RosterScan {
  live: LiveRoute[];
  rejected: RejectedRoute[];
}

export function defaultRosterDir(): string {
  return join(homedir(), '.claude', 'sessions');
}

/**
 * Host facts a liveness check needs, injectable so the rules are testable without
 * fabricating processes. The default implementation reads `/proc`.
 */
export interface ProcessStart {
  /** Raw field 22 of `/proc/<pid>/stat`: start time in clock ticks since boot. */
  ticksSinceBoot: number;
  /** The same instant in epoch seconds, derived with `btime` and the tick rate. */
  epochSeconds: number;
}

export interface ProcessProbe {
  /** Start time of a running PID, or `undefined` if the PID is not running. */
  startOf(pid: number): ProcessStart | undefined;
}

/**
 * `/proc`-backed probe.
 *
 * Field 22 of `/proc/<pid>/stat` is read by index from the tail, because field 2 is the
 * comm string and may itself contain spaces and parentheses.
 *
 * On a host without `/proc` every probe returns `undefined`, so no route is ever selected
 * and the adapter degrades to polling. That is deliberate: guessing liveness without the
 * evidence §4 requires is the failure this module exists to prevent.
 */
export function procProbe(): ProcessProbe {
  let bootSeconds: number | undefined;
  const ticksPerSecond = 100; // ponytail: CLK_TCK is 100 on every Linux target here, and
                              // it only affects the string-format comparison, which
                              // carries a +/-2s tolerance. Read getconf CLK_TCK if a host
                              // with a different tick rate ever appears.
  return {
    startOf(pid: number): ProcessStart | undefined {
      try {
        if (bootSeconds === undefined) {
          const match = /^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf-8'));
          if (!match) return undefined;
          bootSeconds = Number(match[1]);
        }
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
        const afterComm = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        // Fields 1 and 2 (pid, comm) were consumed above, so field 22 is index 19 here.
        const ticksSinceBoot = Number(afterComm[19]);
        if (!Number.isFinite(ticksSinceBoot)) return undefined;
        return { ticksSinceBoot, epochSeconds: bootSeconds + ticksSinceBoot / ticksPerSecond };
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * `procStart` has TWO formats in the wild, and an adapter that handles only one rejects
 * every peer it was built to reach. Measured on this host, 18 registrations:
 *
 *   - 13 written by Claude Code itself (`version` 2.1.257 / 2.1.263) carry a NUMBER: raw
 *     field 22 of `/proc/<pid>/stat`, verified equal for pids 1100092, 2176609, 3574376
 *     and 404065.
 *   - 5 written by `pi-claude-link` carry a `ps`-style local time STRING, e.g.
 *     `Mon Sep  7 11:10:29 2026`.
 *
 * `claude-transport-decision.md` §4 observed only the string form, because it was reading
 * the `pi-claude-link` entries. Both are accepted here. The numeric form is the stronger
 * check — an exact integer comparison with no tolerance at all — so it is tried first.
 */
export type ProcStartFormat = 'ticks' | 'lstart';

/**
 * The string form has second resolution, so it matches within a tolerance rather than
 * exactly. Two seconds absorbs the rounding and is far narrower than any realistic PID
 * reuse interval.
 */
const PROC_START_TOLERANCE_SECONDS = 2;

/** Compare a registration's `procStart` claim against measured process start. */
function procStartMatches(claim: string | number, actual: ProcessStart): boolean {
  if (typeof claim === 'number') return claim === actual.ticksSinceBoot;
  const asNumber = Number(claim);
  if (claim.trim() !== '' && Number.isFinite(asNumber)) return asNumber === actual.ticksSinceBoot;
  const claimedMs = Date.parse(claim);
  if (!Number.isFinite(claimedMs)) return false;
  return Math.abs(actual.epochSeconds - claimedMs / 1000) <= PROC_START_TOLERANCE_SECONDS;
}

/**
 * Decide whether one registration is a usable route.
 *
 * Returns the rejection reason rather than a boolean, so a caller can report *why* a
 * roster entry was skipped instead of reporting an empty roster.
 */
export function evaluateRegistration(
  registration: SessionRegistration,
  probe: ProcessProbe,
): { route: LiveRoute } | { reason: RouteRejection } {
  if (registration.peerProtocol !== SUPPORTED_PEER_PROTOCOL) {
    return { reason: 'unsupported_peer_protocol' };
  }
  if (!registration.messagingSocketPath) {
    return { reason: 'no_socket_path' };
  }
  // Note the order: the socket path is read from the registration but its existence on
  // disk is never checked. 128 socket files existed for 20 registrations; presence proves
  // nothing and absence is not proof of death either.
  if (registration.procStart === undefined || registration.procStart === null || registration.procStart === '') {
    return { reason: 'missing_proc_start' };
  }
  const actualStart = probe.startOf(registration.pid);
  if (actualStart === undefined) {
    return { reason: 'no_proc_entry' };
  }
  if (!procStartMatches(registration.procStart, actualStart)) {
    return { reason: 'proc_start_mismatch' };
  }
  return {
    route: {
      routeRef: `pid:${registration.pid}/session:${registration.sessionId}`,
      pid: registration.pid,
      sessionId: registration.sessionId,
      socketPath: registration.messagingSocketPath,
      cwd: registration.cwd,
      name: registration.name,
      reportedStatus: registration.status,
    },
  };
}

/** Read and evaluate every registration in the roster directory. */
export function scanRoster(options: { dir?: string; probe?: ProcessProbe } = {}): RosterScan {
  const dir = options.dir ?? defaultRosterDir();
  const probe = options.probe ?? procProbe();
  const live: LiveRoute[] = [];
  const rejected: RejectedRoute[] = [];

  if (!existsSync(dir)) return { live, rejected };

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    let registration: SessionRegistration;
    try {
      registration = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as SessionRegistration;
    } catch {
      rejected.push({ file, reason: 'unparsable' });
      continue;
    }
    const verdict = evaluateRegistration(registration, probe);
    if ('route' in verdict) live.push(verdict.route);
    else rejected.push({ file, pid: registration.pid, reason: verdict.reason });
  }
  return { live, rejected };
}

/**
 * Select the route for a coordinator, by session id.
 *
 * Session id is the only stable address. Resolution by display name is not offered at all,
 * because `nameSource: "derived"` means two sessions can present the same name and the
 * name can change under a session that is still the same peer.
 */
export function selectRoute(
  coordinatorSessionId: string,
  options: { dir?: string; probe?: ProcessProbe } = {},
): LiveRoute | undefined {
  return scanRoster(options).live.find(route => route.sessionId === coordinatorSessionId);
}
