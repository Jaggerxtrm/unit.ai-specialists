import { describe, expect, it } from 'vitest';
import { buildRetryArgv, parseRetryArgs, type RetryStatusSnapshot } from '../../../src/cli/retry.js';

const errorJob: RetryStatusSnapshot = {
  id: 'a1b2c3',
  specialist: 'debugger',
  status: 'error',
  bead_id: 'unitAI-1',
  worktree_path: '/tmp/wt',
};

describe('parseRetryArgs', () => {
  it('parses job id with model and background flags', () => {
    expect(parseRetryArgs(['a1b2c3', '--model', 'qwen', '--background'])).toEqual({
      jobId: 'a1b2c3',
      model: 'qwen',
      background: true,
    });
  });

  it('requires a job id', () => {
    expect(parseRetryArgs([]).error).toMatch(/job-id/i);
  });

  it('rejects unknown options', () => {
    expect(parseRetryArgs(['a1b2c3', '--bogus']).error).toMatch(/unknown option/i);
  });
});

describe('buildRetryArgv', () => {
  it('reuses bead and workspace lease, forwarding the manual model', () => {
    expect(buildRetryArgv(errorJob, { model: 'anthropic/claude-sonnet-4-5' })).toEqual({
      argv: ['run', 'debugger', '--bead', 'unitAI-1', '--job', 'a1b2c3', '--model', 'anthropic/claude-sonnet-4-5'],
    });
  });

  it('omits --job when the failed job has no workspace, omits --model when unset', () => {
    const job = { ...errorJob, worktree_path: undefined };
    expect(buildRetryArgv(job, {})).toEqual({ argv: ['run', 'debugger', '--bead', 'unitAI-1'] });
  });

  it('retries cancelled jobs (partial workspace state is preserved)', () => {
    const result = buildRetryArgv({ ...errorJob, status: 'cancelled' }, {});
    expect('argv' in result && result.argv).toContain('--job');
  });

  it('refuses jobs without bead or workspace', () => {
    const result = buildRetryArgv({ id: 'x', specialist: 's', status: 'error' }, {});
    expect('error' in result && result.error).toMatch(/no bead binding/i);
  });

  it('refuses non-terminal jobs with an actionable hint', () => {
    const waiting = buildRetryArgv({ ...errorJob, status: 'waiting' }, {});
    expect('error' in waiting && waiting.error).toMatch(/resume/);

    const running = buildRetryArgv({ ...errorJob, status: 'running' }, {});
    expect('error' in running && running.error).toMatch(/steer/);
  });
});
