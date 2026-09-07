/**
 * InteractionMessage and the direct participant transport — PRD Phase 5.
 *
 * This is the ONE semantic participant protocol (PRD invariant BH). The Claude Code MCP
 * surface and the peer channel are serialisations of this type, never second vocabularies.
 * That constraint is the reason this module exists at all: two transports that each invent
 * their own message shape produce a system where "did the Specialist ask something?" has
 * two answers, and the second vocabulary is effectively unremovable once anything depends
 * on it.
 *
 * Three properties are load-bearing and each has a test:
 *
 *   - **Correlation is by id, never by ordering.** Two asks can be outstanding at once;
 *     a transport that matches replies positionally silently crosses them.
 *   - **Asking does not kill the child** (PRD invariant 7). A blocking request suspends
 *     the asker; the Specialist stays alive and resumable.
 *   - **No silent loss** (PRD §30). A message that cannot be delivered becomes readable
 *     pending state rather than disappearing.
 *
 * Deliberately NOT here: any transport that leaves the process, any persistence, and any
 * notion of who is allowed to answer. Delivery over MCP or the peer channel is
 * unitAI-rrdnt.12 and PRD Phase 13/14; this module defines what they carry.
 */

import { randomUUID } from 'node:crypto';
import type { ActivationId, AttemptId, ParticipantId, PiSessionId } from './types.js';

/** Message id. Distinct from every activation identity — a message is not a participant. */
export type MessageId = string;

/**
 * What a message is for.
 *
 * `question` and `escalation` both expect an answer and both leave the child alive; they
 * differ in who is expected to resolve them, which is why they are not one kind with a
 * severity flag.
 */
export type InteractionKind =
  | 'question'
  | 'escalation'
  | 'finding'
  | 'completion'
  | 'reply'
  | 'instruction';

/** Delivery state. `pending` is the state a lost message degrades INTO, never out of. */
export type DeliveryState = 'pending' | 'delivered' | 'refused';

/**
 * One message between participants.
 *
 * Identity carries all three lineage layers, so a message can be attributed to the exact
 * attempt that produced it — the distinction the v15 identity migration made queryable.
 */
export interface InteractionMessage {
  messageId: MessageId;
  kind: InteractionKind;

  from: ParticipantId;
  to: ParticipantId;

  activationId: ActivationId;
  attemptId: AttemptId;

  /**
   * The physical session that produced this message, when one exists.
   *
   * Correlation metadata, never identity (`types.ts`). It is on the message rather than
   * derived by the reader because a pushed event leaves this process: a coordinator that
   * received a completion over the peer channel has no registry to look the session up in,
   * and PRD acceptance AY requires the full lineage to survive the push.
   */
  piSessionId?: PiSessionId;

  /** Set on a `reply`: the message this answers. The ONLY correlation mechanism. */
  inReplyTo?: MessageId;

  body: string;
  createdAt: number;
}

/** A question or escalation awaiting an answer. */
export interface PendingAsk {
  message: InteractionMessage;
  /** `delivered` means a receipt was seen — never merely "no error was thrown". */
  delivery: DeliveryState;
  askedAt: number;
}

export interface InteractionTransportOptions {
  now?: () => number;
  newId?: () => MessageId;
  /**
   * Attempts delivery. Returning false (or throwing) leaves the message pending rather
   * than losing it. Absence of an error is NOT a receipt: only `true` marks delivered.
   */
  deliver?: (message: InteractionMessage) => boolean | Promise<boolean>;
}

export interface SendInput {
  kind: InteractionKind;
  from: ParticipantId;
  to: ParticipantId;
  activationId: ActivationId;
  attemptId: AttemptId;
  piSessionId?: PiSessionId;
  body: string;
  inReplyTo?: MessageId;
}

/** Thrown when a reply cites a message that was never asked, or was already answered. */
export class UncorrelatedReplyError extends Error {
  constructor(public readonly inReplyTo: MessageId | undefined) {
    super(
      inReplyTo
        ? `reply cites unknown or already-answered message "${inReplyTo}"`
        : 'reply carries no inReplyTo — replies must be correlated by id, never by ordering',
    );
    this.name = 'UncorrelatedReplyError';
  }
}

/**
 * In-process transport between a parent and its children.
 *
 * One instance serves a whole activation tree; participants are addressed by
 * `ParticipantId`, so the transport has no notion of "the" parent and a future scheduler
 * can drive it without being one.
 */
export class InteractionTransport {
  private readonly now: () => number;
  private readonly newId: () => MessageId;
  private readonly deliver?: (message: InteractionMessage) => boolean | Promise<boolean>;

  private readonly pending = new Map<MessageId, PendingAsk>();
  private readonly waiters = new Map<MessageId, (reply: InteractionMessage) => void>();
  /** Replies already delivered, so a waiter registered late still resolves. */
  private readonly answered = new Map<MessageId, InteractionMessage>();
  private readonly log: InteractionMessage[] = [];

  constructor(options: InteractionTransportOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? (() => `msg:${randomUUID().slice(0, 12)}`);
    this.deliver = options.deliver;
  }

  /**
   * Send one message. Never throws on delivery failure.
   *
   * An ask that cannot be delivered is still registered as pending, because the alternative
   * — failing the send — loses the question. The asker learns delivery state by reading
   * `pendingAsks()`, not from the return of this call.
   */
  async send(input: SendInput, messageId?: MessageId): Promise<InteractionMessage> {
    if (input.kind === 'reply') return this.reply(input);

    const message = this.compose(input, messageId);
    this.log.push(message);

    const expectsAnswer = message.kind === 'question' || message.kind === 'escalation';
    if (expectsAnswer) {
      this.pending.set(message.messageId, {
        message,
        delivery: 'pending',
        askedAt: message.createdAt,
      });
    }

    const delivered = await this.attemptDelivery(message);
    const ask = this.pending.get(message.messageId);
    if (ask) ask.delivery = delivered ? 'delivered' : 'pending';

    return message;
  }

  /**
   * Ask and wait for the answer.
   *
   * Suspends the CALLER, not the Specialist: the child stays alive and resumable while its
   * question is outstanding (PRD invariant 7). There is deliberately no timeout — an
   * unanswered question is a state an operator resolves, not an error the runtime invents.
   *
   * The waiter is registered against a pre-allocated id BEFORE the send, never after.
   * Registering afterwards loses any reply that arrives while the send is still in flight
   * — a fast or synchronous responder would answer into no waiter and the asker would
   * block forever. That is silent loss of exactly the kind §30 forbids, and it is a race
   * a test only catches if the reply can outrun the send.
   */
  async request(
    input: Omit<SendInput, 'kind' | 'inReplyTo'> & { kind?: 'question' | 'escalation' },
  ): Promise<InteractionMessage> {
    const messageId = this.newId();
    const waited = new Promise<InteractionMessage>((resolve) => {
      this.waiters.set(messageId, resolve);
    });

    await this.send({ ...input, kind: input.kind ?? 'question' }, messageId);

    const early = this.answered.get(messageId);
    if (early) {
      this.waiters.delete(messageId);
      this.answered.delete(messageId);
      return early;
    }
    return waited;
  }

  /** Answer an outstanding ask. Correlation is by `inReplyTo` and nothing else. */
  private async reply(input: SendInput): Promise<InteractionMessage> {
    const target = input.inReplyTo;
    if (!target || !this.pending.has(target)) throw new UncorrelatedReplyError(target);

    const message = this.compose(input);
    this.log.push(message);

    this.pending.delete(target);
    const waiter = this.waiters.get(target);
    if (waiter) {
      this.waiters.delete(target);
      waiter(message);
    }
    this.answered.set(target, message);

    await this.attemptDelivery(message);
    return message;
  }

  /** Every ask still awaiting an answer, oldest first. */
  pendingAsks(participantId?: ParticipantId): PendingAsk[] {
    const asks = [...this.pending.values()]
      .filter(ask => !participantId || ask.message.from === participantId || ask.message.to === participantId);
    return asks.sort((a, b) => a.askedAt - b.askedAt);
  }

  /**
   * Whether a participant needs someone to act.
   *
   * Attention is derived from outstanding asks rather than stored, so it cannot drift out
   * of agreement with the asks themselves.
   */
  attention(participantId: ParticipantId): boolean {
    return [...this.pending.values()].some(ask => ask.message.to === participantId);
  }

  /** The activation state an outstanding ask implies, for the Fleet projection. */
  impliedState(activationId: ActivationId): 'needs_reply' | 'escalated' | undefined {
    const asks = [...this.pending.values()].filter(a => a.message.activationId === activationId);
    if (asks.some(a => a.message.kind === 'escalation')) return 'escalated';
    return asks.length > 0 ? 'needs_reply' : undefined;
  }

  /** Full ordered message history. Diagnostics only — never an authority for state. */
  history(): InteractionMessage[] {
    return [...this.log];
  }

  private compose(input: SendInput, messageId?: MessageId): InteractionMessage {
    return composeInteractionMessage(input, {
      messageId: messageId ?? this.newId(),
      createdAt: this.now(),
    });
  }

  /** A throwing delivery is a failed delivery, never a lost message. */
  private async attemptDelivery(message: InteractionMessage): Promise<boolean> {
    if (!this.deliver) return true;
    try {
      return (await this.deliver(message)) === true;
    } catch {
      return false;
    }
  }
}

/**
 * Build one canonical message.
 *
 * Exported because the peer channel composes messages the in-process transport never sees
 * — a completion push originates from the runtime and expects no reply, so it needs the
 * vocabulary without needing correlation, waiters or a pending-ask registration. Sharing
 * this function is what keeps that a serialisation of `InteractionMessage` rather than a
 * second message shape that happens to have similar field names (invariant BH).
 */
export function composeInteractionMessage(
  input: SendInput,
  identity: { messageId: MessageId; createdAt: number },
): InteractionMessage {
  return {
    messageId: identity.messageId,
    kind: input.kind,
    from: input.from,
    to: input.to,
    activationId: input.activationId,
    attemptId: input.attemptId,
    ...(input.piSessionId ? { piSessionId: input.piSessionId } : {}),
    body: input.body,
    ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
    createdAt: identity.createdAt,
  };
}
