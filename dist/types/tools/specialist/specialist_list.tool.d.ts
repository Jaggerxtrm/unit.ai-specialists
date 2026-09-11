import * as z from 'zod';
import type { SpecialistLoader, SpecialistSummary } from '../../specialist/loader.js';
export declare const specialistListSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    detail: z.ZodOptional<z.ZodEnum<["compact", "full"]>>;
}, "strip", z.ZodTypeAny, {
    name?: string | undefined;
    detail?: "full" | "compact" | undefined;
}, {
    name?: string | undefined;
    detail?: "full" | "compact" | undefined;
}>;
declare function specialistSummaryView(summary: SpecialistSummary): {
    name: string;
    category: string;
    description: string;
    scope: "default" | "user" | "package";
    source: "user" | "legacy" | "default-mirror" | "package-fallback" | "package-live";
    version: string;
    permission_required: "READ_ONLY" | "LOW" | "MEDIUM" | "HIGH";
};
type RegistryRow = ReturnType<typeof specialistSummaryView> & {
    access: 'write' | 'read';
    dispatchable?: boolean;
    reason?: string;
};
export declare function createSpecialistListTool(loader: SpecialistLoader): {
    name: "specialist_list";
    description: string;
    inputSchema: z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        detail: z.ZodOptional<z.ZodEnum<["compact", "full"]>>;
    }, "strip", z.ZodTypeAny, {
        name?: string | undefined;
        detail?: "full" | "compact" | undefined;
    }, {
        name?: string | undefined;
        detail?: "full" | "compact" | undefined;
    }>;
    execute(input: z.infer<typeof specialistListSchema>): Promise<{
        specialist: RegistryRow;
        note: string;
        error?: undefined;
        known?: undefined;
        specialists?: undefined;
        detail?: undefined;
        count?: undefined;
        undispatchable?: undefined;
    } | {
        error: string;
        known: string[];
        note: string;
        specialist?: undefined;
        specialists?: undefined;
        detail?: undefined;
        count?: undefined;
        undispatchable?: undefined;
    } | {
        specialists: RegistryRow[];
        detail: string;
        note: string;
        specialist?: undefined;
        error?: undefined;
        known?: undefined;
        count?: undefined;
        undispatchable?: undefined;
    } | {
        specialists: {
            reason?: string | undefined;
            dispatchable: boolean;
            category?: string | undefined;
            name: string;
            tier: "READ_ONLY" | "LOW" | "MEDIUM" | "HIGH";
            access: "read" | "write";
        }[];
        count: number;
        undispatchable: number;
        detail: string;
        note: string;
        specialist?: undefined;
        error?: undefined;
        known?: undefined;
    }>;
};
export {};
//# sourceMappingURL=specialist_list.tool.d.ts.map