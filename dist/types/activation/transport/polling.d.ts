/**
 * Polling fallback — the degraded path, and the only one with no external dependency.
 *
 * `docs/design/claude-transport-decision.md` §7 requires this to be built first, because
 * it is what the pending state is read through. Every guarantee the peer channel cannot
 * make is made here instead: when no route can be selected, when the user's cross-session
 * approval gate holds or refuses a push, or when reachability lapses mid-session, the
 * question is still visible and the answer still resumes the Specialist.
 *
 * Nothing in this module talks to a socket, a roster or a process. It reads the durable
 * store and nothing else, which is what makes it the fallback rather than a second
 * transport.
 */
import { type InteractionReply, type SharedDeliveryState } from './pending-store.js';
/**
 * One outstanding interaction, projected for a status surface.
 *
 * Field names are snake_case to match the existing `specialist_status` payload shape
 * (`background_jobs`, `started_at_ms`), so a coordinator reads one consistent surface.
 */
export interface PendingInteractionProjection {
    activation_id: string;
    message_id: string;
    kind: string;
    /** The participant protocol's three-state view, never the richer wire state. */
    delivery: SharedDeliveryState;
    /** The wire outcome, for diagnosis only. A coordinator must not branch on it. */
    wire_delivery: string;
    created_at_ms: number;
    send_attempts: number;
    /** True once a coordinator has answered, whether it read the ask by push or by polling. */
    answered: boolean;
    /** Present only for informational kinds, which never wait for an answer. */
    awaiting_reply: boolean;
    body?: string;
}
/**
 * Every interaction this repository knows about, for the status surface.
 *
 * Exported with an explicit signature because `unitAI-rrdnt.19` wires it into
 * `specialist_status`; this lane does not edit the MCP dispatch surface itself.
 */
export declare function projectInteractionsForStatus(repoRoot: string): PendingInteractionProjection[];
/**
 * Only the interactions still waiting on a coordinator.
 *
 * This is the answer to "did anything get lost when the push failed?". A question whose
 * push was refused appears here identically to one that was never pushed at all — which is
 * the point: the coordinator's view does not depend on the transport.
 */
export declare function projectOutstandingAsks(repoRoot: string): PendingInteractionProjection[];
/** The same projection, narrowed to one activation. */
export declare function projectActivationInteractions(repoRoot: string, activationId: string): PendingInteractionProjection[];
export interface AwaitReplyOptions {
    /** Give up after this long. Expiry is not failure: the record stays readable. */
    timeoutMs: number;
    /** How often to re-read the store. */
    intervalMs?: number;
    /** Abort early, e.g. when the activation is stopped. */
    signal?: AbortSignal;
}
/**
 * Wait for a coordinator's answer by polling the durable store.
 *
 * This is how a Specialist resumes when the peer push never arrived, and it is also
 * correct when the push did arrive: the reply is written to the same place either way, so
 * a coordinator that answered over the peer channel and one that answered after reading
 * `specialist_status` are indistinguishable here apart from latency (invariant BH).
 *
 * Returns `undefined` on timeout rather than throwing. A question that has not been
 * answered yet is a normal state — the Specialist stays in `needs_reply`; it does not fail
 * and it does not silently proceed.
 */
export declare function awaitReply(repoRoot: string, activationId: string, messageId: string, options: AwaitReplyOptions): Promise<InteractionReply | undefined>;
//# sourceMappingURL=polling.d.ts.map