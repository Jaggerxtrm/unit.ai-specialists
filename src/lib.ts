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

// ── Native activation seam (unitAI-rrdnt.37) ─────────────────────────────────
// One host process-lifetime per coordinator surface; both frontends and a future
// Chain scheduler construct the same `ActivationRequest` against it.

export { NativeActivationHost } from './activation/native-host.js';
export type { NativeActivationHostDeps, ActivationForensicSink, ActivationAttachment } from './activation/native-host.js';

export { DispatchRejectedError } from './activation/types.js';
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
export { toActivationView, toPendingAskView } from './tools/specialist/activation.tool.js';
export type { ActivationView, PendingAskView } from './tools/specialist/activation.tool.js';

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
