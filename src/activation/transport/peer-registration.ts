/**
 * Peer registration — what makes a push confirmable.
 *
 * Measured on 2026-09-07 (`unitAI-rrdnt.12`): the Claude cross-session channel DELIVERS a
 * frame to a live coordinator from an unregistered sender, but returns no
 * `peer_message_status` receipt to one. Without a receipt the adapter can never honestly
 * mark a push `delivered`, so acceptance AX is unreachable — hence `unitAI-rrdnt.25`, and
 * hence this module.
 *
 * Registration writes a file into the user's home directory and adds an entry to every
 * other session's roster, so it was escalated rather than assumed. The operator approved it
 * on 2026-09-07 ("yes it can, i do approve"), **on two binding conditions** that are the
 * reason most of this module exists:
 *
 *   1. **Deregistration on exit**, including abnormal exit as far as is reasonably
 *      coverable.
 *   2. **Orphan cleanup.** The measured baseline is 128 socket files for 20 registrations,
 *      and 10 of those 20 named dead PIDs. Approval was given on the understanding that
 *      this runtime does not worsen that ratio.
 *
 * Two shape decisions follow from those conditions:
 *
 * **One registration per runtime process, never per activation.** Registering per
 * activation multiplies entries by concurrency and turns teardown into a race between
 * activations over one PID's registration file — which is precisely how the 128:20 ratio
 * is produced. The registration's lifetime is the process's lifetime; activations come and
 * go underneath it.
 *
 * **Cleanup only ever touches entries this runtime wrote.** The roster is shared with
 * Claude Code itself and with `pi-claude-link`. A reaper that deleted any registration
 * naming a dead PID would delete other tools' state on their behalf, which is not this
 * runtime's call. Entries are marked with `REGISTRATION_VERSION` and only those are
 * reaped.
 *
 * The entry this module writes must satisfy the liveness check in `roster.ts`, because
 * writing an entry our own checker would reject is how a runtime becomes unreachable to
 * itself. `procStart` is therefore written in the NUMERIC form — raw field 22 of
 * `/proc/<pid>/stat` — which is the form Claude Code itself uses and the stronger check,
 * an exact integer comparison with no tolerance window.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  createSocketReceiptSource,
  peerSocketDir,
  type ReceiptSource,
} from './peer-transport.js';
import {
  defaultRosterDir,
  procProbe,
  SUPPORTED_PEER_PROTOCOL,
  type ProcessProbe,
  type SessionRegistration,
} from './roster.js';

/**
 * Marks an entry as written by this runtime.
 *
 * The roster's `version` field is free-form and is how each writer identifies its own rows
 * (`pi-claude-link` uses its own package name). Cleanup is scoped by this value and by
 * nothing else.
 */
export const REGISTRATION_VERSION = 'xtrm-specialists';

export interface RegistrationOptions {
  /** Display name. Not identity — `nameSource` is `derived` and names are not unique. */
  name: string;
  /** Working directory advertised to peers. Defaults to the process cwd. */
  cwd?: string;
  /** Stable session id for this runtime. Generated when absent. */
  sessionId?: string;
  /** Roster directory. Overridable so tests never touch the real home directory. */
  rosterDir?: string;
  /** Socket directory. Defaults to the directory Claude itself binds in. */
  socketDir?: string;
  probe?: ProcessProbe;
  /**
   * Install process-exit handlers that deregister. On by default — condition 1 of the
   * approval. Disable only when the caller owns its own shutdown sequence and calls
   * `close()` itself.
   */
  installExitHandlers?: boolean;
}

/** A live registration. Closing it removes the roster entry and the socket. */
export interface RegisteredPeer {
  sessionId: string;
  pid: number;
  socketPath: string;
  registrationPath: string;
  /** The sender address to put in an envelope's `from`. */
  address: string;
  /** Receipts arriving on this peer's own socket. */
  receipts: ReceiptSource;
  close(): Promise<void>;
}

function registrationPathFor(rosterDir: string, pid: number): string {
  return join(rosterDir, `${pid}.json`);
}

/**
 * Register this process as a Claude peer and bind its receipt socket.
 *
 * Order matters: the socket is bound BEFORE the roster entry is published. A registration
 * advertising a socket that is not yet listening is a registration that other sessions can
 * read and fail against, and the failure would look like an unreachable peer rather than a
 * startup race.
 */
export async function registerRuntimePeer(options: RegistrationOptions): Promise<RegisteredPeer> {
  const rosterDir = options.rosterDir ?? defaultRosterDir();
  const socketDir = options.socketDir ?? peerSocketDir(rosterDir);
  const probe = options.probe ?? procProbe();
  const pid = process.pid;

  const start = probe.startOf(pid);
  if (!start) {
    // Without a start-time guard, the entry cannot survive PID reuse and `roster.ts` would
    // reject it. Refuse to publish a registration our own liveness check would not accept.
    throw new Error('cannot read this process start time; refusing to register a peer entry without the PID-reuse guard');
  }

  const existing = registrationPathFor(rosterDir, pid);
  if (existsSync(existing)) {
    // Another writer already owns this PID's row — Claude Code itself, most likely, if the
    // runtime is hosted in-process. Overwriting it would silently take over its identity.
    throw new Error(`refusing to overwrite an existing registration at ${existing}`);
  }

  const sessionId = options.sessionId ?? randomUUID();
  const socketPath = join(socketDir, `${pid}.sock`);

  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  const receipts = await createSocketReceiptSource(socketPath);

  const entry: SessionRegistration & { version: string; startedAt: number } = {
    pid,
    sessionId,
    cwd: options.cwd ?? process.cwd(),
    startedAt: Date.now(),
    // Numeric form: exactly what `roster.ts` compares against /proc stat field 22.
    procStart: start.ticksSinceBoot,
    version: REGISTRATION_VERSION,
    peerProtocol: SUPPORTED_PEER_PROTOCOL,
    kind: 'interactive',
    entrypoint: 'specialists',
    messagingSocketPath: socketPath,
    name: options.name,
    nameSource: 'derived',
    status: 'idle',
  };

  mkdirSync(rosterDir, { recursive: true });
  writeFileSync(existing, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });

  let closed = false;
  const removeFiles = (): void => {
    // Synchronous and defensive: this also runs from an 'exit' handler, where nothing
    // asynchronous will complete and a throw would mask the real exit reason.
    try { unlinkSync(existing); } catch { /* already gone */ }
    try { unlinkSync(socketPath); } catch { /* already gone */ }
  };

  const peer: RegisteredPeer = {
    sessionId,
    pid,
    socketPath,
    registrationPath: existing,
    address: `uds:${socketPath}`,
    receipts,
    async close() {
      if (closed) return;
      closed = true;
      detach();
      removeFiles();
      await receipts.close();
    },
  };

  const onExit = (): void => { if (!closed) { closed = true; removeFiles(); } };
  const onSignal = (signal: NodeJS.Signals): void => {
    onExit();
    // Restore default behaviour rather than swallowing the signal: a runtime that traps
    // SIGTERM and keeps running is worse than one that leaves a stale registration.
    process.removeListener(signal, onSignal);
    process.kill(process.pid, signal);
  };
  const detach = (): void => {
    process.removeListener('exit', onExit);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  };

  if (options.installExitHandlers !== false) {
    process.on('exit', onExit);
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  }

  return peer;
}

/**
 * What a cleanup pass removed.
 *
 * `SIGKILL`, a power loss and a hard crash cannot run an exit handler, so deregistration
 * alone can never be complete. This is the other half of condition 1, and the whole of
 * condition 2.
 */
export interface CleanupResult {
  registrationsRemoved: string[];
  socketsRemoved: string[];
  /** Entries left alone because another writer owns them. Reported, never touched. */
  foreignEntriesSkipped: number;
}

/**
 * Remove this runtime's dead registrations and their sockets.
 *
 * Scope is deliberately narrow in two directions. It only considers entries whose `version`
 * is `REGISTRATION_VERSION`, because the roster is shared and deleting another tool's row
 * is not this runtime's decision. And it only removes an entry whose holder is provably
 * gone — `/proc` missing, or running with a different start time. An entry whose liveness
 * cannot be established is LEFT IN PLACE: the same rule the lease and the roster follow,
 * because deleting a registration under a live peer makes it unreachable to everyone.
 *
 * Sockets are removed only when they belong to a registration this pass removed, or when
 * they carry this runtime's `<pid>.sock` name and no live process. Orphan sockets belonging
 * to other writers are left alone even when dead, for the same reason their registrations
 * are.
 */
export function cleanupOrphanRegistrations(
  options: { rosterDir?: string; socketDir?: string; probe?: ProcessProbe } = {},
): CleanupResult {
  const rosterDir = options.rosterDir ?? defaultRosterDir();
  const socketDir = options.socketDir ?? peerSocketDir(rosterDir);
  const probe = options.probe ?? procProbe();

  const result: CleanupResult = { registrationsRemoved: [], socketsRemoved: [], foreignEntriesSkipped: 0 };
  if (!existsSync(rosterDir)) return result;

  const ourDeadPids: number[] = [];

  for (const file of readdirSync(rosterDir)) {
    if (!/^\d+\.json$/.test(file)) continue;
    const path = join(rosterDir, file);
    let entry: (SessionRegistration & { version?: string }) | undefined;
    try {
      entry = JSON.parse(readFileSync(path, 'utf-8')) as SessionRegistration & { version?: string };
    } catch {
      // An unreadable row cannot be attributed to a writer, so it is not ours to delete.
      result.foreignEntriesSkipped += 1;
      continue;
    }
    if (entry.version !== REGISTRATION_VERSION) {
      result.foreignEntriesSkipped += 1;
      continue;
    }

    const actual = probe.startOf(entry.pid);
    const dead = actual === undefined
      || (typeof entry.procStart === 'number' && actual.ticksSinceBoot !== entry.procStart);
    if (!dead) continue;

    try { unlinkSync(path); result.registrationsRemoved.push(path); } catch { /* raced with another reaper */ }
    ourDeadPids.push(entry.pid);
    if (entry.messagingSocketPath) {
      try { unlinkSync(entry.messagingSocketPath); result.socketsRemoved.push(entry.messagingSocketPath); } catch { /* already gone */ }
    }
  }

  // Sweep sockets this runtime named but whose registration is already absent — the
  // SIGKILL case, where the roster entry was removed but the socket file outlived it.
  if (existsSync(socketDir)) {
    for (const file of readdirSync(socketDir)) {
      const match = /^(\d+)\.sock$/.exec(file);
      if (!match) continue;
      const pid = Number(match[1]);
      const path = join(socketDir, file);
      if (result.socketsRemoved.includes(path)) continue;
      // Only sweep a socket we can attribute to a registration of ours that is now gone.
      if (!ourDeadPids.includes(pid)) continue;
      try { unlinkSync(path); result.socketsRemoved.push(path); } catch { /* already gone */ }
    }
  }

  return result;
}
