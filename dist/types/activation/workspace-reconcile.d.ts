/**
 * Phase 9 — reconciliation of an uncertain workspace.
 *
 * `workspace-lease.ts` produces `uncertain` honestly and refuses to resolve it: `acquire`
 * will not steal an uncertain lease and `release` throws rather than guess. That is the
 * correct safety property and, on its own, a liveness bug — a writer killed mid-mutation
 * leaves a workspace that is not silently free and also permanently unusable. This module
 * is the only path out, and it exists so that the way out is a recorded decision rather
 * than an inference.
 *
 * ## The rule the obvious implementation gets wrong
 *
 * The tempting shape is `reconcile(workspace)` — look at the world, work out what happened,
 * free the lease if it looks safe. That is precisely the blind free the uncertain state
 * exists to prevent, wearing a different name: absence of a process is not evidence that a
 * mutation completed, and it is not evidence that it did not. So reconciliation here is a
 * PROPOSAL that the module validates and records:
 *
 *   1. the caller states the outcome it wants, who decided it, and on what durable basis;
 *   2. the module re-inspects the live lease at decision time;
 *   3. it refuses any outcome the current `uncertainReason` does not permit;
 *   4. it appends the attempt — accepted or refused — to a durable log beside the lease.
 *
 * A refusal is a result, not an error to discard. It leaves the workspace uncertain and
 * stays readable through `specialist_status`, because a workspace nobody can resolve is
 * exactly the thing an operator needs to see.
 *
 * ## Why the four uncertain reasons are not one rule
 *
 * They were separated in `inspect()` because they have different safe actions, and
 * collapsing them here would waste that. What each one licenses:
 *
 *   `holder_process_gone`     the recorded PID has no `/proc` entry. The holder is provably
 *                             not running, so an operator citing durable evidence may free
 *                             the workspace or record a successor.
 *   `holder_start_mismatch`   the PID runs but is a different process. The holder is equally
 *                             provably gone; the same outcomes are open. It is kept distinct
 *                             because the recorded PID now belongs to an unrelated process
 *                             and must never be treated as the holder for any purpose.
 *   `unreadable_record`       there is no holder identity at all. Nothing can be attributed
 *                             as safely finished, so `safe_free` is refused; an operator who
 *                             has inspected the worktree may still name a successor and free
 *                             it that way, which asserts ownership instead of completion.
 *   `liveness_unverifiable`   this host cannot see processes at all. No evidence available
 *                             to this runtime can show that the holder stopped, so every
 *                             resolving outcome is refused and only
 *                             `manual_attention_required` may be recorded.
 *
 * The last row is the bright line of this module, and it is the one a later reader will want
 * to relax. Every argument for relaxing it is an inference from absence wearing a threshold:
 * "the lease is very old", "nothing has touched the worktree in an hour", "give it a
 * timeout". None of those observe the holder. On a host that cannot see processes, an old
 * lease and a live writer produce identical evidence, which is exactly the condition
 * `uncertain` was invented to represent. A runtime that cannot verify does not act. Adding a
 * timeout here means deleting this paragraph first.
 *
 * ## Scope
 *
 * Acquisition and the `linkSync` publish are untouched. This module reads the lease record
 * and, for an accepted resolving outcome, removes it — it never goes through `release`,
 * which refuses an uncertain lease by design, and it never publishes a lease of its own.
 *
 * The `pi.exec`/`executeBash` veto hole (`unitAI-rrdnt.6`, H3/H4 in `workspace-lease.ts`)
 * is still open and reconciliation does not assume otherwise. It never claims to know what
 * a departed holder did; it only records what a decider asserts and on what basis.
 */
import { type LeaseProcessProbe, type LeaseStatus } from './workspace-lease.js';
import type { ActivationId, WorkspaceIdentity } from './types.js';
/**
 * PRD §59 outcomes, verbatim.
 *
 * `recovered_holder` is never proposed by a caller — it is what the module records when
 * re-inspection finds the workspace held after all. Everything else is a decision someone
 * takes responsibility for.
 */
export type ReconciliationOutcome = 'safe_free' | 'recovered_holder' | 'superseded' | 'manual_attention_required';
/** The outcomes a caller may ask for. `recovered_holder` is computed, never requested. */
export type ProposedOutcome = Exclude<ReconciliationOutcome, 'recovered_holder'>;
/** Why a proposal was not applied. Recorded so a refusal explains itself later. */
export type RefusalReason = 'workspace_not_uncertain' | 'holder_is_live' | 'insufficient_evidence' | 'reason_forbids_outcome' | 'successor_not_named';
export interface ReconciliationRequest {
    /** The outcome the decider asserts. */
    outcome: ProposedOutcome;
    /**
     * Who decided. An operator identity or the runtime component making the call — never a
     * default, because "the runtime decided" with no author is how an inference gets
     * laundered into a decision.
     */
    decidedBy: string;
    /**
     * The durable evidence consulted, one entry per source: forensic event ids, git/worktree
     * observations, termination evidence, the lease generation read. An empty basis is
     * insufficient evidence for every outcome, including `manual_attention_required` — a
     * refusal still has to say what was looked at.
     */
    basis: string[];
    /** Required for `superseded`: the activation the decider asserts now owns the workspace. */
    supersededBy?: ActivationId;
    /** Free-form operator note, carried into the durable record. */
    note?: string;
}
/** One reconciliation attempt, as it is written to the durable log. */
export interface ReconciliationRecord {
    workspaceKey: string;
    worktreePath: string;
    /** True when the proposal was applied; false when it was refused. */
    applied: boolean;
    outcome: ReconciliationOutcome;
    /** The proposal, when it differs from the recorded outcome. */
    proposedOutcome?: ProposedOutcome;
    refusalReason?: RefusalReason;
    /** The lease state observed at decision time, not at request time. */
    observedState: LeaseStatus['state'];
    observedUncertainReason?: LeaseStatus['uncertainReason'];
    /** The departed holder, when the record was readable. */
    holder?: {
        pid: number;
        activationId: ActivationId;
        specialist?: string;
    };
    decidedBy: string;
    basis: string[];
    supersededBy?: ActivationId;
    note?: string;
    decidedAtMs: number;
}
/** The forensic sink shape this module needs — structurally the host's `ActivationForensicSink`. */
export interface ReconciliationForensicSink {
    emit(event: {
        activationId: string;
        attemptId: string;
        participantId: string;
        specialist: string;
        beadId?: string;
        name: string;
        payload?: Record<string, unknown>;
    }): void;
}
export interface ReconcileOptions {
    probe?: LeaseProcessProbe;
    forensics?: ReconciliationForensicSink;
    now?: () => number;
}
/**
 * Resolve — or refuse to resolve — an uncertain workspace.
 *
 * Never throws on a refusal. The caller gets a record whose `applied` is false and whose
 * `refusalReason` says why, and the same record is appended to the durable log and emitted
 * as a forensic event. A refusal that threw would be a refusal an operator has to
 * reconstruct from a stack trace.
 */
export declare function reconcile(workspace: WorkspaceIdentity, request: ReconciliationRequest, options?: ReconcileOptions): ReconciliationRecord;
/** The append-only log of reconciliation attempts for one workspace. */
export declare function reconciliationLogPath(workspace: WorkspaceIdentity): string;
/** Every reconciliation attempt recorded for a workspace, oldest first. */
export declare function readReconciliationLog(workspace: WorkspaceIdentity): ReconciliationRecord[];
/**
 * One uncertain workspace, projected for `specialist_status`.
 *
 * snake_case to match the existing payload shape (`pending_interactions`,
 * `background_jobs`), so a coordinator reads one consistent surface.
 */
export interface UncertainWorkspaceProjection {
    workspace_key: string;
    worktree_path?: string;
    uncertain_reason?: LeaseStatus['uncertainReason'];
    holder_pid?: number;
    holder_activation_id?: string;
    holder_specialist?: string;
    acquired_at_ms?: number;
    /** Outcomes a decider may currently propose. Empty is impossible — manual is always open. */
    permitted_outcomes: ProposedOutcome[];
    /** Attempts recorded so far, so a refusal is visible rather than thrown away. */
    reconciliation_attempts: number;
    last_reconciliation?: {
        outcome: ReconciliationOutcome;
        applied: boolean;
        refusal_reason?: RefusalReason;
        decided_by: string;
        decided_at_ms: number;
        basis: string[];
    };
}
/**
 * The workspace identity whose lease directory holds this checkout's leases.
 *
 * Every worktree of one repository shares one lease directory — that is what makes the
 * whole repository's uncertainty inspectable from any of them — while the key inside still
 * separates them, because the worktree path is the mutation domain. `resolveCommonGitRoot`
 * is the existing helper `.specialists/jobs` is anchored with, reused rather than
 * duplicated; outside a git checkout it yields `cwd`, and the lease directory is then local
 * to it.
 */
export declare function leaseScopeFor(cwd: string): WorkspaceIdentity;
/**
 * Every uncertain workspace in one lease directory.
 *
 * Takes the workspace identity rather than a bare path, so it reads exactly the directory
 * `workspace-lease.ts` writes and cannot drift from it — see `leaseScopeFor` for the
 * identity a status surface should pass.
 *
 * Reads the durable store and nothing else — no socket, no roster, no process beyond the
 * liveness probe the lease itself is defined by. A repository with no lease directory
 * yields an empty list rather than an error, because absence is the normal case.
 */
export declare function projectUncertainWorkspaces(scope: WorkspaceIdentity, probe?: LeaseProcessProbe): UncertainWorkspaceProjection[];
//# sourceMappingURL=workspace-reconcile.d.ts.map