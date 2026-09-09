import { z } from 'zod';
import type { JobRegistry } from '../../specialist/jobRegistry.js';
export declare const steerSpecialistSchema: z.ZodObject<{
    job_id: z.ZodString;
    message: z.ZodString;
}, "strip", z.ZodTypeAny, {
    message: string;
    job_id: string;
}, {
    message: string;
    job_id: string;
}>;
export declare function createSteerSpecialistTool(registry: JobRegistry): {
    name: "steer_specialist";
    description: string;
    inputSchema: z.ZodObject<{
        job_id: z.ZodString;
        message: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        message: string;
        job_id: string;
    }, {
        message: string;
        job_id: string;
    }>;
    execute(input: z.infer<typeof steerSpecialistSchema>): Promise<{
        status: string;
        job_id: string;
        message: string;
        error?: undefined;
    } | {
        status: string;
        error: string | undefined;
        job_id: string;
        message?: undefined;
    }>;
};
//# sourceMappingURL=steer_specialist.tool.d.ts.map