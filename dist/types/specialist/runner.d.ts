import { PiAgentSession, type PiSessionOptions, type SessionMetricEvent, type SessionRunMetrics } from '../pi/session.js';
import type { SpecialistLoader } from './loader.js';
import type { HookEmitter } from './hooks.js';
import { type CircuitBreaker } from '../utils/circuitBreaker.js';
import type { RuntimeOriginV1 } from './runtime-origin.js';
import { type ResolvedToolContract } from './resolved-tool-contract.js';
export interface RunOptions {
    name: string;
    prompt: string;
    variables?: Record<string, string>;
    backendOverride?: string;
    autonomyLevel?: string;
    specialistName?: string;
    specialistPermissions?: PiSessionOptions['specialistPermissions'];
    /** Working directory for local scripts and the pi session. */
    workingDirectory?: string;
    /** Absolute write-boundary for write-side tools inside pi session. */
    worktreeBoundary?: string;
    /** Existing bead whose content should be used as the task prompt. */
    inputBeadId?: string;
    output_file?: string;
    suppressRunnerFileOutput?: boolean;
    notesMode?: 'full-trail' | 'final-only';
    /** Owning epic id for wave-bound chains, when bead belongs to an epic. */
    epicId?: string;
    /** Lineage: set when --job <id> is used to reuse another job's worktree. */
    reusedFromJobId?: string;
    /** Bead dependency context depth (0 disables completed blocker injection). */
    contextDepth?: number;
    /** Lineage: root job id that originally created the reused worktree. */
    worktreeOwnerJobId?: string;
    baseShaPinned?: string;
    baseShaPinnedAtMs?: number;
    /** Path to an existing pi session file for continuation (Phase 2+) */
    sessionPath?: string;
    /**
     * Keep the Pi session alive after agent_end.
     * Enables multi-turn: callers receive resumeFn/closeFn via onResumeReady callback.
     */
    keepAlive?: boolean;
    /** Explicitly disable keepAlive even when specialist.execution.interactive=true. */
    noKeepAlive?: boolean;
    /** Additional retries after the initial attempt (default: 0). */
    maxRetries?: number;
    /** Whether external (input) bead notes should be written by Supervisor. */
    beadsWriteNotes?: boolean;
    /** Force re-dispatch even if active same-bead specialist job exists. */
    forceJob?: boolean;
    /** Permission level used to decide concurrency guard scope. */
    permissionRequired?: 'READ_ONLY' | 'LOW' | 'MEDIUM' | 'HIGH';
    /**
     * Ambient xtmux runtime origin captured at the sp run boundary
     * (spec docs/xtmux-gaps.md §13.1-§13.4). Supervisor uses this in the spawn-
     * origin precedence rule to build the initial SupervisorStatus.
     */
    ambientRuntimeOrigin?: RuntimeOriginV1;
    /**
     * Explicit parent job id, populated by internal launch paths (F1). When set,
     * the spawn origin resolves to specialist.job, superseding any ambient origin.
     */
    explicitParentJobId?: string;
}
export interface RunResult {
    output: string;
    backend: string;
    model: string;
    durationMs: number;
    specialistVersion: string;
    promptHash: string;
    beadId?: string;
    metrics?: SessionRunMetrics;
    permissionRequired?: 'READ_ONLY' | 'LOW' | 'MEDIUM' | 'HIGH';
    autoCommit?: 'never' | 'checkpoint_on_waiting' | 'checkpoint_on_terminal';
    outputType?: string;
    payloadBreakdown?: PayloadBreakdown;
}
type SessionLike = Pick<PiAgentSession, 'start' | 'prompt' | 'waitForDone' | 'getLastOutput' | 'getState' | 'close' | 'kill' | 'meta' | 'steer' | 'resume'> & {
    getMetrics?: () => SessionRunMetrics;
};
export type SessionFactory = (opts: PiSessionOptions) => Promise<SessionLike>;
import { type BeadsClient as BeadsClientType } from './beads.js';
import { type PayloadBreakdown } from './payload-measure.js';
interface RunnerDeps {
    loader: SpecialistLoader;
    hooks: HookEmitter;
    circuitBreaker: CircuitBreaker;
    /** Overridable for testing; defaults to PiAgentSession.create */
    sessionFactory?: SessionFactory;
    /** Optional beads client for specialist run tracking */
    beadsClient?: BeadsClientType;
}
interface ScriptResult {
    name: string;
    output: string;
    stderr: string;
    exitCode: number;
    signal?: string;
    spawnError?: string;
}
/** Bounds the name and strips control/XML-significant characters so a
 *  script-controlled command string cannot break the `<script name="...">`
 *  wrapper or terminal rendering (unitAI-x64ys). */
export declare function sanitizeScriptName(name: string): string;
export declare function runScript(command: string | undefined, cwd: string): ScriptResult;
export interface RequiredPreScriptFailure {
    name: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    signal?: string;
    spawnError?: string;
}
/** Shared required-preflight decision: the first `pre` script marked
 *  `required: true` whose result is nonzero aborts the run. Optional scripts
 *  (required omitted/false) never gate — legacy injection behavior is kept. */
export declare function findRequiredPreScriptFailure(scripts: ReadonlyArray<{
    phase?: string;
    required?: boolean;
}>, results: ReadonlyArray<ScriptResult>): RequiredPreScriptFailure | null;
export declare class RequiredPreScriptError extends Error {
    readonly code = "pre_script_failed";
    constructor(message: string);
}
export declare function formatRequiredPreScriptFailure(failure: RequiredPreScriptFailure): string;
export declare function formatScriptOutput(results: ScriptResult[]): string;
export declare function validateBeforeRun(spec: {
    specialist: {
        skills?: {
            paths?: string[];
            scripts?: Array<{
                run?: string;
                path?: string;
                phase: string;
                inject_output: boolean;
            }>;
        };
        capabilities?: {
            external_commands?: string[];
            required_tools?: string[];
        };
    };
}, permissionLevel: string, resolvedToolContract?: ResolvedToolContract): void;
export declare function classifyFallbackError(error: unknown): string;
export declare class SpecialistRunner {
    private deps;
    private sessionFactory;
    constructor(deps: RunnerDeps);
    private resolvePromptWithBeadContext;
    run(options: RunOptions, onProgress?: (msg: string) => void, onEvent?: (type: string, details?: {
        charCount?: number;
        content?: string;
        toolCallId?: string;
        model?: string;
        previousModel?: string;
        action?: 'set_model' | 'cycle_model';
        extension?: string;
        errorMessage?: string;
        tokensBefore?: number;
        summary?: string;
        source?: string;
        data?: Record<string, unknown>;
        firstKeptEntryId?: string;
        attempt?: number;
        maxAttempts?: number;
        delayMs?: number;
    }) => void, onMetric?: (event: SessionMetricEvent) => void, onMeta?: (meta: {
        backend: string;
        model: string;
        sessionId?: string;
    }) => void, onKillRegistered?: (killFn: () => void) => void, onSessionRegistered?: (session: SessionLike) => void, onBeadCreated?: (beadId: string) => void, onSteerRegistered?: (steerFn: (msg: string) => Promise<void>) => void, onResumeReady?: (resumeFn: (msg: string) => Promise<string>, closeFn: () => Promise<void>) => void, onToolStartCallback?: (tool: string, args?: Record<string, unknown>, toolCallId?: string) => void, onToolEndCallback?: (tool: string, isError: boolean, toolCallId?: string, resultContent?: string, resultRaw?: Record<string, unknown>) => void): Promise<RunResult>;
    /**
     * @deprecated Legacy in-memory async path.
     * Now uses Supervisor-backed jobs under .specialists/jobs.
     */
    startAsync(options: RunOptions, registry: import('./jobRegistry.js').JobRegistry): Promise<string>;
}
export {};
//# sourceMappingURL=runner.d.ts.map