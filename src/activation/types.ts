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
  resolvedModel: string;
  modelOverride: boolean;
  startedAt: number;
  lastActivityAt: number;
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
  resolvedModel: string;
  modelOverride: boolean;
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
