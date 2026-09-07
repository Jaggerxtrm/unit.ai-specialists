export { runScriptSpecialist as runScript, } from './specialist/script-runner.js';
export type { ScriptGenerateRequest, ScriptGenerateResult, ScriptGenerateSuccess, ScriptGenerateFailure, ScriptSpecialistErrorType, ScriptRunnerOptions, } from './specialist/script-runner.js';
export { SpecialistLoader } from './specialist/loader.js';
export type { Specialist } from './specialist/schema.js';
export { NativeActivationHost } from './activation/native-host.js';
export type { NativeActivationHostDeps, ActivationForensicSink, ActivationAttachment } from './activation/native-host.js';
export { DispatchRejectedError } from './activation/types.js';
export type { ActivationId, ActivationRequest, ActivationResult, ActivationSnapshot, ActivationState, ActivationHandle, AttemptId, ParticipantId, PiSessionId, WorkspaceAccess, WorkspaceIdentity, } from './activation/types.js';
export type { DeliveryState, InteractionKind, InteractionMessage, MessageId, PendingAsk, } from './activation/interaction.js';
export { toActivationView, toPendingAskView } from './tools/specialist/activation.tool.js';
export type { ActivationView, PendingAskView } from './tools/specialist/activation.tool.js';
export { LAUNCH_OUTCOME_SCHEMA_VERSION, LaunchOutcomeError, parseLaunchOutcome, validateLaunchOutcome, projectLaunchOutcome, } from './specialist/launch-outcome.js';
export { readVerifiedCitationWindow, verifyExactLineCitation, } from './specialist/citation-evidence.js';
export type { CitationLine, VerifiedCitationWindow, VerifiedCitationWindowOptions, RawPiReadEvidence, ExactLineClaim, ExactLineCitationResult, } from './specialist/citation-evidence.js';
export type { LaunchOutcome, LaunchOutcomeProjection, LaunchOutcomeErrorCode, LaunchOutcomeAction, LaunchOutcomeIdentity, LaunchOutcomeReadiness, LaunchOutcomeWorktree, LaunchOutcomeRuntime, LaunchOutcomeSafetyProfile, LaunchOutcomeSideEffect, LaunchOutcomeMutationRecord, } from './specialist/launch-outcome.js';
//# sourceMappingURL=lib.d.ts.map