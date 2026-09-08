import * as z from 'zod';
import type { SpecialistRunner } from '../../specialist/runner.js';
export declare const useSpecialistSchema: z.ZodEffects<z.ZodObject<{
    name: z.ZodString;
    prompt: z.ZodOptional<z.ZodString>;
    bead_id: z.ZodOptional<z.ZodString>;
    variables: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    backend_override: z.ZodOptional<z.ZodString>;
    autonomy_level: z.ZodOptional<z.ZodEnum<["READ_ONLY", "LOW", "MEDIUM", "HIGH"]>>;
    context_depth: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    name: string;
    bead_id?: string | undefined;
    prompt?: string | undefined;
    variables?: Record<string, string> | undefined;
    backend_override?: string | undefined;
    autonomy_level?: "LOW" | "MEDIUM" | "HIGH" | "READ_ONLY" | undefined;
    context_depth?: number | undefined;
}, {
    name: string;
    bead_id?: string | undefined;
    prompt?: string | undefined;
    variables?: Record<string, string> | undefined;
    backend_override?: string | undefined;
    autonomy_level?: "LOW" | "MEDIUM" | "HIGH" | "READ_ONLY" | undefined;
    context_depth?: number | undefined;
}>, {
    name: string;
    bead_id?: string | undefined;
    prompt?: string | undefined;
    variables?: Record<string, string> | undefined;
    backend_override?: string | undefined;
    autonomy_level?: "LOW" | "MEDIUM" | "HIGH" | "READ_ONLY" | undefined;
    context_depth?: number | undefined;
}, {
    name: string;
    bead_id?: string | undefined;
    prompt?: string | undefined;
    variables?: Record<string, string> | undefined;
    backend_override?: string | undefined;
    autonomy_level?: "LOW" | "MEDIUM" | "HIGH" | "READ_ONLY" | undefined;
    context_depth?: number | undefined;
}>;
export declare function createUseSpecialistTool(runner: SpecialistRunner): {
    name: "use_specialist";
    description: string;
    inputSchema: z.ZodEffects<z.ZodObject<{
        name: z.ZodString;
        prompt: z.ZodOptional<z.ZodString>;
        bead_id: z.ZodOptional<z.ZodString>;
        variables: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        backend_override: z.ZodOptional<z.ZodString>;
        autonomy_level: z.ZodOptional<z.ZodEnum<["READ_ONLY", "LOW", "MEDIUM", "HIGH"]>>;
        context_depth: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        name: string;
        bead_id?: string | undefined;
        prompt?: string | undefined;
        variables?: Record<string, string> | undefined;
        backend_override?: string | undefined;
        autonomy_level?: "LOW" | "MEDIUM" | "HIGH" | "READ_ONLY" | undefined;
        context_depth?: number | undefined;
    }, {
        name: string;
        bead_id?: string | undefined;
        prompt?: string | undefined;
        variables?: Record<string, string> | undefined;
        backend_override?: string | undefined;
        autonomy_level?: "LOW" | "MEDIUM" | "HIGH" | "READ_ONLY" | undefined;
        context_depth?: number | undefined;
    }>, {
        name: string;
        bead_id?: string | undefined;
        prompt?: string | undefined;
        variables?: Record<string, string> | undefined;
        backend_override?: string | undefined;
        autonomy_level?: "LOW" | "MEDIUM" | "HIGH" | "READ_ONLY" | undefined;
        context_depth?: number | undefined;
    }, {
        name: string;
        bead_id?: string | undefined;
        prompt?: string | undefined;
        variables?: Record<string, string> | undefined;
        backend_override?: string | undefined;
        autonomy_level?: "LOW" | "MEDIUM" | "HIGH" | "READ_ONLY" | undefined;
        context_depth?: number | undefined;
    }>;
    execute(input: z.infer<typeof useSpecialistSchema>, onProgress?: (msg: string) => void): Promise<import("../../specialist/runner.js").RunResult | {
        status: "error";
        error: string;
    } | {
        readiness_warning: string;
        output: string;
        backend: string;
        model: string;
        durationMs: number;
        specialistVersion: string;
        promptHash: string;
        beadId?: string;
        metrics?: import("../../pi/session.js").SessionRunMetrics;
        permissionRequired?: "READ_ONLY" | "LOW" | "MEDIUM" | "HIGH";
        autoCommit?: "never" | "checkpoint_on_waiting" | "checkpoint_on_terminal";
        outputType?: string;
        payloadBreakdown?: import("../../specialist/payload-measure.js").PayloadBreakdown;
        status?: undefined;
        error?: undefined;
    }>;
};
//# sourceMappingURL=use_specialist.tool.d.ts.map