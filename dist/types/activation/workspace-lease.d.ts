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
import { type ActivationId, type AttemptId, type WorkspaceIdentity } from './types.js';
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
export declare function procLeaseProbe(): LeaseProcessProbe;
/** This process's own start time, for the record written at acquisition. */
export declare function selfHolder(probe?: LeaseProcessProbe): HolderProcess;
/**
 * The stable key for a mutation domain.
 *
 * `realpath` resolves symlinks so two spellings of one worktree cannot both hold it. The
 * hash keeps the filename bounded and filesystem-safe while the record inside still carries
 * the readable path.
 */
export declare function workspaceKey(workspace: WorkspaceIdentity): string;
/**
 * Where lease records live.
 *
 * Under the git common directory when there is one, so every worktree of one repository has
 * its leases in a single discoverable place — while the key still separates them, because
 * the worktree path is the mutation domain. This is runtime state and not a second forensic
 * database: `observability.db` remains the single forensic store and nothing here writes to
 * it.
 */
export declare function leaseDir(workspace: WorkspaceIdentity): string;
/**
 * Read the lease and apply the liveness verdict.
 *
 * The record's own contents never decide the state — only the probe does. A record that
 * cannot be parsed is `uncertain` rather than `free`, because an unreadable lease is
 * evidence that something wrote it badly, not evidence that nobody holds the workspace.
 */
export declare function inspect(workspace: WorkspaceIdentity, probe?: LeaseProcessProbe): LeaseStatus;
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
export declare function acquire(request: AcquireRequest, probe?: LeaseProcessProbe): WorkspaceLease;
/**
 * Release a lease.
 *
 * Only the holding activation may release, and releasing an `uncertain` lease is refused
 * outright: that is the blind free this module exists to prevent, and it is Phase 9's
 * decision rather than a caller's. Releasing a workspace that is already free is a no-op,
 * so a duplicated teardown is not an error.
 */
export declare function release(workspace: WorkspaceIdentity, activationId: ActivationId, probe?: LeaseProcessProbe): void;
export declare function isMutatingTool(toolName: string): boolean;
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
export declare function admitToolCall(input: {
    toolName: string;
    workspace: WorkspaceIdentity;
    activationId: ActivationId;
}, probe?: LeaseProcessProbe): AdmissionVerdict;
//# sourceMappingURL=workspace-lease.d.ts.map