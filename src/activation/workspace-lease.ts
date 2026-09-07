/**
 * Workspace writer lease — exactly one writer per mutable workspace, coordinator included.
 *
 * Nothing in this codebase implemented workspace exclusion before this module. The console
 * once displayed a lease that was a hardcoded placeholder, and `worktree_owner_job_id` is
 * chain provenance for `--job` reuse, not an exclusion primitive. Until a lease exists no
 * native Specialist can mutate a workspace, and the coordinator itself runs unfenced.
 *
 * Three properties are load-bearing, and each of them is a rule the obvious implementation
 * gets wrong:
 *
 *   1. **The worktree path is the mutation domain.** Two linked git worktrees sharing one
 *      common repo are DISTINCT mutable workspaces even though they share history and one
 *      observability database. Keying a lease by repository would serialise unrelated work;
 *      keying it by branch would miss two activations on one branch in one worktree.
 *   2. **Acquisition is atomic against another process**, so it cannot be a read-then-write
 *      on a JSON file. `link()` publishes a fully-written file or fails with `EEXIST`; the
 *      loser never observes a half-written holder record and never overwrites the winner.
 *   3. **A crashed holder yields `uncertain`, never a blind free.** Releasing a lease whose
 *      holder's liveness is unknown is exactly how two writers end up in one worktree, and
 *      two writers in one worktree is data loss, not a race to tolerate. Recovery from
 *      `uncertain` is PRD Phase 9 and deliberately not implemented here — this module's job
 *      is to produce the state honestly, not to resolve it.
 *
 * Liveness is process existence plus a start-time guard, never a self-reported status field
 * and never the presence of a file. That rule is not a preference: on this host 10 of 20
 * peer registrations advertised `status: "idle"` while naming PIDs with no `/proc` entry,
 * and 128 socket files existed for those 20 registrations (memory
 * `claude-peer-transport-liveness`). A lease that trusted either signal would free itself
 * under a live holder.
 *
 * ## Residual enforcement hole — read this before relying on the guard
 *
 * `docs/design/native-activation-reconciliation.md` §5.8, re-verified against Pi 0.85.1
 * (`unitAI-rrdnt.17`): `tool_call` is a genuine choke point for every LLM-initiated tool
 * path — built-in edit/write, bash-as-tool, `pi.registerTool`, and `customTools` are all
 * wrapped into one registry and the hook is tool-agnostic. Four paths bypass it entirely:
 *
 *   H1  `AgentSession.executeBash()` called directly by any in-process holder of the
 *       session, our own host included — no `emitToolCall` on that path.
 *   H2  the operator `user_bash` path — interactive `!bash` and RPC `bash` emit
 *       `user_bash`, not `tool_call`.
 *   H3  `pi.exec(command, args, options)` inside any extension handler.
 *   H4  direct `node:fs` / `child_process` / `fetch` inside extension code, which runs
 *       in-process.
 *
 * H1 and H2 are satisfiable by our own discipline: the host never calls `executeBash`, and
 * the MCP server routes shell work through prompt-induced tool calls rather than RPC
 * `bash`. **H3 and H4 are not satisfiable on Pi 0.85.1** — no exec or filesystem
 * interposition layer exists, so a trusted extension can mutate a leased workspace without
 * the agent loop ever seeing it. That is a trusted-extension threat, not a delegated-agent
 * threat: the lease still covers every mutation an LLM can initiate, which is the entire
 * threat model for a delegated Specialist. It is stated here rather than implied away,
 * because a lease that claims total enforcement is more dangerous than one that documents
 * its boundary.
 *
 * The guard is a per-tool-call block and NOT `setActiveToolsByName` (§5.9). Within a turn
 * the agent loop executes against a snapshot taken at turn start, and in parallel mode every
 * call is prepared before any executes, so revoking active tools cannot cancel an
 * already-planned call. All `tool_call` handlers in a batch fire before any execution, so a
 * mid-batch block IS enforceable. Building it the other way round produces a lease that
 * silently leaks for the remainder of every turn in which it is acquired.
 *
 * ## Wiring note for the coordinator
 *
 * This module is deliberately not wired into `NativeActivationHost` — that file belongs to
 * the coordinator lane this round. Four call sites are needed, in this order:
 *
 *   1. **Admission, before session creation.** For a `WorkspaceAccess` of `write`, call
 *      `acquire({ workspace, activationId, attemptId, specialist })`. It throws
 *      `DispatchRejectedError` on contention, which already renders `AgentSession: not
 *      created` — so let it propagate rather than catching and re-wrapping it. A `read`
 *      activation acquires nothing and must never be given a lease.
 *   2. **The guard, inside `beforeToolCall`.** Call `admitToolCall({ toolName, workspace,
 *      activationId })` and convert `allow: false` into `{ block: true }` carrying
 *      `reason`. This must be the per-call block; see §5.9 above for why
 *      `setActiveToolsByName` cannot serve as the fence.
 *   3. **Release on settle, stop and failure.** Call `release(workspace, activationId)`.
 *      It is a no-op when already free, so a duplicated teardown path is safe. It THROWS
 *      when the lease is uncertain — that is intentional and must surface, not be
 *      swallowed in a `finally`.
 *   4. **Resume.** Call `acquire` again with the same `activationId` and the next
 *      `attemptId`; it reacquires rather than contending with itself.
 *
 * The host must never call `AgentSession.executeBash()` (H1) and the MCP server must not
 * route shell work through RPC `bash` (H2), because those are the two bypasses that our own
 * discipline is what closes.
 */

import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DispatchRejectedError, type ActivationId, type AttemptId, type WorkspaceIdentity } from './types.js';

/**
 * What the lease store believes about a workspace.
 *
 * `uncertain` is not a degraded `free`. It is the state in which acquisition is refused
 * and a human or Phase 9 recovery decides what happened.
 */
export type LeaseState = 'free' | 'held' | 'uncertain';

/** The holder's process, recorded so liveness can be checked without trusting the holder. */
export interface HolderProcess {
  pid: number;
  /** Raw field 22 of `/proc/<pid>/stat` at acquisition — the PID-reuse guard. */
  startTicks: number;
}

/** The durable lease record. Written once, atomically, and never edited in place. */
export interface WorkspaceLease {
  /** Stable key for the mutation domain: the resolved worktree path. */
  workspaceKey: string;
  worktreePath: string;
  activationId: ActivationId;
  attemptId: AttemptId;
  /** Display only — for the rejection message. Never used to decide anything. */
  specialist?: string;
  holder: HolderProcess;
  acquiredAtMs: number;
}

/** A lease read back, with the liveness verdict applied. */
export interface LeaseStatus {
  state: LeaseState;
  lease?: WorkspaceLease;
  /** Why the state is `uncertain`. Absent otherwise. */
  uncertainReason?: 'holder_process_gone' | 'holder_start_mismatch' | 'liveness_unverifiable' | 'unreadable_record';
}

/**
 * Process facts the liveness check needs, injectable so `uncertain` is reachable in a test
 * without killing a real process (validation criterion 3).
 */
export interface LeaseProcessProbe {
  /** Start time in clock ticks since boot, or `undefined` when the PID is not running. */
  startTicks(pid: number): number | undefined;
  /** False when this host cannot establish liveness at all — then nothing is ever freed. */
  canVerify(): boolean;
}

/**
 * `/proc`-backed probe.
 *
 * Field 22 is read by tail-indexing past the closing parenthesis of the comm field, because
 * a process name may itself contain spaces and parentheses and would otherwise shift every
 * index after it.
 *
 * On a host without `/proc`, `canVerify()` is false and every held lease reads `uncertain`
 * rather than `free`. That is the intended failure direction: a host that cannot see
 * processes must not conclude that a holder is gone.
 */
export function procLeaseProbe(): LeaseProcessProbe {
  return {
    canVerify: () => existsSync('/proc/self/stat'),
    startTicks(pid: number): number | undefined {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
        const afterComm = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        // Fields 1 and 2 (pid, comm) were consumed above, so field 22 is index 19 here.
        const ticks = Number(afterComm[19]);
        return Number.isFinite(ticks) ? ticks : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/** This process's own start time, for the record written at acquisition. */
export function selfHolder(probe: LeaseProcessProbe = procLeaseProbe()): HolderProcess {
  const startTicks = probe.startTicks(process.pid);
  if (startTicks === undefined) {
    // Without a start-time guard the record cannot survive PID reuse, and a lease that
    // cannot be verified later is worse than no lease.
    throw new Error('cannot read this process start time; a lease cannot be acquired without the PID-reuse guard');
  }
  return { pid: process.pid, startTicks };
}

/**
 * The stable key for a mutation domain.
 *
 * `realpath` resolves symlinks so two spellings of one worktree cannot both hold it. The
 * hash keeps the filename bounded and filesystem-safe while the record inside still carries
 * the readable path.
 */
export function workspaceKey(workspace: WorkspaceIdentity): string {
  let resolved = workspace.worktreePath;
  try {
    resolved = realpathSync(workspace.worktreePath);
  } catch {
    // A worktree path that does not resolve is still a distinct domain; hashing the literal
    // path keeps acquisition possible rather than failing on a not-yet-created directory.
  }
  return createHash('sha256').update(resolved).digest('hex').slice(0, 16);
}

/**
 * Where lease records live.
 *
 * Under the git common directory when there is one, so every worktree of one repository has
 * its leases in a single discoverable place — while the key still separates them, because
 * the worktree path is the mutation domain. This is runtime state and not a second forensic
 * database: `observability.db` remains the single forensic store and nothing here writes to
 * it.
 */
export function leaseDir(workspace: WorkspaceIdentity): string {
  return join(workspace.gitCommonDir ?? workspace.repositoryRoot, '.specialists', 'leases');
}

/**
 * The lease record for a workspace.
 *
 * Exported because Phase 9 reconciliation resolves the same record without going through
 * `release`, which refuses an uncertain lease by design.
 */
export function leasePath(workspace: WorkspaceIdentity): string {
  return join(leaseDir(workspace), `${workspaceKey(workspace)}.json`);
}

/**
 * Read the lease and apply the liveness verdict.
 *
 * The record's own contents never decide the state — only the probe does. A record that
 * cannot be parsed is `uncertain` rather than `free`, because an unreadable lease is
 * evidence that something wrote it badly, not evidence that nobody holds the workspace.
 */
export function inspect(
  workspace: WorkspaceIdentity,
  probe: LeaseProcessProbe = procLeaseProbe(),
): LeaseStatus {
  const path = leasePath(workspace);
  if (!existsSync(path)) return { state: 'free' };

  let lease: WorkspaceLease;
  try {
    lease = JSON.parse(readFileSync(path, 'utf-8')) as WorkspaceLease;
    if (typeof lease?.holder?.pid !== 'number') throw new Error('missing holder');
  } catch {
    return { state: 'uncertain', uncertainReason: 'unreadable_record' };
  }

  if (!probe.canVerify()) {
    return { state: 'uncertain', lease, uncertainReason: 'liveness_unverifiable' };
  }
  const actual = probe.startTicks(lease.holder.pid);
  if (actual === undefined) {
    // The holder's process is gone. It is NOT free: the holder may have died mid-write.
    return { state: 'uncertain', lease, uncertainReason: 'holder_process_gone' };
  }
  if (actual !== lease.holder.startTicks) {
    // The PID is running but is a different process. PID reuse, not the holder.
    return { state: 'uncertain', lease, uncertainReason: 'holder_start_mismatch' };
  }
  return { state: 'held', lease };
}

export interface AcquireRequest {
  workspace: WorkspaceIdentity;
  activationId: ActivationId;
  attemptId: AttemptId;
  specialist?: string;
}

/**
 * Take the writer lease for a workspace, or refuse with the holder named.
 *
 * Resume is the one case that is not contention: an activation that already holds this
 * workspace reacquires its own lease for a new attempt rather than colliding with itself.
 * The comparison is on `activationId`, because a retry is a new attempt under one
 * activation and not a new participant.
 *
 * Refusal is a `DispatchRejectedError`, so every refusal is forensic evidence carrying the
 * activation, the workspace and the holder.
 */
export function acquire(
  request: AcquireRequest,
  probe: LeaseProcessProbe = procLeaseProbe(),
): WorkspaceLease {
  const { workspace, activationId, attemptId } = request;
  const path = leasePath(workspace);
  const status = inspect(workspace, probe);

  if (status.state === 'held' && status.lease) {
    if (status.lease.activationId === activationId) {
      // Resume: the same activation reacquires, advancing only the attempt.
      return rewrite(workspace, { ...status.lease, attemptId });
    }
    throw refusal('workspace_held_by_another_writer', request, status);
  }

  if (status.state === 'uncertain') {
    // Never steal. A holder whose liveness is unknown may still be mutating this worktree,
    // and Phase 9 recovery — not an acquirer — decides what happened.
    throw refusal('workspace_lease_uncertain', request, status);
  }

  const lease: WorkspaceLease = {
    workspaceKey: workspaceKey(workspace),
    worktreePath: workspace.worktreePath,
    activationId,
    attemptId,
    specialist: request.specialist,
    holder: selfHolder(probe),
    acquiredAtMs: Date.now(),
  };

  mkdirSync(leaseDir(workspace), { recursive: true, mode: 0o700 });
  const staging = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(staging, `${JSON.stringify(lease, null, 2)}\n`, { mode: 0o600 });
  try {
    // `link` publishes a fully-written file or fails with EEXIST. This is the atomic step:
    // a concurrent acquirer either sees no lease at all or sees a complete one, never a
    // half-written record, and the loser cannot overwrite the winner.
    linkSync(staging, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Lost the race. Re-read so the refusal names whoever actually won it.
      throw refusal('workspace_held_by_another_writer', request, inspect(workspace, probe));
    }
    throw err;
  } finally {
    try { unlinkSync(staging); } catch { /* the published link is what matters */ }
  }
  return lease;
}

/** Replace a lease record in place, for the resume case only. */
function rewrite(workspace: WorkspaceIdentity, lease: WorkspaceLease): WorkspaceLease {
  const path = leasePath(workspace);
  const staging = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(staging, `${JSON.stringify(lease, null, 2)}\n`, { mode: 0o600 });
  // Rename, not link: this path deliberately REPLACES the record, and only for the resume
  // case where the caller has already been proven to be the current holder.
  renameSync(staging, path);
  return lease;
}

/**
 * Release a lease.
 *
 * Only the holding activation may release, and releasing an `uncertain` lease is refused
 * outright: that is the blind free this module exists to prevent, and it is Phase 9's
 * decision rather than a caller's. Releasing a workspace that is already free is a no-op,
 * so a duplicated teardown is not an error.
 */
export function release(
  workspace: WorkspaceIdentity,
  activationId: ActivationId,
  probe: LeaseProcessProbe = procLeaseProbe(),
): void {
  const status = inspect(workspace, probe);
  if (status.state === 'free') return;

  if (status.state === 'uncertain') {
    throw new DispatchRejectedError('workspace_lease_uncertain', {
      activationId,
      workspace: workspace.worktreePath,
      holder: describeHolder(status),
      note: 'refusing to release a lease whose holder liveness is unknown; recovery is PRD Phase 9',
    });
  }
  if (status.lease && status.lease.activationId !== activationId) {
    throw new DispatchRejectedError('workspace_lease_not_held_by_caller', {
      activationId,
      workspace: workspace.worktreePath,
      holder: describeHolder(status),
    });
  }
  try {
    unlinkSync(leasePath(workspace));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function describeHolder(status: LeaseStatus): string {
  if (!status.lease) return status.uncertainReason ?? 'unknown';
  const { activationId, specialist, holder } = status.lease;
  const who = specialist ? `${specialist} ` : '';
  const why = status.uncertainReason ? ` (${status.uncertainReason})` : '';
  return `${who}${activationId} pid ${holder.pid}${why}`;
}

function refusal(reason: string, request: AcquireRequest, status: LeaseStatus): DispatchRejectedError {
  return new DispatchRejectedError(reason, {
    activationId: request.activationId,
    specialist: request.specialist,
    workspace: request.workspace.worktreePath,
    holder: describeHolder(status),
    note: status.state === 'uncertain'
      ? 'the previous holder\'s liveness could not be established; the lease is uncertain, not free'
      : 'exactly one writer holds a mutable workspace at a time',
  });
}

// --------------------------------------------------------------- mutation admission

/**
 * Tools that cannot mutate a workspace.
 *
 * An allowlist rather than a denylist, and the direction matters: an unrecognised tool is
 * treated as mutating. A denylist would silently admit every tool added after this list was
 * written, which is the failure mode PRD §54 warns about — a model where only edit and
 * write are protected while custom mutation stays unrestricted.
 */
const NON_MUTATING_TOOLS = new Set([
  'read', 'grep', 'glob', 'ls', 'list', 'search', 'view', 'todowrite', 'websearch', 'webfetch',
]);

export function isMutatingTool(toolName: string): boolean {
  return !NON_MUTATING_TOOLS.has(toolName.trim().toLowerCase());
}

/** The verdict a `tool_call` handler converts into `{ block: true }` plus a reason. */
export interface AdmissionVerdict {
  allow: boolean;
  reason?: string;
}

/**
 * Decide whether one tool call may proceed against a workspace.
 *
 * Wire this into `beforeToolCall` and convert `allow: false` into a per-call block. Do NOT
 * implement it with `setActiveToolsByName`: within a turn the agent loop runs against a
 * snapshot taken at turn start, so revoking a tool cannot cancel a call that is already
 * planned (§5.9). Every handler in a batch fires before any execution, so a per-call block
 * is enforceable where a tool-set change is not.
 *
 * A read-only activation is refused every mutating call, because it holds no lease and is
 * not entitled to one. That is not an error state — it is the capability grant being
 * enforced at the only choke point that can enforce it.
 */
export function admitToolCall(
  input: {
    toolName: string;
    workspace: WorkspaceIdentity;
    activationId: ActivationId;
  },
  probe: LeaseProcessProbe = procLeaseProbe(),
): AdmissionVerdict {
  if (!isMutatingTool(input.toolName)) return { allow: true };

  const status = inspect(input.workspace, probe);
  if (status.state === 'held' && status.lease?.activationId === input.activationId) {
    return { allow: true };
  }
  if (status.state === 'held') {
    return {
      allow: false,
      reason: `workspace ${input.workspace.worktreePath} is held by ${describeHolder(status)}; `
        + `${input.toolName} would mutate a workspace this activation does not hold`,
    };
  }
  if (status.state === 'uncertain') {
    return {
      allow: false,
      reason: `workspace ${input.workspace.worktreePath} lease is uncertain (${status.uncertainReason}); `
        + 'mutation is refused until recovery resolves the previous holder',
    };
  }
  return {
    allow: false,
    reason: `workspace ${input.workspace.worktreePath} is not leased by this activation; `
      + `${input.toolName} may not mutate it`,
  };
}
