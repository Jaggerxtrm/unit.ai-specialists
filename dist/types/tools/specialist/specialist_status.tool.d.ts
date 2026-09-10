import * as z from 'zod';
import type { SpecialistLoader } from '../../specialist/loader.js';
import type { CircuitBreaker } from '../../utils/circuitBreaker.js';
import { type PendingInteractionProjection } from '../../activation/transport/polling.js';
import { type UncertainWorkspaceProjection } from '../../activation/workspace-reconcile.js';
import type { NativeActivationHost } from '../../activation/native-host.js';
import { type ActivationResultView, type ActivationView, type PendingAskView } from './activation.tool.js';
import type { RuntimeEventPusher } from '../../activation/async-events.js';
/**
 * @param getHost Native runtime, when this process hosts one. Optional so the CLI and the
 *   tests that build this tool without a Fleet keep working; PRD Phase 13 acceptance
 *   requires only that an MCP-dispatched activation reads back here IDENTICALLY to a
 *   CLI-dispatched one, which is why `activations` projects the host's own snapshots
 *   rather than a shape invented for MCP. A coordinator must not have to know which
 *   transport dispatched an activation in order to read it.
 */
export declare function createSpecialistStatusTool(loader: SpecialistLoader, circuitBreaker: CircuitBreaker, getHost?: () => NativeActivationHost | undefined, getPusher?: () => RuntimeEventPusher | undefined): {
    name: "specialist_status";
    description: string;
    inputSchema: z.ZodObject<{}, "strip", z.ZodTypeAny, {}, {}>;
    execute(_: object): Promise<{
        loaded_count: number;
        activations: ActivationView[];
        pending_asks: PendingAskView[];
        activation_results: ActivationResultView[];
        pending_interactions: PendingInteractionProjection[];
        uncertain_workspaces: UncertainWorkspaceProjection[];
        backends_health: {
            [k: string]: "CLOSED" | "HALF_OPEN" | "OPEN";
        };
    }>;
};
//# sourceMappingURL=specialist_status.tool.d.ts.map