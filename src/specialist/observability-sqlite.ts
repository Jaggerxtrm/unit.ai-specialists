import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';

// bun:sqlite is Bun-only — lazy-load to avoid breaking Node/vitest imports.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BunDb = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _BunDatabase: (new (path: string) => BunDb) | null = null;
let _probed = false;
function loadBunDatabase(): (new (path: string) => BunDb) | null {
  if (_probed) return _BunDatabase;
  _probed = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _BunDatabase = require('bun:sqlite').Database;
  } catch {
    _BunDatabase = null;
  }
  return _BunDatabase;
}
import { resolveObservabilityDbLocation } from './observability-db.js';
import { resolveJobsDir } from './job-root.js';
import type { TimelineEvent, TimelineEventTool } from './timeline-events.js';
import { deriveParticipantId, forensicEventFromTimelineEvent, type ForensicEvent } from './forensic-events.js';
import type { BranchIntegrationEvent } from './branch-integration-events.js';
import type { SupervisorStatus } from './supervisor.js';
import type { EpicChainRecord, EpicRunRecord } from './epic-lifecycle.js';
import type { PersistedChainIdentity } from './chain-identity.js';

const BUSY_TIMEOUT_MS = 5000;
const MAX_RETRY_ATTEMPTS = 5;
const BASE_RETRY_DELAY_MS = 50;

function toSqlNumber(value: number | undefined): string {
  return value === undefined ? 'NULL' : String(value);
}

/**
 * Calculate retry delay with exponential backoff and jitter.
 * Formula: min(baseDelay * 2^attempt + random(0, baseDelay), busyTimeout)
 */
function calculateRetryDelay(attempt: number): number {
  const exponentialDelay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * BASE_RETRY_DELAY_MS;
  return Math.min(exponentialDelay + jitter, BUSY_TIMEOUT_MS);
}

/**
 * Execute a database operation with bounded retry logic.
 * Retries on SQLITE_BUSY (5) and SQLITE_LOCKED (6) errors.
 */
function withRetry<T>(operation: () => T, context: string): T {
  let lastError: Error | undefined;
  
  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      return operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (lastError.message.includes('Cannot use a closed database')) {
        throw new Error(`[observability-sqlite] SQLite client is closed (${context})`);
      }

      // Check if it's a retryable SQLite error
      const isRetryable =
        lastError.message.includes('SQLITE_BUSY') ||
        lastError.message.includes('SQLITE_LOCKED') ||
        lastError.message.includes('database is locked') ||
        lastError.message.includes('database is busy');

      if (!isRetryable || attempt === MAX_RETRY_ATTEMPTS - 1) {
        break;
      }
      
      const delayMs = calculateRetryDelay(attempt);
      Bun.sleepSync(delayMs);
    }
  }
  
  throw new Error(`Failed after ${MAX_RETRY_ATTEMPTS} attempts (${context}): ${lastError?.message ?? 'unknown error'}`);
}

export function parseJournalMode(mode: string | null | undefined): string | null {
  if (!mode) return null;
  return mode.toLowerCase();
}

export function enforceWalMode(db: BunDb): void {
  const result = db.query('PRAGMA journal_mode=WAL').get() as { journal_mode?: string };
  const mode = parseJournalMode(result?.journal_mode);
  if (mode !== 'wal') {
    throw new Error(`Failed to enable WAL journal mode (got: ${mode ?? 'null'})`);
  }
}

export function verifyWalMode(db: BunDb): void {
  const result = db.query('PRAGMA journal_mode').get() as { journal_mode?: string };
  const mode = parseJournalMode(result?.journal_mode);
  if (mode !== 'wal') {
    throw new Error(`WAL journal mode is not active (got: ${mode ?? 'null'})`);
  }
}

function migrateToV2(db: BunDb): void {
  const hasV2 = db.query('SELECT 1 FROM schema_version WHERE version = 2 LIMIT 1').get() as { 1?: number } | undefined;
  if (hasV2) {
    db.run('CREATE INDEX IF NOT EXISTS idx_jobs_bead ON specialist_jobs(bead_id) WHERE bead_id IS NOT NULL');
    return;
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS specialist_jobs_v2 (
      job_id          TEXT PRIMARY KEY,
      specialist      TEXT NOT NULL,
      worktree_column TEXT,
      status_json     TEXT NOT NULL,
      bead_id         TEXT,
      updated_at_ms   INTEGER NOT NULL,
      last_output     TEXT,
      startup_payload_json TEXT
    );
    INSERT OR IGNORE INTO specialist_jobs_v2
      SELECT
        job_id,
        specialist,
        worktree_column,
        status_json,
        JSON_EXTRACT(status_json, '$.bead_id'),
        updated_at_ms,
        last_output,
        startup_payload_json
      FROM specialist_jobs;
    DROP TABLE IF EXISTS specialist_jobs;
    ALTER TABLE specialist_jobs_v2 RENAME TO specialist_jobs;
    CREATE INDEX IF NOT EXISTS idx_jobs_bead ON specialist_jobs(bead_id) WHERE bead_id IS NOT NULL;
    INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
      VALUES (2, strftime('%s', 'now') * 1000);
  `);
}

function migrateToV3(db: BunDb): void {
  const hasV3 = db.query('SELECT 1 FROM schema_version WHERE version = 3 LIMIT 1').get() as { 1?: number } | undefined;
  if (hasV3) {
    db.run('CREATE INDEX IF NOT EXISTS idx_jobs_status ON specialist_jobs(status)');
    db.run('CREATE INDEX IF NOT EXISTS idx_jobs_node ON specialist_jobs(node_id) WHERE node_id IS NOT NULL');
    db.run('CREATE INDEX IF NOT EXISTS idx_jobs_status_updated ON specialist_jobs(status, updated_at_ms DESC)');
    return;
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS specialist_jobs_v3 (
      job_id          TEXT PRIMARY KEY,
      specialist      TEXT NOT NULL,
      worktree_column TEXT,
      bead_id         TEXT,
      node_id         TEXT,
      status          TEXT NOT NULL,
      status_json     TEXT NOT NULL,
      updated_at_ms   INTEGER NOT NULL,
      last_output     TEXT,
      startup_payload_json TEXT
    );
    INSERT OR IGNORE INTO specialist_jobs_v3
      SELECT
        job_id,
        specialist,
        worktree_column,
        bead_id,
        NULL,
        COALESCE(JSON_EXTRACT(status_json, '$.status'), 'starting'),
        status_json,
        updated_at_ms,
        last_output,
        startup_payload_json
      FROM specialist_jobs;
    DROP TABLE IF EXISTS specialist_jobs;
    ALTER TABLE specialist_jobs_v3 RENAME TO specialist_jobs;
    CREATE INDEX IF NOT EXISTS idx_jobs_bead ON specialist_jobs(bead_id) WHERE bead_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON specialist_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_node ON specialist_jobs(node_id) WHERE node_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_jobs_status_updated ON specialist_jobs(status, updated_at_ms DESC);
    INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
      VALUES (3, strftime('%s', 'now') * 1000);
  `);
}

function migrateToV11(db: BunDb): void {
  const hasV11 = db.query('SELECT 1 FROM schema_version WHERE version = 11 LIMIT 1').get() as { 1?: number } | undefined;

  if (hasV11) {
    const metricsColumns = new Set(
      (db.query('PRAGMA table_info(specialist_job_metrics)').all() as Array<{ name?: string }>)
        .map((column) => column.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0),
    );

    for (const column of [
      { name: 'active_runtime_ms', definition: 'INTEGER' },
      { name: 'waiting_ms', definition: 'INTEGER' },
      { name: 'startup_payload_json', definition: 'TEXT' },
    ]) {
      if (!metricsColumns.has(column.name)) {
        db.run(`ALTER TABLE specialist_job_metrics ADD COLUMN ${column.name} ${column.definition}`);
      }
    }

    db.run('CREATE INDEX IF NOT EXISTS idx_job_metrics_spec_model_updated ON specialist_job_metrics(specialist, model, updated_at_ms DESC)');
    db.run('CREATE INDEX IF NOT EXISTS idx_job_metrics_updated ON specialist_job_metrics(updated_at_ms DESC)');
    return;
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS specialist_job_metrics (
      job_id TEXT PRIMARY KEY,
      specialist TEXT NOT NULL,
      model TEXT,
      status TEXT NOT NULL,
      chain_kind TEXT,
      chain_id TEXT,
      bead_id TEXT,
      node_id TEXT,
      epic_id TEXT,
      started_at_ms INTEGER,
      completed_at_ms INTEGER,
      elapsed_ms INTEGER,
      active_runtime_ms INTEGER,
      waiting_ms INTEGER,
      total_turns INTEGER NOT NULL DEFAULT 0,
      total_tools INTEGER NOT NULL DEFAULT 0,
      tool_call_counts_json TEXT NOT NULL,
      token_trajectory_json TEXT NOT NULL,
      context_trajectory_json TEXT NOT NULL,
      stall_gaps_json TEXT NOT NULL,
      run_complete_json TEXT,
      startup_payload_json TEXT,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_job_metrics_spec_model_updated ON specialist_job_metrics(specialist, model, updated_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_job_metrics_updated ON specialist_job_metrics(updated_at_ms DESC);
    INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
      VALUES (11, strftime('%s', 'now') * 1000);
  `);
}

function migrateToV12(db: BunDb): void {
  const hasV12 = db.query('SELECT 1 FROM schema_version WHERE version = 12 LIMIT 1').get() as { 1?: number } | undefined;

  db.run(`
    CREATE TABLE IF NOT EXISTS specialist_forensic_events (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id             TEXT NOT NULL,
      seq                INTEGER NOT NULL,
      t                  INTEGER NOT NULL,
      schema_version     TEXT NOT NULL,
      event_family       TEXT NOT NULL,
      event_name         TEXT NOT NULL,
      participant_kind   TEXT,
      participant_role   TEXT,
      participant_id     TEXT,
      redaction_status   TEXT NOT NULL,
      event_json         TEXT NOT NULL
    );
  `);
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_forensic_events_job_seq ON specialist_forensic_events(job_id, seq)');
  db.run('CREATE INDEX IF NOT EXISTS idx_forensic_events_job_t ON specialist_forensic_events(job_id, t, seq, id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_forensic_events_family ON specialist_forensic_events(event_family, event_name, t)');
  db.run('CREATE INDEX IF NOT EXISTS idx_forensic_events_participant ON specialist_forensic_events(participant_kind, participant_role, t)');

  if (hasV12) return;

  db.run(`
    INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
      VALUES (12, strftime('%s', 'now') * 1000);
  `);
}

function parseJsonRecord(input: string | null | undefined): Record<string, unknown> {
  if (!input) return {};
  try {
    const parsed = JSON.parse(input) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readNumber(input: unknown): number | null {
  return typeof input === 'number' && Number.isFinite(input) ? input : null;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

// V15 identity helpers (unitAI-rrdnt.2). Workspace rule: normalize(resolve(path))
// only — no realpath, repo-root, or git-common-dir normalization, so linked
// worktree paths remain distinct mutable workspaces.
function normalizeWorkspacePath(worktreePath: string | null | undefined): string | null {
  if (!worktreePath || worktreePath.trim().length === 0) return null;
  return normalize(resolve(worktreePath));
}

function buildAttemptId(jobId: string, attemptNo: number): string {
  return `${jobId}::attempt::${attemptNo}`;
}

function isRetryStartEvent(event: { type: string; phase?: unknown }): boolean {
  return event.type === 'retry' && event.phase === 'start';
}

function migrateToV4(db: BunDb): void {
  const hasV4 = db.query('SELECT 1 FROM schema_version WHERE version = 4 LIMIT 1').get() as { 1?: number } | undefined;
  if (hasV4) {
    db.run('CREATE TABLE IF NOT EXISTS node_runs (id TEXT PRIMARY KEY, node_name TEXT NOT NULL, status TEXT NOT NULL, coordinator_job_id TEXT, started_at_ms INTEGER, updated_at_ms INTEGER NOT NULL, waiting_on TEXT, error TEXT, memory_namespace TEXT, status_json TEXT NOT NULL)');
    db.run('CREATE INDEX IF NOT EXISTS idx_node_runs_status ON node_runs(status)');

    db.run('CREATE TABLE IF NOT EXISTS node_members (id INTEGER PRIMARY KEY AUTOINCREMENT, node_run_id TEXT NOT NULL, member_id TEXT NOT NULL, job_id TEXT, specialist TEXT NOT NULL, model TEXT, role TEXT, status TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, generation INTEGER NOT NULL DEFAULT 0)');
    db.run('CREATE INDEX IF NOT EXISTS idx_node_members_run ON node_members(node_run_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_node_members_job ON node_members(job_id) WHERE job_id IS NOT NULL');
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_node_members_run_member ON node_members(node_run_id, member_id)');

    db.run('CREATE TABLE IF NOT EXISTS node_events (id INTEGER PRIMARY KEY AUTOINCREMENT, node_run_id TEXT NOT NULL, seq INTEGER NOT NULL, t INTEGER NOT NULL, type TEXT NOT NULL, event_json TEXT NOT NULL)');
    // seq-dependent indexes handled by migrateToV6 for existing DBs without seq column
    db.run('CREATE INDEX IF NOT EXISTS idx_node_events_type ON node_events(type)');

    db.run('CREATE TABLE IF NOT EXISTS node_memory (id INTEGER PRIMARY KEY AUTOINCREMENT, node_run_id TEXT NOT NULL, namespace TEXT, entry_type TEXT, entry_id TEXT, summary TEXT, source_member_id TEXT, confidence REAL, provenance_json TEXT, created_at_ms INTEGER, updated_at_ms INTEGER)');
    db.run('CREATE INDEX IF NOT EXISTS idx_node_memory_run ON node_memory(node_run_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_node_memory_entry_id ON node_memory(entry_id) WHERE entry_id IS NOT NULL');
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_node_memory_run_entry ON node_memory(node_run_id, entry_id) WHERE entry_id IS NOT NULL');
    return;
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS node_runs (
      id                 TEXT PRIMARY KEY,
      node_name          TEXT NOT NULL,
      status             TEXT NOT NULL,
      coordinator_job_id TEXT,
      started_at_ms      INTEGER,
      updated_at_ms      INTEGER NOT NULL,
      waiting_on         TEXT,
      error              TEXT,
      memory_namespace   TEXT,
      status_json        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_node_runs_status ON node_runs(status);

    CREATE TABLE IF NOT EXISTS node_members (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      node_run_id  TEXT NOT NULL,
      member_id    TEXT NOT NULL,
      job_id       TEXT,
      specialist   TEXT NOT NULL,
      model        TEXT,
      role         TEXT,
      status       TEXT NOT NULL,
      enabled      INTEGER NOT NULL DEFAULT 1,
      generation   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_node_members_run ON node_members(node_run_id);
    CREATE INDEX IF NOT EXISTS idx_node_members_job ON node_members(job_id) WHERE job_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_node_members_run_member ON node_members(node_run_id, member_id);

    CREATE TABLE IF NOT EXISTS node_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      node_run_id  TEXT NOT NULL,
      seq          INTEGER NOT NULL,
      t            INTEGER NOT NULL,
      type         TEXT NOT NULL,
      event_json   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_node_events_run_seq ON node_events(node_run_id, seq);
    CREATE INDEX IF NOT EXISTS idx_node_events_run_t ON node_events(node_run_id, t, seq, id);
    CREATE INDEX IF NOT EXISTS idx_node_events_type ON node_events(type);

    CREATE TABLE IF NOT EXISTS node_memory (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      node_run_id      TEXT NOT NULL,
      namespace        TEXT,
      entry_type       TEXT,
      entry_id         TEXT,
      summary          TEXT,
      source_member_id TEXT,
      confidence       REAL,
      provenance_json  TEXT,
      created_at_ms    INTEGER,
      updated_at_ms    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_node_memory_run ON node_memory(node_run_id);
    CREATE INDEX IF NOT EXISTS idx_node_memory_entry_id ON node_memory(entry_id) WHERE entry_id IS NOT NULL;

    INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
      VALUES (4, strftime('%s', 'now') * 1000);
  `);
}

export function initSchema(db: BunDb): void {
  enforceWalMode(db);

  // Step 1: core tables + schema_version (must run before migration)
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version     INTEGER PRIMARY KEY,
      applied_at_ms INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
      VALUES (1, strftime('%s', 'now') * 1000);

    -- Ensure specialist_jobs exists with at least the base columns so the
    -- migration INSERT below can always SELECT from it.
    CREATE TABLE IF NOT EXISTS specialist_jobs (
      job_id       TEXT PRIMARY KEY,
      specialist   TEXT NOT NULL,
      status_json  TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS specialist_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id       TEXT NOT NULL,
      seq          INTEGER NOT NULL,
      specialist   TEXT NOT NULL,
      bead_id      TEXT,
      t            INTEGER NOT NULL,
      type         TEXT NOT NULL,
      event_json   TEXT NOT NULL
    );
    -- seq-dependent indexes are created/maintained by migrateToV6 to handle
    -- existing DBs where specialist_events was created without the seq column.
    CREATE INDEX IF NOT EXISTS idx_specialist_events_type ON specialist_events(type);

    CREATE TABLE IF NOT EXISTS specialist_results (
      job_id        TEXT PRIMARY KEY,
      output        TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memories_cache (
      memory_key           TEXT PRIMARY KEY,
      memory_value         TEXT NOT NULL,
      updated_at_ms        INTEGER NOT NULL,
      last_accessed_at_ms  INTEGER,
      access_count         INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS memories_cache_meta (
      singleton_key    INTEGER PRIMARY KEY CHECK (singleton_key = 1),
      last_sync_at_ms  INTEGER NOT NULL,
      memory_count     INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      key,
      content,
      tokenize='porter ascii'
    );
  `);

  const specialistJobsColumns = new Set(
    (db.query('PRAGMA table_info(specialist_jobs)').all() as Array<{ name?: string }>)
      .map((column) => column.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
  );

  const missingSpecialistJobsColumns: Array<{ name: string; definition: string }> = [
    { name: 'worktree_column', definition: 'TEXT' },
    { name: 'bead_id', definition: 'TEXT' },
    { name: 'node_id', definition: 'TEXT' },
    { name: 'chain_kind', definition: "TEXT NOT NULL DEFAULT 'prep'" },
    { name: 'chain_id', definition: 'TEXT' },
    { name: 'chain_root_job_id', definition: 'TEXT' },
    { name: 'chain_root_bead_id', definition: 'TEXT' },
    { name: 'epic_id', definition: 'TEXT' },
    { name: 'status', definition: "TEXT NOT NULL DEFAULT 'starting'" },
    { name: 'last_output', definition: 'TEXT' },
    { name: 'startup_payload_json', definition: 'TEXT' },
  ].filter(({ name }) => !specialistJobsColumns.has(name));

  for (const missingColumn of missingSpecialistJobsColumns) {
    db.run(`ALTER TABLE specialist_jobs ADD COLUMN ${missingColumn.name} ${missingColumn.definition}`);
  }

  const shouldRebuildSpecialistJobs = missingSpecialistJobsColumns.length > 0;

  // Step 2: idempotent v1 migration — rebuild specialist_jobs with a superset
  // of columns. Only run when upgrading legacy schemas to avoid DROP/RENAME churn
  // on already-migrated DBs.
  if (shouldRebuildSpecialistJobs) {
    db.run(`
      CREATE TABLE IF NOT EXISTS specialist_jobs_new (
        job_id          TEXT PRIMARY KEY,
        specialist      TEXT NOT NULL,
        worktree_column TEXT,
        bead_id         TEXT,
        node_id         TEXT,
        chain_kind      TEXT NOT NULL DEFAULT 'prep',
        chain_id        TEXT,
        chain_root_job_id TEXT,
        chain_root_bead_id TEXT,
        epic_id         TEXT,
        status          TEXT NOT NULL,
        status_json     TEXT NOT NULL,
        updated_at_ms   INTEGER NOT NULL,
        last_output     TEXT,
        startup_payload_json TEXT
      );
      INSERT OR IGNORE INTO specialist_jobs_new
        SELECT
          job_id,
          specialist,
          worktree_column,
          bead_id,
          node_id,
          COALESCE(chain_kind, CASE WHEN chain_id IS NOT NULL OR worktree_column IS NOT NULL THEN 'chain' ELSE 'prep' END),
          chain_id,
          COALESCE(chain_root_job_id, chain_id),
          chain_root_bead_id,
          epic_id,
          COALESCE(status, JSON_EXTRACT(status_json, '$.status'), 'starting'),
          status_json,
          updated_at_ms,
          last_output,
          startup_payload_json
        FROM specialist_jobs;
      DROP TABLE IF EXISTS specialist_jobs;
      ALTER TABLE specialist_jobs_new RENAME TO specialist_jobs;
    `);
  }
  migrateToV2(db);
  migrateToV3(db);
  migrateToV4(db);
  migrateToV5(db);
  migrateToV6(db);
  migrateToV7(db);
  migrateToV8(db);
  migrateToV9(db);
  migrateToV10(db);
  migrateToV11(db);
  migrateToV12(db);
  migrateToV13(db);
  migrateToV14(db);
  migrateToV15(db);
  verifyWalMode(db);
}

// V13 — durable PR/base drift fields on specialist_jobs. specialists-05q.1.
// Additive nullable columns; bridge for substrate `containers.pr_*` /
// `containers.base_sha_pinned*` rename (specialists-roadmap §B.3).
function migrateToV13(db: BunDb): void {
  const hasV13 = db.query('SELECT 1 FROM schema_version WHERE version = 13 LIMIT 1').get() as { 1?: number } | undefined;

  const specialistJobsColumns = new Set(
    (db.query('PRAGMA table_info(specialist_jobs)').all() as Array<{ name?: string }>)
      .map((column) => column.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
  );

  for (const column of [
    { name: 'pr_url', definition: 'TEXT' },
    { name: 'pr_head_sha', definition: 'TEXT' },
    { name: 'pr_state', definition: 'TEXT' },
    { name: 'pr_merge_state', definition: 'TEXT' },
    { name: 'pr_classification', definition: 'TEXT' },
    { name: 'pr_base_ref', definition: 'TEXT' },
    { name: 'pr_base_sha', definition: 'TEXT' },
    { name: 'pr_drift_checked_at_ms', definition: 'INTEGER' },
    { name: 'base_sha_pinned', definition: 'TEXT' },
    { name: 'base_sha_pinned_at_ms', definition: 'INTEGER' },
  ]) {
    if (!specialistJobsColumns.has(column.name)) {
      db.run(`ALTER TABLE specialist_jobs ADD COLUMN ${column.name} ${column.definition}`);
    }
  }

  if (hasV13) {
    return;
  }

  db.run(`
    INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
      VALUES (13, strftime('%s', 'now') * 1000);
  `);
}

// V14 — branch_integration_events: append-only RESULT records for
// `xtrm.branch.integration.v1` (audit 11.md §P2-04). Observation only; git
// remains the merge authority. unitAI-cnpvd.2.
function migrateToV14(db: BunDb): void {
  const hasV14 = db.query('SELECT 1 FROM schema_version WHERE version = 14 LIMIT 1').get() as { 1?: number } | undefined;

  db.run(`
    CREATE TABLE IF NOT EXISTS branch_integration_events (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      t                 INTEGER NOT NULL,
      schema_version    TEXT NOT NULL,
      source_job_id     TEXT NOT NULL,
      source_branch     TEXT NOT NULL,
      source_worktree   TEXT NOT NULL,
      target_role       TEXT,
      target_branch     TEXT NOT NULL,
      target_worktree   TEXT NOT NULL,
      status            TEXT NOT NULL,
      commit_sha        TEXT NOT NULL,
      event_json        TEXT NOT NULL
    );
  `);
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_branch_integration_source_commit ON branch_integration_events(source_branch, commit_sha)');
  db.run('CREATE INDEX IF NOT EXISTS idx_branch_integration_target ON branch_integration_events(target_branch, t)');
  db.run('CREATE INDEX IF NOT EXISTS idx_branch_integration_source_job ON branch_integration_events(source_job_id, t)');

  if (hasV14) return;

  db.run(`
    INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
      VALUES (14, strftime('%s', 'now') * 1000);
  `);
}

// V15 — identity lineage: attempt_id, columnar pi_session_id/workspace_id,
// chain-independent participant_id. unitAI-rrdnt.2.
//
// Migration contract (normative):
// - Additive and idempotent: only ADD COLUMN / CREATE INDEX IF NOT EXISTS plus
//   columnar backfill. No shadow/new table, no event_json/status_json mutation
//   or removal — the column is a normalized query projection; the blob is the
//   original forensic record, never rewritten.
// - workspace_id uses normalize(resolve(path)) without realpath, repo-root, or
//   git-common-dir normalization, so linked worktree paths remain distinct
//   mutable workspaces. Known ceiling: a symlinked worktree path and its real
//   path become two different workspace_ids.
// - participant_id is recomputed as `specialist::<specialist>` (jobs) /
//   `specialist::<participant_role>` (forensic rows). `specialist::<unknown>`
//   means exactly "role not recoverable", NOT a participant named unknown;
//   acceptance/rollup queries must exclude sentinel rows, never aggregate them
//   as a participant. A read-only dry run over the repository's v14 store found
//   zero sentinel rows; the guard is exercised only by the synthetic v15 fixture.
// - Legacy rows keep attempt_no = 0 and attempt_id = NULL; no attempt 1 is
//   invented by the migration.
function migrateToV15(db: BunDb): void {
  const hasV15 = db.query('SELECT 1 FROM schema_version WHERE version = 15 LIMIT 1').get() as { 1?: number } | undefined;

  const jobsColumns = new Set(
    (db.query('PRAGMA table_info(specialist_jobs)').all() as Array<{ name?: string }>)
      .map((column) => column.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
  );
  for (const column of [
    { name: 'participant_id', definition: 'TEXT' },
    { name: 'pi_session_id', definition: 'TEXT' },
    { name: 'workspace_id', definition: 'TEXT' },
    { name: 'attempt_no', definition: 'INTEGER DEFAULT 0' },
    { name: 'attempt_id', definition: 'TEXT' },
  ]) {
    if (!jobsColumns.has(column.name)) {
      db.run(`ALTER TABLE specialist_jobs ADD COLUMN ${column.name} ${column.definition}`);
    }
  }

  const eventsColumns = new Set(
    (db.query('PRAGMA table_info(specialist_events)').all() as Array<{ name?: string }>)
      .map((column) => column.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
  );
  if (!eventsColumns.has('attempt_id')) {
    db.run('ALTER TABLE specialist_events ADD COLUMN attempt_id TEXT');
  }

  const forensicColumns = new Set(
    (db.query('PRAGMA table_info(specialist_forensic_events)').all() as Array<{ name?: string }>)
      .map((column) => column.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
  );
  if (!forensicColumns.has('attempt_id')) {
    db.run('ALTER TABLE specialist_forensic_events ADD COLUMN attempt_id TEXT');
  }

  db.run('CREATE INDEX IF NOT EXISTS idx_jobs_participant ON specialist_jobs(participant_id) WHERE participant_id IS NOT NULL');
  db.run('CREATE INDEX IF NOT EXISTS idx_jobs_pi_session ON specialist_jobs(pi_session_id) WHERE pi_session_id IS NOT NULL');
  db.run('CREATE INDEX IF NOT EXISTS idx_jobs_workspace ON specialist_jobs(workspace_id) WHERE workspace_id IS NOT NULL');
  db.run('CREATE INDEX IF NOT EXISTS idx_specialist_events_job_attempt ON specialist_events(job_id, attempt_id, seq) WHERE attempt_id IS NOT NULL');
  db.run('CREATE INDEX IF NOT EXISTS idx_forensic_events_job_attempt ON specialist_forensic_events(job_id, attempt_id, seq) WHERE attempt_id IS NOT NULL');

  if (hasV15) return;

  const backfill = db.transaction(() => {
    db.run(`
      UPDATE specialist_jobs
      SET pi_session_id = NULLIF(JSON_EXTRACT(status_json, '$.session_id'), '')
    `);
    db.run(`
      UPDATE specialist_jobs
      SET participant_id = 'specialist::' || COALESCE(NULLIF(TRIM(specialist), ''), '<unknown>')
    `);
    db.run(`
      UPDATE specialist_jobs
      SET attempt_no = 0
      WHERE attempt_no IS NULL
    `);

    const worktreeRows = db.query(`
      SELECT job_id, worktree_column
      FROM specialist_jobs
      WHERE worktree_column IS NOT NULL AND worktree_column != ''
    `).all() as Array<{ job_id?: string; worktree_column?: string }>;
    const workspaceStmt = db.query('UPDATE specialist_jobs SET workspace_id = ? WHERE job_id = ?');
    for (const row of worktreeRows) {
      if (!row.job_id || !row.worktree_column) continue;
      workspaceStmt.run(normalizeWorkspacePath(row.worktree_column), row.job_id);
    }

    db.run(`
      UPDATE specialist_forensic_events AS forensic
      SET participant_id = 'specialist::' || COALESCE(
        NULLIF(TRIM(forensic.participant_role), ''),
        NULLIF(TRIM((
          SELECT jobs.specialist
          FROM specialist_jobs AS jobs
          WHERE jobs.job_id = forensic.job_id
          LIMIT 1
        )), ''),
        '<unknown>'
      )
      WHERE forensic.participant_kind = 'specialist'
    `);

    db.run(`
      INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
        VALUES (15, strftime('%s', 'now') * 1000);
    `);
  });
  backfill();
}

function migrateToV5(db: BunDb): void {
  const hasV5 = db.query('SELECT 1 FROM schema_version WHERE version = 5 LIMIT 1').get() as { 1?: number } | undefined;
  if (!hasV5) {
    const nodeMemberColumns = new Set(
      (db.query('PRAGMA table_info(node_members)').all() as Array<{ name?: string }>)
        .map((column) => column.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0),
    );
    if (!nodeMemberColumns.has('generation')) {
      db.run('ALTER TABLE node_members ADD COLUMN generation INTEGER NOT NULL DEFAULT 0');
    }

    db.run(`
      INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
        VALUES (5, strftime('%s', 'now') * 1000);
    `);
  }
}

function migrateToV6(db: BunDb): void {
  const hasV6 = db.query('SELECT 1 FROM schema_version WHERE version = 6 LIMIT 1').get() as { 1?: number } | undefined;
  if (hasV6) {
    db.run('CREATE INDEX IF NOT EXISTS idx_specialist_events_job_seq ON specialist_events(job_id, seq)');
    db.run('CREATE INDEX IF NOT EXISTS idx_specialist_events_job_t ON specialist_events(job_id, t, seq, id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_node_events_run_seq ON node_events(node_run_id, seq)');
    db.run('CREATE INDEX IF NOT EXISTS idx_node_events_run_t ON node_events(node_run_id, t, seq, id)');
    return;
  }

  const specialistEventColumns = new Set(
    (db.query('PRAGMA table_info(specialist_events)').all() as Array<{ name?: string }>)
      .map((column) => column.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
  );

  if (!specialistEventColumns.has('seq')) {
    db.run('ALTER TABLE specialist_events ADD COLUMN seq INTEGER');
  }
  db.run(`
    UPDATE specialist_events
    SET seq = (
      SELECT COUNT(*)
      FROM specialist_events prior
      WHERE prior.job_id = specialist_events.job_id
        AND prior.id <= specialist_events.id
    )
    WHERE seq IS NULL OR seq <= 0
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_specialist_events_job_seq ON specialist_events(job_id, seq)');
  db.run('CREATE INDEX IF NOT EXISTS idx_specialist_events_job_t ON specialist_events(job_id, t, seq, id)');

  const nodeEventColumns = new Set(
    (db.query('PRAGMA table_info(node_events)').all() as Array<{ name?: string }>)
      .map((column) => column.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
  );

  if (!nodeEventColumns.has('seq')) {
    db.run('ALTER TABLE node_events ADD COLUMN seq INTEGER');
  }
  db.run(`
    UPDATE node_events
    SET seq = (
      SELECT COUNT(*)
      FROM node_events prior
      WHERE prior.node_run_id = node_events.node_run_id
        AND prior.id <= node_events.id
    )
    WHERE seq IS NULL OR seq <= 0
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_node_events_run_seq ON node_events(node_run_id, seq)');
  db.run('CREATE INDEX IF NOT EXISTS idx_node_events_run_t ON node_events(node_run_id, t, seq, id)');

  db.run(`
    INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
      VALUES (6, strftime('%s', 'now') * 1000);
  `);
}

function migrateToV7(db: BunDb): void {
  const hasV7 = db.query('SELECT 1 FROM schema_version WHERE version = 7 LIMIT 1').get() as { 1?: number } | undefined;

  const nodeRunColumns = new Set(
    (db.query('PRAGMA table_info(node_runs)').all() as Array<{ name?: string }>)
      .map((column) => column.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
  );

  for (const column of [
    { name: 'pr_number', definition: 'INTEGER' },
    { name: 'pr_url', definition: 'TEXT' },
    { name: 'pr_head_sha', definition: 'TEXT' },
    { name: 'gate_results', definition: 'TEXT' },
    { name: 'completion_strategy', definition: 'TEXT' },
  ]) {
    if (!nodeRunColumns.has(column.name)) {
      db.run(`ALTER TABLE node_runs ADD COLUMN ${column.name} ${column.definition}`);
    }
  }

  const nodeMemberColumns = new Set(
    (db.query('PRAGMA table_info(node_members)').all() as Array<{ name?: string }>)
      .map((column) => column.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
  );

  for (const column of [
    { name: 'worktree_path', definition: 'TEXT' },
    { name: 'parent_member_id', definition: 'TEXT' },
    { name: 'replaced_member_id', definition: 'TEXT' },
    { name: 'phase_id', definition: 'TEXT' },
  ]) {
    if (!nodeMemberColumns.has(column.name)) {
      db.run(`ALTER TABLE node_members ADD COLUMN ${column.name} ${column.definition}`);
    }
  }

  if (hasV7) {
    return;
  }

  db.run(`
    INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
      VALUES (7, strftime('%s', 'now') * 1000);
  `);
}

function migrateToV8(db: BunDb): void {
  const hasV8 = db.query('SELECT 1 FROM schema_version WHERE version = 8 LIMIT 1').get() as { 1?: number } | undefined;

  const specialistJobsColumns = new Set(
    (db.query('PRAGMA table_info(specialist_jobs)').all() as Array<{ name?: string }>)
      .map((column) => column.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
  );

  for (const column of [
    { name: 'chain_id', definition: 'TEXT' },
    { name: 'epic_id', definition: 'TEXT' },
  ]) {
    if (!specialistJobsColumns.has(column.name)) {
      db.run(`ALTER TABLE specialist_jobs ADD COLUMN ${column.name} ${column.definition}`);
    }
  }

  db.run('CREATE INDEX IF NOT EXISTS idx_jobs_chain ON specialist_jobs(chain_id) WHERE chain_id IS NOT NULL');
  db.run('CREATE INDEX IF NOT EXISTS idx_jobs_epic ON specialist_jobs(epic_id) WHERE epic_id IS NOT NULL');
  db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_bead_specialist ON specialist_jobs(bead_id, specialist) WHERE bead_id IS NOT NULL AND status IN ('starting', 'running')");

  db.run(`
    CREATE TABLE IF NOT EXISTS epic_runs (
      epic_id         TEXT PRIMARY KEY,
      status          TEXT NOT NULL,
      status_json     TEXT NOT NULL,
      updated_at_ms   INTEGER NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS epic_chain_membership (
      chain_id            TEXT PRIMARY KEY,
      epic_id             TEXT NOT NULL,
      chain_root_bead_id  TEXT,
      chain_root_job_id   TEXT,
      updated_at_ms       INTEGER NOT NULL
    );
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_epic_runs_status ON epic_runs(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_epic_chain_membership_epic ON epic_chain_membership(epic_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_epic_chain_membership_bead ON epic_chain_membership(chain_root_bead_id) WHERE chain_root_bead_id IS NOT NULL');

  if (hasV8) {
    return;
  }

  db.run(`
    INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
      VALUES (8, strftime('%s', 'now') * 1000);
  `);
}

function migrateToV9(db: BunDb): void {
  const hasV9 = db.query('SELECT 1 FROM schema_version WHERE version = 9 LIMIT 1').get() as { 1?: number } | undefined;

  const specialistJobsColumns = new Set(
    (db.query('PRAGMA table_info(specialist_jobs)').all() as Array<{ name?: string }>)
      .map((column) => column.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
  );

  for (const column of [
    { name: 'chain_kind', definition: "TEXT NOT NULL DEFAULT 'prep'" },
    { name: 'chain_root_job_id', definition: 'TEXT' },
    { name: 'chain_root_bead_id', definition: 'TEXT' },
  ]) {
    if (!specialistJobsColumns.has(column.name)) {
      db.run(`ALTER TABLE specialist_jobs ADD COLUMN ${column.name} ${column.definition}`);
    }
  }

  db.run(`
    UPDATE specialist_jobs
    SET chain_kind = CASE
      WHEN chain_id IS NOT NULL OR worktree_column IS NOT NULL THEN 'chain'
      ELSE 'prep'
    END
    WHERE chain_kind IS NULL OR chain_kind = ''
  `);

  db.run(`
    UPDATE specialist_jobs
    SET chain_root_job_id = COALESCE(chain_root_job_id, chain_id)
    WHERE chain_kind = 'chain' AND chain_root_job_id IS NULL
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_jobs_chain_kind ON specialist_jobs(chain_kind)');
  db.run('CREATE INDEX IF NOT EXISTS idx_jobs_chain_root_job ON specialist_jobs(chain_root_job_id) WHERE chain_root_job_id IS NOT NULL');

  if (hasV9) {
    return;
  }

  db.run(`
    INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
      VALUES (9, strftime('%s', 'now') * 1000);
  `);
}

function migrateToV10(db: BunDb): void {
  const hasV10 = db.query('SELECT 1 FROM schema_version WHERE version = 10 LIMIT 1').get() as { 1?: number } | undefined;

  db.run(`
    CREATE TABLE IF NOT EXISTS memories_cache (
      memory_key           TEXT PRIMARY KEY,
      memory_value         TEXT NOT NULL,
      updated_at_ms        INTEGER NOT NULL,
      last_accessed_at_ms  INTEGER,
      access_count         INTEGER NOT NULL DEFAULT 0
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS memories_cache_meta (
      singleton_key    INTEGER PRIMARY KEY CHECK (singleton_key = 1),
      last_sync_at_ms  INTEGER NOT NULL,
      memory_count     INTEGER NOT NULL
    );
  `);

  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      key,
      content,
      tokenize='porter ascii'
    );
  `);

  if (hasV10) {
    return;
  }

  db.run(`
    INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
      VALUES (10, strftime('%s', 'now') * 1000);
  `);
}

export type NodeRunStatus = 'created' | 'starting' | 'running' | 'waiting' | 'degraded' | 'awaiting_merge' | 'fixing_after_review' | 'failed' | 'error' | 'done' | 'stopped';

export type NodeEventType =
  | 'node_created'
  | 'node_started'
  | 'node_state_changed'
  | 'member_started'
  | 'member_state_changed'
  | 'member_output_received'
  | 'member_failed'
  | 'member_recovered'
  | 'member_respawned'
  | 'member_job_rebound'
  | 'member_disabled'
  | 'coordinator_resumed'
  | 'coordinator_resume_state'
  | 'coordinator_resume_skipped'
  | 'coordinator_first_turn_context_built'
  | 'coordinator_output_received'
  | 'coordinator_output_invalid'
  | 'coordinator_repair_requested'
  | 'memory_updated'
  | 'memory_patch_rejected'
  | 'memory_patch_deduplicated'
  // action_written is the canonical "dispatched to member" event.
  | 'action_queued'
  | 'action_written'
  | 'action_observed'
  | 'action_superseded'
  | 'action_completed'
  | 'action_failed'
  | 'action_dropped'
  | 'node_recovered'
  | 'node_waiting'
  | 'node_done'
  | 'node_error'
  | 'node_stopped'
  | 'phase_started'
  | 'phase_completed'
  | 'bead_created'
  | 'worktree_provisioned'
  | 'member_spawned_dynamic'
  | 'member_replaced'
  | 'coordinator_restarted'
  | 'pr_created'
  | 'pr_updated'
  | 'node_completed';

export interface NodeRunRow {
  id: string;
  node_name: string;
  status: NodeRunStatus;
  coordinator_job_id?: string;
  started_at_ms?: number;
  updated_at_ms: number;
  waiting_on?: string;
  error?: string;
  memory_namespace?: string;
  status_json: string;
  pr_number?: number;
  pr_url?: string;
  pr_head_sha?: string;
  gate_results?: string;
  completion_strategy?: string;
}

export interface NodeMemberRow {
  node_run_id: string;
  member_id: string;
  job_id?: string;
  specialist: string;
  model?: string;
  role?: string;
  status: string;
  enabled?: boolean;
  generation?: number;
  worktree_path?: string;
  parent_member_id?: string;
  replaced_member_id?: string;
  phase_id?: string;
}

export interface NodeMemoryRow {
  node_run_id: string;
  namespace?: string;
  entry_type?: 'fact' | 'question' | 'decision';
  entry_id?: string;
  summary?: string;
  source_member_id?: string;
  confidence?: number;
  provenance_json?: string;
  created_at_ms?: number;
  updated_at_ms?: number;
}

export interface ChainEpicLinkRecord {
  chain_id: string;
  epic_id?: string;
  chain_root_job_id?: string;
  chain_root_bead_id?: string;
}

export interface MemoryCacheState {
  lastSyncAtMs: number;
  memoryCount: number;
}

export interface MemoryCacheInputRecord {
  key: string;
  value: string;
}

export interface RelevantMemoryRecord {
  key: string;
  value: string;
  bm25: number;
  recency: number;
  accessFrequency: number;
  score: number;
}

export interface EpicChainLatestJobRecord {
  chain_id: string;
  epic_id: string;
  chain_root_bead_id?: string;
  chain_root_job_id?: string;
  job_id: string;
  status?: string;
  branch?: string;
  updated_at_ms: number;
}

export interface PruneObservabilityOptions {
  beforeMs: number;
  includeEpics: boolean;
  apply: boolean;
  nowMs?: number;
  eventsRetentionMs?: number;
  skipExtract?: boolean;
}

export interface ForensicEventRecord {
  id: number;
  job_id: string;
  seq: number;
  t: number;
  schema_version: string;
  event_family: string;
  event_name: string;
  participant_kind: string | null;
  participant_role: string | null;
  participant_id: string | null;
  attempt_id?: string | null;
  redaction_status: string;
  event_json: string;
}

export interface ListForensicEventsFilters {
  jobId?: string;
  sinceMs?: number;
  eventFamily?: string;
  eventName?: string;
  limit?: number;
  // Default 'asc' (oldest first) for back-compat. Use 'desc' to fetch the
  // newest rows when a caller intends to slice the tail of a busy stream.
  order?: 'asc' | 'desc';
}

export interface JobMetricsRecord {
  job_id: string;
  specialist: string;
  model: string | null;
  status: string;
  chain_kind: string | null;
  chain_id: string | null;
  bead_id: string | null;
  node_id: string | null;
  epic_id: string | null;
  started_at_ms: number | null;
  completed_at_ms: number | null;
  elapsed_ms: number | null;
  active_runtime_ms: number | null;
  waiting_ms: number | null;
  total_turns: number;
  total_tools: number;
  tool_call_counts_json: string;
  token_trajectory_json: string;
  context_trajectory_json: string;
  stall_gaps_json: string;
  run_complete_json: string | null;
  startup_payload_json: string | null;
  updated_at_ms: number;
}

export interface PruneObservabilityReport {
  dryRun: boolean;
  beforeMs: number;
  eventsCutoffMs: number;
  includeEpics: boolean;
  deletedEvents: number;
  deletedResults: number;
  deletedJobs: number;
  deletedEpicRuns: number;
  skippedActiveChainJobs: number;
  extractedJobs: number;
}

export interface OrphanScanFinding {
  kind: 'orphan' | 'stale-pointer' | 'integrity-violation';
  code: 'chain_membership_without_jobs' | 'epic_without_chains' | 'job_epic_without_membership' | 'worktree_missing_on_disk';
  message: string;
  details: Record<string, string | number | boolean | null>;
}

type ClaimJobStartResult = { ok: true } | { ok: false; existingJobId: string; existingStatus: string };

interface ActiveJobRow {
  job_id?: string;
  status?: string;
  pid?: number;
  updated_at_ms?: number;
}

interface ClaimJobStartStore {
  transaction<T>(callback: () => T): T;
  findActiveJob(beadId: string | null, specialist: string): ActiveJobRow | undefined;
  writeStatusRow(status: SupervisorStatus): void;
  writeEventRow(jobId: string, specialist: string, beadId: string | undefined, event: TimelineEvent): void;
  /** Mark a stale claim row as cancelled. Optional for backward-compat with simpler test stores. */
  cancelStaleClaim?(jobId: string): void;
}

/** Minimum age for a 'starting'/'running' row to be considered orphaned and reclaim-eligible. */
export const STALE_CLAIM_AGE_MS = 60_000;

function defaultIsPidAlive(pid: number | undefined): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface ClaimJobStartOptions {
  isPidAlive?: (pid: number | undefined) => boolean;
  nowMs?: () => number;
  staleClaimAgeMs?: number;
}

export function claimJobStartWithStore(
  store: ClaimJobStartStore,
  status: SupervisorStatus,
  event: TimelineEvent,
  options: ClaimJobStartOptions = {},
): ClaimJobStartResult {
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const nowMs = options.nowMs ?? Date.now;
  const staleAgeMs = options.staleClaimAgeMs ?? STALE_CLAIM_AGE_MS;

  return withRetry(() => store.transaction(() => {
    const existing = store.findActiveJob(status.bead_id ?? null, status.specialist);
    if (existing?.job_id && existing.job_id !== status.id) {
      const updatedAtMs = existing.updated_at_ms ?? 0;
      const isStale = updatedAtMs > 0 && (nowMs() - updatedAtMs) > staleAgeMs && !isPidAlive(existing.pid);
      if (isStale && store.cancelStaleClaim) {
        // Orphan: dead/missing PID + row hasn't been touched in >staleAgeMs.
        // Cancel it transactionally and proceed with the new claim.
        store.cancelStaleClaim(existing.job_id);
      } else {
        return { ok: false as const, existingJobId: existing.job_id, existingStatus: existing.status ?? 'starting' };
      }
    }

    store.writeStatusRow(status);
    store.writeEventRow(status.id, status.specialist, status.bead_id, event);
    return { ok: true as const };
  }), 'claimJobStart');
}

/**
 * Durable PR/base drift state for a specialist job (specialists-05q.1).
 *
 * Bridge → substrate mapping (specialists-roadmap §B.3): every field renames 1:1 onto
 * `containers.*` when the substrate daemon ships (`pr_*` → `containers.pr_*`,
 * `base_sha_pinned*` → `containers.base_sha_pinned*`). Pre-substrate columns live on
 * `specialist_jobs`; mirror on `SupervisorStatus` for serialization symmetry.
 *
 * Schema/model only — refresh logic (GitHub/git lookup, classification, attention scoring)
 * is owned by specialists-05q.2. Fields are populated lazily; `null` is a meaningful "checked
 * and unset" value, `undefined` is "never checked".
 */
export interface PrDriftState {
  /** PR URL as recorded by xt at PR creation. */
  pr_url: string | null;
  /** Head SHA observed at last drift check. */
  pr_head_sha: string | null;
  /** Raw GitHub PR state (open / closed / merged / draft). */
  pr_state: string | null;
  /** Raw GitHub merge state (clean / dirty / blocked / behind / unstable / unknown / has_hooks). */
  pr_merge_state: string | null;
  /** Local classification derived from raw state (clean / behind / conflicted / unknown / dead).
   *  Distinct from `pr_merge_state` so a future GitHub label change does not silently shift the
   *  semantics specialists relies on for attention scoring. */
  pr_classification: string | null;
  /** Base branch ref (e.g. "master"). */
  pr_base_ref: string | null;
  /** Observed base tip SHA at last drift check — compared against `base_sha_pinned`
   *  to detect commits-behind without re-fetching. */
  pr_base_sha: string | null;
  /** Epoch ms when drift state was last computed. */
  pr_drift_checked_at_ms: number | null;
  /** Base SHA pinned at chain start (specialists-05q.3 / Opp 7 extension). Used as the
   *  authoritative "what this run measured against" reference. */
  base_sha_pinned: string | null;
  /** Epoch ms when the base SHA pin was set. */
  base_sha_pinned_at_ms: number | null;
}

/** Partial update of {@link PrDriftState}. Omitted keys are left unchanged; explicit `null` clears. */
export type PrDriftStatePatch = Partial<PrDriftState>;

export interface ListBranchIntegrationFilters {
  targetBranch?: string;
  sourceJobId?: string;
  limit?: number;
}

export interface BranchIntegrationEventRecord {
  id: number;
  t: number;
  event: BranchIntegrationEvent;
}

export interface ObservabilitySqliteClient {
  upsertStatus(status: SupervisorStatus): void;
  markSpecialistJobCancelled(jobId: string, reason: string): void;
  upsertEpicRun(epic: EpicRunRecord): void;
  upsertEpicChainMembership(chain: EpicChainRecord): void;
  upsertStatusWithEvent(status: SupervisorStatus, event: TimelineEvent): void;
  upsertStatusWithEventAndResult(status: SupervisorStatus, event: TimelineEvent, output: string): void;
  appendEvent(jobId: string, specialist: string, beadId: string | undefined, event: TimelineEvent): void;
  appendForensicEvent(jobId: string, specialist: string, beadId: string | undefined, forensicEvent: ForensicEvent): void;
  recordBranchIntegration(event: BranchIntegrationEvent): void;
  listBranchIntegrations(filters?: ListBranchIntegrationFilters): BranchIntegrationEventRecord[];
  claimJobStart(status: SupervisorStatus, event: TimelineEvent): { ok: true } | { ok: false; existingJobId: string; existingStatus: string };
  findActiveJob(beadId: string | null, specialist: string): { job_id?: string; status?: string; pid?: number; updated_at_ms?: number } | undefined;
  upsertResult(jobId: string, output: string): void;
  bootstrapNode(nodeRunId: string, nodeName: string, memoryNamespace?: string): void;
  upsertNodeRun(nodeRun: NodeRunRow): void;
  upsertNodeMember(member: NodeMemberRow): void;
  appendNodeEvent(nodeRunId: string, t: number, type: NodeEventType, eventJson: unknown): void;
  upsertNodeMemory(entry: NodeMemoryRow): void;
  upsertNodeRunWithEvent(nodeRun: NodeRunRow, t: number, type: NodeEventType, eventJson: unknown): void;
  upsertNodeMemberWithEvent(member: NodeMemberRow, nodeRunId: string, t: number, type: NodeEventType, eventJson: unknown): void;
  upsertNodeMemoryWithEvent(entry: NodeMemoryRow, nodeRunId: string, t: number, type: NodeEventType, eventJson: unknown): void;
  readNodeRun(nodeRunId: string): NodeRunRow | null;
  listNodeRuns(filter?: { status?: NodeRunStatus }): NodeRunRow[];
  listNodeRunsByRef(partialRef: string, statuses: readonly NodeRunStatus[]): NodeRunRow[];
  listNodeRunsByStatuses(statuses: readonly NodeRunStatus[]): NodeRunRow[];
  readNodeMembers(nodeRunId: string): NodeMemberRow[];
  readNodeEvents(nodeRunId: string, opts?: { type?: NodeEventType; limit?: number }): Array<{ id: number; seq: number; t: number; type: string; event_json: string }>;
  readNodeMemory(nodeRunId: string, opts?: { namespace?: string; entry_type?: 'fact' | 'question' | 'decision' }): NodeMemoryRow[];
  queryMemberContextHealth(jobId: string): number | null;
  readStatus(jobId: string): SupervisorStatus | null;
  listStatuses(): SupervisorStatus[];
  /** Read durable PR/base drift state for a job. Returns null when the job row is missing.
   *  Specialists-05q.1: schema/model only — refresh logic lives in .2. */
  readPrDriftState(jobId: string): PrDriftState | null;
  /** Write durable PR/base drift state to specialist_jobs columns. Partial updates supported;
   *  passing `null` clears a field; omitting a field leaves it unchanged. Returns true on
   *  successful row touch, false when the job row does not exist. Updates `updated_at_ms`. */
  updatePrDriftState(jobId: string, drift: PrDriftStatePatch): boolean;
  /** List stale specialist job rows that may be dead after container restart.
   *  Core predicate: status IN ('starting','running','waiting') AND pid IS NOT NULL
   *  AND updated_at_ms < (nowMs - minAgeMs).  ORDER BY updated_at_ms ASC LIMIT 200.
   *  @param opts.minAgeMs minimum age in ms to consider a row stale. Default 60_000.
   *  @param opts.nowMs epoch ms anchor. Default Date.now().
   *  @returns rows with job_id, specialist, status, pid, updated_at_ms, bead_id, chain_id */
  listStaleSpecialistJobs(opts?: { minAgeMs?: number; nowMs?: number }): Array<{
    job_id: string;
    specialist: string;
    status: string;
    pid: number;
    updated_at_ms: number;
    bead_id: string | null;
    chain_id: string | null;
  }>;

  /** List jobs with PR URLs that haven't been checked recently, ordered by
   *  pr_drift_checked_at_ms ascending (NULLs first). Limit 50.
   *  @param olderThanMs Epoch ms threshold; rows with pr_drift_checked_at_ms
   *    >= olderThanMs are excluded. Defaults to Date.now() - 5*60*1000 (5 min). */
  listJobsNeedingPrDriftRefresh(olderThanMs?: number): Array<{
    job_id: string;
    pr_url: string;
    pr_head_sha: string | null;
    pr_drift_checked_at_ms: number | null;
    branch: string | null;
  }>;
  removeJobs(jobIds: readonly string[]): number;
  readEpicRun(epicId: string): EpicRunRecord | null;
  listEpicRuns(): EpicRunRecord[];
  resolveEpicByChainId(chainId: string): EpicChainRecord | null;
  resolveEpicByChainRootBeadId(chainRootBeadId: string): EpicChainRecord | null;
  listEpicChains(epicId: string): EpicChainRecord[];
  deleteEpicChainMembership(epicId: string, chainIds: readonly string[]): string[];
  listReferencedChainRootJobIds(): string[];
  listEpicChainsWithLatestJob(epicId: string): EpicChainLatestJobRecord[];
  readChainIdentity(jobId: string): PersistedChainIdentity | null;
  listChainJobIds(chainId: string): string[];
  listLiveJobsForBead(beadId: string): string[];
  resolveChainEpicLinkByJobId(jobId: string): ChainEpicLinkRecord | null;
  readEvents(jobId: string): TimelineEvent[];
  readEventsAfterSeq(jobId: string, afterSeq: number): TimelineEvent[];
  readForensicEvents(filters?: ListForensicEventsFilters): ForensicEventRecord[];
  readLatestToolEvent(jobId: string): TimelineEventTool | null;
  getLastActivityTimestampMs(jobId: string): number | null;
  aggregateJobMetrics(jobId: string): JobMetricsRecord | null;
  listJobMetrics(filters?: { spec?: string; model?: string; sinceMs?: number }): JobMetricsRecord[];
  listElapsedMsBySpecialist(sinceMs: number, limitPerSpecialist?: number): Record<string, number[]>;
  readResult(jobId: string): string | null;
  syncMemoriesCache(memories: readonly MemoryCacheInputRecord[], syncedAtMs?: number): void;
  getMemoriesCacheState(): MemoryCacheState | null;
  queryRelevantMemories(keywords: readonly string[], limit?: number, nowMs?: number): RelevantMemoryRecord[];
  invalidateMemoriesCache(): void;
  hasActiveJobs(statuses?: readonly string[]): boolean;
  listActiveJobs(statuses?: readonly string[]): Array<{ job_id: string; specialist: string; status: string }>;
  getDatabaseSizeBytes(): number;
  vacuumDatabase(): { beforeBytes: number; afterBytes: number };
  pruneObservabilityData(options: PruneObservabilityOptions): PruneObservabilityReport;
  scanOrphans(): OrphanScanFinding[];
  close(): void;
}

class SqliteClient implements ObservabilitySqliteClient {
  private readonly db: BunDb;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    // Open persistent connection with WAL mode and busy_timeout
    const Ctor = loadBunDatabase()!;
    this.db = new Ctor(dbPath);
    
    // Set busy_timeout for connection-level locking handling
    this.db.run(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
    
    // Ensure WAL mode is set (will be no-op if already set by initSchema)
    this.db.run('PRAGMA journal_mode=WAL');
  }

  private writeStatusRow(status: SupervisorStatus, lastOutput?: string): void {
    const statusJson = JSON.stringify(status);
    const workspaceId = normalizeWorkspacePath(status.worktree_path);
    const piSessionId = status.session_id ?? null;
    const participantId = deriveParticipantId({ participant_role: status.specialist });
    const attemptId = `${status.id}::attempt::1`;
    this.db.run(`
      INSERT INTO specialist_jobs (job_id, specialist, worktree_column, bead_id, node_id, chain_kind, chain_id, chain_root_job_id, chain_root_bead_id, epic_id, status, status_json, updated_at_ms, last_output, startup_payload_json, participant_id, pi_session_id, workspace_id, attempt_no, attempt_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        specialist = excluded.specialist,
        worktree_column = excluded.worktree_column,
        bead_id = excluded.bead_id,
        node_id = excluded.node_id,
        chain_kind = excluded.chain_kind,
        chain_id = excluded.chain_id,
        chain_root_job_id = excluded.chain_root_job_id,
        chain_root_bead_id = excluded.chain_root_bead_id,
        epic_id = excluded.epic_id,
        status = excluded.status,
        status_json = excluded.status_json,
        updated_at_ms = excluded.updated_at_ms,
        last_output = COALESCE(excluded.last_output, specialist_jobs.last_output),
        startup_payload_json = COALESCE(excluded.startup_payload_json, specialist_jobs.startup_payload_json),
        participant_id = excluded.participant_id,
        pi_session_id = excluded.pi_session_id,
        workspace_id = excluded.workspace_id;
    `, [
      status.id,
      status.specialist,
      status.worktree_path ?? null,
      status.bead_id ?? null,
      status.node_id ?? null,
      status.chain_kind ?? (status.chain_id ? 'chain' : 'prep'),
      status.chain_id ?? null,
      status.chain_root_job_id ?? null,
      status.chain_root_bead_id ?? null,
      status.epic_id ?? null,
      status.status,
      statusJson,
      Date.now(),
      lastOutput ?? null,
      status.startup_payload_json ?? null,
      participantId,
      piSessionId,
      workspaceId,
      attemptId,
    ]);
  }

  private writeEpicRunRow(epic: EpicRunRecord): void {
    this.db.run(`
      INSERT INTO epic_runs (epic_id, status, status_json, updated_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(epic_id) DO UPDATE SET
        status = excluded.status,
        status_json = excluded.status_json,
        updated_at_ms = excluded.updated_at_ms;
    `, [epic.epic_id, epic.status, epic.status_json, epic.updated_at_ms]);
  }

  private writeEpicChainMembershipRow(chain: EpicChainRecord): void {
    this.db.run(`
      INSERT INTO epic_chain_membership (chain_id, epic_id, chain_root_bead_id, chain_root_job_id, updated_at_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(chain_id) DO UPDATE SET
        epic_id = excluded.epic_id,
        chain_root_bead_id = excluded.chain_root_bead_id,
        chain_root_job_id = excluded.chain_root_job_id,
        updated_at_ms = excluded.updated_at_ms;
    `, [
      chain.chain_id,
      chain.epic_id,
      chain.chain_root_bead_id ?? null,
      chain.chain_root_job_id ?? null,
      chain.updated_at_ms,
    ]);
  }

  private getNextSpecialistEventSeq(jobId: string): number {
    const row = this.db.query('SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM specialist_events WHERE job_id = ?').get(jobId) as { next_seq?: number } | undefined;
    return row?.next_seq ?? 1;
  }

  private getNextForensicEventSeq(jobId: string): number {
    const row = this.db.query('SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM specialist_forensic_events WHERE job_id = ?').get(jobId) as { next_seq?: number } | undefined;
    return row?.next_seq ?? 1;
  }

  private getNextNodeEventSeq(nodeRunId: string): number {
    const row = this.db.query('SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM node_events WHERE node_run_id = ?').get(nodeRunId) as { next_seq?: number } | undefined;
    return row?.next_seq ?? 1;
  }

  private readJobAttempt(jobId: string): { attempt_no: number; attempt_id: string | null } | null {
    const row = this.db.query('SELECT attempt_no, attempt_id FROM specialist_jobs WHERE job_id = ? LIMIT 1').get(jobId) as { attempt_no?: number | bigint | null; attempt_id?: string | null } | undefined;
    if (!row) return null;
    const attemptNo = typeof row.attempt_no === 'bigint' ? Number(row.attempt_no) : typeof row.attempt_no === 'number' ? row.attempt_no : 0;
    return { attempt_no: attemptNo, attempt_id: typeof row.attempt_id === 'string' ? row.attempt_id : null };
  }

  private writeEventRow(jobId: string, specialist: string, beadId: string | undefined, event: TimelineEvent): void {
    const seq = typeof event.seq === 'number' && event.seq > 0 ? event.seq : this.getNextSpecialistEventSeq(jobId);
    const sequencedEvent = { ...event, seq };
    const eventJson = JSON.stringify(sequencedEvent);
    const current = this.readJobAttempt(jobId);
    let attemptId: string | null;
    if (isRetryStartEvent(event as { type: string; phase?: unknown })) {
      const nextNo = (current?.attempt_no ?? 0) + 1;
      attemptId = buildAttemptId(jobId, nextNo);
      if (current) {
        this.db.run('UPDATE specialist_jobs SET attempt_no = ?, attempt_id = ?, updated_at_ms = ? WHERE job_id = ?', [nextNo, attemptId, Date.now(), jobId]);
      }
    } else if (current && current.attempt_no > 0) {
      attemptId = current.attempt_id ?? buildAttemptId(jobId, current.attempt_no);
    } else if (!current) {
      attemptId = buildAttemptId(jobId, 1);
    } else {
      attemptId = null;
    }
    this.db.run(`
      INSERT INTO specialist_events (job_id, seq, specialist, bead_id, t, type, event_json, attempt_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [jobId, seq, specialist, beadId ?? null, event.t, event.type, eventJson, attemptId]);
    this.writeForensicEventRow(jobId, specialist, beadId, sequencedEvent, attemptId);
  }

  private writeForensicEventRow(jobId: string, specialist: string, beadId: string | undefined, event: TimelineEvent & { seq: number }, attemptId: string | null): void {
    const context = this.readForensicContext(jobId);
    const forensicEvent = forensicEventFromTimelineEvent(
      event as unknown as { t: number; seq?: number; type: string; [key: string]: unknown },
      {
        jobId,
        specialist,
        beadId: context.beadId ?? beadId,
        nodeId: context.nodeId,
        repo: context.repo,
        serviceComponent: 'runtime',
        model: context.model,
        backend: context.backend,
        chainKind: context.chainKind,
        chainId: context.chainId,
        chainRootJobId: context.chainRootJobId,
        chainRootBeadId: context.chainRootBeadId,
        epicId: context.epicId,
        sessionId: context.sessionId,
        attemptId: attemptId ?? context.attemptId,
        piSessionId: context.piSessionId ?? context.sessionId,
        workspaceId: context.workspaceId,
        conversationId: context.conversationId,
        traceId: context.traceId,
        spanId: context.spanId,
        parentSpanId: context.parentSpanId,
        parentJobId: context.parentJobId,
        spawnOrigin: context.spawnOrigin,
        rootRuntimeOrigin: context.rootRuntimeOrigin,
      },
    );
    this.insertForensicEventRow(jobId, event.seq, forensicEvent, attemptId);
  }

  private readForensicContext(jobId: string): {
    beadId?: string;
    nodeId?: string;
    repo?: string;
    model?: string;
    backend?: string;
    chainKind?: string;
    chainId?: string;
    chainRootJobId?: string;
    chainRootBeadId?: string;
    epicId?: string;
    sessionId?: string;
    attemptId?: string;
    piSessionId?: string;
    workspaceId?: string;
    participantId?: string;
    conversationId?: string;
    traceId?: string;
    spanId?: string;
    parentSpanId?: string;
    // Runtime-origin fields (spec docs/xtmux-gaps.md §13.5).
    // Read verbatim from status_json — E4 does not modify the schema.
    parentJobId?: string;
    spawnOrigin?: unknown;
    rootRuntimeOrigin?: unknown;
  } {
    const row = this.db.query(`
      SELECT bead_id, node_id, chain_kind, chain_id, chain_root_job_id, chain_root_bead_id, epic_id,
             participant_id, pi_session_id, workspace_id, attempt_id, status_json
      FROM specialist_jobs
      WHERE job_id = ?
      LIMIT 1
    `).get(jobId) as Record<string, unknown> | undefined;
    const statusJson = parseJsonRecord(typeof row?.status_json === 'string' ? row.status_json : undefined);
    const columnSession = typeof row?.pi_session_id === 'string' ? row.pi_session_id : undefined;
    return {
      beadId: typeof row?.bead_id === 'string' ? row.bead_id : undefined,
      nodeId: typeof row?.node_id === 'string' ? row.node_id : undefined,
      repo: typeof statusJson.repo === 'string' ? statusJson.repo : undefined,
      model: typeof statusJson.model === 'string' ? statusJson.model : undefined,
      backend: typeof statusJson.backend === 'string' ? statusJson.backend : undefined,
      chainKind: typeof row?.chain_kind === 'string' ? row.chain_kind : undefined,
      chainId: typeof row?.chain_id === 'string' ? row.chain_id : undefined,
      chainRootJobId: typeof row?.chain_root_job_id === 'string' ? row.chain_root_job_id : undefined,
      chainRootBeadId: typeof row?.chain_root_bead_id === 'string' ? row.chain_root_bead_id : undefined,
      epicId: typeof row?.epic_id === 'string' ? row.epic_id : undefined,
      sessionId: columnSession ?? (typeof statusJson.session_id === 'string' ? statusJson.session_id : undefined),
      attemptId: typeof row?.attempt_id === 'string' ? row.attempt_id : undefined,
      piSessionId: columnSession ?? (typeof statusJson.session_id === 'string' ? statusJson.session_id : undefined),
      workspaceId: typeof row?.workspace_id === 'string' ? row.workspace_id : undefined,
      participantId: typeof row?.participant_id === 'string' ? row.participant_id : undefined,
      conversationId: typeof statusJson.conversation_id === 'string' ? statusJson.conversation_id : undefined,
      traceId: typeof statusJson.trace_id === 'string' ? statusJson.trace_id : undefined,
      spanId: typeof statusJson.span_id === 'string' ? statusJson.span_id : undefined,
      parentSpanId: typeof statusJson.parent_span_id === 'string' ? statusJson.parent_span_id : undefined,
      parentJobId: typeof statusJson.parent_job_id === 'string' ? statusJson.parent_job_id : undefined,
      spawnOrigin: statusJson.spawn_origin,
      rootRuntimeOrigin: statusJson.root_runtime_origin,
    };
  }

  private insertForensicEventRow(jobId: string, seq: number, forensicEvent: ForensicEvent, attemptId?: string | null): void {
    const columnAttemptId = attemptId ?? (typeof forensicEvent.correlation.attempt_id === 'string' ? forensicEvent.correlation.attempt_id : null);
    this.db.run(`
      INSERT INTO specialist_forensic_events (
        job_id, seq, t, schema_version, event_family, event_name,
        participant_kind, participant_role, participant_id, redaction_status, event_json, attempt_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      jobId,
      seq,
      forensicEvent.t_unix_ms,
      forensicEvent.schema_version,
      forensicEvent.event_family,
      forensicEvent.event_name,
      forensicEvent.resource.participant_kind ?? null,
      forensicEvent.resource.participant_role ?? null,
      typeof forensicEvent.correlation.participant_id === 'string' ? forensicEvent.correlation.participant_id : null,
      forensicEvent.redaction.status,
      JSON.stringify(forensicEvent),
      columnAttemptId,
    ]);
  }

  findActiveJob(beadId: string | null, specialist: string): { job_id?: string; status?: string; pid?: number; updated_at_ms?: number } | undefined {
    return this.db.query(`
      SELECT
        job_id,
        status,
        updated_at_ms,
        CAST(JSON_EXTRACT(status_json, '$.pid') AS INTEGER) AS pid
      FROM specialist_jobs
      WHERE bead_id = ?
        AND specialist = ?
        AND status IN ('starting', 'running', 'waiting')
      ORDER BY updated_at_ms DESC
      LIMIT 1
    `).get(beadId, specialist) as { job_id?: string; status?: string; pid?: number; updated_at_ms?: number } | undefined;
  }

  claimJobStart(status: SupervisorStatus, event: TimelineEvent): { ok: true } | { ok: false; existingJobId: string; existingStatus: string } {
    return claimJobStartWithStore(
      {
        transaction: <T>(callback: () => T) => this.db.transaction(callback)(),
        findActiveJob: (beadId, specialist) => this.findActiveJob(beadId, specialist),
        writeStatusRow: (nextStatus) => this.writeStatusRow(nextStatus),
        writeEventRow: (jobId, specialist, beadId, nextEvent) => this.writeEventRow(jobId, specialist, beadId, nextEvent),
        cancelStaleClaim: (jobId) => {
          const nowMs = Date.now();
          this.db.run(`
            UPDATE specialist_jobs
            SET status = 'cancelled',
                status_json = JSON_PATCH(status_json, JSON_OBJECT('status', 'cancelled', 'cancelled_reason', 'orphan-claim-stale')),
                updated_at_ms = ?
            WHERE job_id = ?
          `, [nowMs, jobId]);
        },
      },
      status,
      event,
    );
  }

  private writeResultRow(jobId: string, output: string): void {
    this.db.run(`
      INSERT INTO specialist_results (job_id, output, updated_at_ms)
      VALUES (?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        output = excluded.output,
        updated_at_ms = excluded.updated_at_ms;
    `, [jobId, output, Date.now()]);
  }

  private writeNodeRunRow(nodeRun: NodeRunRow): void {
    this.db.run(`
      INSERT INTO node_runs (
        id,
        node_name,
        status,
        coordinator_job_id,
        started_at_ms,
        updated_at_ms,
        waiting_on,
        error,
        memory_namespace,
        status_json,
        pr_number,
        pr_url,
        pr_head_sha,
        gate_results,
        completion_strategy
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        node_name = excluded.node_name,
        status = excluded.status,
        coordinator_job_id = excluded.coordinator_job_id,
        started_at_ms = excluded.started_at_ms,
        updated_at_ms = excluded.updated_at_ms,
        waiting_on = excluded.waiting_on,
        error = excluded.error,
        memory_namespace = excluded.memory_namespace,
        status_json = excluded.status_json,
        pr_number = excluded.pr_number,
        pr_url = excluded.pr_url,
        pr_head_sha = excluded.pr_head_sha,
        gate_results = excluded.gate_results,
        completion_strategy = excluded.completion_strategy;
    `, [
      nodeRun.id,
      nodeRun.node_name,
      nodeRun.status,
      nodeRun.coordinator_job_id ?? null,
      nodeRun.started_at_ms ?? null,
      nodeRun.updated_at_ms,
      nodeRun.waiting_on ?? null,
      nodeRun.error ?? null,
      nodeRun.memory_namespace ?? null,
      nodeRun.status_json,
      nodeRun.pr_number ?? null,
      nodeRun.pr_url ?? null,
      nodeRun.pr_head_sha ?? null,
      nodeRun.gate_results ?? null,
      nodeRun.completion_strategy ?? null,
    ]);
  }

  private writeNodeMemberRow(member: NodeMemberRow): void {
    this.db.run(`
      INSERT INTO node_members (
        node_run_id,
        member_id,
        job_id,
        specialist,
        model,
        role,
        status,
        enabled,
        generation,
        worktree_path,
        parent_member_id,
        replaced_member_id,
        phase_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(node_run_id, member_id) DO UPDATE SET
        job_id = excluded.job_id,
        specialist = excluded.specialist,
        model = excluded.model,
        role = excluded.role,
        status = excluded.status,
        enabled = excluded.enabled,
        generation = excluded.generation,
        worktree_path = excluded.worktree_path,
        parent_member_id = excluded.parent_member_id,
        replaced_member_id = excluded.replaced_member_id,
        phase_id = excluded.phase_id;
    `, [
      member.node_run_id,
      member.member_id,
      member.job_id ?? null,
      member.specialist,
      member.model ?? null,
      member.role ?? null,
      member.status,
      member.enabled === undefined ? 1 : (member.enabled ? 1 : 0),
      member.generation ?? 0,
      member.worktree_path ?? null,
      member.parent_member_id ?? null,
      member.replaced_member_id ?? null,
      member.phase_id ?? null,
    ]);
  }

  private writeNodeEventRow(nodeRunId: string, t: number, type: NodeEventType, eventJson: unknown): void {
    const seq = this.getNextNodeEventSeq(nodeRunId);
    const payload = typeof eventJson === 'object' && eventJson !== null
      ? { ...(eventJson as Record<string, unknown>), seq }
      : { value: eventJson, seq };
    this.db.run(`
      INSERT INTO node_events (node_run_id, seq, t, type, event_json)
      VALUES (?, ?, ?, ?, ?)
    `, [nodeRunId, seq, t, type, JSON.stringify(payload)]);
  }

  private writeNodeMemoryRow(entry: NodeMemoryRow): void {
    const now = Date.now();
    const createdAtMs = entry.created_at_ms ?? now;
    const updatedAtMs = entry.updated_at_ms ?? now;

    if (entry.entry_id) {
      this.db.run(`
        INSERT INTO node_memory (
          node_run_id,
          namespace,
          entry_type,
          entry_id,
          summary,
          source_member_id,
          confidence,
          provenance_json,
          created_at_ms,
          updated_at_ms
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_run_id, entry_id) DO UPDATE SET
          namespace = excluded.namespace,
          entry_type = excluded.entry_type,
          summary = excluded.summary,
          source_member_id = excluded.source_member_id,
          confidence = excluded.confidence,
          provenance_json = excluded.provenance_json,
          created_at_ms = excluded.created_at_ms,
          updated_at_ms = excluded.updated_at_ms
      `, [
        entry.node_run_id,
        entry.namespace ?? null,
        entry.entry_type ?? null,
        entry.entry_id,
        entry.summary ?? null,
        entry.source_member_id ?? null,
        entry.confidence ?? null,
        entry.provenance_json ?? null,
        createdAtMs,
        updatedAtMs,
      ]);
      return;
    }

    this.db.run(`
      INSERT INTO node_memory (
        node_run_id,
        namespace,
        entry_type,
        entry_id,
        summary,
        source_member_id,
        confidence,
        provenance_json,
        created_at_ms,
        updated_at_ms
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      entry.node_run_id,
      entry.namespace ?? null,
      entry.entry_type ?? null,
      null,
      entry.summary ?? null,
      entry.source_member_id ?? null,
      entry.confidence ?? null,
      entry.provenance_json ?? null,
      createdAtMs,
      updatedAtMs,
    ]);
  }

  upsertStatus(status: SupervisorStatus): void {
    withRetry(() => {
      this.writeStatusRow(status);
    }, 'upsertStatus');
  }

  markSpecialistJobCancelled(jobId: string, reason: string): void {
    withRetry(() => {
      const transaction = this.db.transaction(() => {
        const nowMs = Date.now();
        this.db.run(`
          UPDATE specialist_jobs
          SET status = 'cancelled',
              status_json = JSON_PATCH(status_json, JSON_OBJECT('status', 'cancelled', 'cancelled_reason', ?)),
              updated_at_ms = ?
          WHERE job_id = ?
        `, [reason, nowMs, jobId]);
      });
      transaction();
    }, 'markSpecialistJobCancelled');
  }

  upsertEpicRun(epic: EpicRunRecord): void {
    withRetry(() => {
      this.writeEpicRunRow(epic);
    }, 'upsertEpicRun');
  }

  upsertEpicChainMembership(chain: EpicChainRecord): void {
    withRetry(() => {
      this.writeEpicChainMembershipRow(chain);
    }, 'upsertEpicChainMembership');
  }

  upsertStatusWithEvent(status: SupervisorStatus, event: TimelineEvent): void {
    withRetry(() => {
      const transaction = this.db.transaction(() => {
        this.writeStatusRow(status);
        this.writeEventRow(status.id, status.specialist, status.bead_id, event);
      });
      transaction();
    }, 'upsertStatusWithEvent');
  }

  upsertStatusWithEventAndResult(status: SupervisorStatus, event: TimelineEvent, output: string): void {
    withRetry(() => {
      const transaction = this.db.transaction(() => {
        this.writeStatusRow(status, output);
        this.writeEventRow(status.id, status.specialist, status.bead_id, event);
        this.writeResultRow(status.id, output);
      });
      transaction();
    }, 'upsertStatusWithEventAndResult');
  }

  appendEvent(jobId: string, specialist: string, beadId: string | undefined, event: TimelineEvent): void {
    withRetry(() => {
      this.writeEventRow(jobId, specialist, beadId, event);
    }, 'appendEvent');
  }

  appendForensicEvent(jobId: string, specialist: string, beadId: string | undefined, forensicEvent: ForensicEvent): void {
    withRetry(() => {
      const seq = typeof forensicEvent.seq === 'number' && forensicEvent.seq > 0 ? forensicEvent.seq : this.getNextForensicEventSeq(jobId);
      this.insertForensicEventRow(jobId, seq, forensicEvent);
    }, 'appendForensicEvent');
  }

  recordBranchIntegration(event: BranchIntegrationEvent): void {
    withRetry(() => {
      this.db.run(`
        INSERT OR IGNORE INTO branch_integration_events (
          t, schema_version,
          source_job_id, source_branch, source_worktree,
          target_role, target_branch, target_worktree,
          status, commit_sha, event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        event.t_unix_ms,
        event.schema_version,
        event.source.job_id,
        event.source.branch,
        event.source.worktree,
        event.target.role ?? null,
        event.target.branch,
        event.target.worktree,
        event.status,
        event.commit,
        JSON.stringify(event),
      ]);
    }, 'recordBranchIntegration');
  }

  listBranchIntegrations(filters: ListBranchIntegrationFilters = {}): BranchIntegrationEventRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filters.targetBranch) { clauses.push('target_branch = ?'); params.push(filters.targetBranch); }
    if (filters.sourceJobId) { clauses.push('source_job_id = ?'); params.push(filters.sourceJobId); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = filters.limit && filters.limit > 0 ? ` LIMIT ${Math.floor(filters.limit)}` : '';
    const rows = this.db.query(
      `SELECT id, t, event_json FROM branch_integration_events ${where} ORDER BY t DESC, id DESC${limit}`,
    ).all(...params) as Array<{ id: number; t: number; event_json: string }>;
    return rows.map((row) => ({
      id: row.id,
      t: row.t,
      event: JSON.parse(row.event_json) as BranchIntegrationEvent,
    }));
  }

  upsertResult(jobId: string, output: string): void {
    withRetry(() => {
      const transaction = this.db.transaction(() => {
        this.writeResultRow(jobId, output);
        // Also update last_output on the job row for quick access
        this.db.run(`
          UPDATE specialist_jobs SET last_output = ? WHERE job_id = ?
        `, [output, jobId]);
      });
      transaction();
    }, 'upsertResult');
  }

  bootstrapNode(nodeRunId: string, nodeName: string, memoryNamespace?: string): void {
    withRetry(() => {
      const transaction = this.db.transaction(() => {
        const now = Date.now();
        this.writeNodeRunRow({
          id: nodeRunId,
          node_name: nodeName,
          status: 'created',
          started_at_ms: now,
          updated_at_ms: now,
          memory_namespace: memoryNamespace,
          status_json: JSON.stringify({ status: 'created' }),
        });
        this.writeNodeEventRow(nodeRunId, now, 'node_created', { node_run_id: nodeRunId, node_name: nodeName });
        this.writeNodeEventRow(nodeRunId, now + 1, 'node_started', { node_run_id: nodeRunId, node_name: nodeName });
      });
      transaction();
    }, 'bootstrapNode');
  }

  upsertNodeRun(nodeRun: NodeRunRow): void {
    withRetry(() => {
      this.writeNodeRunRow(nodeRun);
    }, 'upsertNodeRun');
  }

  upsertNodeMember(member: NodeMemberRow): void {
    withRetry(() => {
      this.writeNodeMemberRow(member);
    }, 'upsertNodeMember');
  }

  appendNodeEvent(nodeRunId: string, t: number, type: NodeEventType, eventJson: unknown): void {
    withRetry(() => {
      this.writeNodeEventRow(nodeRunId, t, type, eventJson);
    }, 'appendNodeEvent');
  }

  upsertNodeMemory(entry: NodeMemoryRow): void {
    withRetry(() => {
      this.writeNodeMemoryRow(entry);
    }, 'upsertNodeMemory');
  }

  upsertNodeRunWithEvent(nodeRun: NodeRunRow, t: number, type: NodeEventType, eventJson: unknown): void {
    withRetry(() => {
      const transaction = this.db.transaction(() => {
        this.writeNodeRunRow(nodeRun);
        this.writeNodeEventRow(nodeRun.id, t, type, eventJson);
      });
      transaction();
    }, 'upsertNodeRunWithEvent');
  }

  upsertNodeMemberWithEvent(member: NodeMemberRow, nodeRunId: string, t: number, type: NodeEventType, eventJson: unknown): void {
    withRetry(() => {
      const transaction = this.db.transaction(() => {
        this.writeNodeMemberRow(member);
        this.writeNodeEventRow(nodeRunId, t, type, eventJson);
      });
      transaction();
    }, 'upsertNodeMemberWithEvent');
  }

  upsertNodeMemoryWithEvent(entry: NodeMemoryRow, nodeRunId: string, t: number, type: NodeEventType, eventJson: unknown): void {
    withRetry(() => {
      const transaction = this.db.transaction(() => {
        this.writeNodeMemoryRow(entry);
        this.writeNodeEventRow(nodeRunId, t, type, eventJson);
      });
      transaction();
    }, 'upsertNodeMemoryWithEvent');
  }

  readNodeRun(nodeRunId: string): NodeRunRow | null {
    return withRetry(() => {
      const row = this.db.query('SELECT * FROM node_runs WHERE id = ? LIMIT 1').get(nodeRunId) as NodeRunRow | undefined;
      if (!row) return null;
      return {
        ...row,
        status: row.status as NodeRunStatus,
      };
    }, 'readNodeRun');
  }

  listNodeRuns(filter?: { status?: NodeRunStatus }): NodeRunRow[] {
    return withRetry(() => {
      const query = filter?.status
        ? 'SELECT * FROM node_runs WHERE status = ? ORDER BY updated_at_ms DESC'
        : 'SELECT * FROM node_runs ORDER BY updated_at_ms DESC';
      const rows = filter?.status
        ? this.db.query(query).all(filter.status)
        : this.db.query(query).all();
      return (rows as NodeRunRow[]).map((row) => ({
        ...row,
        status: row.status as NodeRunStatus,
      }));
    }, 'listNodeRuns');
  }

  listNodeRunsByRef(partialRef: string, statuses: readonly NodeRunStatus[]): NodeRunRow[] {
    return withRetry(() => {
      if (statuses.length === 0) return [];
      const placeholders = statuses.map(() => '?').join(', ');
      const query = `
        SELECT *
        FROM node_runs
        WHERE status IN (${placeholders})
          AND (id LIKE ? OR node_name LIKE ?)
        ORDER BY updated_at_ms DESC
      `;
      const prefix = `${partialRef}%`;
      const rows = this.db.query(query).all(...statuses, prefix, prefix) as NodeRunRow[];
      return rows.map((row) => ({
        ...row,
        status: row.status as NodeRunStatus,
      }));
    }, 'listNodeRunsByRef');
  }

  listNodeRunsByStatuses(statuses: readonly NodeRunStatus[]): NodeRunRow[] {
    return withRetry(() => {
      if (statuses.length === 0) return [];
      const placeholders = statuses.map(() => '?').join(', ');
      const query = `
        SELECT *
        FROM node_runs
        WHERE status IN (${placeholders})
        ORDER BY updated_at_ms DESC
      `;
      const rows = this.db.query(query).all(...statuses) as NodeRunRow[];
      return rows.map((row) => ({
        ...row,
        status: row.status as NodeRunStatus,
      }));
    }, 'listNodeRunsByStatuses');
  }

  readNodeMembers(nodeRunId: string): NodeMemberRow[] {
    return withRetry(() => {
      const rows = this.db.query('SELECT * FROM node_members WHERE node_run_id = ? ORDER BY id ASC').all(nodeRunId) as Array<NodeMemberRow & { enabled?: number | boolean }>;
      return rows.map((row) => ({
        node_run_id: row.node_run_id,
        member_id: row.member_id,
        job_id: row.job_id ?? undefined,
        specialist: row.specialist,
        model: row.model ?? undefined,
        role: row.role ?? undefined,
        status: row.status,
        enabled: row.enabled === undefined ? undefined : Boolean(row.enabled),
        generation: row.generation ?? 0,
        worktree_path: row.worktree_path ?? undefined,
        parent_member_id: row.parent_member_id ?? undefined,
        replaced_member_id: row.replaced_member_id ?? undefined,
        phase_id: row.phase_id ?? undefined,
      }));
    }, 'readNodeMembers');
  }

  readNodeEvents(nodeRunId: string, opts?: { type?: NodeEventType; limit?: number }): Array<{ id: number; seq: number; t: number; type: string; event_json: string }> {
    return withRetry(() => {
      const whereClauses = ['node_run_id = ?'];
      const params: Array<string | number> = [nodeRunId];

      if (opts?.type) {
        whereClauses.push('type = ?');
        params.push(opts.type);
      }

      let query = `
        SELECT id, seq, t, type, event_json
        FROM node_events
        WHERE ${whereClauses.join(' AND ')}
        ORDER BY seq ASC, id ASC
      `;

      if (opts?.limit !== undefined) {
        query += ' LIMIT ?';
        params.push(opts.limit);
      }

      return this.db.query(query).all(...params) as Array<{ id: number; seq: number; t: number; type: string; event_json: string }>;
    }, 'readNodeEvents');
  }

  readNodeMemory(nodeRunId: string, opts?: { namespace?: string; entry_type?: 'fact' | 'question' | 'decision' }): NodeMemoryRow[] {
    return withRetry(() => {
      const whereClauses = ['node_run_id = ?'];
      const params: Array<string> = [nodeRunId];

      if (opts?.namespace) {
        whereClauses.push('namespace = ?');
        params.push(opts.namespace);
      }

      if (opts?.entry_type) {
        whereClauses.push('entry_type = ?');
        params.push(opts.entry_type);
      }

      const query = `
        SELECT *
        FROM node_memory
        WHERE ${whereClauses.join(' AND ')}
        ORDER BY created_at_ms ASC
      `;

      return this.db.query(query).all(...params) as NodeMemoryRow[];
    }, 'readNodeMemory');
  }

  queryMemberContextHealth(jobId: string): number | null {
    return withRetry(() => {
      const row = this.db.query(`
        SELECT json_extract(event_json, '$.context_pct') AS context_pct
        FROM specialist_events
        WHERE job_id = ? AND type = 'turn_summary'
        ORDER BY seq DESC, id DESC
        LIMIT 1
      `).get(jobId) as { context_pct?: number | string | null } | undefined;

      if (!row || row.context_pct === null || row.context_pct === undefined) {
        return null;
      }

      const contextPct = typeof row.context_pct === 'number' ? row.context_pct : Number(row.context_pct);
      return Number.isFinite(contextPct) ? contextPct : null;
    }, 'queryMemberContextHealth');
  }

  readStatus(jobId: string): SupervisorStatus | null {
    return withRetry(() => {
      const row = this.db.query('SELECT status_json FROM specialist_jobs WHERE job_id = ? LIMIT 1').get(jobId) as { status_json?: string } | undefined;
      if (!row?.status_json) return null;
      return JSON.parse(row.status_json) as SupervisorStatus;
    }, 'readStatus');
  }

  listStatuses(): SupervisorStatus[] {
    return withRetry(() => {
      const rows = this.db.query('SELECT status_json FROM specialist_jobs ORDER BY updated_at_ms DESC').all() as Array<{ status_json?: string }>;
      const statuses: SupervisorStatus[] = [];
      for (const row of rows) {
        if (!row.status_json) continue;
        try { statuses.push(JSON.parse(row.status_json) as SupervisorStatus); } catch { /* ignore malformed rows */ }
      }
      return statuses;
    }, 'listStatuses');
  }

  readPrDriftState(jobId: string): PrDriftState | null {
    return withRetry(() => {
      const row = this.db.query(`
        SELECT pr_url, pr_head_sha, pr_state, pr_merge_state, pr_classification,
               pr_base_ref, pr_base_sha, pr_drift_checked_at_ms,
               base_sha_pinned, base_sha_pinned_at_ms
        FROM specialist_jobs WHERE job_id = ? LIMIT 1
      `).get(jobId) as Record<keyof PrDriftState, unknown> | undefined;
      if (!row) return null;
      // Normalize SQLite return shape: missing → null. Numeric columns may come back as bigint
      // depending on bun:sqlite mode; coerce to number for the timestamp fields.
      const num = (v: unknown): number | null =>
        v === null || v === undefined ? null : typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : null;
      const str = (v: unknown): string | null =>
        v === null || v === undefined ? null : typeof v === 'string' ? v : null;
      return {
        pr_url: str(row.pr_url),
        pr_head_sha: str(row.pr_head_sha),
        pr_state: str(row.pr_state),
        pr_merge_state: str(row.pr_merge_state),
        pr_classification: str(row.pr_classification),
        pr_base_ref: str(row.pr_base_ref),
        pr_base_sha: str(row.pr_base_sha),
        pr_drift_checked_at_ms: num(row.pr_drift_checked_at_ms),
        base_sha_pinned: str(row.base_sha_pinned),
        base_sha_pinned_at_ms: num(row.base_sha_pinned_at_ms),
      };
    }, 'readPrDriftState');
  }

  updatePrDriftState(jobId: string, drift: PrDriftStatePatch): boolean {
    return withRetry(() => {
      // Build dynamic SET clause from only-present keys so callers can do partial updates.
      const ALLOWED: ReadonlyArray<keyof PrDriftState> = [
        'pr_url', 'pr_head_sha', 'pr_state', 'pr_merge_state', 'pr_classification',
        'pr_base_ref', 'pr_base_sha', 'pr_drift_checked_at_ms',
        'base_sha_pinned', 'base_sha_pinned_at_ms',
      ];
      const setClauses: string[] = [];
      const params: Array<string | number | null> = [];
      for (const key of ALLOWED) {
        if (!Object.prototype.hasOwnProperty.call(drift, key)) continue;
        setClauses.push(`${key} = ?`);
        // SQLite normalizes undefined → null at binding; we accept both as "clear".
        const value = (drift as Record<string, unknown>)[key];
        params.push(value === undefined ? null : (value as string | number | null));
      }
      if (setClauses.length === 0) return false; // nothing to do — no-op
      setClauses.push('updated_at_ms = ?');
      params.push(Date.now());
      params.push(jobId);
      const sql = `UPDATE specialist_jobs SET ${setClauses.join(', ')} WHERE job_id = ?`;
      const result = this.db.run(sql, params) as { changes?: number };
      return (result?.changes ?? 0) > 0;
    }, 'updatePrDriftState');
  }

  listStaleSpecialistJobs(opts?: { minAgeMs?: number; nowMs?: number }): Array<{
    job_id: string;
    specialist: string;
    status: string;
    pid: number;
    updated_at_ms: number;
    bead_id: string | null;
    chain_id: string | null;
  }> {
    return withRetry(() => {
      const nowMs = opts?.nowMs ?? Date.now();
      const minAgeMs = opts?.minAgeMs ?? 60_000;
      const cutoff = nowMs - minAgeMs;
      const statuses = ['starting', 'running', 'waiting'];
      const placeholders = statuses.map(() => '?').join(', ');
      const rows = this.db.query(`
        SELECT job_id, specialist, status, status_json,
               JSON_EXTRACT(status_json, '$.pid') AS pid,
               updated_at_ms,
               bead_id,
               chain_id
        FROM specialist_jobs
        WHERE status IN (${placeholders})
          AND pid IS NOT NULL
          AND updated_at_ms < ?
        ORDER BY updated_at_ms ASC
        LIMIT 200
      `).all(...statuses, cutoff) as Array<Record<string, unknown>>;

      const num = (v: unknown): number =>
        v === null || v === undefined ? 0 : typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : 0;
      const str = (v: unknown): string | null =>
        v === null || v === undefined ? null : typeof v === 'string' ? v : null;

      return rows
        .filter((row) => {
          const pid = num(row.pid);
          return Number.isInteger(pid) && pid > 0;
        })
        .map((row) => ({
          job_id: str(row.job_id) ?? '',
          specialist: str(row.specialist) ?? '',
          status: str(row.status) ?? '',
          pid: num(row.pid),
          updated_at_ms: num(row.updated_at_ms),
          bead_id: str(row.bead_id),
          chain_id: str(row.chain_id),
        }));
    }, 'listStaleSpecialistJobs');
  }

  listJobsNeedingPrDriftRefresh(olderThanMs?: number): Array<{
    job_id: string;
    pr_url: string;
    pr_head_sha: string | null;
    pr_drift_checked_at_ms: number | null;
    branch: string | null;
  }> {
    return withRetry(() => {
      const threshold = olderThanMs ?? Date.now() - 5 * 60 * 1000;
      const rows = this.db.query(`
        SELECT job_id, pr_url, pr_head_sha, pr_drift_checked_at_ms,
               JSON_EXTRACT(status_json, '$.branch') AS branch
        FROM specialist_jobs
        WHERE pr_url IS NOT NULL
          AND (pr_drift_checked_at_ms IS NULL OR pr_drift_checked_at_ms < ?)
        ORDER BY pr_drift_checked_at_ms ASC NULLS FIRST
        LIMIT 50
      `).all(threshold) as Array<Record<string, unknown>>;
      const num = (v: unknown): number | null =>
        v === null || v === undefined ? null : typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : null;
      const str = (v: unknown): string | null =>
        v === null || v === undefined ? null : typeof v === 'string' ? v : null;
      return rows.map((row) => ({
        job_id: str(row.job_id) ?? '',
        pr_url: str(row.pr_url) ?? '',
        pr_head_sha: str(row.pr_head_sha),
        pr_drift_checked_at_ms: num(row.pr_drift_checked_at_ms),
        branch: str(row.branch),
      }));
    }, 'listJobsNeedingPrDriftRefresh');
  }

  removeJobs(jobIds: readonly string[]): number {
    return withRetry(() => {
      if (jobIds.length === 0) return 0;
      const placeholders = jobIds.map(() => '?').join(', ');
      const result = this.db.query(`DELETE FROM specialist_jobs WHERE job_id IN (${placeholders})`).run(...jobIds);
      return result.changes ?? 0;
    }, 'removeJobs');
  }

  readEpicRun(epicId: string): EpicRunRecord | null {
    return withRetry(() => {
      const row = this.db.query('SELECT epic_id, status, status_json, updated_at_ms FROM epic_runs WHERE epic_id = ? LIMIT 1').get(epicId) as EpicRunRecord | undefined;
      return row ?? null;
    }, 'readEpicRun');
  }

  listEpicRuns(): EpicRunRecord[] {
    return withRetry(() => {
      return this.db.query('SELECT epic_id, status, status_json, updated_at_ms FROM epic_runs ORDER BY updated_at_ms DESC').all() as EpicRunRecord[];
    }, 'listEpicRuns');
  }

  resolveEpicByChainId(chainId: string): EpicChainRecord | null {
    return withRetry(() => {
      const row = this.db.query('SELECT chain_id, epic_id, chain_root_bead_id, chain_root_job_id, updated_at_ms FROM epic_chain_membership WHERE chain_id = ? LIMIT 1').get(chainId) as EpicChainRecord | undefined;
      return row ?? null;
    }, 'resolveEpicByChainId');
  }

  resolveEpicByChainRootBeadId(chainRootBeadId: string): EpicChainRecord | null {
    return withRetry(() => {
      const row = this.db.query('SELECT chain_id, epic_id, chain_root_bead_id, chain_root_job_id, updated_at_ms FROM epic_chain_membership WHERE chain_root_bead_id = ? LIMIT 1').get(chainRootBeadId) as EpicChainRecord | undefined;
      return row ?? null;
    }, 'resolveEpicByChainRootBeadId');
  }

  listEpicChains(epicId: string): EpicChainRecord[] {
    return withRetry(() => {
      return this.db.query(`
        SELECT chain_id, epic_id, chain_root_bead_id, chain_root_job_id, updated_at_ms
        FROM epic_chain_membership
        WHERE epic_id = ?
        ORDER BY updated_at_ms DESC
      `).all(epicId) as EpicChainRecord[];
    }, 'listEpicChains');
  }

  deleteEpicChainMembership(epicId: string, chainIds: readonly string[]): string[] {
    if (chainIds.length === 0) return [];

    return withRetry(() => {
      const existing = new Set(
        this.db
          .query('SELECT chain_id FROM epic_chain_membership WHERE epic_id = ?')
          .all(epicId)
          .map((row: unknown) => (row as { chain_id: string }).chain_id),
      );
      const removable = chainIds.filter((chainId) => existing.has(chainId));
      if (removable.length === 0) return [];

      const placeholders = removable.map(() => '?').join(', ');
      this.db
        .query(`DELETE FROM epic_chain_membership WHERE epic_id = ? AND chain_id IN (${placeholders})`)
        .run(epicId, ...removable);
      return removable;
    }, 'deleteEpicChainMembership');
  }

  listReferencedChainRootJobIds(): string[] {
    return withRetry(() => {
      const rows = this.db.query(`
        SELECT DISTINCT chain_root_job_id
        FROM epic_chain_membership
        WHERE chain_root_job_id IS NOT NULL AND chain_root_job_id != ''
      `).all() as Array<{ chain_root_job_id?: string | null }>;

      return rows
        .map((row) => row.chain_root_job_id)
        .filter((jobId): jobId is string => typeof jobId === 'string' && jobId.length > 0);
    }, 'listReferencedChainRootJobIds');
  }

  listEpicChainsWithLatestJob(epicId: string): EpicChainLatestJobRecord[] {
    return withRetry(() => {
      const rows = this.db.query(`
        WITH ranked_jobs AS (
          SELECT
            jobs.chain_id AS chain_id,
            membership.epic_id AS epic_id,
            membership.chain_root_bead_id AS chain_root_bead_id,
            membership.chain_root_job_id AS chain_root_job_id,
            jobs.job_id AS job_id,
            jobs.status AS status,
            json_extract(jobs.status_json, '$.branch') AS branch,
            jobs.updated_at_ms AS updated_at_ms,
            ROW_NUMBER() OVER (
              PARTITION BY jobs.chain_id
              ORDER BY jobs.updated_at_ms DESC, jobs.rowid DESC
            ) AS row_rank
          FROM epic_chain_membership membership
          INNER JOIN specialist_jobs jobs ON jobs.chain_id = membership.chain_id
          WHERE membership.epic_id = ?
            AND jobs.chain_kind = 'chain'
        )
        SELECT
          chain_id,
          epic_id,
          chain_root_bead_id,
          chain_root_job_id,
          job_id,
          status,
          branch,
          updated_at_ms
        FROM ranked_jobs
        WHERE row_rank = 1
        ORDER BY updated_at_ms DESC, job_id DESC
      `).all(epicId) as Array<{
        chain_id: string;
        epic_id: string;
        chain_root_bead_id?: string | null;
        chain_root_job_id?: string | null;
        job_id: string;
        status?: string | null;
        branch?: string | null;
        updated_at_ms: number;
      }>;

      return rows.map((row) => ({
        chain_id: row.chain_id,
        epic_id: row.epic_id,
        chain_root_bead_id: row.chain_root_bead_id ?? undefined,
        chain_root_job_id: row.chain_root_job_id ?? undefined,
        job_id: row.job_id,
        status: row.status ?? undefined,
        branch: row.branch ?? undefined,
        updated_at_ms: row.updated_at_ms,
      }));
    }, 'listEpicChainsWithLatestJob');
  }

  readChainIdentity(jobId: string): PersistedChainIdentity | null {
    return withRetry(() => {
      const row = this.db.query(`
        SELECT chain_kind, chain_id, chain_root_job_id, chain_root_bead_id
        FROM specialist_jobs
        WHERE job_id = ?
        LIMIT 1
      `).get(jobId) as { chain_kind?: string; chain_id?: string | null; chain_root_job_id?: string | null; chain_root_bead_id?: string | null } | undefined;

      if (!row?.chain_kind || row.chain_kind.trim().length === 0) {
        return { chain_kind: 'prep' };
      }

      return {
        chain_kind: row.chain_kind === 'chain' ? 'chain' : 'prep',
        chain_id: row.chain_id ?? undefined,
        chain_root_job_id: row.chain_root_job_id ?? undefined,
        chain_root_bead_id: row.chain_root_bead_id ?? undefined,
      };
    }, 'readChainIdentity');
  }

  listChainJobIds(chainId: string): string[] {
    return withRetry(() => {
      const rows = this.db.query(`
        SELECT job_id
        FROM specialist_jobs
        WHERE chain_id = ?
        ORDER BY updated_at_ms ASC
      `).all(chainId) as Array<{ job_id?: string | null }>;

      return rows
        .map((row) => row.job_id)
        .filter((jobId): jobId is string => typeof jobId === 'string' && jobId.length > 0);
    }, 'listChainJobIds');
  }

  listLiveJobsForBead(beadId: string): string[] {
    return withRetry(() => {
      const rows = this.db.query(`
        SELECT job_id
        FROM specialist_jobs
        WHERE bead_id = ?
          AND status IN ('starting', 'running', 'waiting')
        ORDER BY updated_at_ms ASC
      `).all(beadId) as Array<{ job_id?: string | null }>;

      return rows
        .map((row) => row.job_id)
        .filter((jobId): jobId is string => typeof jobId === 'string' && jobId.length > 0);
    }, 'listLiveJobsForBead');
  }

  resolveChainEpicLinkByJobId(jobId: string): ChainEpicLinkRecord | null {
    return withRetry(() => {
      const row = this.db.query(`
        SELECT
          jobs.chain_id AS chain_id,
          COALESCE(membership.epic_id, jobs.epic_id) AS epic_id,
          COALESCE(jobs.chain_root_job_id, membership.chain_root_job_id, jobs.chain_id) AS chain_root_job_id,
          COALESCE(jobs.chain_root_bead_id, membership.chain_root_bead_id) AS chain_root_bead_id
        FROM specialist_jobs jobs
        LEFT JOIN epic_chain_membership membership ON membership.chain_id = jobs.chain_id
        WHERE jobs.job_id = ?
          AND jobs.chain_kind = 'chain'
          AND jobs.chain_id IS NOT NULL
        LIMIT 1
      `).get(jobId) as ChainEpicLinkRecord | undefined;

      return row ?? null;
    }, 'resolveChainEpicLinkByJobId');
  }

  readEvents(jobId: string): TimelineEvent[] {
    return withRetry(() => {
      const rows = this.db.query(`
        SELECT seq, event_json FROM specialist_events
        WHERE job_id = ?
        ORDER BY seq ASC, id ASC;
      `).all(jobId) as Array<{ seq?: number; event_json?: string }>;
      const events: TimelineEvent[] = [];
      for (const row of rows) {
        if (!row.event_json) continue;
        try {
          const parsed = JSON.parse(row.event_json) as TimelineEvent;
          events.push(typeof parsed.seq === 'number' ? parsed : { ...parsed, seq: row.seq });
        } catch {
          /* ignore malformed rows */
        }
      }
      return events;
    }, 'readEvents');
  }

  readEventsAfterSeq(jobId: string, afterSeq: number): TimelineEvent[] {
    return withRetry(() => {
      const rows = this.db.query(`
        SELECT seq, event_json FROM specialist_events
        WHERE job_id = ? AND seq > ?
        ORDER BY seq ASC, id ASC;
      `).all(jobId, afterSeq) as Array<{ seq?: number; event_json?: string }>;
      const events: TimelineEvent[] = [];
      for (const row of rows) {
        if (!row.event_json) continue;
        try {
          const parsed = JSON.parse(row.event_json) as TimelineEvent;
          events.push(typeof parsed.seq === 'number' ? parsed : { ...parsed, seq: row.seq });
        } catch {
          /* ignore malformed rows */
        }
      }
      return events;
    }, 'readEventsAfterSeq');
  }

  readForensicEvents(filters: ListForensicEventsFilters = {}): ForensicEventRecord[] {
    return withRetry(() => {
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (filters.jobId) { clauses.push('job_id = ?'); params.push(filters.jobId); }
      if (filters.sinceMs !== undefined) { clauses.push('t >= ?'); params.push(filters.sinceMs); }
      if (filters.eventFamily) { clauses.push('event_family = ?'); params.push(filters.eventFamily); }
      if (filters.eventName) { clauses.push('event_name = ?'); params.push(filters.eventName); }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = Math.max(1, Math.min(filters.limit ?? 1000, 10_000));
      const dir = filters.order === 'desc' ? 'DESC' : 'ASC';
      return this.db.query(`
        SELECT id, job_id, seq, t, schema_version, event_family, event_name,
               participant_kind, participant_role, participant_id, attempt_id, redaction_status, event_json
        FROM specialist_forensic_events
        ${where}
        ORDER BY t ${dir}, seq ${dir}, id ${dir}
        LIMIT ?
      `).all(...params, limit) as ForensicEventRecord[];
    }, 'readForensicEvents');
  }

  readLatestToolEvent(jobId: string): TimelineEventTool | null {
    return withRetry(() => {
      const row = this.db.query(`
        SELECT seq, event_json FROM specialist_events
        WHERE job_id = ? AND type = 'tool'
        ORDER BY seq DESC, id DESC
        LIMIT 1;
      `).get(jobId) as { seq?: number; event_json?: string } | undefined;

      if (!row?.event_json) return null;

      try {
        const parsed = JSON.parse(row.event_json) as TimelineEvent;
        if (parsed.type !== 'tool') return null;
        return typeof parsed.seq === 'number' ? parsed : { ...parsed, seq: row.seq };
      } catch {
        return null;
      }
    }, 'readLatestToolEvent');
  }

  getLastActivityTimestampMs(jobId: string): number | null {
    return withRetry(() => {
      const row = this.db.query(`
        SELECT MAX(t) AS last_activity_ms
        FROM specialist_events
        WHERE job_id = ? AND type IN ('tool', 'think')
      `).get(jobId) as { last_activity_ms?: number } | undefined;
      return typeof row?.last_activity_ms === 'number' ? row.last_activity_ms : null;
    }, 'getLastActivityTimestampMs');
  }

  aggregateJobMetrics(jobId: string): JobMetricsRecord | null {
    return withRetry(() => {
      const jobRow = this.db.query(`
        SELECT job_id, specialist, status, chain_kind, chain_id, bead_id, node_id, epic_id, updated_at_ms, startup_payload_json
        FROM specialist_jobs
        WHERE job_id = ?
      `).get(jobId) as {
        job_id: string;
        specialist: string;
        status: string;
        chain_kind?: string | null;
        chain_id?: string | null;
        bead_id?: string | null;
        node_id?: string | null;
        epic_id?: string | null;
        updated_at_ms: number;
        startup_payload_json?: string | null;
      } | undefined;

      if (!jobRow) return null;

      const events = this.readEvents(jobId);
      const toolCallCounts: Record<string, number> = {};
      const tokenTrajectory: Array<Record<string, unknown>> = [];
      const contextTrajectory: Array<Record<string, unknown>> = [];
      const stallGaps: Array<Record<string, unknown>> = [];
      let totalTools = 0;
      let totalTurns = 0;
      let startedAtMs: number | null = null;
      let completedAtMs: number | null = null;
      let runCompleteJson: string | null = null;
      let model: string | null = null;
      let elapsedMs: number | null = null;
      let activeRuntimeMs = 0;
      let waitingMs = 0;
      let phase: 'running' | 'waiting' | null = null;
      let phaseStartedAtMs: number | null = null;

      const closePhase = (endAtMs: number): void => {
        if (phase === null || phaseStartedAtMs === null || endAtMs < phaseStartedAtMs) return;
        const durationMs = endAtMs - phaseStartedAtMs;
        if (phase === 'running') {
          activeRuntimeMs += durationMs;
        } else {
          waitingMs += durationMs;
        }
      };

      for (const event of events) {
        startedAtMs = startedAtMs === null ? event.t : Math.min(startedAtMs, event.t);

        if (event.type === 'tool') {
          totalTools += 1;
          toolCallCounts[event.tool] = (toolCallCounts[event.tool] ?? 0) + 1;
          continue;
        }

        if (event.type === 'turn_summary') {
          totalTurns += 1;
          if (event.token_usage) tokenTrajectory.push({ turn_index: event.turn_index, t: event.t, token_usage: event.token_usage });
          if (event.context_pct !== undefined) contextTrajectory.push({ turn_index: event.turn_index, t: event.t, context_pct: event.context_pct });
          continue;
        }

        if (event.type === 'token_usage') {
          tokenTrajectory.push({ t: event.t, source: event.source, token_usage: event.token_usage });
          continue;
        }

        if (event.type === 'run_start') {
          phase = 'running';
          phaseStartedAtMs = event.t;
          continue;
        }

        if (event.type === 'status_change') {
          if (event.status === 'running' || event.status === 'waiting') {
            closePhase(event.t);
            phase = event.status;
            phaseStartedAtMs = event.t;
            continue;
          }
          if (event.status === 'done' || event.status === 'error' || event.status === 'cancelled') {
            closePhase(event.t);
            phase = null;
            phaseStartedAtMs = null;
          }
          continue;
        }

        if (event.type === 'run_complete') {
          closePhase(event.t);
          completedAtMs = event.t;
          runCompleteJson = JSON.stringify(event);
          model = event.model ?? model;
          elapsedMs = Math.round(event.elapsed_s * 1000);
          phase = null;
          phaseStartedAtMs = null;
          continue;
        }

        if (event.type === 'stale_warning' && event.reason === 'tool_duration') {
          stallGaps.push({ t: event.t, tool: event.tool ?? null, silence_ms: event.silence_ms, threshold_ms: event.threshold_ms });
        }
      }

      if (startedAtMs !== null && completedAtMs === null) {
        completedAtMs = events.length > 0 ? events[events.length - 1]!.t : startedAtMs;
      }
      if (elapsedMs === null && startedAtMs !== null && completedAtMs !== null) {
        elapsedMs = Math.max(0, completedAtMs - startedAtMs);
      }

      const record: JobMetricsRecord = {
        job_id: jobRow.job_id,
        specialist: jobRow.specialist,
        model,
        status: jobRow.status,
        chain_kind: jobRow.chain_kind ?? null,
        chain_id: jobRow.chain_id ?? null,
        bead_id: jobRow.bead_id ?? null,
        node_id: jobRow.node_id ?? null,
        epic_id: jobRow.epic_id ?? null,
        started_at_ms: startedAtMs,
        completed_at_ms: completedAtMs,
        elapsed_ms: elapsedMs,
        active_runtime_ms: activeRuntimeMs,
        waiting_ms: waitingMs,
        total_turns: totalTurns,
        total_tools: totalTools,
        tool_call_counts_json: stringifyJson(toolCallCounts),
        token_trajectory_json: stringifyJson(tokenTrajectory),
        context_trajectory_json: stringifyJson(contextTrajectory),
        stall_gaps_json: stringifyJson(stallGaps),
        run_complete_json: runCompleteJson,
        startup_payload_json: jobRow.startup_payload_json ?? null,
        updated_at_ms: jobRow.updated_at_ms,
      };

      this.db.run(`
        INSERT INTO specialist_job_metrics (
          job_id, specialist, model, status, chain_kind, chain_id, bead_id, node_id, epic_id,
          started_at_ms, completed_at_ms, elapsed_ms, active_runtime_ms, waiting_ms, total_turns, total_tools,
          tool_call_counts_json, token_trajectory_json, context_trajectory_json, stall_gaps_json,
          run_complete_json, startup_payload_json, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          specialist = excluded.specialist,
          model = excluded.model,
          status = excluded.status,
          chain_kind = excluded.chain_kind,
          chain_id = excluded.chain_id,
          bead_id = excluded.bead_id,
          node_id = excluded.node_id,
          epic_id = excluded.epic_id,
          started_at_ms = excluded.started_at_ms,
          completed_at_ms = excluded.completed_at_ms,
          elapsed_ms = excluded.elapsed_ms,
          active_runtime_ms = excluded.active_runtime_ms,
          waiting_ms = excluded.waiting_ms,
          total_turns = excluded.total_turns,
          total_tools = excluded.total_tools,
          tool_call_counts_json = excluded.tool_call_counts_json,
          token_trajectory_json = excluded.token_trajectory_json,
          context_trajectory_json = excluded.context_trajectory_json,
          stall_gaps_json = excluded.stall_gaps_json,
          run_complete_json = excluded.run_complete_json,
          startup_payload_json = excluded.startup_payload_json,
          updated_at_ms = excluded.updated_at_ms;
      `, [
        record.job_id, record.specialist, record.model, record.status, record.chain_kind, record.chain_id, record.bead_id, record.node_id, record.epic_id,
        record.started_at_ms, record.completed_at_ms, record.elapsed_ms, record.active_runtime_ms, record.waiting_ms, record.total_turns, record.total_tools,
        record.tool_call_counts_json, record.token_trajectory_json, record.context_trajectory_json, record.stall_gaps_json,
        record.run_complete_json, record.startup_payload_json, record.updated_at_ms,
      ]);

      return record;
    }, 'aggregateJobMetrics');
  }

  listJobMetrics(filters?: { spec?: string; model?: string; sinceMs?: number }): JobMetricsRecord[] {
    return withRetry(() => {
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (filters?.spec) { clauses.push('specialist = ?'); params.push(filters.spec); }
      if (filters?.model) { clauses.push('model LIKE ?'); params.push(filters.model.replace(/\*/g, '%')); }
      if (filters?.sinceMs !== undefined) { clauses.push('updated_at_ms >= ?'); params.push(filters.sinceMs); }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      return this.db.query(`SELECT * FROM specialist_job_metrics ${where} ORDER BY updated_at_ms DESC, job_id DESC`).all(...params) as JobMetricsRecord[];
    }, 'listJobMetrics');
  }

  listElapsedMsBySpecialist(sinceMs: number, limitPerSpecialist: number = 200): Record<string, number[]> {
    return withRetry(() => {
      const rows = this.db.query(`
        WITH ranked AS (
          SELECT specialist, elapsed_ms,
                 ROW_NUMBER() OVER (PARTITION BY specialist ORDER BY updated_at_ms DESC) AS rn
          FROM specialist_job_metrics
          WHERE status = 'completed' AND updated_at_ms >= ? AND elapsed_ms IS NOT NULL
        )
        SELECT specialist, elapsed_ms
        FROM ranked
        WHERE rn <= ?
        ORDER BY specialist, rn
      `).all(sinceMs, limitPerSpecialist) as Array<{ specialist?: string; elapsed_ms?: number }>;

      const bySpecialist: Record<string, number[]> = {};
      for (const row of rows) {
        if (!row.specialist || typeof row.elapsed_ms !== 'number' || !Number.isFinite(row.elapsed_ms)) continue;
        (bySpecialist[row.specialist] ??= []).push(row.elapsed_ms);
      }
      return bySpecialist;
    }, 'listElapsedMsBySpecialist');
  }

  readResult(jobId: string): string | null {
    return withRetry(() => {
      const row = this.db.query('SELECT output FROM specialist_results WHERE job_id = ? LIMIT 1').get(jobId) as { output?: string } | undefined;
      return row?.output ?? null;
    }, 'readResult');
  }

  syncMemoriesCache(memories: readonly MemoryCacheInputRecord[], syncedAtMs: number = Date.now()): void {
    withRetry(() => {
      const transaction = this.db.transaction(() => {
        this.db.run('DELETE FROM memories_fts');

        const upsertMemory = this.db.query(`
          INSERT INTO memories_cache (memory_key, memory_value, updated_at_ms)
          VALUES (?, ?, ?)
          ON CONFLICT(memory_key) DO UPDATE SET
            memory_value = excluded.memory_value,
            updated_at_ms = excluded.updated_at_ms
        `);

        const insertFts = this.db.query('INSERT INTO memories_fts (key, content) VALUES (?, ?)');
        const seen = new Set<string>();

        for (const memory of memories) {
          if (!memory.key || seen.has(memory.key)) continue;
          seen.add(memory.key);
          upsertMemory.run(memory.key, memory.value, syncedAtMs);
          insertFts.run(memory.key, `${memory.key} ${memory.value}`);
        }

        if (seen.size > 0) {
          const placeholders = [...seen].map(() => '?').join(', ');
          this.db.query(`DELETE FROM memories_cache WHERE memory_key NOT IN (${placeholders})`).run(...seen);
        } else {
          this.db.run('DELETE FROM memories_cache');
        }

        this.db.query(`
          INSERT INTO memories_cache_meta (singleton_key, last_sync_at_ms, memory_count)
          VALUES (1, ?, ?)
          ON CONFLICT(singleton_key) DO UPDATE SET
            last_sync_at_ms = excluded.last_sync_at_ms,
            memory_count = excluded.memory_count
        `).run(syncedAtMs, seen.size);
      });
      transaction();
    }, 'syncMemoriesCache');
  }

  getMemoriesCacheState(): MemoryCacheState | null {
    return withRetry(() => {
      const row = this.db.query(`
        SELECT last_sync_at_ms, memory_count
        FROM memories_cache_meta
        WHERE singleton_key = 1
        LIMIT 1
      `).get() as { last_sync_at_ms?: number; memory_count?: number } | undefined;

      if (!row || typeof row.last_sync_at_ms !== 'number' || typeof row.memory_count !== 'number') {
        return null;
      }

      return { lastSyncAtMs: row.last_sync_at_ms, memoryCount: row.memory_count };
    }, 'getMemoriesCacheState');
  }

  queryRelevantMemories(keywords: readonly string[], limit: number = 10, nowMs: number = Date.now()): RelevantMemoryRecord[] {
    return withRetry(() => {
      const cleanedKeywords = [...new Set(keywords.map(keyword => keyword.trim()).filter(keyword => keyword.length > 0))];
      if (cleanedKeywords.length === 0) return [];

      const matchQuery = cleanedKeywords.map(keyword => `"${keyword.replace(/"/g, '""')}"`).join(' OR ');

      const rows = this.db.query(`
        SELECT
          cache.memory_key,
          cache.memory_value,
          bm25(memories_fts) AS bm25_score,
          COALESCE((? - cache.updated_at_ms) / 3600000.0, 999999.0) AS age_hours,
          cache.access_count
        FROM memories_fts
        JOIN memories_cache cache ON cache.memory_key = memories_fts.key
        WHERE memories_fts MATCH ?
        ORDER BY bm25_score ASC
        LIMIT ?
      `).all(nowMs, matchQuery, Math.max(1, limit * 3)) as Array<{
        memory_key: string;
        memory_value: string;
        bm25_score: number;
        age_hours: number;
        access_count: number;
      }>;

      const ranked = rows.map((row) => {
        const bm25 = Number.isFinite(row.bm25_score) ? row.bm25_score : 100;
        const bm25Norm = 1 / (1 + Math.max(0, bm25));
        const recency = Math.exp(-Math.max(0, row.age_hours) / 72);
        const accessFrequency = Math.min(1, Math.log1p(Math.max(0, row.access_count)) / Math.log(10));
        const score = (0.5 * bm25Norm) + (0.3 * recency) + (0.2 * accessFrequency);

        return {
          key: row.memory_key,
          value: row.memory_value,
          bm25,
          recency,
          accessFrequency,
          score,
        };
      });

      ranked.sort((left, right) => right.score - left.score);
      const selected = ranked.slice(0, Math.max(1, limit));
      if (selected.length === 0) return [];

      const accessStmt = this.db.query(`
        UPDATE memories_cache
        SET access_count = access_count + 1,
            last_accessed_at_ms = ?
        WHERE memory_key = ?
      `);
      for (const memory of selected) {
        accessStmt.run(nowMs, memory.key);
      }

      return selected;
    }, 'queryRelevantMemories');
  }

  invalidateMemoriesCache(): void {
    withRetry(() => {
      const transaction = this.db.transaction(() => {
        this.db.run('DELETE FROM memories_fts');
        this.db.run('DELETE FROM memories_cache');
        this.db.run('DELETE FROM memories_cache_meta');
      });
      transaction();
    }, 'invalidateMemoriesCache');
  }

  hasActiveJobs(statuses: readonly string[] = ['running', 'starting']): boolean {
    return this.listActiveJobs(statuses).length > 0;
  }

  listActiveJobs(statuses: readonly string[] = ['running', 'starting']): Array<{ job_id: string; specialist: string; status: string }> {
    return withRetry(() => {
      if (statuses.length === 0) return [];
      const placeholders = statuses.map(() => '?').join(', ');
      return this.db.query(`
        SELECT job_id, specialist, status
        FROM specialist_jobs
        WHERE status IN (${placeholders})
        ORDER BY updated_at_ms DESC
      `).all(...statuses) as Array<{ job_id: string; specialist: string; status: string }>;
    }, 'listActiveJobs');
  }

  getDatabaseSizeBytes(): number {
    try {
      return statSync(this.dbPath).size;
    } catch {
      return 0;
    }
  }

  vacuumDatabase(): { beforeBytes: number; afterBytes: number } {
    return withRetry(() => {
      const beforeBytes = this.getDatabaseSizeBytes();
      this.db.run('VACUUM');
      const afterBytes = this.getDatabaseSizeBytes();
      return { beforeBytes, afterBytes };
    }, 'vacuumDatabase');
  }

  pruneObservabilityData(options: PruneObservabilityOptions): PruneObservabilityReport {
    return withRetry(() => {
      const nowMs = options.nowMs ?? Date.now();
      const eventsRetentionMs = options.eventsRetentionMs ?? (30 * 24 * 60 * 60 * 1000);
      const eventsCutoffMs = nowMs - eventsRetentionMs;
      const terminalStatuses = ['done', 'error', 'stopped'];
      const activeStatuses = ['running', 'starting', 'waiting'];

      const skippedActiveChainJobs = (this.db.query(`
        SELECT COUNT(*) AS count
        FROM specialist_jobs stale
        WHERE stale.updated_at_ms < ?
          AND stale.status IN (${terminalStatuses.map(() => '?').join(', ')})
          AND stale.chain_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM specialist_jobs active
            WHERE active.chain_id = stale.chain_id
              AND active.status IN (${activeStatuses.map(() => '?').join(', ')})
          )
      `).get(options.beforeMs, ...terminalStatuses, ...activeStatuses) as { count?: number } | undefined)?.count ?? 0;

      const resultCandidates = (this.db.query(`
        SELECT COUNT(*) AS count
        FROM specialist_results results
        LEFT JOIN specialist_jobs jobs ON jobs.job_id = results.job_id
        WHERE results.updated_at_ms < ?
          AND (
            jobs.job_id IS NULL
            OR jobs.chain_id IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM specialist_jobs active
              WHERE active.chain_id = jobs.chain_id
                AND active.status IN (${activeStatuses.map(() => '?').join(', ')})
            )
          )
      `).get(options.beforeMs, ...activeStatuses) as { count?: number } | undefined)?.count ?? 0;

      const jobCandidates = (this.db.query(`
        SELECT COUNT(*) AS count
        FROM specialist_jobs stale
        WHERE stale.updated_at_ms < ?
          AND stale.status IN (${terminalStatuses.map(() => '?').join(', ')})
          AND (
            stale.chain_id IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM specialist_jobs active
              WHERE active.chain_id = stale.chain_id
                AND active.status IN (${activeStatuses.map(() => '?').join(', ')})
            )
          )
      `).get(options.beforeMs, ...terminalStatuses, ...activeStatuses) as { count?: number } | undefined)?.count ?? 0;

      const extractCandidates = options.skipExtract
        ? 0
        : (this.db.query(`
          SELECT COUNT(DISTINCT job_id) AS count
          FROM specialist_events
          WHERE t < ?
        `).get(eventsCutoffMs) as { count?: number } | undefined)?.count ?? 0;

      const eventsCandidates = (this.db.query('SELECT COUNT(*) AS count FROM specialist_events WHERE t < ?').get(eventsCutoffMs) as { count?: number } | undefined)?.count ?? 0;

      const epicCandidates = options.includeEpics
        ? ((this.db.query(`
          SELECT COUNT(*) AS count
          FROM epic_runs epic
          WHERE epic.updated_at_ms < ?
            AND epic.status IN ('merged', 'failed', 'abandoned')
            AND NOT EXISTS (
              SELECT 1
              FROM epic_chain_membership membership
              WHERE membership.epic_id = epic.epic_id
            )
        `).get(options.beforeMs) as { count?: number } | undefined)?.count ?? 0)
        : 0;

      if (!options.apply) {
        return {
          dryRun: true,
          beforeMs: options.beforeMs,
          eventsCutoffMs,
          includeEpics: options.includeEpics,
          deletedEvents: eventsCandidates,
          deletedResults: resultCandidates,
          deletedJobs: jobCandidates,
          deletedEpicRuns: epicCandidates,
          skippedActiveChainJobs,
          extractedJobs: extractCandidates,
        };
      }

      let extractedJobs = 0;
      if (!options.skipExtract) {
        const jobsToExtract = this.db.query(`
          SELECT DISTINCT stale.job_id
          FROM specialist_events stale
          WHERE stale.t < ?
        `).all(eventsCutoffMs) as Array<{ job_id?: string | null }>;

        for (const row of jobsToExtract) {
          if (!row.job_id) continue;
          const metrics = this.aggregateJobMetrics(row.job_id);
          if (!metrics) {
            throw new Error(`Failed to aggregate metrics for job ${row.job_id}`);
          }
          extractedJobs += 1;
        }
      }

      const deleteResults = this.db.query(`
        DELETE FROM specialist_results
        WHERE updated_at_ms < ?
          AND (
            job_id NOT IN (SELECT job_id FROM specialist_jobs WHERE chain_id IS NOT NULL)
            OR job_id IN (
              SELECT jobs.job_id
              FROM specialist_jobs jobs
              WHERE jobs.chain_id IS NULL
                 OR NOT EXISTS (
                    SELECT 1
                    FROM specialist_jobs active
                    WHERE active.chain_id = jobs.chain_id
                      AND active.status IN (${activeStatuses.map(() => '?').join(', ')})
                 )
            )
          )
      `);
      const deletedResults = deleteResults.run(options.beforeMs, ...activeStatuses).changes ?? 0;

      const deleteEvents = this.db.query('DELETE FROM specialist_events WHERE t < ?');
      const deletedEvents = deleteEvents.run(eventsCutoffMs).changes ?? 0;

      const deleteJobs = this.db.query(`
        DELETE FROM specialist_jobs
        WHERE updated_at_ms < ?
          AND status IN (${terminalStatuses.map(() => '?').join(', ')})
          AND (
            chain_id IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM specialist_jobs active
              WHERE active.chain_id = specialist_jobs.chain_id
                AND active.status IN (${activeStatuses.map(() => '?').join(', ')})
            )
          )
      `);
      const deletedJobs = deleteJobs.run(options.beforeMs, ...terminalStatuses, ...activeStatuses).changes ?? 0;

      let deletedEpicRuns = 0;
      if (options.includeEpics) {
        const deleteEpics = this.db.query(`
          DELETE FROM epic_runs
          WHERE updated_at_ms < ?
            AND status IN ('merged', 'failed', 'abandoned')
            AND NOT EXISTS (
              SELECT 1
              FROM epic_chain_membership membership
              WHERE membership.epic_id = epic_runs.epic_id
            )
        `);
        deletedEpicRuns = deleteEpics.run(options.beforeMs).changes ?? 0;
      }

      return {
        dryRun: false,
        beforeMs: options.beforeMs,
        eventsCutoffMs,
        includeEpics: options.includeEpics,
        deletedEvents,
        deletedResults,
        deletedJobs,
        deletedEpicRuns,
        skippedActiveChainJobs,
        extractedJobs,
      };
    }, 'pruneObservabilityData');
  }

  scanOrphans(): OrphanScanFinding[] {
    return withRetry(() => {
      const findings: OrphanScanFinding[] = [];

      const chainMembershipWithoutJobs = this.db.query(`
        SELECT membership.chain_id, membership.epic_id
        FROM epic_chain_membership membership
        LEFT JOIN specialist_jobs jobs ON jobs.chain_id = membership.chain_id
        WHERE jobs.job_id IS NULL
      `).all() as Array<{ chain_id: string; epic_id: string }>;

      for (const row of chainMembershipWithoutJobs) {
        findings.push({
          kind: 'orphan',
          code: 'chain_membership_without_jobs',
          message: `chain ${row.chain_id} has epic membership but no jobs`,
          details: { chain_id: row.chain_id, epic_id: row.epic_id },
        });
      }

      const epicsWithoutChains = this.db.query(`
        SELECT epic.epic_id, epic.status
        FROM epic_runs epic
        LEFT JOIN epic_chain_membership membership ON membership.epic_id = epic.epic_id
        WHERE membership.chain_id IS NULL
      `).all() as Array<{ epic_id: string; status: string }>;

      for (const row of epicsWithoutChains) {
        findings.push({
          kind: 'orphan',
          code: 'epic_without_chains',
          message: `epic ${row.epic_id} has no chain membership`,
          details: { epic_id: row.epic_id, status: row.status },
        });
      }

      const jobEpicWithoutMembership = this.db.query(`
        SELECT jobs.job_id, jobs.epic_id, jobs.chain_id
        FROM specialist_jobs jobs
        LEFT JOIN epic_chain_membership membership
          ON membership.chain_id = jobs.chain_id
         AND membership.epic_id = jobs.epic_id
        WHERE jobs.epic_id IS NOT NULL
          AND (jobs.chain_id IS NULL OR membership.chain_id IS NULL)
      `).all() as Array<{ job_id: string; epic_id: string; chain_id?: string | null }>;

      for (const row of jobEpicWithoutMembership) {
        findings.push({
          kind: 'integrity-violation',
          code: 'job_epic_without_membership',
          message: `job ${row.job_id} references epic without chain membership link`,
          details: { job_id: row.job_id, epic_id: row.epic_id, chain_id: row.chain_id ?? null },
        });
      }

      const worktreeRows = this.db.query(`
        SELECT DISTINCT job_id, worktree_column
        FROM specialist_jobs
        WHERE worktree_column IS NOT NULL AND worktree_column != ''
      `).all() as Array<{ job_id: string; worktree_column: string }>;

      for (const row of worktreeRows) {
        if (existsSync(row.worktree_column)) continue;
        findings.push({
          kind: 'stale-pointer',
          code: 'worktree_missing_on_disk',
          message: `job ${row.job_id} points to missing worktree path`,
          details: { job_id: row.job_id, worktree_path: row.worktree_column },
        });
      }

      return findings;
    }, 'scanOrphans');
  }

  close(): void {
    this.db.close();
  }
}

export function hasRunCompleteEvent(jobId: string, cwd: string = process.cwd()): boolean {
  const sqliteClient = createObservabilitySqliteClient(cwd);

  try {
    if (sqliteClient) {
      const events = sqliteClient.readEvents(jobId);
      return events.some((event) => event.type === 'run_complete');
    }
  } finally {
    sqliteClient?.close();
  }

  const eventsPath = join(resolveJobsDir(cwd), jobId, 'events.jsonl');
  if (!existsSync(eventsPath)) return false;

  try {
    const lines = readFileSync(eventsPath, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (const line of lines) {
      const event = JSON.parse(line) as { type?: string };
      if (event.type === 'run_complete') return true;
    }
  } catch {
    return false;
  }

  return false;
}

function openObservabilitySqliteClient(dbPath: string): ObservabilitySqliteClient | null {
  if (!loadBunDatabase()) return null;

  try {
    // Open DB for schema initialization (temporary connection)
    const Ctor = loadBunDatabase()!;
    const initDb = new Ctor(dbPath);
    initDb.run(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
    initSchema(initDb);
    initDb.close();

    // Create persistent client connection
    return new SqliteClient(dbPath);
  } catch (error) {
    console.warn(`[observability-sqlite] Failed to open observability database at ${dbPath}: ${String(error)}`);
    return null;
  }
}

export function createObservabilitySqliteClient(cwd: string = process.cwd()): ObservabilitySqliteClient | null {
  const location = resolveObservabilityDbLocation(cwd);
  if (!existsSync(location.dbPath)) return null;
  return openObservabilitySqliteClient(location.dbPath);
}

export function createObservabilitySqliteClientAtPath(dbPath: string): ObservabilitySqliteClient | null {
  mkdirSync(dirname(dbPath), { recursive: true });
  return openObservabilitySqliteClient(dbPath);
}
