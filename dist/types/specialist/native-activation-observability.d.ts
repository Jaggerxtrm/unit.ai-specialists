import type { PiAgentSessionEvent } from '../activation/pi-sdk.js';
import { type TimelineEvent, type TimelineTokenUsage } from './timeline-events.js';
export interface NativeLifecycleEvent {
    activationId: string;
    specialist: string;
    beadId?: string;
    name: string;
    payload?: Record<string, unknown>;
}
export interface NativeLifecycleProjectionContext {
    startedAtMs: number;
    workspacePath?: string;
    resolvedModel?: string;
    output?: string;
    tokenUsage?: TimelineTokenUsage;
    finishReason?: string;
    toolCalls?: string[];
    turns?: number;
    autoRetries?: number;
    autoCompactions?: number;
}
/**
 * Native host lifecycle signals with no legacy timeline counterpart.
 *
 * They remain represented by the job status projection where applicable. They are not
 * persisted as `activation.*` forensic names because that would retain the parallel event
 * vocabulary which Phase 7 removes.
 *
 * Two different debts live here — see the bead notes for the per-name accounting:
 * native-only concepts with no legacy equivalent (lease, interaction, validation,
 * resume — out of scope by NON_GOALS, "does not add event kinds beyond parity") and
 * translated aliases whose canonical producer is the raw Pi event stream.
 */
export declare const NATIVE_LIFECYCLE_OBSERVABILITY_GAPS: Readonly<{
    readonly activation_requested: "Dispatch intent precedes the legacy run_start boundary and has no timeline event.";
    readonly step_contract_compiled: "Step-contract compilation has no legacy AgentSession event.";
    readonly activation_admitted: "Admission metadata has no legacy timeline event; identity is projected on specialist_jobs.";
    readonly activation_starting: "Session construction has no legacy timeline event; run_start follows once construction succeeds.";
    readonly activation_resumed: "Resume-from-record has no legacy counterpart; the resumed run re-enters the shared stream at turn_start.";
    readonly output_validation_started: "Native result validation has no legacy timeline event kind.";
    readonly output_validation_passed: "Native result validation has no legacy timeline event kind.";
    readonly output_validation_failed: "Native result validation has no legacy timeline event kind; terminal failure is run_complete.";
    readonly activation_disposed: "In-memory session disposal after a terminal event has no legacy timeline event.";
    readonly lease_released: "Workspace-lease teardown has no legacy timeline event.";
    readonly lease_reconciled: "Lease reconciliation has no legacy timeline event.";
    readonly clarification_requested: "Peer interaction has no legacy timeline event; interactions persist as files, not timeline rows.";
    readonly clarification_answered: "Peer interaction has no legacy timeline event; interactions persist as files, not timeline rows.";
    readonly escalation_raised: "Peer interaction has no legacy timeline event; interactions persist as files, not timeline rows.";
    readonly escalation_resolved: "Peer interaction has no legacy timeline event; interactions persist as files, not timeline rows.";
    readonly turn_started: "Suppressed compatibility alias; the raw Pi turn_start event is canonical.";
    readonly turn_completed: "Suppressed compatibility alias; the raw Pi turn_end event is canonical.";
    readonly retry_started: "Suppressed compatibility alias; the raw Pi auto_retry_start event is canonical.";
    readonly retry_completed: "Suppressed compatibility alias; the raw Pi auto_retry_end event is canonical.";
    readonly compaction_started: "Suppressed compatibility alias; the raw Pi compaction_start event is canonical.";
    readonly compaction_completed: "Suppressed compatibility alias; the raw Pi compaction_end event is canonical.";
}>;
/** Pi session signals intentionally omitted from the legacy-compatible timeline. */
export declare const NATIVE_SESSION_OBSERVABILITY_GAPS: Readonly<{
    readonly agent_start: "turn_start is the canonical turn boundary.";
    readonly agent_end: "run_complete is emitted by the activation lifecycle; agent_end is not a run boundary.";
    readonly agent_settled: "The lifecycle activation_settled signal projects the waiting status.";
    readonly message_update: "Only thinking deltas are projected; text is persisted once at assistant message_end.";
    readonly message_user: "User and custom-message boundaries are not persisted by the legacy timeline mapper.";
    readonly queue_update: "The legacy runner does not persist Pi prompt-queue state.";
    readonly entry_appended: "Session transcript persistence is not a timeline event.";
    readonly session_info_changed: "Session display-name changes are not a timeline event.";
    readonly thinking_level_changed: "The legacy runner does not persist thinking-level changes.";
    readonly summarization_retry_scheduled: "The legacy runner has no summarization-retry timeline event.";
    readonly summarization_retry_attempt_start: "The legacy runner has no summarization-retry timeline event.";
    readonly summarization_retry_finished: "The legacy runner has no summarization-retry timeline event.";
    readonly bash_execution_update: "The legacy runner does not persist streaming bash deltas.";
}>;
/** Parse the stable trailing sequence from `att:<activation>:N`. */
export declare function nativeAttemptNo(attemptId: string): number;
/** Advance a runtime-owned attempt ID without replacing its identity namespace. */
export declare function nativeAttemptIdForNo(initialAttemptId: string, attemptNo: number): string;
/** Map native host lifecycle signals onto existing legacy timeline vocabulary. */
export declare function mapNativeLifecycleEvent(event: NativeLifecycleEvent, context: NativeLifecycleProjectionContext, t?: number): TimelineEvent | null;
/**
 * Map a public Pi AgentSession event onto the same timeline events used by legacy `sp run`.
 * One Pi message boundary can produce both the boundary row and the legacy text row.
 */
export declare function mapNativeSessionEvent(event: PiAgentSessionEvent, t?: number, turnIndex?: number): TimelineEvent[];
//# sourceMappingURL=native-activation-observability.d.ts.map