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

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCommonGitRoot } from '../specialist/job-root.js';
import {
  inspect,
  leaseDir,
  leasePath,
  procLeaseProbe,
  type LeaseProcessProbe,
  type LeaseStatus,
  type WorkspaceLease,
} from './workspace-lease.js';
import type { ActivationId, WorkspaceIdentity } from './types.js';

/**
 * PRD §59 outcomes, verbatim.
 *
 * `recovered_holder` is never proposed by a caller — it is what the module records when
 * re-inspection finds the workspace held after all. Everything else is a decision someone
 * takes responsibility for.
 */
export type ReconciliationOutcome =
  | 'safe_free'
  | 'recovered_holder'
  | 'superseded'
  | 'manual_attention_required';

/** The outcomes a caller may ask for. `recovered_holder` is computed, never requested. */
export type ProposedOutcome = Exclude<ReconciliationOutcome, 'recovered_holder'>;

/** Why a proposal was not applied. Recorded so a refusal explains itself later. */
export type RefusalReason =
  | 'workspace_not_uncertain'
  | 'holder_is_live'
  | 'insufficient_evidence'
  | 'reason_forbids_outcome'
  | 'successor_not_named';

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
  holder?: { pid: number; activationId: ActivationId; specialist?: string };
  decidedBy: string;
  basis: string[];
  supersededBy?: ActivationId;
  note?: string;
  decidedAtMs: number;
}

/**
 * Which resolving outcomes each uncertain reason permits.
 *
 * `manual_attention_required` is always permitted: recording that nobody can resolve this
 * yet is itself a legitimate outcome, and it is the only one open on a host that cannot
 * establish liveness.
 */
const PERMITTED: Record<NonNullable<LeaseStatus['uncertainReason']>, ReadonlySet<ProposedOutcome>> = {
  holder_process_gone: new Set<ProposedOutcome>(['safe_free', 'superseded', 'manual_attention_required']),
  holder_start_mismatch: new Set<ProposedOutcome>(['safe_free', 'superseded', 'manual_attention_required']),
  unreadable_record: new Set<ProposedOutcome>(['superseded', 'manual_attention_required']),
  liveness_unverifiable: new Set<ProposedOutcome>(['manual_attention_required']),
};

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
export function reconcile(
  workspace: WorkspaceIdentity,
  request: ReconciliationRequest,
  options: ReconcileOptions = {},
): ReconciliationRecord {
  const probe = options.probe ?? procLeaseProbe();
  const now = options.now ?? Date.now;
  // Re-inspect at decision time, not at request time. A live writer's workspace can never
  // be reconciled out from under it, and the only way to know it is live is to look now.
  const status = inspect(workspace, probe);

  const record = decide(workspace, request, status, now());
  appendRecord(workspace, record);
  emit(options.forensics, record, status.lease);
  return record;
}

function decide(
  workspace: WorkspaceIdentity,
  request: ReconciliationRequest,
  status: LeaseStatus,
  decidedAtMs: number,
): ReconciliationRecord {
  const base = {
    workspaceKey: keyFor(workspace, status.lease),
    worktreePath: workspace.worktreePath,
    observedState: status.state,
    observedUncertainReason: status.uncertainReason,
    holder: status.lease
      ? { pid: status.lease.holder.pid, activationId: status.lease.activationId, specialist: status.lease.specialist }
      : undefined,
    decidedBy: request.decidedBy,
    basis: request.basis,
    supersededBy: request.supersededBy,
    note: request.note,
    decidedAtMs,
  };
  const refuse = (refusalReason: RefusalReason, outcome: ReconciliationOutcome = 'manual_attention_required'): ReconciliationRecord => ({
    ...base,
    applied: false,
    outcome,
    proposedOutcome: request.outcome,
    refusalReason,
  });

  if (status.state === 'held') {
    // The holder was alive after all. Nothing is touched, and this is recorded as an
    // outcome rather than an error: it is the honest answer to "what happened here?".
    return refuse('holder_is_live', 'recovered_holder');
  }
  if (status.state === 'free') {
    return refuse('workspace_not_uncertain');
  }
  if (request.basis.length === 0) {
    // Applies to every outcome. A recorded decision with no stated basis is an inference.
    return refuse('insufficient_evidence');
  }
  const reason = status.uncertainReason;
  if (!reason || !PERMITTED[reason].has(request.outcome)) {
    return refuse('reason_forbids_outcome');
  }
  if (request.outcome === 'superseded' && !request.supersededBy) {
    return refuse('successor_not_named');
  }

  if (request.outcome === 'manual_attention_required') {
    // Applied, and deliberately non-resolving: the lease record stays exactly as it is so
    // the workspace remains refused to every acquirer until someone can resolve it.
    return { ...base, applied: true, outcome: 'manual_attention_required' };
  }

  // `safe_free` and `superseded` do the same thing to the lease FILE, and that is not an
  // oversight worth collapsing: they differ in what is asserted, and the assertion is the
  // durable product of this module. `safe_free` says the departed holder's mutation reached
  // a boundary; `superseded` says a named activation now owns the workspace regardless of
  // what the departed holder finished. Both leave the workspace free to be acquired, and in
  // neither case is a successor lease written here — that would fabricate liveness for a
  // process this module has never probed. The successor still acquires through the ordinary
  // atomic path, which is the only thing entitled to publish a `held` record.
  removeLease(workspace);
  return { ...base, applied: true, outcome: request.outcome };
}

/** Free the workspace. Reached only for an applied `safe_free` or `superseded`. */
function removeLease(workspace: WorkspaceIdentity): void {
  try {
    unlinkSync(leasePath(workspace));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function keyFor(workspace: WorkspaceIdentity, lease?: WorkspaceLease): string {
  return lease?.workspaceKey ?? basenameKey(leasePath(workspace));
}

function basenameKey(path: string): string {
  const file = path.slice(path.lastIndexOf('/') + 1);
  return file.endsWith('.json') ? file.slice(0, -5) : file;
}

// ------------------------------------------------------------------- durable evidence

/** The append-only log of reconciliation attempts for one workspace. */
export function reconciliationLogPath(workspace: WorkspaceIdentity): string {
  return `${leasePath(workspace).slice(0, -'.json'.length)}.reconcile.jsonl`;
}

/**
 * Append one attempt.
 *
 * JSONL and append-only, because a refusal must not be overwritten by the next attempt:
 * "we tried three times and could not resolve it" is the evidence an operator needs, and a
 * last-write-wins file destroys it. This is runtime state beside the lease, not a second
 * forensic database — `observability.db` remains the forensic store, written through the
 * sink below.
 */
function appendRecord(workspace: WorkspaceIdentity, record: ReconciliationRecord): void {
  mkdirSync(leaseDir(workspace), { recursive: true, mode: 0o700 });
  appendFileSync(reconciliationLogPath(workspace), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/** Every reconciliation attempt recorded for a workspace, oldest first. */
export function readReconciliationLog(workspace: WorkspaceIdentity): ReconciliationRecord[] {
  return readLogAt(reconciliationLogPath(workspace));
}

function readLogAt(path: string): ReconciliationRecord[] {
  if (!existsSync(path)) return [];
  const out: ReconciliationRecord[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    // A corrupt line is skipped rather than failing the read: a status surface that throws
    // on one bad row shows an operator nothing at all.
    try { out.push(JSON.parse(line) as ReconciliationRecord); } catch { /* skip */ }
  }
  return out;
}

function emit(
  sink: ReconciliationForensicSink | undefined,
  record: ReconciliationRecord,
  lease: WorkspaceLease | undefined,
): void {
  if (!sink) return;
  try {
    sink.emit({
      // The departed holder's activation is the subject of the event. Without a readable
      // record there is no activation to attribute it to, and inventing one would corrupt
      // lineage — so the workspace key stands in and is labelled as such in the payload.
      activationId: lease?.activationId ?? `workspace:${record.workspaceKey}`,
      attemptId: lease?.attemptId ?? 'reconciliation',
      participantId: lease?.specialist ? `specialist::${lease.specialist}` : 'specialist::unknown',
      specialist: lease?.specialist ?? 'unknown',
      name: record.applied ? 'lease_reconciled' : 'lease_uncertain',
      payload: {
        workspace: record.worktreePath,
        workspace_key: record.workspaceKey,
        outcome: record.outcome,
        applied: record.applied,
        proposed_outcome: record.proposedOutcome,
        refusal_reason: record.refusalReason,
        observed_state: record.observedState,
        uncertain_reason: record.observedUncertainReason,
        decided_by: record.decidedBy,
        basis: record.basis,
        superseded_by: record.supersededBy,
        note: record.note,
        holder_activation_id: record.holder?.activationId,
        holder_pid: record.holder?.pid,
        attributed_to_workspace: lease === undefined,
      },
    });
  } catch {
    // Forensics never decide an outcome. The durable log above already holds the decision.
  }
}

// --------------------------------------------------------------------- status surface

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
export function leaseScopeFor(cwd: string): WorkspaceIdentity {
  const commonRoot = resolveCommonGitRoot(cwd);
  return {
    repositoryRoot: commonRoot ?? cwd,
    worktreePath: cwd,
    gitCommonDir: commonRoot ? join(commonRoot, '.git') : undefined,
  };
}

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
export function projectUncertainWorkspaces(
  scope: WorkspaceIdentity,
  probe: LeaseProcessProbe = procLeaseProbe(),
): UncertainWorkspaceProjection[] {
  const dir = leaseDir(scope);
  if (!existsSync(dir)) return [];

  const out: UncertainWorkspaceProjection[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    const key = entry.slice(0, -'.json'.length);
    const lease = readLeaseFile(join(dir, entry));
    // The record's own worktree path is what makes each workspace inspectable: one lease
    // directory serves every worktree of the repository, and the mutation domain is the
    // worktree, not the repository. An unreadable record has no worktree path to recover,
    // which is precisely why `safe_free` is refused for it.
    const status = lease
      ? inspect({ ...scope, worktreePath: lease.worktreePath }, probe)
      : { state: 'uncertain' as const, uncertainReason: 'unreadable_record' as const };
    if (status.state !== 'uncertain') continue;

    const log = readLogAt(join(dir, `${key}.reconcile.jsonl`));
    const last = log[log.length - 1];
    out.push({
      workspace_key: key,
      worktree_path: lease?.worktreePath,
      uncertain_reason: status.uncertainReason,
      holder_pid: lease?.holder.pid,
      holder_activation_id: lease?.activationId,
      holder_specialist: lease?.specialist,
      acquired_at_ms: lease?.acquiredAtMs,
      permitted_outcomes: status.uncertainReason ? [...PERMITTED[status.uncertainReason]] : ['manual_attention_required'],
      reconciliation_attempts: log.length,
      last_reconciliation: last && {
        outcome: last.outcome,
        applied: last.applied,
        refusal_reason: last.refusalReason,
        decided_by: last.decidedBy,
        decided_at_ms: last.decidedAtMs,
        basis: last.basis,
      },
    });
  }
  return out;
}

function readLeaseFile(path: string): WorkspaceLease | undefined {
  try {
    const lease = JSON.parse(readFileSync(path, 'utf-8')) as WorkspaceLease;
    return typeof lease?.holder?.pid === 'number' && typeof lease.worktreePath === 'string' ? lease : undefined;
  } catch {
    return undefined;
  }
}
