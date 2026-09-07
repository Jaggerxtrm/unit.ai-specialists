// src/tools/specialist/specialist_status.tool.ts
import { z } from 'zod';
import type { SpecialistLoader } from '../../specialist/loader.js';
import { checkStaleness } from '../../specialist/loader.js';
import type { CircuitBreaker } from '../../utils/circuitBreaker.js';
import { createObservabilitySqliteClient } from '../../specialist/observability-sqlite.js';
import { isJobDead } from '../../specialist/supervisor.js';
import { detectJobOutputMode } from '../../cli/status.js';
import { projectOutstandingAsks, type PendingInteractionProjection } from '../../activation/transport/polling.js';

const BACKENDS = ['gemini', 'qwen', 'anthropic', 'openai'];

export function createSpecialistStatusTool(loader: SpecialistLoader, circuitBreaker: CircuitBreaker) {
  return {
    name: 'specialist_status' as const,
    description: 'System health: backend circuit breaker states, loaded specialists, staleness. Also shows active background jobs from DB-backed runtime state; .specialists/jobs/ is legacy/operator-only.',
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

      return {
        loaded_count: list.length,
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
