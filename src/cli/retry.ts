// Re-dispatch a terminal (error/cancelled) job, optionally on a named model.
//
// Manual model switch for activations that died on provider errors (e.g. a 429
// quota window with no fallback configured, unitAI-xxjw2). The retry reuses the
// failed job's bead and workspace lease via the `sp run --job` path, so no new
// lease is taken and partial workspace state is preserved. All guards of the
// normal dispatch path (concurrency, stale-base, worktree provisioning) apply
// unchanged — this command only resolves the equivalent `sp run` arguments and
// re-invokes the CLI.

import { spawnSync } from 'node:child_process';
import { Supervisor } from '../specialist/supervisor.js';
import { resolveJobsDir } from '../specialist/job-root.js';

export const RETRYABLE_JOB_STATUSES = new Set(['error', 'cancelled']);

export interface RetryStatusSnapshot {
  id: string;
  specialist: string;
  status: string;
  bead_id?: string;
  worktree_path?: string;
}

export interface ParsedRetryArgs {
  jobId?: string;
  model?: string;
  background?: boolean;
}

export function parseRetryArgs(argv: readonly string[]): ParsedRetryArgs & { error?: string } {
  let jobId: string | undefined;
  let model: string | undefined;
  let background = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--model' && argv[i + 1]) { model = argv[++i]; continue; }
    if (token === '--background') { background = true; continue; }
    if (!token.startsWith('-') && !jobId) { jobId = token; continue; }
    return { jobId, model, background, error: `Unknown option: ${token}` };
  }

  if (!jobId) return { jobId, model, background, error: 'Missing <job-id>.' };
  return { jobId, model: model?.trim() || undefined, background };
}

/**
 * Resolve the equivalent `sp run` arguments for a failed activation.
 * Returns `{ argv }` on success or `{ error }` with an actionable message.
 */
export function buildRetryArgv(
  status: RetryStatusSnapshot,
  opts: { model?: string; background?: boolean },
): { argv: string[] } | { error: string } {
  if (!RETRYABLE_JOB_STATUSES.has(status.status)) {
    const hint = status.status === 'waiting'
      ? `Job ${status.id} is waiting — use: specialists resume ${status.id} "..."`
      : `Job ${status.id} is ${status.status} — use: specialists steer ${status.id} "..." (running) or specialists stop ${status.id} first.`;
    return { error: `Job ${status.id} is not terminal (status: ${status.status}). retry only re-dispatches error/cancelled jobs.\n${hint}` };
  }

  const argv = ['run', status.specialist];
  if (status.bead_id) argv.push('--bead', status.bead_id);
  // --job reuses the failed job's workspace lease (guarded by the normal run
  // path); without a worktree the run provisions fresh from --bead.
  if (status.worktree_path) argv.push('--job', status.id);
  if (!status.bead_id && !status.worktree_path) {
    return { error: `Cannot retry job ${status.id}: it has no bead binding and no workspace to reuse (ad-hoc prompt runs are not persisted).` };
  }
  if (opts.model) argv.push('--model', opts.model);
  if (opts.background) argv.push('--background');
  return { argv };
}

export async function run(): Promise<void> {
  const parsed = parseRetryArgs(process.argv.slice(3));
  if (parsed.error || !parsed.jobId) {
    console.error(parsed.error ?? 'Missing <job-id>.');
    console.error('Usage: specialists|sp retry <job-id> [--model <model>] [--background]');
    process.exit(1);
  }

  const jobsDir = resolveJobsDir();
  const supervisor = new Supervisor({ runner: null as any, runOptions: null as any, jobsDir });

  try {
    const status = supervisor.readStatus(parsed.jobId);
    if (!status) {
      console.error(`No job found: ${parsed.jobId}`);
      process.exit(1);
    }

    const resolved = buildRetryArgv(status, { model: parsed.model, background: parsed.background });
    if ('error' in resolved) {
      console.error(resolved.error);
      process.exit(1);
    }

    const child = spawnSync(process.execPath, [process.argv[1], ...resolved.argv], { stdio: 'inherit' });
    process.exit(child.status ?? 1);
  } finally {
    await supervisor.dispose();
  }
}
