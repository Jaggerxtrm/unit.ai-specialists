import { z } from 'zod';
import type { SpecialistLoader } from '../../specialist/loader.js';
import type { CircuitBreaker } from '../../utils/circuitBreaker.js';
import { type PendingInteractionProjection } from '../../activation/transport/polling.js';
export declare function createSpecialistStatusTool(loader: SpecialistLoader, circuitBreaker: CircuitBreaker): {
    name: "specialist_status";
    description: string;
    inputSchema: z.ZodObject<{}, "strip", z.ZodTypeAny, {}, {}>;
    execute(_: object): Promise<{
        loaded_count: number;
        pending_interactions: PendingInteractionProjection[];
        backends_health: {
            [k: string]: "CLOSED" | "HALF_OPEN" | "OPEN";
        };
        specialists: {
            name: string;
            scope: "default" | "user" | "package";
            category: string;
            version: string;
            staleness: "OK" | "STALE" | "AGED";
        }[];
        background_jobs: {
            id: any;
            specialist: any;
            status: any;
            is_dead: boolean;
            elapsed_s: any;
            current_event: any;
            bead_id: any;
            metrics: any;
            error: any;
        }[];
    }>;
};
//# sourceMappingURL=specialist_status.tool.d.ts.map