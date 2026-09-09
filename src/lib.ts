// src/lib.ts — Library entry point for Node consumers.
// Importable via: import { runScript, ... } from '@jaggerxtrm/specialists/lib'
//
// Stable surface for embedding script-class specialist invocations into
// other Node services without spawning the CLI or running sp serve.
//
// Native activation seam (unitAI-rrdnt.37): the Pi coordinator extension
// (config/pi-extensions/specialist-subagents) and the Claude Code MCP server are
// frontends over the SAME `NativeActivationHost`; this is the single runtime export
// through which they reach it. Re-exports only — the classes and types below are
// defined in src/activation/* and nothing here widens their shape.

export {
  runScriptSpecialist as runScript,
} from './specialist/script-runner.js';

export type {
  ScriptGenerateRequest,
  ScriptGenerateResult,
  ScriptGenerateSuccess,
  ScriptGenerateFailure,
  ScriptSpecialistErrorType,
  ScriptRunnerOptions,
} from './specialist/script-runner.js';

export { SpecialistLoader } from './specialist/loader.js';
export type { Specialist } from './specialist/schema.js';

// Dispatchability projection (unitAI-rrdnt.49): the SAME checks the host runs at
// admission (model chain, tool contract, preflight), exposed so a frontend can
// distinguish dispatchable specialists from undispatchable ones without writing a
// second resolution.
export { resolveModelChain } from './specialist/model-chain.js';
export { resolveRuntimeToolContract } from './pi/session.js';
export { validateBeforeRun } from './specialist/runner.js';

// ── Native activation seam (unitAI-rrdnt.37) ─────────────────────────────────
// One host process-lifetime per coordinator surface; both frontends and a future
// Chain scheduler construct the same `ActivationRequest` against it.

export { NativeActivationHost } from './activation/native-host.js';
export type { NativeActivationHostDeps, ActivationForensicSink, ActivationAttachment } from './activation/native-host.js';

export { DispatchRejectedError, THINKING_LEVELS } from './activation/types.js';
export type {
  ActivationId,
  ActivationRequest,
  ActivationResult,
  ActivationSnapshot,
  ActivationState,
  ActivationHandle,
  AttemptId,
  ParticipantId,
  PiSessionId,
  WorkspaceAccess,
  WorkspaceIdentity,
} from './activation/types.js';

export type {
  DeliveryState,
  InteractionKind,
  InteractionMessage,
  MessageId,
  PendingAsk,
} from './activation/interaction.js';

// Shared frontend projections (unitAI-rrdnt.33): the SAME snapshot→wire mapping both
// coordinator surfaces use. One vocabulary, imported not re-implemented — two
// hand-written projections agree until the next field is added, then diverge silently.
export { toActivationView, toActivationResultView, toPendingAskView } from './tools/specialist/activation.tool.js';
export type { ActivationView, ActivationResultView, PendingAskView } from './tools/specialist/activation.tool.js';
export { RuntimeEventPusher, ResultNotValidatedError, completionBody, parseCompletionBody } from './activation/async-events.js';
export type { EventRoute, RuntimeEventPusherOptions } from './activation/async-events.js';

// Canonical forensic store (unitAI-rrdnt.37.1): the SAME observability.db the
// legacy runner and the MCP frontend write. No parallel store (PRD §73/AP).
export {
  createActivationForensicSink,
} from './activation/forensic-sink.js';
export {
  createObservabilitySqliteClientAtPath,
} from './specialist/observability-sqlite.js';
export { resolveObservabilityDbLocation } from './specialist/observability-db.js';

// Bead readiness gate (unitAI-rrdnt.48): the SAME parser and gate the host runs,
// exposed so a frontend can gate an inline dispatch contract BEFORE creating a
// bead — a refused dispatch must leave the board unchanged.
export { evaluateBeadReadiness, extractSections } from './activation/bead-gate.js';
// Build identity for the stale-build refusal (unitAI-rrdnt.55): the single
// source of the identity wording every frontend uses.
export {
  describeBuildIdentity,
  hashFileBytes,
  readBuildId,
  shortBuildId,
  BUILD_ID_BYTES,
  UNKNOWN_BUILD_ID,
} from './activation/build-identity.js';
export type { BeadRecord } from './specialist/beads.js';

// K4 (unitAI-e67up.4): Core K2 launcher-outcome consumer contract surface.
export {
  LAUNCH_OUTCOME_SCHEMA_VERSION,
  LaunchOutcomeError,
  parseLaunchOutcome,
  validateLaunchOutcome,
  projectLaunchOutcome,
} from './specialist/launch-outcome.js';

export {
  readVerifiedCitationWindow,
  verifyExactLineCitation,
} from './specialist/citation-evidence.js';
export type {
  CitationLine,
  VerifiedCitationWindow,
  VerifiedCitationWindowOptions,
  RawPiReadEvidence,
  ExactLineClaim,
  ExactLineCitationResult,
} from './specialist/citation-evidence.js';
export type {
  LaunchOutcome,
  LaunchOutcomeProjection,
  LaunchOutcomeErrorCode,
  LaunchOutcomeAction,
  LaunchOutcomeIdentity,
  LaunchOutcomeReadiness,
  LaunchOutcomeWorktree,
  LaunchOutcomeRuntime,
  LaunchOutcomeSafetyProfile,
  LaunchOutcomeSideEffect,
  LaunchOutcomeMutationRecord,
} from './specialist/launch-outcome.js';

// Coordinator-side workspace fence (unitAI-rrdnt.61). `admitCoordinatorToolCall` is the
// coordinator's admission rule and is deliberately NOT `admitToolCall` — see its docstring for
// why the default on an unleased workspace differs. `leaseScopeFor` turns a cwd into the
// workspace identity both rules key on.
export { admitCoordinatorToolCall } from './activation/workspace-lease.js';
export { leaseScopeFor } from './activation/workspace-reconcile.js';

// Shared refusal renderer (unitAI-t2kol.4): the single gate-outcome shape both
// coordinator surfaces use. MCP imports it; the Pi extension follows (recorded follow-up).
export { renderRejection } from './activation/rejection.js';
export type { RejectionInput } from './activation/rejection.js';
