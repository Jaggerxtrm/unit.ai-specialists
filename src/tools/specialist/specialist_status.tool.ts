// src/tools/specialist/specialist_status.tool.ts
import * as z from 'zod';
import type { SpecialistLoader } from '../../specialist/loader.js';
import { checkStaleness } from '../../specialist/loader.js';
import type { CircuitBreaker } from '../../utils/circuitBreaker.js';
import { createObservabilitySqliteClient } from '../../specialist/observability-sqlite.js';
import { isJobDead } from '../../specialist/supervisor.js';
import { detectJobOutputMode } from '../../cli/status.js';
import { projectOutstandingAsks, type PendingInteractionProjection } from '../../activation/transport/polling.js';
import type { NativeActivationHost } from '../../activation/native-host.js';
import { toActivationView, toPendingAskView, type ActivationView, type PendingAskView } from './activation.tool.js';

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
) {
  return {
    name: 'specialist_status' as const,
    description: 'System health: backend circuit breaker states, loaded specialists, staleness. Also shows active background jobs from DB-backed runtime state (.specialists/jobs/ is legacy/operator-only), and native in-process activations with any question they are waiting on — answer those with specialist_reply.',
    inputSchema: z.object({}),
    async execute(_: object) {
      const list = await loader.list();

      // Check staleness for each specialist concurrently
      const stalenessResults = await Promise.all(list.map(s => checkStaleness(s)));

      // Include active background jobs — DB-first, file fallback only when file output is on.
      const sqliteClient = createObservabilitySqliteClient();
      let jobs: any[] = [];
      try {
        const dbStatuses = sqliteClient?.listStatuses() ?? [];
        if (dbStatuses.length > 0) {
          jobs = dbStatuses;
        } else if (detectJobOutputMode() === 'on') {
          const { existsSync, readdirSync, readFileSync } = await import('node:fs');
          const { join } = await import('node:path');
          const jobsDir = join(process.cwd(), '.specialists', 'jobs');
          if (existsSync(jobsDir)) {
            for (const entry of readdirSync(jobsDir)) {
              const statusPath = join(jobsDir, entry, 'status.json');
              if (!existsSync(statusPath)) continue;
              try { jobs.push(JSON.parse(readFileSync(statusPath, 'utf-8'))); } catch { /* skip */ }
            }
          }
        }
      } finally {
        sqliteClient?.close();
      }
      jobs.sort((a, b) => (b.started_at_ms ?? 0) - (a.started_at_ms ?? 0));

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

      // The native Fleet. Separate from `background_jobs` because they are different
      // things and merging them would hide it: a background job is a `sp run` child
      // process with a pid, an activation is an in-process AgentSession with none. The
      // projection is the host's own `ActivationSnapshot`, so this reads the same whether
      // the activation was dispatched over MCP or by the Pi extension.
      const host = getHost?.();
      const activations: ActivationView[] = host ? host.list().map(toActivationView) : [];
      const pending_asks: PendingAskView[] = host ? host.pendingAsks().map(toPendingAskView) : [];

      return {
        loaded_count: list.length,
        activations,
        pending_asks,
        pending_interactions,
        backends_health: Object.fromEntries(BACKENDS.map(b => [b, circuitBreaker.getState(b)])),
        specialists: list.map((s, i) => ({
          name: s.name,
          scope: s.scope,
          category: s.category,
          version: s.version,
          staleness: stalenessResults[i],
        })),
        background_jobs: jobs.map(j => ({
          id: j.id,
          specialist: j.specialist,
          status: j.status,
          is_dead: isJobDead({ status: j.status, pid: j.pid, tmux_session: j.tmux_session }),
          elapsed_s: j.elapsed_s,
          current_event: j.current_event,
          bead_id: j.bead_id,
          metrics: j.metrics,
          error: j.error,
        })),
      };
    },
  };
}
