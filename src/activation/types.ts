/**
 * Canonical object model for native Specialist activation.
 *
 * The distinction between role, activation and physical session is load-bearing and is
 * preserved here deliberately:
 *
 *   SpecialistDefinition → SpecialistLoader → Activation → Attempt → Pi AgentSession
 *
 * These types are transport-neutral and carry no TUI state, so a future scheduler can
 * construct the same `ActivationRequest` that the Pi extension and the Claude Code MCP
 * server construct.
 */

import type { StepContract } from './step-contract.js';

/** Stable logical participant identity — the role, across activations. */
export type ParticipantId = string;

/** One activation of a participant. Canonical runtime identity; maps to job_id. */
export type ActivationId = string;

/**
 * One retry/recovery attempt within an activation.
 *
 * Retries are attempts under a single activation, never new participants — otherwise
 * lineage cannot answer "did this Specialist retry, or did two Specialists run?".
 */
export type AttemptId = string;

/** Physical Pi session id. Correlation metadata only — never durable Specialist identity. */
export type PiSessionId = string;

/**
 * A mutable workspace.
 *
 * The worktree path is the mutation domain: two linked git worktrees sharing one common
 * repo are DISTINCT mutable workspaces, even though they share history and one
 * observability database.
 */
export interface WorkspaceIdentity {
  repositoryRoot: string;
  gitCommonDir?: string;
  worktreePath: string;
  branch?: string;
}

/**
 * Resolved mutation authority for an activation.
 *
 * Derived from the Specialist's resolved capability grant, never from its name — a custom
 * Specialist with edit tools is a writer regardless of what it is called, and a Specialist
 * named "executor" with a read-only grant is not.
 */
export type WorkspaceAccess = 'read' | 'write';

/**
 * A request to activate a Specialist.
 *
 * Independent of TUI state by design. Tracked work is identified by `beadId` only: there is
 * deliberately no free-form task field, because supplementing an incomplete Bead through
 * delegation prose is how durable work silently loses scope.
 */
export interface ActivationRequest {
  specialist: string;
  beadId: string;

  /**
   * Overrides the effective configured model for THIS activation only.
   *
   * Never mutates Specialist config. An explicitly requested unavailable model must be
   * rejected before session creation rather than silently replaced.
   */
  modelOverride?: string;

  requestedByParticipantId: ParticipantId;
  coordinatorSessionId?: string;

  /**
   * Up-walk hops along bead.parent for epic lineage in the turn-1 prompt.
   * 1 = immediate parent, 2 = parent + grandparent. Absent = no lineage.
   * Distinct from the CLI's downward --context-depth over completed blockers.
   */
  epicContextDepth?: number;

  /** Defaults to the coordinator's current worktree. A writer does not get a new one. */
  workspaceHint?: WorkspaceIdentity;
}

/** Presentation state. Not necessarily durable workflow state. */
export type ActivationState =
  | 'starting'
  | 'running'
  | 'waiting'
  | 'needs_reply'
  | 'escalated'
  | 'settled'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'uncertain';

/** Point-in-time view of an activation, for Fleet projection and diagnostics. */
export interface ActivationSnapshot {
  activationId: ActivationId;
  participantId: ParticipantId;
  attemptId: AttemptId;
  specialist: string;
  beadId: string;
  state: ActivationState;
  access: WorkspaceAccess;
  workspace: WorkspaceIdentity;
  piSessionId?: PiSessionId;
  configuredModel?: string;
  /**
   * The model this activation ASKED for: the override when one was given, the configured
   * model otherwise.
   *
   * Recorded separately from `resolvedModel` and kept even when the two are equal.
   * `configuredModel` plus the `modelOverride` boolean cannot reconstruct it, because the
   * override string itself is nowhere else on the snapshot; and the query this exists to
   * answer — "which activations ran on something other than what was asked for" — is
   * unanswerable if the equal case is omitted from the record.
   */
  requestedModel?: string;
  resolvedModel: string;
  /** True iff an explicit `modelOverride` was supplied. `requestedModel` carries which. */
  modelOverride: boolean;
  /** Thinking level passed to session creation. Absent when unset — never fabricated. */
  thinkingLevel?: string;
  /** Cumulative spend counts from the session event stream. Absent until the first usage event. */
  tokenUsage?: ActivationTokenUsage;
  /**
   * One-line purpose excerpt captured once at dispatch from the bead contract
   * (first meaningful SCOPE line, else SUCCESS). Absent when unreadable — never fabricated.
   */
  purpose?: string;
  startedAt: number;
  lastActivityAt: number;
}

/**
 * Cumulative token spend for one activation.
 *
 * Spend counts only. Window-context % is coordinator-owned (it needs the model's context
 * window, which the host never sees) and is deliberately not computed here.
 */
export interface ActivationTokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_tokens?: number;
  cache_read_tokens?: number;
  reasoning_tokens?: number;
  tool_tokens?: number;
  total_tokens?: number;
}

/**
 * Live per-activation stats over existing in-memory state.
 *
 * A Map read plus arithmetic — never an observability.db query — so the 1s widget tick
 * stays cheap. Window-context % is omitted by design (see `ActivationTokenUsage`).
 */
export interface LiveActivationStats {
  activationId: ActivationId;
  elapsed_s: number;
  last_activity_at: number;
  thinking_level?: string;
  token_usage?: ActivationTokenUsage;
}

/**
 * The validated outcome of an activation.
 *
 * Distinct from an interaction message by design. A model that stopped has not necessarily
 * produced a result: completion runs output validation and post-execution logic, whereas a
 * progress message performs no state transition at all. A completion *notification* is a
 * projection of this object, never a substitute for it.
 */
export interface ActivationResult {
  activationId: ActivationId;
  participantId: ParticipantId;
  attemptId: AttemptId;
  beadId: string;

  status: 'completed' | 'failed' | 'uncertain';

  output: unknown;

  validation: {
    valid: boolean;
    schema?: string;
    errors?: string[];
  };

  piSessionId?: PiSessionId;

  configuredModel?: string;
  /**
   * The model this activation ASKED for: the override when one was given, the configured
   * model otherwise.
   *
   * Recorded separately from `resolvedModel` and kept even when the two are equal.
   * `configuredModel` plus the `modelOverride` boolean cannot reconstruct it, because the
   * override string itself is nowhere else on the snapshot; and the query this exists to
   * answer — "which activations ran on something other than what was asked for" — is
   * unanswerable if the equal case is omitted from the record.
   */
  requestedModel?: string;
  resolvedModel: string;
  /** True iff an explicit `modelOverride` was supplied. `requestedModel` carries which. */
  modelOverride: boolean;
  /**
   * Always false on the native runtime, and that is the contract, not an omission.
   *
   * A model that cannot be honoured is refused before the AgentSession exists
   * (`model-gate.ts`), never substituted — a Specialist that quietly ran on a fallback
   * produces results nobody can attribute. The field stays because a reader must be able
   * to ask the question and get an answer rather than find no field at all.
   */
  fallbackUsed: boolean;

  completedAt: number;
}

/** A live activation. */
export interface ActivationHandle {
  activationId: ActivationId;
  participantId: ParticipantId;
  attemptId: AttemptId;
  specialist: string;
  beadId: string;
  access: WorkspaceAccess;
  workspace: WorkspaceIdentity;
  resolvedModel: string;
  /** The bounded contract this activation was compiled to. Derived, never persisted. */
  stepContract: StepContract;
  /** Resolves when the activation reaches a validated result. */
  result: Promise<ActivationResult>;
}

/** Structured dispatch refusal. Every refusal is forensic evidence. */
export class DispatchRejectedError extends Error {
  constructor(
    public readonly reason: string,
    public readonly detail: {
      specialist?: string;
      beadId?: string;
      missing?: string[];
      workspace?: string;
      holder?: string;
      requestedModel?: string;
      activationId?: string;
      note?: string;
    } = {},
  ) {
    const lines = [
      'SPECIALIST_DISPATCH_REJECTED',
      '',
      ...(detail.activationId ? [`activation:\n  ${detail.activationId}`, ''] : []),
      ...(detail.beadId ? [`bead:\n  ${detail.beadId}`, ''] : []),
      ...(detail.specialist ? [`specialist:\n  ${detail.specialist}`, ''] : []),
      ...(detail.note ? [`note:\n  ${detail.note}`, ''] : []),
      `reason:\n  ${reason}`,
      ...(detail.missing?.length ? ['', `missing:\n${detail.missing.map(m => `  - ${m}`).join('\n')}`] : []),
      ...(detail.requestedModel ? ['', `requested model:\n  ${detail.requestedModel}`] : []),
      ...(detail.workspace ? ['', `workspace:\n  ${detail.workspace}`] : []),
      ...(detail.holder ? ['', `holder:\n  ${detail.holder}`] : []),
      '',
      'AgentSession:\n  not created',
    ];
    super(lines.join('\n'));
    this.name = 'DispatchRejectedError';
  }
}
