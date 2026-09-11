import * as z from 'zod';
import type { NativeActivationHost } from '../activation/native-host.js';
import type { RuntimeEventPusher } from '../activation/async-events.js';
export declare const specialistResumeSchema: z.ZodObject<{
    activation_id: z.ZodString;
    prompt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    prompt: string;
    activation_id: string;
}, {
    prompt: string;
    activation_id: string;
}>;
/**
 * Resume a settled or waiting activation in the SAME session.
 *
 * Not a second dispatch: `activation_id` is kept and `attempt_id` advances, so
 * the child keeps its context and workspace lease rather than starting over.
 * A disposed activation cannot be resumed — that is what makes
 * `specialist_stop_activation` the irreversible one.
 */
export declare function createSpecialistResumeTool(getHost: () => NativeActivationHost, getPusher?: () => RuntimeEventPusher | undefined): {
    name: "specialist_resume";
    description: string;
    inputSchema: z.ZodObject<{
        activation_id: z.ZodString;
        prompt: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        prompt: string;
        activation_id: string;
    }, {
        prompt: string;
        activation_id: string;
    }>;
    execute(input: z.infer<typeof specialistResumeSchema>): Promise<{
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
        activation_id: string;
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
        requested_model?: string;
        resolved_model: string;
        model_override: boolean;
        thinking_override: boolean;
        elapsed_s: number;
        token_usage?: import("../activation/types.js").ActivationTokenUsage;
        thinking_level?: string;
        purpose?: string;
        last_activity_at: number;
        status: "resumed";
        previous_attempt_id: string;
        error?: undefined;
    } | {
        activation_id: string;
        status: "resumed";
        previous_attempt_id: string;
        error?: undefined;
    }>;
};
//# sourceMappingURL=resume-tool.d.ts.map