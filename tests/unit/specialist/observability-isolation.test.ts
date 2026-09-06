import { describe, it, expect } from 'vitest';
import { resolveObservabilityDbLocation } from '../../../src/specialist/observability-db.js';
import { resolve } from 'node:path';

/**
 * The canary for unitAI-rrdnt.16. If this fails, the suite can once again read and write
 * the repository's authoritative forensic store — which it did on 2026-09-06, migrating
 * 678,561 rows in place from a test run.
 *
 * `source` is deliberately still `git-root`: the resolution REASON is unchanged and the
 * relocation is a test-only override on top of it. Asserting the path rather than the
 * source keeps this test honest about what the guard actually does.
 */
describe('observability test isolation', () => {
  const repoDbDir = resolve(import.meta.dirname, '../../../.specialists/db');

  it('never resolves to the repository store, even from the repository root', () => {
    const location = resolveObservabilityDbLocation(process.cwd());

    expect(location.dbDirectory.startsWith(repoDbDir)).toBe(false);
    expect(location.dbPath.startsWith(repoDbDir)).toBe(false);
    // dbDirectory and dbPath must agree, or ensureObservabilityDbFile would mkdir one
    // place and write another — which would recreate the repository directory.
    expect(location.dbPath.startsWith(location.dbDirectory)).toBe(true);
  });

  it('arms the guard for every test file', () => {
    expect(process.env.SPECIALISTS_FORBID_DB_DIR).toBe(repoDbDir);
    expect(process.env.SPECIALISTS_FALLBACK_DB_DIR).toBeTruthy();
    expect(process.env.SPECIALISTS_FALLBACK_DB_DIR?.startsWith(repoDbDir)).toBe(false);
  });

  it('leaves a temp repository resolving inside itself, not to the fallback', () => {
    // The failure mode a global XDG_DATA_HOME override would cause: a test builds its own
    // git root, and writer and reader end up on different databases.
    const location = resolveObservabilityDbLocation('/tmp');
    expect(location.dbDirectory).not.toBe(process.env.SPECIALISTS_FALLBACK_DB_DIR);
  });
});
