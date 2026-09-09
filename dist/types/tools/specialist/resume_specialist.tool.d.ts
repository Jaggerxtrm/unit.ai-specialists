import { z } from 'zod';
import type { JobRegistry } from '../../specialist/jobRegistry.js';
export declare const resumeSpecialistSchema: z.ZodObject<{
    job_id: z.ZodString;
    task: z.ZodString;
}, "strip", z.ZodTypeAny, {
    task: string;
    job_id: string;
}, {
    task: string;
    job_id: string;
}>;
export declare function createResumeSpecialistTool(registry: JobRegistry): {
    name: "resume_specialist";
    description: string;
    inputSchema: z.ZodObject<{
        job_id: z.ZodString;
        task: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        task: string;
        job_id: string;
    }, {
        task: string;
        job_id: string;
    }>;
    execute(input: z.infer<typeof resumeSpecialistSchema>): Promise<{
        status: string;
        job_id: string;
        output: string | undefined;
        error?: undefined;
        task?: undefined;
    } | {
        status: string;
        error: string | undefined;
        job_id: string;
        output?: undefined;
        task?: undefined;
    } | {
        status: string;
        job_id: string;
        task: string;
        output?: undefined;
        error?: undefined;
    }>;
};
//# sourceMappingURL=resume_specialist.tool.d.ts.map