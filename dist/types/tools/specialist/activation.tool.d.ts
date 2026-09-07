import * as z from 'zod';
import type { NativeActivationHost } from '../../activation/native-host.js';
import type { ActivationSnapshot } from '../../activation/types.js';
import type { PendingAsk } from '../../activation/interaction.js';
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
    resolved_model: string;
    model_override: boolean;
}
export declare function toActivationView(snapshot: ActivationSnapshot): ActivationView;
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
export declare const specialistDispatchSchema: z.ZodObject<{
    specialist: z.ZodString;
    bead_id: z.ZodString;
    model_override: z.ZodOptional<z.ZodString>;
    requested_by: z.ZodOptional<z.ZodString>;
    coordinator_session_id: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    bead_id: string;
    specialist: string;
    requested_by?: string | undefined;
    model_override?: string | undefined;
    coordinator_session_id?: string | undefined;
}, {
    bead_id: string;
    specialist: string;
    requested_by?: string | undefined;
    model_override?: string | undefined;
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
export declare function createSpecialistDispatchTool(getHost: () => NativeActivationHost): {
    name: "specialist_dispatch";
    description: string;
    inputSchema: z.ZodObject<{
        specialist: z.ZodString;
        bead_id: z.ZodString;
        model_override: z.ZodOptional<z.ZodString>;
        requested_by: z.ZodOptional<z.ZodString>;
        coordinator_session_id: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        bead_id: string;
        specialist: string;
        requested_by?: string | undefined;
        model_override?: string | undefined;
        coordinator_session_id?: string | undefined;
    }, {
        bead_id: string;
        specialist: string;
        requested_by?: string | undefined;
        model_override?: string | undefined;
        coordinator_session_id?: string | undefined;
    }>;
    execute(input: z.infer<typeof specialistDispatchSchema>): Promise<{
        status: "rejected";
        reason: string;
        detail: {
            specialist?: string;
            beadId?: string;
            missing?: string[];
            workspace?: string;
            holder?: string;
            requestedModel?: string;
            activationId?: string;
            note?: string;
        };
    } | {
        step_contract: {
            root_work_ref: string;
            inputs: number;
            outputs: number;
        };
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
        resolved_model: string;
        model_override: boolean;
        status: "dispatched";
    } | {
        step_contract: {
            root_work_ref: string;
            inputs: number;
            outputs: number;
        };
        activation_id: string;
        status: "dispatched";
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
//# sourceMappingURL=activation.tool.d.ts.map