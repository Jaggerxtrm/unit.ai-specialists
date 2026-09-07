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
/**
 * Wire a transport to the peer channel and return its `deliver` hook.
 *
 * Pass the result as `InteractionTransport`'s `deliver`. It pushes every message and, for
 * the kinds that expect an answer, watches the durable store and routes the reply back
 * through the transport so the blocked `request()` resolves and the Specialist resumes in
 * the same session.
 */
export declare function createPeerDelivery(options: PeerBridgeOptions): (message: InteractionMessage) => Promise<boolean>;
//# sourceMappingURL=peer-bridge.d.ts.map