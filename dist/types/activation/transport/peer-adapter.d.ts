/**
 * Peer adapter — pushes a runtime-originated interaction to a Claude coordinator, and
 * degrades to the polling fallback whenever it cannot.
 *
 * The ordering below is the whole contract, and it is why the durable store was built
 * first:
 *
 *   1. Write the durable record.        <- before anything else can fail
 *   2. Resolve a route from the roster. <- /proc + procStart, never status, never sockets
 *   3. Attempt the send.                <- acceptance only
 *   4. Wait for a receipt.              <- the only thing that means "delivered"
 *
 * Every step from 2 onward may fail, and none of those failures loses the message: the
 * record from step 1 is already readable through `specialist_status`, and the Specialist
 * stays in `needs_reply` rather than failing or silently proceeding.
 *
 * What this adapter is NOT: it is never authoritative for activation identity, lease
 * authority, result state or forensic state (PRD §107, invariant 14). It writes runtime
 * state only. Forensic emission is an injected callback so `observability.db` stays the
 * single forensic authority and this lane owns no file belonging to the forensic sink.
 */
import { type InteractionPayload, type PendingInteraction } from './pending-store.js';
import { type ReceiptSource } from './peer-transport.js';
import { type LiveRoute, type ProcessProbe } from './roster.js';
import type { InteractionKind } from '../interaction.js';
/**
 * Why a push did not reach `delivered`.
 *
 * None of these is an error. §5: peer delivery passes the user's cross-session approval
 * gate and may be held, delayed or refused, and reachability lapses mid-session.
 */
export type PushOutcome = 'delivered' | 'no_route' | 'send_failed' | 'no_receipt' | 'refused';
export interface PushResult {
    outcome: PushOutcome;
    record: PendingInteraction;
    route?: LiveRoute;
    /** Present when the peer answered with an explicit non-delivery status. */
    reason?: string;
}
/** A forensic event, handed to the host rather than written here. */
export interface TransportForensicEvent {
    event: 'peer.route_selected' | 'peer.route_absent' | 'peer.send_attempted' | 'peer.receipt' | 'peer.no_receipt';
    activationId: string;
    messageId: string;
    routeRef?: string;
    detail?: string;
}
export interface PeerAdapterOptions {
    /** Repository root under which `.specialists/interactions/` lives. */
    repoRoot: string;
    /** Receipts, if this process binds a socket. Without it nothing is ever `delivered`. */
    receipts?: ReceiptSource;
    /** This sender's own peer address, echoed as the envelope `from`. */
    selfAddress?: string;
    /** Display label for the envelope. Never an address — `nameSource` is not identity. */
    selfName?: string;
    /** How long to wait for a receipt before recording `sent_unconfirmed`. */
    receiptTimeoutMs?: number;
    /** Roster overrides, for tests. */
    rosterDir?: string;
    probe?: ProcessProbe;
    /** Forensic sink, injected. `observability.db` is not written from this lane. */
    emit?: (event: TransportForensicEvent) => void;
}
/**
 * A message to push, addressed by the coordinator's session id.
 *
 * `messageId`, `activationId` and `kind` are the canonical `InteractionMessage`'s own
 * fields, passed explicitly so this lane indexes the message without reinterpreting the
 * vocabulary it does not own (`src/activation/interaction.ts`, `unitAI-rrdnt.19`).
 */
export interface PushRequest {
    messageId: string;
    activationId: string;
    kind: InteractionKind;
    /** The canonical InteractionMessage, stored verbatim and serialised onto the wire. */
    message: InteractionPayload;
    /** Human-readable body carried in the envelope. */
    body: string;
    /** The coordinator's Claude session id. The only stable address. */
    coordinatorSessionId: string;
}
export declare class PeerAdapter {
    private readonly options;
    constructor(options: PeerAdapterOptions);
    /**
     * Push one interaction, writing durable state before anything is attempted.
     *
     * Returns the outcome rather than throwing for a non-delivery: a held, refused or
     * unrouteable message is a normal state of this transport, and the caller's next move is
     * the same in every case — wait on the durable store.
     */
    push(request: PushRequest): Promise<PushResult>;
    /**
     * Push a question and wait for the coordinator's answer.
     *
     * The wait is always on the durable store, never on the socket. That is what makes the
     * two transports indistinguishable to the caller (invariant BH): a coordinator that was
     * pushed to and one that read `specialist_status` both write the reply to the same
     * place, so this resolves identically whether the push was delivered, held, refused or
     * never routed at all.
     */
    ask(request: PushRequest, wait: {
        timeoutMs: number;
        intervalMs?: number;
        signal?: AbortSignal;
    }): Promise<{
        push: PushResult;
        reply?: InteractionPayload;
    }>;
}
//# sourceMappingURL=peer-adapter.d.ts.map