/**
 * Native-activation adapter for the canonical Specialists observability pipeline.
 *
 * Native and legacy activations write one `observability.db`. Native events are projected
 * onto the existing timeline vocabulary, written through the same append-event writer
 * (which mirrors every timeline row into `specialist_forensic_events`), and carry the
 * full v15 identity lineage. There is deliberately NO native-subagent telemetry database
 * and no second forensic model: a native activation and a legacy one are answerable by
 * one query against one store.
 *
 * Producer rule: raw Pi events enter through `sessionEvent` and are the sole producers of
 * turn, message, tool, retry, and compaction timeline rows. The host's legacy translated
 * `emit` aliases remain status-only to avoid duplicate rows. `activation_settled` stays on
 * `emit` and is the sole producer of the waiting status-change row.
 */

import type { ActivationForensicSink, NativeActivationSessionEventInput } from './native-host.js';
import {
  mapNativeLifecycleEvent,
  mapNativeSessionEvent,
  nativeAttemptIdForNo,
  nativeAttemptNo,
} from '../specialist/native-activation-observability.js';
import type {
  ObservabilityIdentityProjection,
  ObservabilitySqliteClient,
} from '../specialist/observability-sqlite.js';
import {
  TIMELINE_EVENT_TYPES,
  type TimelineEvent,
  type TimelineTokenUsage,
} from '../specialist/timeline-events.js';
import type { SupervisorJobStatus, SupervisorStatus } from '../specialist/supervisor.js';

interface ActivationProjectionState {
  initialAttemptId: string;
  attemptId: string;
  attemptNo: number;
  specialist: string;
  beadId?: string;
  startedAtMs: number;
  lastEventAtMs: number;
  status: SupervisorJobStatus;
  workspacePath?: string;
  piSessionId?: string;
  resolvedModel?: string;
  latestOutput?: string;
  tokenUsage?: TimelineTokenUsage;
  finishReason?: string;
  toolCalls: string[];
  turns: number;
  autoRetries: number;
  autoCompactions: number;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function statusForLifecycle(name: string, current: SupervisorJobStatus): SupervisorJobStatus {
  switch (name) {
    case 'activation_requested':
    case 'activation_admitted':
    case 'activation_starting':
      return 'starting';
    case 'activation_started':
    case 'activation_resumed':
    case 'turn_started':
      return 'running';
    case 'activation_settled':
      return 'waiting';
    case 'activation_completed':
      return 'done';
    case 'activation_failed':
    case 'activation_rejected':
    case 'output_validation_failed':
      return 'error';
    default:
      return current;
  }
}

function statusForSessionEvent(type: string, current: SupervisorJobStatus): SupervisorJobStatus {
  if (type === 'agent_start' || type === 'turn_start') return 'running';
  if (type === 'agent_settled') return 'waiting';
  return current;
}

function identityOf(state: ActivationProjectionState): ObservabilityIdentityProjection {
  return { attemptId: state.attemptId, attemptNo: state.attemptNo };
}

function statusOf(
  activationId: string,
  state: ActivationProjectionState,
  currentEvent: string | undefined,
  error?: string,
): SupervisorStatus {
  const elapsedMs = Math.max(0, state.lastEventAtMs - state.startedAtMs);
  return {
    id: activationId,
    specialist: state.specialist,
    status: state.status,
    current_event: currentEvent,
    model: state.resolvedModel,
    backend: state.resolvedModel?.split('/')[0],
    started_at_ms: state.startedAtMs,
    elapsed_s: elapsedMs / 1_000,
    last_event_at_ms: state.lastEventAtMs,
    bead_id: state.beadId,
    session_id: state.piSessionId,
    worktree_path: state.workspacePath,
    metrics: {
      token_usage: state.tokenUsage,
      finish_reason: state.finishReason,
      turns: state.turns,
      tool_calls: state.toolCalls.length,
      tool_call_names: state.toolCalls,
      auto_compactions: state.autoCompactions,
      auto_retries: state.autoRetries,
    },
    error,
  };
}

function newProjectionState(input: {
  attemptId: string;
  specialist: string;
  beadId?: string;
  startedAtMs: number;
}): ActivationProjectionState {
  return {
    initialAttemptId: input.attemptId,
    attemptId: input.attemptId,
    attemptNo: nativeAttemptNo(input.attemptId),
    specialist: input.specialist,
    beadId: input.beadId,
    startedAtMs: input.startedAtMs,
    lastEventAtMs: input.startedAtMs,
    status: 'starting',
    toolCalls: [],
    turns: 0,
    autoRetries: 0,
    autoCompactions: 0,
  };
}

/**
 * Build a failure-isolated sink backed by the shared timeline/forensic writer.
 *
 * `null` remains a true no-op. A database failure is diagnostic loss and must never change
 * native activation behavior.
 */
export function createActivationForensicSink(
  observability: ObservabilitySqliteClient | null,
): ActivationForensicSink {
  if (!observability) return { emit: () => {}, sessionEvent: () => {} };

  const states = new Map<string, ActivationProjectionState>();

  const writeProjection = (
    activationId: string,
    state: ActivationProjectionState,
    currentEvent: string | undefined,
    timelineEvents: readonly TimelineEvent[],
    error?: string,
  ): void => {
    const status = statusOf(activationId, state, currentEvent, error);
    if (timelineEvents.length > 0) {
      observability.upsertStatusWithEvents(status, timelineEvents, identityOf(state));
    } else {
      observability.upsertStatus(status, identityOf(state));
    }
  };

  return {
    emit(event) {
      try {
        const now = Date.now();
        const existing = states.get(event.activationId);
        const state: ActivationProjectionState = existing ?? newProjectionState({
          attemptId: event.attemptId,
          specialist: event.specialist,
          beadId: event.beadId,
          startedAtMs: now,
        });

        state.lastEventAtMs = now;
        state.status = statusForLifecycle(event.name, state.status);
        state.workspacePath = stringValue(event.payload?.workspace) ?? state.workspacePath;
        state.piSessionId = stringValue(event.payload?.pi_session_id) ?? state.piSessionId;
        state.resolvedModel = stringValue(event.payload?.resolved_model) ?? state.resolvedModel;
        states.set(event.activationId, state);

        const error = stringValue(event.payload?.error) ?? stringValue(event.payload?.reason);
        const timelineEvent = mapNativeLifecycleEvent(event, {
          startedAtMs: state.startedAtMs,
          workspacePath: state.workspacePath,
          resolvedModel: state.resolvedModel,
          output: state.latestOutput,
          tokenUsage: state.tokenUsage,
          finishReason: state.finishReason,
          toolCalls: state.toolCalls,
          turns: state.turns,
          autoRetries: state.autoRetries,
          autoCompactions: state.autoCompactions,
        }, now);
        writeProjection(
          event.activationId,
          state,
          timelineEvent?.type,
          timelineEvent ? [timelineEvent] : [],
          error,
        );

        if (event.name === 'activation_disposed') states.delete(event.activationId);
      } catch {
        // Never let an observability write failure abort an activation.
      }
    },

    sessionEvent(input: NativeActivationSessionEventInput) {
      try {
        const now = Date.now();
        const existing = states.get(input.activationId);
        const state: ActivationProjectionState = existing ?? newProjectionState({
          attemptId: input.attemptId,
          specialist: input.specialist,
          beadId: input.beadId,
          startedAtMs: now,
        });

        if (input.event.type === 'auto_retry_start') {
          state.attemptNo += 1;
          state.attemptId = nativeAttemptIdForNo(state.initialAttemptId, state.attemptNo);
          state.autoRetries += 1;
        }
        if (input.event.type === 'turn_start') state.turns += 1;
        if (input.event.type === 'compaction_start') state.autoCompactions += 1;
        state.lastEventAtMs = now;
        state.status = statusForSessionEvent(input.event.type, state.status);
        // The host passes `snapshot.piSessionId ?? ''` before a session exists; a blank
        // must never clear an identity the status row already carries.
        if (stringValue(input.piSessionId)) state.piSessionId = input.piSessionId;
        state.workspacePath = input.workspacePath;
        states.set(input.activationId, state);

        const timelineEvents = mapNativeSessionEvent(input.event, now, state.turns);
        for (const timelineEvent of timelineEvents) {
          if (timelineEvent.type === TIMELINE_EVENT_TYPES.TEXT && typeof timelineEvent.content === 'string') {
            state.latestOutput = timelineEvent.content;
          }
          if (timelineEvent.type === TIMELINE_EVENT_TYPES.TOKEN_USAGE) state.tokenUsage = timelineEvent.token_usage;
          if (timelineEvent.type === TIMELINE_EVENT_TYPES.FINISH_REASON) state.finishReason = timelineEvent.finish_reason;
          if (timelineEvent.type === TIMELINE_EVENT_TYPES.TOOL && timelineEvent.phase === 'end') {
            state.toolCalls.push(timelineEvent.tool);
          }
        }
        writeProjection(input.activationId, state, timelineEvents.at(-1)?.type, timelineEvents);
      } catch {
        // Never let an observability write failure abort an activation.
      }
    },
  };
}
