/**
 * NativeActivationHost — hosts a real Specialist on an in-process Pi `AgentSession`.
 *
 * This is the shared runtime seam. The Pi extension and the Claude Code MCP server are
 * both frontends over this class; neither invokes the legacy `sp run` CLI, and a future
 * Chain scheduler can call `start()` with a synthetic request because nothing here depends
 * on TUI state.
 *
 * WRITERS ARE ADMITTED, and the lease is wired. This paragraph used to say the opposite and
 * was left behind when the wiring landed — the exact drift this epic kept finding elsewhere,
 * so it is worth being precise about what is and is not true now:
 *   - A `MEDIUM` or `HIGH` tier resolves to `access: 'write'` and MUST acquire the workspace
 *     lease before an AgentSession exists; a denied lease is a refusal, not a warning.
 *   - `admitToolCall` re-checks the lease on every mutating tool call, and `guarded-tools.ts`
 *     wraps pi's four mutating builtins so a refusal comes back as a tool RESULT.
 *   - `releaseIfWriter` releases on DISPOSAL and converts a throwing release into
 *     `lease_uncertain` evidence rather than a silent success. It does NOT release on
 *     settle, though `workspace-lease.ts`'s wiring note (call site 3) says it should — so a
 *     settled writer keeps its workspace until an explicit stop, and sequential writer
 *     handoff needs one. That divergence is `unitAI-rrdnt.59` and is a design decision
 *     rather than an oversight to patch: releasing on settle buys automatic handoff and
 *     costs guaranteed resumability.
 *   The lease guards the LLM TOOL PATH ONLY. `pi.exec` and `AgentSession.executeBash` do not
 *   fire the tool_call handler (`unitAI-rrdnt.6`, unclosed), so a child reaching the
 *   filesystem that way is not fenced. Do not describe writers as "fenced" without that
 *   qualifier.
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
import { type ActivationHandle, type ActivationRequest, type ActivationSnapshot, type LiveActivationStats } from './types.js';
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
     * Last per-message usage value seen per activation, keyed by live snapshot.
     * Feeds accumulateTokenUsage so delta-shape and cumulative-shape providers both
     * project monotonic totals. WeakMap: the entry dies with the snapshot, and resume
     * keeps the same snapshot so counters continue across attempts by construction.
     */
    private readonly lastUsageSeen;
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
     * Run the turn-1 attempt, walking the model chain on retryable provider failures.
     *
     * The first attempt runs on the dispatch-time session; a failure whose class is
     * retryable (rate_limit/timeout/transient per the classifier shared with the CLI
     * runner) disposes that session and continues on the next chain model under the SAME
     * activation and attempt id. Auth, unknown and abort-class failures settle failed
     * immediately — retrying those on another model is either wrong (auth) or blind
     * (unknown), exactly the CLI rule. The winner lands on the snapshot (`resolvedModel`,
     * `piSessionId`) and on the result (`resolvedModel`, `fallbackUsed`), so attribution
     * answers what actually ran.
     *
     * Runs inside the dispatch result promise: dispatch already returned, so the walk never
     * blocks admission. A record removed mid-walk (stop) ends the walk — a disposed
     * activation must never resurrect.
     */
    private runWithFallback;
    /**
     * Re-run a FAILED activation in place — the native equivalent of `sp retry`.
     *
     * Keeps `activationId` and advances `attemptId`: a retry is a new attempt under one
     * activation, never a second dispatch, so lineage and the workspace lease survive it.
     * Without a model override the SAME session is re-prompted, so its context survives
     * too; with one a new session is built identically except for the model, and the
     * failed session is disposed. The turn prompt defaults to the dispatch-time render of
     * the same bead — pass `prompt` to say something new, or dispatch fresh when the bead
     * itself was rewritten.
     *
     * Gating mirrors the CLI retry: failed only. A waiting/settled/needs_reply/escalated
     * activation resumes (its session is alive); a running one steers or stops first.
     * A refused model override leaves the activation failed-and-retryable, never
     * half-advanced. Writers reacquire their own lease for the new attempt — the workspace
     * is held across the retry, never dropped, so no orphan is possible.
     */
    retry(activationId: string, opts?: {
        modelOverride?: string;
        prompt?: string;
    }): Promise<ActivationHandle>;
    /**
     * Answer an outstanding ask, resuming the child inside its existing tool call.
     *
     * The answer returns as that tool's result, so the SAME AgentSession continues with its
     * context intact. Correlation is by `messageId`; there is deliberately no "answer the
     * latest ask" convenience, because with two asks outstanding that is a coin flip.
     */
    answer(messageId: string, body: string): Promise<InteractionMessage | undefined>;
    /**
     * Release a writer's lease, converting an uncertain release into evidence.
     *
     * `release` THROWS when the holder's liveness cannot be established, and that throw is
     * the point: it refuses to guess whether the previous writer finished. Swallowing it
     * would silently free a workspace that may still be under mutation, which is the exact
     * inference the uncertain state exists to prevent. So the throw becomes a
     * `lease_uncertain` event and the workspace stays uncertain until an operator reconciles
     * it through `specialist_status` — the shape argued by the unitAI-rrdnt.31 lane.
     *
     * Teardown is never failed by this. A stop that could not release is still a stop.
     */
    private releaseIfWriter;
    /**
     * Decide whether one planned tool call may run — PRD §52, the per-call block.
     *
     * This must be a per-call verdict and NOT `setActiveToolsByName`. Within a turn the agent
     * loop runs against a tool snapshot taken at turn start, so revoking a tool cannot cancel
     * a call that is already planned; every handler in a batch fires before any execution, so
     * a block is enforceable exactly where a tool-set change is not (unitAI-rrdnt.7).
     *
     * A read-only activation is refused every mutating call. That is not an error — it holds
     * no lease because it is not entitled to one, and this is the only choke point where the
     * capability grant can actually be enforced.
     *
     * KNOWN HOLE, unclosed and not closable on pi 0.85.1: this guards the LLM tool path only.
     * `AgentSession.executeBash()` and `pi.exec()` fire the extension `tool_call` handler
     * ZERO times, re-verified on 0.85.1 (unitAI-rrdnt.6). An extension that mutates the
     * workspace through those bypasses this gate entirely. Do not document the lease as
     * protecting a worktree against arbitrary extension effects; it does not.
     */
    admitToolCall(activationId: string, toolName: string): {
        allow: boolean;
        reason?: string;
    };
    /** Every outstanding ask across the Fleet, oldest first. */
    pendingAsks(): PendingAsk[];
    /** Current state of one activation, or undefined if unknown to this host. */
    inspect(activationId: string): ActivationSnapshot | undefined;
    /**
     * Live per-activation stats over existing in-memory state: one Map read plus
     * arithmetic, never an observability.db query, so the 1s widget tick stays cheap.
     */
    liveStats(activationId: string): LiveActivationStats | undefined;
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