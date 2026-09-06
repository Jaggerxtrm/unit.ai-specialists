/**
 * Keep the test suite off the repository's authoritative observability store.
 *
 * `resolveObservabilityDbLocation` falls back to `<gitRoot>/.specialists/db` when
 * XDG_DATA_HOME is unset. That is correct for production and catastrophic for tests: on
 * 2026-09-06 a full suite run with an unreleased schema migration in the tree migrated the
 * live store in place — 678,561 forensic rows — with no operator action, and concurrent
 * workers contending on that one file produced `database is locked` failures that read as
 * flaky tests.
 *
 * This relocates ONLY the repository's own directory, per test file. Forcing
 * XDG_DATA_HOME globally was tried first and is wrong: tests that build their own temp
 * repository expect git-root resolution INSIDE it, so a global override puts the writer
 * and the reader of a single test on different databases. A targeted relocation leaves
 * every legitimate pattern untouched.
 */

import { afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createObservabilitySqliteClientAtPath } from '../../src/specialist/observability-sqlite.js';

const isolated = mkdtempSync(join(tmpdir(), 'specialists-test-db-'));

process.env.SPECIALISTS_FORBID_DB_DIR = resolve(import.meta.dirname, '../../.specialists/db');
process.env.SPECIALISTS_FALLBACK_DB_DIR = isolated;

// Create the relocated store eagerly. `createObservabilitySqliteClient` returns null when
// the file is absent, and several supervisor and CLI tests require a real client — they
// used to get one only because they were opening the REPOSITORY's database. They need
// *a* store, not *the* store, so give them an empty migrated one.
createObservabilitySqliteClientAtPath(join(isolated, 'observability.db'))?.close();

afterAll(() => {
  rmSync(isolated, { recursive: true, force: true });
});
