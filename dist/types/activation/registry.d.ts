/**
 * FleetRegistry — the persistent store behind `NativeActivationHost`.
 *
 * A coordinator turn ends and starts many times; the Fleet must not. This is the seam that
 * survives a turn boundary: it owns activation records (identity, live session, and the
 * result each is running toward) and exposes only `ActivationSnapshot` outward, so the Pi
 * extension, the Claude Code MCP server and a future Chain scheduler all read the same
 * transport-neutral shape rather than reaching into host internals.
 */
import type { PiAgentSessionLike } from './pi-sdk.js';
import type { ActivationSnapshot, AttemptId } from './types.js';
import type { StepContract } from './step-contract.js';
/** Everything the host needs to keep a running or resumable activation alive. */
export interface ActivationRecord {
    snapshot: ActivationSnapshot;
    session: PiAgentSessionLike;
    /** Detaches the host's own lifecycle listener; re-created on every `resume()`. */
    unsubscribe: () => void;
    result: Promise<unknown>;
    /** Derived, never persisted independently — carried so a resumed handle can return it. */
    stepContract: StepContract;
    /**
     * The turn-1 prompt, carried so `retry()` re-runs the same bead contract in place.
     * An operator-supplied prompt overrides it; a bead edited after dispatch needs one of
     * the two (fresh dispatch otherwise), because this is the dispatch-time render.
     */
    initialPrompt: string;
    /**
     * Builds a new session identically to the dispatch-time one, for a new model.
     * Serves the fallback walk (start) and retry-with-override (retry); the ask/escalate
     * tools are shared by construction — they key off the live attempt id, not the session.
     */
    createSession: (model: {
        id?: string;
        provider?: string;
    }) => Promise<PiAgentSessionLike>;
}
export declare class FleetRegistry {
    private readonly records;
    register(record: ActivationRecord): void;
    get(activationId: string): ActivationRecord | undefined;
    remove(activationId: string): void;
    /** Transport-neutral projection of every activation this process knows about. */
    list(): ActivationSnapshot[];
    projection(activationId: string): ActivationSnapshot | undefined;
}
/**
 * Next attempt id for a resumed activation: `att:<suffix>:<n>` -> `att:<suffix>:<n+1>`.
 *
 * Resume never mints a new activation id — only the attempt counter advances, per the
 * identity model in types.ts (retries/resumes are attempts under one activation).
 */
export declare function nextAttemptId(current: AttemptId): AttemptId;
/** States from which `resume()` may start a new attempt. Running/starting/disposed cannot. */
export declare const RESUMABLE_STATES: Set<string>;
/**
 * States from which `retry()` may start a new attempt in place.
 *
 * Failed only, by design: every other state already has an operator path (waiting and
 * settled/needs_reply/escalated resume, running/starting steer or stop first), and a
 * retry that accepted them would be a second dispatch path wearing a resume name.
 * Mirrors the CLI `sp retry` gate (error/cancelled only) for the native runtime.
 */
export declare const RETRYABLE_STATES: Set<string>;
//# sourceMappingURL=registry.d.ts.map