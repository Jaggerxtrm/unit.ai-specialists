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
export type InteractionKind = 'question' | 'escalation' | 'finding' | 'completion' | 'reply' | 'instruction';
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
export declare class UncorrelatedReplyError extends Error {
    readonly inReplyTo: MessageId | undefined;
    constructor(inReplyTo: MessageId | undefined);
}
/**
 * In-process transport between a parent and its children.
 *
 * One instance serves a whole activation tree; participants are addressed by
 * `ParticipantId`, so the transport has no notion of "the" parent and a future scheduler
 * can drive it without being one.
 */
export declare class InteractionTransport {
    private readonly now;
    private readonly newId;
    private readonly deliver?;
    private readonly pending;
    private readonly waiters;
    /** Replies already delivered, so a waiter registered late still resolves. */
    private readonly answered;
    private readonly log;
    constructor(options?: InteractionTransportOptions);
    /**
     * Send one message. Never throws on delivery failure.
     *
     * An ask that cannot be delivered is still registered as pending, because the alternative
     * — failing the send — loses the question. The asker learns delivery state by reading
     * `pendingAsks()`, not from the return of this call.
     */
    send(input: SendInput, messageId?: MessageId): Promise<InteractionMessage>;
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
    request(input: Omit<SendInput, 'kind' | 'inReplyTo'> & {
        kind?: 'question' | 'escalation';
    }): Promise<InteractionMessage>;
    /** Answer an outstanding ask. Correlation is by `inReplyTo` and nothing else. */
    private reply;
    /** Every ask still awaiting an answer, oldest first. */
    pendingAsks(participantId?: ParticipantId): PendingAsk[];
    /**
     * Whether a participant needs someone to act.
     *
     * Attention is derived from outstanding asks rather than stored, so it cannot drift out
     * of agreement with the asks themselves.
     */
    attention(participantId: ParticipantId): boolean;
    /** The activation state an outstanding ask implies, for the Fleet projection. */
    impliedState(activationId: ActivationId): 'needs_reply' | 'escalated' | undefined;
    /** Full ordered message history. Diagnostics only — never an authority for state. */
    history(): InteractionMessage[];
    private compose;
    /** A throwing delivery is a failed delivery, never a lost message. */
    private attemptDelivery;
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
export declare function composeInteractionMessage(input: SendInput, identity: {
    messageId: MessageId;
    createdAt: number;
}): InteractionMessage;
//# sourceMappingURL=interaction.d.ts.map