import type { PiAgentSessionEvent } from '../activation/pi-sdk.js';
import {
  createFinishReasonEvent,
  createMetaEvent,
  createRunCompleteEvent,
  createRunStartEvent,
  createStatusChangeEvent,
  createTokenUsageEvent,
  createTurnSummaryEvent,
  mapCallbackEventToTimelineEvent,
  TIMELINE_EVENT_TYPES,
  type TimelineEvent,
  type TimelineTokenUsage,
} from './timeline-events.js';

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
export const NATIVE_LIFECYCLE_OBSERVABILITY_GAPS = Object.freeze({
  activation_requested: 'Dispatch intent precedes the legacy run_start boundary and has no timeline event.',
  step_contract_compiled: 'Step-contract compilation has no legacy AgentSession event.',
  activation_admitted: 'Admission metadata has no legacy timeline event; identity is projected on specialist_jobs.',
  activation_starting: 'Session construction has no legacy timeline event; run_start follows once construction succeeds.',
  activation_resumed: 'Resume-from-record has no legacy counterpart; the resumed run re-enters the shared stream at turn_start.',
  output_validation_started: 'Native result validation has no legacy timeline event kind.',
  output_validation_passed: 'Native result validation has no legacy timeline event kind.',
  output_validation_failed: 'Native result validation has no legacy timeline event kind; terminal failure is run_complete.',
  activation_disposed: 'In-memory session disposal after a terminal event has no legacy timeline event.',
  lease_acquired: 'Workspace-lease contention has no legacy runner concept; admission identity is projected on specialist_jobs.',
  lease_denied: 'Workspace-lease contention has no legacy runner concept; the refusal itself is run_complete.',
  lease_released: 'Workspace-lease teardown has no legacy timeline event.',
  lease_uncertain: 'Uncertain lease release has no legacy timeline event; reconciliation is operator-visible via specialist_status.',
  lease_reconciled: 'Lease reconciliation has no legacy timeline event.',
  tool_blocked: 'Per-call tool-guard refusal has no legacy timeline event; the turn continues and completion carries the outcome.',
  clarification_requested: 'Peer interaction has no legacy timeline event; interactions persist as files, not timeline rows.',
  clarification_answered: 'Peer interaction has no legacy timeline event; interactions persist as files, not timeline rows.',
  escalation_raised: 'Peer interaction has no legacy timeline event; interactions persist as files, not timeline rows.',
  escalation_resolved: 'Peer interaction has no legacy timeline event; interactions persist as files, not timeline rows.',
  turn_started: 'Suppressed compatibility alias; the raw Pi turn_start event is canonical.',
  turn_completed: 'Suppressed compatibility alias; the raw Pi turn_end event is canonical.',
  retry_started: 'Suppressed compatibility alias; the raw Pi auto_retry_start event is canonical.',
  retry_completed: 'Suppressed compatibility alias; the raw Pi auto_retry_end event is canonical.',
  compaction_started: 'Suppressed compatibility alias; the raw Pi compaction_start event is canonical.',
  compaction_completed: 'Suppressed compatibility alias; the raw Pi compaction_end event is canonical.',
} as const);

/** Pi session signals intentionally omitted from the legacy-compatible timeline. */
export const NATIVE_SESSION_OBSERVABILITY_GAPS = Object.freeze({
  agent_start: 'turn_start is the canonical turn boundary.',
  agent_end: 'run_complete is emitted by the activation lifecycle; agent_end is not a run boundary.',
  agent_settled: 'The lifecycle activation_settled signal projects the waiting status.',
  message_update: 'Only thinking deltas are projected; text is persisted once at assistant message_end.',
  message_user: 'User and custom-message boundaries are not persisted by the legacy timeline mapper.',
  queue_update: 'The legacy runner does not persist Pi prompt-queue state.',
  entry_appended: 'Session transcript persistence is not a timeline event.',
  session_info_changed: 'Session display-name changes are not a timeline event.',
  thinking_level_changed: 'The legacy runner does not persist thinking-level changes.',
  summarization_retry_scheduled: 'The legacy runner has no summarization-retry timeline event.',
  summarization_retry_attempt_start: 'The legacy runner has no summarization-retry timeline event.',
  summarization_retry_finished: 'The legacy runner has no summarization-retry timeline event.',
  bash_execution_update: 'The legacy runner does not persist streaming bash deltas.',
} as const);

function at<T extends TimelineEvent>(event: T, t: number): T {
  return { ...event, t };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function messageRole(event: PiAgentSessionEvent): string | undefined {
  return stringField(record(event.message)?.role);
}

function assistantMessage(event: PiAgentSessionEvent): Record<string, unknown> | undefined {
  const message = record(event.message);
  return message?.role === 'assistant' ? message : undefined;
}

function assistantText(event: PiAgentSessionEvent): string | undefined {
  const message = assistantMessage(event);
  if (!message) return undefined;
  const content = message.content;
  if (typeof content === 'string') return content.trim().length > 0 ? content : undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((item) => {
      const part = record(item);
      return part?.type === 'text' ? stringField(part.text) ?? '' : '';
    })
    .join('');
  return text.trim().length > 0 ? text : undefined;
}

function tokenUsage(event: PiAgentSessionEvent): TimelineTokenUsage | undefined {
  const usage = record(assistantMessage(event)?.usage);
  if (!usage) return undefined;
  const projected: TimelineTokenUsage = {
    input_tokens: numberField(usage.input),
    output_tokens: numberField(usage.output),
    cache_creation_tokens: numberField(usage.cacheWrite),
    cache_read_tokens: numberField(usage.cacheRead),
    reasoning_tokens: numberField(usage.reasoning),
    total_tokens: numberField(usage.totalTokens),
    usage_source: 'provider_usage',
  };
  return Object.values(projected).some(value => typeof value === 'number') ? projected : undefined;
}

function resultContent(result: unknown): string | undefined {
  if (typeof result === 'string') return result;
  const resultRecord = record(result);
  const content = resultRecord?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((item) => {
      if (typeof item === 'string') return item;
      const part = record(item);
      return part?.type === 'text' ? stringField(part.text) ?? '' : '';
    })
    .join('\n');
  return text.trim().length > 0 ? text : undefined;
}

/** Parse the stable trailing sequence from `att:<activation>:N`. */
export function nativeAttemptNo(attemptId: string): number {
  const match = /:(\d+)$/.exec(attemptId);
  if (!match) return 1;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

/** Advance a runtime-owned attempt ID without replacing its identity namespace. */
export function nativeAttemptIdForNo(initialAttemptId: string, attemptNo: number): string {
  const safeAttemptNo = Number.isSafeInteger(attemptNo) && attemptNo > 0 ? attemptNo : 1;
  return /:\d+$/.test(initialAttemptId)
    ? initialAttemptId.replace(/:\d+$/, `:${safeAttemptNo}`)
    : `${initialAttemptId}:${safeAttemptNo}`;
}

/** Map native host lifecycle signals onto existing legacy timeline vocabulary. */
export function mapNativeLifecycleEvent(
  event: NativeLifecycleEvent,
  context: NativeLifecycleProjectionContext,
  t = Date.now(),
): TimelineEvent | null {
  switch (event.name) {
    case 'activation_started':
      return at(createRunStartEvent(event.specialist, event.beadId, {
        job_id: event.activationId,
        specialist_name: event.specialist,
        bead_id: event.beadId,
        worktree_path: context.workspacePath,
      }), t);
    case 'activation_settled':
      return at(createStatusChangeEvent('waiting', 'running'), t);
    case 'activation_completed':
      return at(createRunCompleteEvent('COMPLETE', Math.max(0, t - context.startedAtMs) / 1_000, {
        model: context.resolvedModel,
        backend: context.resolvedModel?.split('/')[0],
        bead_id: event.beadId,
        output: context.output,
        token_usage: context.tokenUsage,
        finish_reason: context.finishReason,
        tool_calls: context.toolCalls,
        final: true,
        metrics: {
          token_usage: context.tokenUsage,
          finish_reason: context.finishReason,
          turns: context.turns,
          tool_calls: context.toolCalls?.length,
          tool_call_names: context.toolCalls,
          auto_retries: context.autoRetries,
          auto_compactions: context.autoCompactions,
        },
      }), t);
    case 'activation_failed':
    case 'activation_rejected':
      return at(createRunCompleteEvent('ERROR', Math.max(0, t - context.startedAtMs) / 1_000, {
        model: context.resolvedModel,
        backend: context.resolvedModel?.split('/')[0],
        bead_id: event.beadId,
        error: stringField(event.payload?.error) ?? stringField(event.payload?.reason),
        output: context.output,
        token_usage: context.tokenUsage,
        finish_reason: context.finishReason,
        tool_calls: context.toolCalls,
        final: true,
      }), t);
    default:
      return null;
  }
}

/**
 * Map a public Pi AgentSession event onto the same timeline events used by legacy `sp run`.
 * One Pi message boundary can produce both the boundary row and the legacy text row.
 */
export function mapNativeSessionEvent(
  event: PiAgentSessionEvent,
  t = Date.now(),
  turnIndex = 0,
): TimelineEvent[] {
  const mapped: TimelineEvent[] = [];
  const add = (timeline: TimelineEvent | null): void => {
    if (timeline) mapped.push(at(timeline, t));
  };

  switch (event.type) {
    case 'turn_start':
      add(mapCallbackEventToTimelineEvent('turn_start', {}));
      break;
    case 'turn_end':
      add(mapCallbackEventToTimelineEvent('turn_end', {}));
      break;
    case 'message_start': {
      const role = messageRole(event);
      if (role === 'assistant') {
        const message = assistantMessage(event);
        const model = stringField(message?.model);
        const provider = stringField(message?.provider);
        if (model || provider) mapped.push(at(createMetaEvent(model ?? 'unknown', provider ?? 'unknown'), t));
        add(mapCallbackEventToTimelineEvent('message_start_assistant', {}));
      }
      if (role === 'toolResult') add(mapCallbackEventToTimelineEvent('message_start_tool_result', {}));
      break;
    }
    case 'message_end': {
      const role = messageRole(event);
      if (role === 'assistant') {
        const text = assistantText(event);
        const usage = tokenUsage(event);
        const finishReason = stringField(assistantMessage(event)?.stopReason);
        if (text) mapped.push({ t, type: TIMELINE_EVENT_TYPES.TEXT, char_count: text.length, content: text });
        add(mapCallbackEventToTimelineEvent('message_end_assistant', {}));
        if (usage) mapped.push(at(createTokenUsageEvent(usage, 'message_done'), t));
        if (finishReason) mapped.push(at(createFinishReasonEvent(finishReason, 'message_done'), t));
        mapped.push(at(createTurnSummaryEvent(turnIndex, usage, finishReason, text), t));
      }
      if (role === 'toolResult') add(mapCallbackEventToTimelineEvent('message_end_tool_result', {}));
      break;
    }
    case 'message_update': {
      const update = record(event.assistantMessageEvent);
      if (update?.type === 'thinking_delta') {
        add(mapCallbackEventToTimelineEvent('thinking', { charCount: stringField(update.delta)?.length }));
      }
      break;
    }
    case 'tool_execution_start':
      add(mapCallbackEventToTimelineEvent('tool_execution_start', {
        tool: stringField(event.toolName),
        toolCallId: stringField(event.toolCallId),
        args: record(event.args),
      }));
      break;
    case 'tool_execution_update':
      add(mapCallbackEventToTimelineEvent('tool_execution_update', {
        tool: stringField(event.toolName),
        toolCallId: stringField(event.toolCallId),
      }));
      break;
    case 'tool_execution_end':
      add(mapCallbackEventToTimelineEvent('tool_execution_end', {
        tool: stringField(event.toolName),
        toolCallId: stringField(event.toolCallId),
        isError: booleanField(event.isError),
        resultContent: resultContent(event.result),
      }));
      break;
    case 'compaction_start':
      add(mapCallbackEventToTimelineEvent('auto_compaction_start', {}));
      break;
    case 'compaction_end': {
      const result = record(event.result);
      add(mapCallbackEventToTimelineEvent('auto_compaction_end', {
        compaction: {
          tokensBefore: numberField(result?.tokensBefore),
          summary: stringField(result?.summary),
          firstKeptEntryId: stringField(result?.firstKeptEntryId),
        },
      }));
      break;
    }
    case 'auto_retry_start':
      add(mapCallbackEventToTimelineEvent('auto_retry_start', {
        retry: {
          attempt: numberField(event.attempt),
          maxAttempts: numberField(event.maxAttempts),
          delayMs: numberField(event.delayMs),
          errorMessage: stringField(event.errorMessage),
        },
      }));
      break;
    case 'auto_retry_end':
      add(mapCallbackEventToTimelineEvent('auto_retry_end', {
        retry: {
          attempt: numberField(event.attempt),
          errorMessage: stringField(event.finalError),
        },
      }));
      break;
    default:
      break;
  }

  return mapped;
}
