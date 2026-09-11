import * as z from 'zod';
import type { NativeActivationHost } from '../../activation/native-host.js';
import type { ActivationSnapshot, ActivationTokenUsage } from '../../activation/types.js';
import type { PendingAsk } from '../../activation/interaction.js';
import type { RuntimeEventPusher } from '../../activation/async-events.js';
import type { ActivationResult } from '../../activation/types.js';
/**
 * Transport-neutral projection of one activation.
 *
 * Mirrors `ActivationSnapshot` rather than reshaping it, so an MCP reader and a Pi
 * extension reader answer "what is this Specialist doing" the same way. `workspace` is
 * flattened to its worktree path: the full `WorkspaceIdentity` is a runtime structure and
 * the coordinator needs the mutation domain, not the git plumbing.
 */
export interface ActivationView {
    activation_id: string;
    participant_id: string;
    attempt_id: string;
    specialist: string;
    bead_id: string;
    state: string;
    access: 'read' | 'write';
    worktree_path: string;
    branch?: string;
    pi_session_id?: string;
    /** What was asked for — the override when one was given, the configured model otherwise. */
    requested_model?: string;
    resolved_model: string;
    model_override: boolean;
    thinking_override: boolean;
    /** Seconds since dispatch, from the in-memory snapshot — never an observability.db query. */
    elapsed_s: number;
    /** Cumulative spend counts. Omitted until the first usage event (never zero-filled). */
    token_usage?: ActivationTokenUsage;
    /** Thinking level from session creation. Omitted when unset (never fabricated). */
    thinking_level?: string;
    /** One-line purpose excerpt captured at dispatch. Omitted when absent (never fabricated). */
    purpose?: string;
    /** Last session-event time. Per-tool "doing X now" inference is out of scope. */
    last_activity_at: number;
}
export declare function toActivationView(snapshot: ActivationSnapshot, nowMs?: number): ActivationView;
/** An outstanding question or escalation, projected for a coordinator that must answer it. */
export interface PendingAskView {
    message_id: string;
    kind: string;
    activation_id: string;
    attempt_id: string;
    from: string;
    to: string;
    body: string;
    delivery: string;
    asked_at: number;
}
export declare function toPendingAskView(ask: PendingAsk): PendingAskView;
/**
 * A validated result, projected for a coordinator that reads instead of being pushed.
 *
 * This is the ONE projection of `ActivationResult`, and it carries its own identity so it
 * can stand alone in a list. The Pi extension attaches its result to an `ActivationView`
 * that already names the activation, so the identity fields are redundant there — but
 * redundant is not divergent, and two functions that describe the same settled activation
 * with different field sets is exactly how a Pi coordinator and a Claude coordinator end
 * up disagreeing about one object (`config/pi-extensions/specialist-subagents/index.mjs`,
 * unitAI-rrdnt.45). Exported from `lib.js` so the extension imports it rather than
 * restating it, the way it already does for `toActivationView`.
 */
export interface ActivationResultView {
    activation_id: string;
    participant_id: string;
    attempt_id: string;
    bead_id: string;
    status: string;
    /** Explicitly `null` rather than absent: a missing key reads as "not projected yet". */
    output: unknown;
    validation: {
        valid: boolean;
        schema?: string;
        errors?: string[];
    };
    pi_session_id?: string;
    configured_model?: string;
    requested_model?: string;
    resolved_model: string;
    model_override: boolean;
    thinking_level?: string;
    thinking_override: boolean;
    fallback_used: boolean;
    completed_at: number;
}
export declare function toActivationResultView(result: ActivationResult): ActivationResultView;
export declare const specialistDispatchSchema: z.ZodObject<{
    specialist: z.ZodString;
    bead_id: z.ZodOptional<z.ZodString>;
    contract: z.ZodOptional<z.ZodString>;
    title: z.ZodOptional<z.ZodString>;
    epic_context_depth: z.ZodOptional<z.ZodNumber>;
    model_override: z.ZodOptional<z.ZodString>;
    thinking_override: z.ZodOptional<z.ZodEnum<["off", "minimal", "low", "medium", "high", "xhigh"]>>;
    requested_by: z.ZodOptional<z.ZodString>;
    coordinator_session_id: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    specialist: string;
    bead_id?: string | undefined;
    contract?: string | undefined;
    title?: string | undefined;
    requested_by?: string | undefined;
    model_override?: string | undefined;
    thinking_override?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
    epic_context_depth?: number | undefined;
    coordinator_session_id?: string | undefined;
}, {
    specialist: string;
    bead_id?: string | undefined;
    contract?: string | undefined;
    title?: string | undefined;
    requested_by?: string | undefined;
    model_override?: string | undefined;
    thinking_override?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
    epic_context_depth?: number | undefined;
    coordinator_session_id?: string | undefined;
}>;
/**
 * Dispatch a Specialist onto the in-process runtime.
 *
 * Returns as soon as the activation is admitted and started, NOT when it finishes. The
 * session deliberately outlives the call: a Specialist that reaches `settled` is waiting
 * and resumable, and a tool that blocked until completion would make every clarification
 * a deadlock — the coordinator cannot answer a question it is blocked waiting on.
 */
export declare function createSpecialistDispatchTool(getHost: () => NativeActivationHost, getPusher?: () => RuntimeEventPusher | undefined): {
    name: "specialist_dispatch";
    description: string;
    inputSchema: z.ZodObject<{
        specialist: z.ZodString;
        bead_id: z.ZodOptional<z.ZodString>;
        contract: z.ZodOptional<z.ZodString>;
        title: z.ZodOptional<z.ZodString>;
        epic_context_depth: z.ZodOptional<z.ZodNumber>;
        model_override: z.ZodOptional<z.ZodString>;
        thinking_override: z.ZodOptional<z.ZodEnum<["off", "minimal", "low", "medium", "high", "xhigh"]>>;
        requested_by: z.ZodOptional<z.ZodString>;
        coordinator_session_id: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        specialist: string;
        bead_id?: string | undefined;
        contract?: string | undefined;
        title?: string | undefined;
        requested_by?: string | undefined;
        model_override?: string | undefined;
        thinking_override?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
        epic_context_depth?: number | undefined;
        coordinator_session_id?: string | undefined;
    }, {
        specialist: string;
        bead_id?: string | undefined;
        contract?: string | undefined;
        title?: string | undefined;
        requested_by?: string | undefined;
        model_override?: string | undefined;
        thinking_override?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
        epic_context_depth?: number | undefined;
        coordinator_session_id?: string | undefined;
    }>;
    execute(input: z.infer<typeof specialistDispatchSchema>): Promise<{
        build?: string | undefined;
        missing?: string[] | undefined;
        detail?: {
            specialist?: string;
            beadId?: string;
            missing?: string[];
            workspace?: string;
            holder?: string;
            requestedModel?: string;
            activationId?: string;
            note?: string;
        } | undefined;
        status: "rejected";
        reason: string;
    } | {
        status: "error";
        error: string;
    } | {
        step_contract: {
            root_work_ref: string;
            inputs: number;
            outputs: number;
        };
        created_bead_id?: string | undefined;
        created_bead_note?: string | undefined;
        activation_id: string;
        participant_id: string;
        attempt_id: string;
        specialist: string;
        bead_id: string;
        state: string;
        access: "read" | "write";
        worktree_path: string;
        branch?: string;
        pi_session_id?: string;
        /** What was asked for — the override when one was given, the configured model otherwise. */
        requested_model?: string;
        resolved_model: string;
        model_override: boolean;
        thinking_override: boolean;
        /** Seconds since dispatch, from the in-memory snapshot — never an observability.db query. */
        elapsed_s: number;
        /** Cumulative spend counts. Omitted until the first usage event (never zero-filled). */
        token_usage?: ActivationTokenUsage;
        /** Thinking level from session creation. Omitted when unset (never fabricated). */
        thinking_level?: string;
        /** One-line purpose excerpt captured at dispatch. Omitted when absent (never fabricated). */
        purpose?: string;
        /** Last session-event time. Per-tool "doing X now" inference is out of scope. */
        last_activity_at: number;
        status: "dispatched";
        error?: undefined;
    } | {
        step_contract: {
            root_work_ref: string;
            inputs: number;
            outputs: number;
        };
        created_bead_id?: string | undefined;
        created_bead_note?: string | undefined;
        activation_id: string;
        status: "dispatched";
        error?: undefined;
    }>;
};
export declare const specialistReplySchema: z.ZodObject<{
    message_id: z.ZodString;
    body: z.ZodString;
}, "strip", z.ZodTypeAny, {
    body: string;
    message_id: string;
}, {
    body: string;
    message_id: string;
}>;
/**
 * Answer an outstanding question or escalation.
 *
 * The answer resumes the child inside its existing tool call, so the same AgentSession
 * continues with its context intact rather than being restarted with an answer pasted
 * into a fresh prompt.
 */
export declare function createSpecialistReplyTool(getHost: () => NativeActivationHost): {
    name: "specialist_reply";
    description: string;
    inputSchema: z.ZodObject<{
        message_id: z.ZodString;
        body: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        body: string;
        message_id: string;
    }, {
        body: string;
        message_id: string;
    }>;
    execute(input: z.infer<typeof specialistReplySchema>): Promise<{
        status: "error";
        error: string;
        message_id: string;
        in_reply_to?: undefined;
        activation_id?: undefined;
        attempt_id?: undefined;
    } | {
        status: "answered";
        message_id: string;
        in_reply_to: string | undefined;
        activation_id: string;
        attempt_id: string;
        error?: undefined;
    }>;
};
export declare const specialistStopSchema: z.ZodObject<{
    activation_id: z.ZodString;
    reason: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    activation_id: string;
    reason?: string | undefined;
}, {
    activation_id: string;
    reason?: string | undefined;
}>;
/**
 * Stop and dispose a native activation.
 *
 * Distinct from the legacy `stop_specialist`, which SIGTERMs a `sp run` child process by
 * its recorded pid. There is no child process here; disposal is a method call, and it is
 * the only ordinary path to disposal because settling is not one.
 */
export declare function createSpecialistStopActivationTool(getHost: () => NativeActivationHost): {
    name: "specialist_stop_activation";
    description: string;
    inputSchema: z.ZodObject<{
        activation_id: z.ZodString;
        reason: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        activation_id: string;
        reason?: string | undefined;
    }, {
        activation_id: string;
        reason?: string | undefined;
    }>;
    execute(input: z.infer<typeof specialistStopSchema>): Promise<{
        status: "error";
        error: string;
        activation_id: string;
    } | {
        status: "stopped";
        activation_id: string;
        error?: undefined;
    }>;
};
export declare const specialistRetrySchema: z.ZodObject<{
    activation_id: z.ZodString;
    model_override: z.ZodOptional<z.ZodString>;
    prompt: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    activation_id: string;
    prompt?: string | undefined;
    model_override?: string | undefined;
}, {
    activation_id: string;
    prompt?: string | undefined;
    model_override?: string | undefined;
}>;
/**
 * Re-run a failed native activation in place — the native equivalent of `sp retry`.
 *
 * Same activation id, new attempt: the bead, the workspace lease and (without a model
 * override) the session survive the retry. Failed only — a live or waiting activation
 * already has its path (reply for an outstanding question, resume for a settled one,
 * steer/stop for a running one), and retry refuses those states with the right pointer
 * rather than becoming a second dispatch. An escalation or question that CAN wait stays
 * an ask answered with specialist_reply; retry is for runs that already died.
 */
export declare function createSpecialistRetryTool(getHost: () => NativeActivationHost, getPusher?: () => RuntimeEventPusher | undefined): {
    name: "specialist_retry";
    description: string;
    inputSchema: z.ZodObject<{
        activation_id: z.ZodString;
        model_override: z.ZodOptional<z.ZodString>;
        prompt: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        activation_id: string;
        prompt?: string | undefined;
        model_override?: string | undefined;
    }, {
        activation_id: string;
        prompt?: string | undefined;
        model_override?: string | undefined;
    }>;
    execute(input: z.infer<typeof specialistRetrySchema>): Promise<{
        build?: string | undefined;
        missing?: string[] | undefined;
        detail?: {
            specialist?: string;
            beadId?: string;
            missing?: string[];
            workspace?: string;
            holder?: string;
            requestedModel?: string;
            activationId?: string;
            note?: string;
        } | undefined;
        status: "rejected";
        reason: string;
    } | {
        activation_id: string;
        participant_id: string;
        attempt_id: string;
        specialist: string;
        bead_id: string;
        state: string;
        access: "read" | "write";
        worktree_path: string;
        branch?: string;
        pi_session_id?: string;
        /** What was asked for — the override when one was given, the configured model otherwise. */
        requested_model?: string;
        resolved_model: string;
        model_override: boolean;
        thinking_override: boolean;
        /** Seconds since dispatch, from the in-memory snapshot — never an observability.db query. */
        elapsed_s: number;
        /** Cumulative spend counts. Omitted until the first usage event (never zero-filled). */
        token_usage?: ActivationTokenUsage;
        /** Thinking level from session creation. Omitted when unset (never fabricated). */
        thinking_level?: string;
        /** One-line purpose excerpt captured at dispatch. Omitted when absent (never fabricated). */
        purpose?: string;
        /** Last session-event time. Per-tool "doing X now" inference is out of scope. */
        last_activity_at: number;
        status: "retried";
    } | {
        activation_id: string;
        status: "retried";
    }>;
};
//# sourceMappingURL=activation.tool.d.ts.map