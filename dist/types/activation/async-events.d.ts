/**
 * Asynchronous runtime events toward a Claude coordinator — PRD Phase 14, acceptance AY
 * (unitAI-rrdnt.34).
 *
 * Before this module a coordinator learned nothing about an activation until it asked. The
 * ask path (Phase 6) pushes because the Specialist is blocked on the answer; a completion
 * blocks nobody, so nothing pushed it and a long activation was silent until something
 * polled. This module is the push half of that gap.
 *
 * Three properties are load-bearing, and each is the reason a simpler shape was rejected:
 *
 *   - **The notification is a PROJECTION, never a substitute.** `settle()` records the
 *     validated `ActivationResult` and BOTH readers — the coordinator that polls
 *     `specialist_status` and the coordinator that received a push — resolve to that one
 *     object. They cannot disagree, because there is only one of it: the push body is a
 *     serialisation of the same record, not a summary composed beside it.
 *   - **Push is refused before validation.** The only way to name a result here is by
 *     activation id, and an activation with no recorded result has none to project. A push
 *     attempted before `settle()` throws rather than inventing an optimistic completion.
 *   - **`finding` and `completion` never reach `delivered`.** Claude Code emits no receipt
 *     to a peer sender, so these stay `sent_unconfirmed` permanently and that is the honest
 *     terminal state, not a defect to be worked around. The durable record is written by
 *     `PeerAdapter.push` before any send is attempted, so an unroutable, held or refused
 *     push loses nothing.
 *
 * Deliberately NOT here: the in-process `InteractionTransport`. A completion expects no
 * answer, so it needs the vocabulary (`composeInteractionMessage`) and the wire
 * (`PeerAdapter`), and none of the correlation machinery the transport exists to provide.
 */
import { type InteractionMessage } from './interaction.js';
import type { PeerAdapter, PushResult } from './transport/peer-adapter.js';
import type { ActivationId, ActivationResult, ParticipantId } from './types.js';
/** Where one activation's asynchronous events are addressed. Recorded at dispatch. */
export interface EventRoute {
    /** The coordinator's Claude session id. The only stable address on this channel. */
    coordinatorSessionId?: string;
    /** The coordinator participant the message is addressed `to`. */
    coordinatorParticipantId: ParticipantId;
}
export interface RuntimeEventPusherOptions {
    adapter: PeerAdapter;
    now?: () => number;
    newMessageId?: () => string;
    /** Reported for forensics and tests; never used to decide anything. */
    onPush?: (message: InteractionMessage, result: PushResult) => void;
}
/**
 * Thrown when a completion push is attempted for an activation that has not settled.
 *
 * A distinct error rather than a `false` return: pushing an unvalidated completion is a
 * caller bug, and a coordinator acting on a completion that no result backs is exactly the
 * silent-success failure `ActivationResult` exists to prevent.
 */
export declare class ResultNotValidatedError extends Error {
    readonly activationId: ActivationId;
    constructor(activationId: ActivationId);
}
/**
 * Records validated results and pushes their projections to a coordinator.
 *
 * One instance per host process, so the result store survives a coordinator turn boundary
 * for the same reason `FleetRegistry` does: the coordinator that reads a completion is
 * usually not the turn that dispatched it.
 */
export declare class RuntimeEventPusher {
    private readonly adapter;
    private readonly now;
    private readonly newMessageId;
    private readonly onPush?;
    private readonly routes;
    private readonly results;
    constructor(options: RuntimeEventPusherOptions);
    /**
     * Record where an activation's events go.
     *
     * Called at dispatch, because the coordinator address is a property of the dispatch and
     * not of the runtime. An untracked activation still settles and is still readable; it
     * simply has nowhere to push, which is the degraded path and is fully functional.
     */
    track(activationId: ActivationId, route: EventRoute): void;
    /** Record the validated result. The one object both the push and the poll return. */
    settle(result: ActivationResult): void;
    /** The polling path. Identical to what a completion push carries. */
    result(activationId: ActivationId): ActivationResult | undefined;
    /** Every validated result this process holds. */
    allResults(): ActivationResult[];
    /**
     * Push the completion notification for a settled activation.
     *
     * Returns the transport outcome rather than throwing on non-delivery: unroutable, held
     * and refused are ordinary states of this channel and the durable record covers all of
     * them. The one thing that DOES throw is a push with no validated result behind it.
     */
    pushCompletion(activationId: ActivationId): Promise<PushResult>;
}
/**
 * Serialise a result into a message body.
 *
 * Whole-object JSON rather than a prose summary, because AY requires the pushed and the
 * polled coordinator to reach the SAME result object, and a summary is by construction a
 * second, lossy description of it that drifts the moment a field is added.
 */
export declare function completionBody(result: ActivationResult): string;
/** Recover the projected result from a pushed body. Undefined if the body is not one. */
export declare function parseCompletionBody(body: string): ActivationResult | undefined;
//# sourceMappingURL=async-events.d.ts.map