/**
 * The seam between the participant protocol and the Claude peer channel — PRD Phase 14
 * groundwork, acceptance AX (unitAI-rrdnt.30).
 *
 * `InteractionTransport` owns the vocabulary; `PeerAdapter` owns the wire. Neither knows
 * about the other, and that is deliberate: the peer channel is a *serialisation* of
 * `InteractionMessage` (PRD invariant BH), not a second protocol. This module is the only
 * place the two meet, so a future MCP transport plugs in beside it rather than teaching
 * either side a new vocabulary.
 *
 * Two things this bridge must not do, both of which look like simplifications:
 *
 *   - It must not make the ask wait on the socket. The wait belongs to the durable store,
 *     which is what makes a pushed question and a polled question indistinguishable to the
 *     Specialist. A coordinator that never saw the push and answered through
 *     `specialist_status` resolves the ask on exactly the same path.
 *   - It must not report delivery from the absence of an error. Claude Code emits no
 *     receipt to a peer sender (docs/design/claude-transport-decision.md §5.1), so `push`
 *     returns `no_receipt` on the happy path and the ask stays `pending` until a correlated
 *     reply arrives. `pending` is the honest state, not a degraded one.
 */

import { PeerAdapter, type PushResult } from './transport/peer-adapter.js';
import { readReply } from './transport/pending-store.js';
import type { InteractionMessage, InteractionTransport } from './interaction.js';

export interface PeerBridgeOptions {
  /**
   * Resolved at call time, not at wiring time.
   *
   * The host builds this hook inside the same expression that constructs the transport it
   * routes replies through, because `deliver` can only be supplied to the constructor. A
   * direct reference would capture `undefined` and every reply would be dropped silently —
   * the ask would simply never resolve, which reads as a slow coordinator rather than a bug.
   */
  transport: () => InteractionTransport;
  adapter: PeerAdapter;
  repoRoot: string;
  /** The coordinator's Claude session id — the only stable address on this channel. */
  coordinatorSessionId: string;
  /** How long an outstanding ask is watched for a reply. */
  replyTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Reported to the host for forensics; never used to decide anything. */
  onPush?: (message: InteractionMessage, result: PushResult) => void;
  onReplyRouted?: (message: InteractionMessage, reply: InteractionMessage) => void;
}

/** Default watch window. Deliberately long: an unanswered question is an operator state. */
const DEFAULT_REPLY_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 500;

/**
 * Wire a transport to the peer channel and return its `deliver` hook.
 *
 * Pass the result as `InteractionTransport`'s `deliver`. It pushes every message and, for
 * the kinds that expect an answer, watches the durable store and routes the reply back
 * through the transport so the blocked `request()` resolves and the Specialist resumes in
 * the same session.
 */
export function createPeerDelivery(options: PeerBridgeOptions) {
  const {
    transport, adapter, repoRoot, coordinatorSessionId,
    replyTimeoutMs = DEFAULT_REPLY_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    onPush, onReplyRouted,
  } = options;

  const watched = new Set<string>();

  const watchForReply = (message: InteractionMessage): void => {
    // One watcher per message. A second one would race itself into a duplicate reply,
    // which the transport rejects as uncorrelated — a confusing way to learn about a bug
    // that is really about bookkeeping here.
    if (watched.has(message.messageId)) return;
    watched.add(message.messageId);

    const deadline = Date.now() + replyTimeoutMs;
    const tick = async (): Promise<void> => {
      if (Date.now() > deadline) { watched.delete(message.messageId); return; }

      const stored = readReply(repoRoot, message.activationId, message.messageId);
      if (!stored) { setTimeout(() => void tick(), pollIntervalMs).unref?.(); return; }

      watched.delete(message.messageId);
      try {
        const reply = await transport().send({
          kind: 'reply',
          from: message.to,
          to: message.from,
          activationId: message.activationId,
          attemptId: message.attemptId,
          body: bodyOf(stored.body),
          inReplyTo: message.messageId,
        });
        onReplyRouted?.(message, reply);
      } catch {
        // The transport refused the correlation — the ask was already answered by another
        // route. That is the polling path winning the race, which is a correct outcome and
        // not something to retry: the Specialist has its answer either way.
      }
    };

    setTimeout(() => void tick(), pollIntervalMs).unref?.();
  };

  return async (message: InteractionMessage): Promise<boolean> => {
    const result = await adapter.push({
      messageId: message.messageId,
      activationId: message.activationId,
      kind: message.kind,
      message,
      body: message.body,
      coordinatorSessionId,
    });
    onPush?.(message, result);

    if (message.kind === 'question' || message.kind === 'escalation') watchForReply(message);

    // Only an explicit receipt is delivery. On this transport that never happens, so this
    // is `false` in practice and the ask reads as `pending` until a reply confirms it.
    return result.outcome === 'delivered';
  };
}

/** A stored reply is the opaque payload the coordinator wrote; take its body if it has one. */
function bodyOf(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
    const body = (payload as { body?: unknown }).body;
    if (typeof body === 'string') return body;
  }
  return String(payload ?? '');
}
