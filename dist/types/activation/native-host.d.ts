/**
 * NativeActivationHost — hosts a real Specialist on an in-process Pi `AgentSession`.
 *
 * This is the shared runtime seam. The Pi extension and the Claude Code MCP server are
 * both frontends over this class; neither invokes the legacy `sp run` CLI, and a future
 * Chain scheduler can call `start()` with a synthetic request because nothing here depends
 * on TUI state.
 *
 * WHAT THIS DOES NOT DO YET, and why:
 *   - No writer support. Only read-only Specialists are admitted (see the `access` check
 *     below). `src/activation/workspace-lease.ts` now EXISTS and is mutation-tested, but it
 *     is imported by nothing in `src/` — this host does not acquire it. That is currently
 *     harmless precisely because writers are refused here: nothing is fenced because
 *     nothing writes. Enabling writers and wiring the lease is one change, not two, and it
 *     is `unitAI-rrdnt.36`. Flipping the admission check without the acquire call would
 *     ship write-capable Specialists guarded by a lease that is present, tested, closed on
 *     the board, and never called.
 *   - No model picker.
 *
 * The interaction protocol and the Fleet DO exist: see `./interaction.ts`, `./ask-tool.ts`
 * and `./registry.ts`.
 *
 * Session lifetime deliberately exceeds turn lifetime: reaching `agent_settled` makes a
 * Specialist *waiting and resumable*, never disposed. Disposal is an explicit act.
 */
import { SpecialistLoader } from '../specialist/loader.js';
import { BeadsClient } from '../specialist/beads.js';
import { type BeadGateOptions } from './bead-gate.js';
import { type InteractionMessage, type PendingAsk } from './interaction.js';
import { PeerAdapter, type TransportForensicEvent } from './transport/peer-adapter.js';
import { type PiSdk, type PiAgentSessionEvent } from './pi-sdk.js';
import { type ActivationHandle, type ActivationRequest, type ActivationSnapshot } from './types.js';
/**
 * Sink for activation forensics.
 *
 * Native activations write the SAME `observability.db` as the legacy runner — there is no
 * native-subagent telemetry database. This interface exists only so tests can observe the
 * event stream without a database; production wires it to `appendForensicEvent`.
 */
export interface ActivationForensicSink {
    emit(event: {
        activationId: string;
        attemptId: string;
        participantId: string;
        specialist: string;
        beadId?: string;
        name: string;
        payload?: Record<string, unknown>;
    }): void;
    /**
     * Receives every RAW Pi session event, untranslated.
     *
     * The `emit` path above carries a small hand-written vocabulary; this one carries the
     * whole stream so the Phase 7 mapper can produce timeline rows through the same
     * factories the legacy `sp run` path uses. Without it, a native activation and a legacy
     * one answer the same query differently.
     *
     * Optional by design: every existing sink, including the null sink and each test double,
     * keeps working untouched. The two paths do not overlap — raw events feed the timeline
     * mappers, and the translated `emit` names remain the sole producers of their own rows.
     */
    sessionEvent?(input: NativeActivationSessionEventInput): void;
    /**
     * Receives peer-transport route and delivery events.
     *
     * The transport lane writes no forensics itself — `observability.db` is the single
     * forensic authority and no lane owns a file belonging to the sink, which is why
     * `PeerAdapter` takes an injected `emit` rather than importing one. Ownership follows the
     * authority; the fact that three lanes then merged without touching each other's files is
     * a consequence of that boundary, not a merge tactic to copy where no boundary exists.
     */
    peerTransportEvent?(event: TransportForensicEvent): void;
}
/** One raw session event, with the activation identity needed to attribute it. */
export interface NativeActivationSessionEventInput {
    activationId: string;
    attemptId: string;
    participantId: string;
    specialist: string;
    beadId?: string;
    piSessionId: string;
    workspacePath: string;
    event: PiAgentSessionEvent;
}
/** Discards events. Used only where forensics are genuinely not wanted (unit tests). */
export declare const NULL_FORENSIC_SINK: ActivationForensicSink;
export interface NativeActivationHostDeps {
    loader?: SpecialistLoader;
    beadsClient?: Pick<BeadsClient, 'readBead'>;
    forensics?: ActivationForensicSink;
    /** Injected for tests; defaults to resolving the real Pi SDK. */
    loadSdk?: () => Promise<PiSdk>;
    /** Bead readiness gate seams. Defaults read the real `bd` state marker. */
    beadGate?: BeadGateOptions;
    /** Defaults to `process.cwd()`. */
    cwd?: string;
    now?: () => number;
    /**
     * Push asks to a live Claude coordinator over the peer channel.
     *
     * Omit it and the host is polling-only, which is the degraded path and is correct: the
     * question is still readable through `specialist_status` and nothing is lost. Supplying
     * it does not make delivery guaranteed — see docs/design/claude-transport-decision.md §5.
     */
    peer?: PeerDelivery;
}
/** Configuration for pushing interactions to a Claude coordinator. */
export interface PeerDelivery {
    /** The coordinator's Claude session id. The only stable address on this channel. */
    coordinatorSessionId: string;
    /** Repository root under which `.specialists/interactions/` lives. Defaults to `cwd`. */
    repoRoot?: string;
    /** Built for tests; defaults to a real `PeerAdapter` against the live roster. */
    adapter?: PeerAdapter;
    replyTimeoutMs?: number;
    pollIntervalMs?: number;
}
/**
 * A live activation view attached to a running or resumable session.
 *
 * `detach` only removes this listener; it is symmetric with `attach`/`return` and never
 * touches the session's turn, its state, or any other attachment on the same activation.
 */
export interface ActivationAttachment {
    snapshot: ActivationSnapshot;
    detach: () => void;
}
export declare class NativeActivationHost {
    private readonly loader;
    private readonly beadsClient;
    private readonly forensics;
    private readonly loadSdk;
    private readonly beadGate;
    private readonly cwd;
    private readonly now;
    private readonly registry;
    /**
     * One transport for the whole host. Messages carry their own activationId, so a single
     * instance serves every child and the parent enumerates asks across the Fleet in one
     * place rather than walking activations.
     *
     * Delivery is wired only when a coordinator address is configured. Without one the
     * transport is in-process and every ask reads as `pending` through `specialist_status`,
     * which is the degraded path and is fully functional — the peer channel is an
     * optimisation on top of durable state, never a prerequisite for it (PRD §30).
     */
    private readonly interactions;
    constructor(deps?: NativeActivationHostDeps);
    /**
     * Admit and start one activation.
     *
     * Every rejection below happens BEFORE an AgentSession exists, and each leaves forensic
     * evidence: a refused dispatch is still runtime evidence, and a dispatch that failed
     * silently is indistinguishable from one that never happened.
     */
    start(request: ActivationRequest): Promise<ActivationHandle>;
    /**
     * Translate Pi session events into Specialists forensic events.
     *
     * `agent_end` is a per-turn boundary carrying `willRetry`; `agent_settled` is the
     * governed quiescence boundary. Conflating them is why a naive host disposes a child
     * that was merely pausing.
     */
    private onSessionEvent;
    private runToSettled;
    /**
     * Answer an outstanding ask, resuming the child inside its existing tool call.
     *
     * The answer returns as that tool's result, so the SAME AgentSession continues with its
     * context intact. Correlation is by `messageId`; there is deliberately no "answer the
     * latest ask" convenience, because with two asks outstanding that is a coin flip.
     */
    answer(messageId: string, body: string): Promise<InteractionMessage | undefined>;
    /** Every outstanding ask across the Fleet, oldest first. */
    pendingAsks(): PendingAsk[];
    /** Current state of one activation, or undefined if unknown to this host. */
    inspect(activationId: string): ActivationSnapshot | undefined;
    /**
     * Build the delivery hook for a configured coordinator.
     *
     * Called from the constructor, so it must not read any field the constructor has not yet
     * assigned — `repoRoot` is taken from the config or from `deps.cwd` directly rather than
     * from `this.cwd`, which is set on the line above but would be a trap to depend on if the
     * order ever changed.
     */
    private wirePeerDelivery;
    /** The Fleet projection: every activation this process knows about, transport-neutral. */
    list(): ActivationSnapshot[];
    /**
     * Explicitly stop and dispose an activation.
     *
     * This is the only ordinary path to disposal — settling is not one.
     */
    stop(activationId: string, reason?: string): Promise<void>;
    /**
     * Attach a listener to a live activation's event stream without perturbing its turn.
     *
     * Subscribing is additive — `PiAgentSessionLike.subscribe` fans out to every listener —
     * so an attached observer (a Fleet view, a follow MCP call) never displaces the host's
     * own lifecycle subscription or any other attachment on the same activation.
     */
    attach(activationId: string, listener: (event: PiAgentSessionEvent) => void): ActivationAttachment | undefined;
    /** Release an attachment. Symmetric with `attach`; the activation itself is unaffected. */
    return(attachment: ActivationAttachment): void;
    /**
     * Resume a settled or waiting activation with a new prompt.
     *
     * Keeps `activationId` and advances `attemptId` — a resume is never a second activation.
     * The host's own lifecycle listener is re-subscribed so forensics for the new attempt
     * carry the new `attemptId` rather than the one closed over at `start()`.
     */
    resume(activationId: string, prompt: string): Promise<ActivationHandle>;
}
//# sourceMappingURL=native-host.d.ts.map