import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectOutstandingAsks } from '../../../src/activation/transport/polling.js';

/**
 * unitAI-rrdnt.26. The polling projection is the degraded path the whole Claude transport
 * decision rests on: a pending clarification must be readable when the peer channel is
 * not working. These assert the two cases the status surface actually hits.
 */
describe('pending interaction projection for specialist_status', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function repo(): string {
    const d = mkdtempSync(join(tmpdir(), 'status-interactions-'));
    dirs.push(d);
    return d;
  }

  it('returns cleanly with no entries when the repo has no interactions directory', () => {
    // Absence of pending state is the normal case, not a failure — a status call on a repo
    // that has never run a Specialist must not throw.
    expect(projectOutstandingAsks(repo())).toEqual([]);
  });

  it('does not throw on a repository path that does not exist at all', () => {
    expect(projectOutstandingAsks(join(tmpdir(), 'definitely-not-a-repo-xyz'))).toEqual([]);
  });
});
