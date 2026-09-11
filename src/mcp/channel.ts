/**
 * Claude Code Channel push — the deterministic replacement for the `.21` poller
 * (unitAI-aiwva.21).
 *
 * Claude Code registers an inbound listener for `notifications/claude/channel`
 * when a connected MCP server declares `experimental: { 'claude/channel': {} }`.
 * The notification is unsolicited: it reaches a session that is idle, which no
 * tool result can do and which is the entire reason this module exists. The
 * host already emits every transition in-process, so nothing here polls, and
 * nothing here wakes the model except on a real event.
 *
 * Three properties decide the shape, and each is enforced rather than assumed:
 *
 *   - **The push is a REFERENCE, never the payload.** `content` names the
 *     activation and says to call `specialist_status`; the result, contract and
 *     transcript stay in the authority store. A channel frame is rendered
 *     straight into the session's context, so a body here is an unbounded
 *     context cost paid on an event the reader may not care about (spec AD/AA).
 *   - **Delivery is unacknowledged and gated eight ways.** Capability, protocol
 *     era, provider, feature flag, org policy, `--channels` membership,
 *     marketplace match and plugin allowlist — each failing gate is a SILENT
 *     no-op on the client. So this is delivery, never authority: the hook and
 *     `specialist_status` recovery paths stay exactly as they are.
 *   - **Only a legacy-era connection can carry it.** Claude Code refuses to
 *     register the listener when the connection negotiated 2026-07-28,
 *     reporting "connection negotiated a modern protocol revision with no
 *     unsolicited notification path". Stateless means no server-initiated
 *     frame. `serveStdio({ legacy: 'serve' })` is therefore a PRECONDITION for
 *     push, not a compatibility concession — see the era note in
 *     `docs/claude-native-integration-spec-2026-09-09.md`.
 *
 * Verified against the Claude Code 2.1.268 binary, not documentation: the gate
 * chain, the frame shape and the meta-key filter below are what that build
 * actually enforces.
 */
import type { ActivationForensicSink } from '../activation/native-host.js';
import { logger } from '../utils/logger.js';

/**
 * Declared in the server's capabilities. Presence of this key is what registers
 * the channel listener on Claude's side; the value is intentionally empty.
 */
export const CHANNEL_CAPABILITY = { 'claude/channel': {} } as const;

/** The notification method Claude Code listens for. */
export const CHANNEL_METHOD = 'notifications/claude/channel';

/**
 * Claude Code drops meta keys that fail this pattern, with a warning on its
 * side that a server author never sees. Keys are validated here so a malformed
 * one is a visible local failure instead of a silent remote omission.
 */
const META_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Host forensic events that mean a coordinator has something to act on, mapped
 * to the event class carried in the push.
 *
 * Deliberately narrow. Every other forensic name — turn boundaries, retries,
 * compaction, lease acquisition — is progress, not an actionable transition,
 * and pushing progress into an idle session is the token cost this module was
 * built to remove.
 */
const PUSHED_EVENTS: Readonly<Record<string, string>> = {
  activation_settled: 'completed',
  activation_failed: 'failed',
  escalation_raised: 'escalation',
  clarification_requested: 'needs_reply',
};

/** What a coordinator is told to do about each class. One line, no result body. */
const ACTION: Readonly<Record<string, string>> = {
  completed: 'Call specialist_status for the authoritative result.',
  failed: 'Call specialist_status for the authoritative failure detail.',
  escalation: 'Call specialist_status to read the escalation, then specialist_reply.',
  needs_reply: 'Call specialist_status to read the pending ask and message_id, then specialist_reply.',
};

export interface ChannelFrame {
  method: typeof CHANNEL_METHOD;
  params: { content: string; meta: Record<string, string> };
}

/** Sends one frame. Returns/throws are the caller's problem, never the host's. */
export type ChannelSend = (frame: ChannelFrame) => void | Promise<unknown>;

/**
 * Build the frame for one transition.
 *
 * Exported so a test can assert the reference-only discipline directly: the
 * frame is a pure function of the identity fields, and there is no parameter
 * through which a result body could reach it.
 */
export function buildChannelFrame(input: {
  activationId: string;
  specialist: string;
  beadId?: string;
  eventClass: string;
}): ChannelFrame {
  const meta: Record<string, string> = {
    activation_id: input.activationId,
    specialist: input.specialist,
    event: input.eventClass,
    read_with: 'specialist_status',
  };
  if (input.beadId) meta.bead_id = input.beadId;

  for (const key of Object.keys(meta)) {
    // Unreachable with the literals above; it guards the next key someone adds.
    if (!META_KEY.test(key)) throw new Error(`channel meta key "${key}" fails ${META_KEY.source}`);
  }

  const work = input.beadId ? ` on ${input.beadId}` : '';
  const action = ACTION[input.eventClass] ?? 'Call specialist_status for authoritative state.';
  return {
    method: CHANNEL_METHOD,
    params: {
      content: `Specialist ${input.specialist}${work}: ${input.eventClass} (${input.activationId}). ${action}`,
      meta,
    },
  };
}

/**
 * Wrap a forensic sink so actionable transitions also push a channel frame.
 *
 * Composition rather than a second sink parameter on the host: the host already
 * emits exactly these events to exactly one sink, so the push rides the stream
 * that exists instead of introducing an event bus for a producer and consumer
 * that share a process.
 *
 * Failure-isolated in both directions. A send that throws or rejects is logged
 * and dropped — an undeliverable push loses nothing, because the authority
 * store was written before the event was emitted and `specialist_status` still
 * answers. Letting a transport error escape would make a cosmetic notification
 * able to fail an activation.
 */
export function withChannelPush(base: ActivationForensicSink, send: ChannelSend): ActivationForensicSink {
  return {
    ...base,
    emit(event) {
      base.emit(event);

      const eventClass = PUSHED_EVENTS[event.name];
      if (!eventClass) return;

      try {
        const frame = buildChannelFrame({
          activationId: event.activationId,
          specialist: event.specialist,
          ...(event.beadId ? { beadId: event.beadId } : {}),
          eventClass,
        });
        void Promise.resolve(send(frame)).catch((error: unknown) => {
          logger.debug(`channel push dropped (${eventClass}): ${String(error)}`);
        });
      } catch (error) {
        logger.debug(`channel push not built (${eventClass}): ${String(error)}`);
      }
    },
  };
}
