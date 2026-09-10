// src/tools/specialist/specialist_status.tool.ts
import * as z from 'zod';
import type { SpecialistLoader } from '../../specialist/loader.js';
import type { CircuitBreaker } from '../../utils/circuitBreaker.js';
import { projectOutstandingAsks, type PendingInteractionProjection } from '../../activation/transport/polling.js';
import { leaseScopeFor, projectUncertainWorkspaces, type UncertainWorkspaceProjection } from '../../activation/workspace-reconcile.js';
import type { NativeActivationHost } from '../../activation/native-host.js';
import { toActivationView, toActivationResultView, toPendingAskView, type ActivationResultView, type ActivationView, type PendingAskView } from './activation.tool.js';
import type { RuntimeEventPusher } from '../../activation/async-events.js';

const BACKENDS = ['gemini', 'qwen', 'anthropic', 'openai'];

/**
 * @param getHost Native runtime, when this process hosts one. Optional so the CLI and the
 *   tests that build this tool without a Fleet keep working; PRD Phase 13 acceptance
 *   requires only that an MCP-dispatched activation reads back here IDENTICALLY to a
 *   CLI-dispatched one, which is why `activations` projects the host's own snapshots
 *   rather than a shape invented for MCP. A coordinator must not have to know which
 *   transport dispatched an activation in order to read it.
 */
export function createSpecialistStatusTool(
  loader: SpecialistLoader,
  circuitBreaker: CircuitBreaker,
  getHost?: () => NativeActivationHost | undefined,
  getPusher?: () => RuntimeEventPusher | undefined,
) {
  return {
    name: 'specialist_status' as const,
    description: 'System health: backend circuit breaker states, loaded specialist count, and native in-process activations with any question they are waiting on — answer those with specialist_reply.',
    inputSchema: z.object({}),
    async execute(_: object) {
      const list = await loader.list();

      // The degraded path from the Claude transport decision: outstanding clarifications
      // must be readable WITHOUT the peer channel working. Projection only — never a
      // branch on wire_delivery, which is diagnosis. Absent state is the normal case, so a
      // repo with no interactions directory yields an empty list rather than an error.
      let pending_interactions: PendingInteractionProjection[] = [];
      try {
        pending_interactions = projectOutstandingAsks(process.cwd());
      } catch {
        pending_interactions = [];
      }

      // A workspace whose writer disappeared mid-mutation is refused to every acquirer until
      // someone reconciles it, and a refused reconciliation leaves it refused. Both states
      // are invisible without this: the lease record is under the git common dir and nothing
      // else reports it, so an operator would see a Specialist that cannot start and no
      // reason why. Reads the durable lease store only — same contract as the projection
      // above — and an empty list is the normal case.
      let uncertain_workspaces: UncertainWorkspaceProjection[] = [];
      try {
        uncertain_workspaces = projectUncertainWorkspaces(leaseScopeFor(process.cwd()));
      } catch {
        uncertain_workspaces = [];
      }

      // The native Fleet is an in-process AgentSession projection. It reads the host's own
      // `ActivationSnapshot`, so this is the same whether the activation was dispatched over
      // MCP or by the Pi extension.
      const host = getHost?.();
      const activations: ActivationView[] = host ? host.list().map(s => toActivationView(s)) : [];
      const pending_asks: PendingAskView[] = host ? host.pendingAsks().map(toPendingAskView) : [];

      // The read half of Phase 14. A completion notification is pushed toward a live
      // coordinator, but the push can be unroutable, held or refused and never reports
      // `delivered` on this channel at all — so the validated result must be readable
      // without one. This projects the SAME ActivationResult the push serialises, which is
      // what makes a pushed coordinator and a polling coordinator agree by construction.
      const activation_results: ActivationResultView[] =
        getPusher?.()?.allResults().map(toActivationResultView) ?? [];

      return {
        loaded_count: list.length,
        activations,
        pending_asks,
        activation_results,
        pending_interactions,
        uncertain_workspaces,
        backends_health: Object.fromEntries(BACKENDS.map(b => [b, circuitBreaker.getState(b)])),
      };
    },
  };
}
