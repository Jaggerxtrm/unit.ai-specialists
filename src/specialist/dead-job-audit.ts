// Bridge → substrate: when substrate ships container-state reconciler (kj651 follow-up),
// this audit retires (specialists-roadmap §B.3 row 'dead-job audit', shape 'attach' then 'retire').
// Column moves job→container; the logic is dropped, not renamed.

import type { ObservabilitySqliteClient } from './observability-sqlite.js';
import { createForensicEvent, deploymentEnvironment } from './forensic-events.js';

export interface DeadJobAuditFinding {
  job_id: string;
  pid: number;
  reason: string;
  age_ms: number;
}

export interface DeadJobAuditResult {
  dryRun: boolean;
  found: DeadJobAuditFinding[];
  cancelled: number;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ESRCH') {
      return false;
    }
    return true;
  }
}

export function auditDeadJobs(opts: {
  client: ObservabilitySqliteClient;
  dryRun?: boolean;
  nowMs?: number;
  isPidAlive?: (pid: number) => boolean;
  minAgeMs?: number;
}): DeadJobAuditResult {
  const dryRun = opts.dryRun ?? false;
  const nowMs = opts.nowMs ?? Date.now();
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const minAgeMs = opts.minAgeMs ?? 60_000;

  const rows = opts.client.listStaleSpecialistJobs({ minAgeMs, nowMs });
  const found: DeadJobAuditFinding[] = [];
  let cancelled = 0;

  for (const row of rows) {
    if (isPidAlive(row.pid)) continue;

    const age_ms = Math.max(0, nowMs - row.updated_at_ms);
    found.push({
      job_id: row.job_id,
      pid: row.pid,
      reason: 'container-restart-orphan',
      age_ms,
    });

    if (!dryRun) {
      opts.client.markSpecialistJobCancelled(row.job_id, 'container-restart-orphan');
      cancelled += 1;
      // Emit xtrm.forensic.v1 lifecycle event for durable operator visibility.
      // This bridge path retires once substrate owns container-state reconciler.
      opts.client.appendForensicEvent(
        row.job_id,
        row.specialist,
        row.bead_id ?? undefined,
        createForensicEvent({
          event_family: 'lifecycle',
          event_name: 'dead_declared',
          resource: {
            service_namespace: 'xtrm',
            service_name: 'specialists',
            service_component: 'dead-job-audit',
            deployment_environment: deploymentEnvironment(),
            repo: 'specialists',
            participant_kind: 'specialist',
            participant_role: row.specialist,
          },
          correlation: { job_id: row.job_id, bead_id: row.bead_id ?? undefined },
          body: {
            job_id: row.job_id,
            pid: row.pid,
            age_ms,
            reason: 'container-restart-orphan',
            dry_run: dryRun,
          },
        }),
      );
    }
  }

  return { dryRun, found, cancelled };
}
