import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { Database } from 'bun:sqlite';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createObservabilitySqliteClient,
  createObservabilitySqliteClientAtPath,
  enforceWalMode,
  initSchema,
  parseJournalMode,
  verifyWalMode,
} from '../../../src/specialist/observability-sqlite.js';
import { createForensicEvent } from '../../../src/specialist/forensic-events.js';
import { createBranchIntegrationEvent } from '../../../src/specialist/branch-integration-events.js';
import { loadEpicReadinessSummary } from '../../../src/specialist/epic-readiness.js';
import {
  OBSERVABILITY_SCHEMA_VERSION,
  ensureObservabilityDbFile,
  resolveObservabilityDbLocation,
} from '../../../src/specialist/observability-db.js';

describe('observability-sqlite', () => {
  let tempRoot: string;
  let tempDbPath: string;
  let db: Database | null = null;
  let sqliteClient: ReturnType<typeof createObservabilitySqliteClient> | null = null;

  beforeEach(() => {
    tempRoot = join(tmpdir(), `test-observability-${crypto.randomUUID()}`);
    mkdirSync(tempRoot, { recursive: true });
    tempDbPath = join(tempRoot, 'direct.db');
  });

  afterEach(() => {
    if (sqliteClient) {
      try { sqliteClient.close(); } catch { /* ignore */ }
      sqliteClient = null;
    }

    if (db) {
      try { db.close(); } catch { /* ignore */ }
      db = null;
    }

    rmSync(tempRoot, { recursive: true, force: true });
  });

  const createClient = () => {
    const location = resolveObservabilityDbLocation(tempRoot);
    ensureObservabilityDbFile(location);

    const client = createObservabilitySqliteClientAtPath(location.dbPath);
    expect(client).not.toBeNull();
    sqliteClient = client;
    return client!;
  };

  it('opens and initializes an explicit observability database file path', () => {
    const explicitPath = join(tempRoot, 'custom', 'observability.db');

    const client = createObservabilitySqliteClientAtPath(explicitPath);
    sqliteClient = client;

    expect(client).not.toBeNull();
    expect(existsSync(explicitPath)).toBe(true);
    db = new Database(explicitPath);
    const schemaVersion = db.query('SELECT MAX(version) AS version FROM schema_version').get() as { version?: number };
    expect(schemaVersion.version).toBe(OBSERVABILITY_SCHEMA_VERSION);
  });

  it('warns and leaves no zero-byte placeholder when sqlite open fails', () => {
    const dbPath = join(tempRoot, 'not-a-database');
    mkdirSync(dbPath, { recursive: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const client = createObservabilitySqliteClientAtPath(dbPath);

    expect(client).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`Failed to open observability database at ${dbPath}`));
    expect(existsSync(join(tempRoot, 'not-a-database', 'observability.db'))).toBe(false);
    warn.mockRestore();
  });

  describe('enforceWalMode', () => {
    it('enables WAL mode on a fresh database', () => {
      db = new Database(tempDbPath);
      expect(() => enforceWalMode(db!)).not.toThrow();

      const result = db.query('PRAGMA journal_mode').get() as { journal_mode?: string };
      expect(result.journal_mode?.toLowerCase()).toBe('wal');
    });

    it('is idempotent - can be called multiple times', () => {
      db = new Database(tempDbPath);
      expect(() => enforceWalMode(db!)).not.toThrow();
      expect(() => enforceWalMode(db!)).not.toThrow();
      expect(() => enforceWalMode(db!)).not.toThrow();
    });
  });

  describe('verifyWalMode', () => {
    it('verifies WAL mode after it has been enabled', () => {
      db = new Database(tempDbPath);
      enforceWalMode(db);
      expect(() => verifyWalMode(db!)).not.toThrow();
    });

    it('throws when WAL mode is not enabled', () => {
      db = new Database(tempDbPath);
      expect(() => verifyWalMode(db!)).toThrow(/WAL journal mode is not active/);
    });
  });

  describe('migrateToV4', () => {
    it('creates node tables, v4 schema row, and expected indexes', () => {
      db = new Database(tempDbPath);
      initSchema(db);

      const tableRows = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('node_runs', 'node_members', 'node_events', 'node_memory') ORDER BY name").all() as Array<{ name: string }>;
      expect(tableRows.map((row) => row.name)).toEqual(['node_events', 'node_members', 'node_memory', 'node_runs']);

      expect(OBSERVABILITY_SCHEMA_VERSION).toBe(15);

      const schemaVersionRow = db.query('SELECT version FROM schema_version WHERE version = 10 LIMIT 1').get() as { version?: number };
      expect(schemaVersionRow.version).toBe(10);

      const indexRows = db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_node_runs_status', 'idx_node_members_run', 'idx_node_members_job', 'idx_node_members_run_member', 'idx_node_events_run_t', 'idx_node_events_type', 'idx_node_memory_run', 'idx_node_memory_entry_id') ORDER BY name").all() as Array<{ name: string }>;
      expect(indexRows.map((row) => row.name)).toEqual([
        'idx_node_events_run_t',
        'idx_node_events_type',
        'idx_node_members_job',
        'idx_node_members_run',
        'idx_node_members_run_member',
        'idx_node_memory_entry_id',
        'idx_node_memory_run',
        'idx_node_runs_status',
      ]);
    });

    it('is idempotent when initSchema is called twice on same database', () => {
      db = new Database(tempDbPath);
      expect(() => initSchema(db!)).not.toThrow();
      expect(() => initSchema(db!)).not.toThrow();

      const schemaVersionRow = db.query('SELECT version FROM schema_version WHERE version = 10 LIMIT 1').get() as { version?: number };
      expect(schemaVersionRow.version).toBe(10);
    });
  });

  describe('bootstrapNode', () => {
    it('creates node_runs row and two bootstrap events', () => {
      const client = createClient();
      client.bootstrapNode('node-1', 'coordinator', 'mem.ns');

      const run = client.readNodeRun('node-1');
      expect(run).not.toBeNull();
      expect(run?.status).toBe('created');

      const events = client.readNodeEvents('node-1');
      expect(events.map((event) => event.type)).toEqual(['node_created', 'node_started']);
    });

    it('is atomic (failure rolls back run and events)', () => {
      const client = createClient();
      const location = resolveObservabilityDbLocation(tempRoot);
      db = new Database(location.dbPath);

      db.run("CREATE TRIGGER fail_node_started BEFORE INSERT ON node_events WHEN NEW.type = 'node_started' BEGIN SELECT RAISE(ABORT, 'fail node_started'); END;");

      expect(() => client.bootstrapNode('node-rollback', 'coordinator')).toThrow();

      const runCount = db.query("SELECT COUNT(*) AS count FROM node_runs WHERE id = 'node-rollback'").get() as { count: number };
      const eventCount = db.query("SELECT COUNT(*) AS count FROM node_events WHERE node_run_id = 'node-rollback'").get() as { count: number };
      expect(runCount.count).toBe(0);
      expect(eventCount.count).toBe(0);
    });
  });


  describe('listElapsedMsBySpecialist', () => {
    it('returns bounded elapsed ms per specialist', () => {
      const client = createClient();
      const location = resolveObservabilityDbLocation(tempRoot);
      db = new Database(location.dbPath);

      db.run(`
        INSERT INTO specialist_job_metrics (job_id, specialist, status, elapsed_ms, updated_at_ms, tool_call_counts_json, token_trajectory_json, context_trajectory_json, stall_gaps_json, total_turns, total_tools) VALUES
        ('job-1', 'alpha', 'completed', 100, 1000, '{}', '{}', '{}', '[]', 0, 0),
        ('job-2', 'alpha', 'completed', 200, 2000, '{}', '{}', '{}', '[]', 0, 0),
        ('job-3', 'alpha', 'completed', 300, 3000, '{}', '{}', '{}', '[]', 0, 0),
        ('job-4', 'beta', 'completed', 400, 4000, '{}', '{}', '{}', '[]', 0, 0),
        ('job-5', 'beta', 'running', 500, 5000, '{}', '{}', '{}', '[]', 0, 0)
      `);

      const result = client.listElapsedMsBySpecialist(0, 2);
      expect(result.alpha).toEqual([300, 200]);
      expect(result.beta).toEqual([400]);
    });
  });

  describe('upsertNodeRun', () => {
    it('inserts and updates node_runs rows (status/error/update fields)', () => {
      const client = createClient();

      client.upsertNodeRun({
        id: 'run-1',
        node_name: 'node-a',
        status: 'running',
        updated_at_ms: 100,
        status_json: JSON.stringify({ status: 'running', nested: { pct: 10 } }),
      });

      let row = client.readNodeRun('run-1');
      expect(row?.status).toBe('running');
      expect(row?.updated_at_ms).toBe(100);

      client.upsertNodeRun({
        id: 'run-1',
        node_name: 'node-a',
        status: 'error',
        updated_at_ms: 200,
        error: 'boom',
        status_json: JSON.stringify({ status: 'error', nested: { pct: 100, info: ['a', 'b'] } }),
      });

      row = client.readNodeRun('run-1');
      expect(row?.status).toBe('error');
      expect(row?.updated_at_ms).toBe(200);
      expect(row?.error).toBe('boom');

      const parsedStatus = JSON.parse(row?.status_json ?? '{}') as Record<string, unknown>;
      expect(parsedStatus).toEqual({ status: 'error', nested: { pct: 100, info: ['a', 'b'] } });
    });
  });

  describe('upsertNodeMember', () => {
    it('inserts, upserts by (node_run_id, member_id), and supports multiple members per run', () => {
      const client = createClient();
      client.bootstrapNode('node-members', 'coordinator');

      client.upsertNodeMember({
        node_run_id: 'node-members',
        member_id: 'member-1',
        specialist: 'alpha',
        status: 'running',
      });

      client.upsertNodeMember({
        node_run_id: 'node-members',
        member_id: 'member-1',
        specialist: 'alpha',
        status: 'done',
      });

      client.upsertNodeMember({
        node_run_id: 'node-members',
        member_id: 'member-2',
        specialist: 'beta',
        status: 'running',
      });

      const members = client.readNodeMembers('node-members');
      expect(members).toHaveLength(2);
      expect(members[0].member_id).toBe('member-1');
      expect(members[0].status).toBe('done');
      expect(members[1].member_id).toBe('member-2');
    });
  });

  describe('appendNodeEvent', () => {
    it('appends events and keeps append order for custom events', () => {
      const client = createClient();
      client.bootstrapNode('node-events', 'coordinator');

      client.appendNodeEvent('node-events', 500, 'member_started', { seq: 2 });
      client.appendNodeEvent('node-events', 500, 'member_state_changed', { seq: 3 });
      client.appendNodeEvent('node-events', 400, 'node_state_changed', { seq: 1 });

      const events = client.readNodeEvents('node-events');
      const customEvents = events.filter((event) => ['node_state_changed', 'member_started', 'member_state_changed'].includes(event.type));

      expect(customEvents.map((event) => event.type).sort()).toEqual([
        'member_started',
        'member_state_changed',
        'node_state_changed',
      ]);

      const customSeqValues = customEvents
        .map((event) => JSON.parse(event.event_json) as { seq?: number })
        .map((payload) => payload.seq);
      expect(customSeqValues).toHaveLength(3);
      expect(customSeqValues.every((seq) => typeof seq === 'number')).toBe(true);
      expect(customSeqValues).toEqual([...customSeqValues].sort((a, b) => (a ?? 0) - (b ?? 0)));
    });
  });

  describe('appendForensicEvent', () => {
    it('allocates unique seq values when caller omits seq', () => {
      const client = createClient();
      const event = createForensicEvent({
        event_family: 'chain',
        event_name: 'chain.ready_for_review',
        resource: {
          service_namespace: 'xtrm',
          service_name: 'specialists',
          service_component: 'epic',
          deployment_environment: 'local',
          repo: 'specialists',
          participant_kind: 'specialist',
          participant_role: 'epic',
        },
        correlation: { job_id: 'epic-1', participant_id: 'epic::1' },
        body: { chain_template: 'epic-1', changed_paths_count: 2, terminal_state: 'merge_ready', result: 'pass' },
      });

      client.appendForensicEvent('epic-1', 'specialist', undefined, event);
      client.appendForensicEvent('epic-1', 'specialist', undefined, createForensicEvent({
        event_family: 'chain',
        event_name: 'chain.ready_for_review',
        resource: event.resource,
        correlation: event.correlation,
        body: event.body,
      }));

      db = new Database(resolveObservabilityDbLocation(tempRoot).dbPath);
      const rows = db.query('SELECT seq, event_json FROM specialist_forensic_events WHERE job_id = ? ORDER BY seq').all('epic-1') as Array<{ seq: number; event_json: string }>;
      expect(rows).toHaveLength(2);
      expect(rows[0].seq).toBeLessThan(rows[1].seq);
      expect(rows.map((row) => JSON.parse(row.event_json) as { correlation?: { job_id?: string } }).every((payload) => payload.correlation?.job_id === 'epic-1')).toBe(true);
    });

    it('fails visible on explicit seq collision and preserves the original row', () => {
      const client = createClient();
      const original = createForensicEvent({
        seq: 7,
        event_family: 'chain',
        event_name: 'chain.ready_for_review',
        resource: {
          service_namespace: 'xtrm',
          service_name: 'specialists',
          service_component: 'epic',
          deployment_environment: 'local',
          repo: 'specialists',
          participant_kind: 'specialist',
          participant_role: 'epic',
        },
        correlation: { job_id: 'epic-2', participant_id: 'epic::2' },
        body: { marker: 'original' },
      });
      const colliding = createForensicEvent({
        seq: 7,
        event_family: original.event_family,
        event_name: original.event_name,
        resource: original.resource,
        correlation: original.correlation,
        body: { marker: 'colliding' },
      });

      client.appendForensicEvent('epic-2', 'specialist', undefined, original);

      expect(() => client.appendForensicEvent('epic-2', 'specialist', undefined, colliding)).toThrow(/appendForensicEvent/i);

      db = new Database(resolveObservabilityDbLocation(tempRoot).dbPath);
      const rows = db.query('SELECT seq, event_json FROM specialist_forensic_events WHERE job_id = ? ORDER BY seq').all('epic-2') as Array<{ seq: number; event_json: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].seq).toBe(7);
      expect(JSON.parse(rows[0].event_json)).toMatchObject({
        seq: 7,
        body: { marker: 'original' },
      });
    });
  });

  describe('upsertNodeMemory', () => {
    it('inserts memory rows without entry_id and preserves sort order', () => {
      const client = createClient();
      client.bootstrapNode('node-memory', 'coordinator');

      client.upsertNodeMemory({
        node_run_id: 'node-memory',
        namespace: 'ns-1',
        entry_type: 'fact',
        summary: 'first',
        created_at_ms: 10,
        updated_at_ms: 10,
      });

      client.upsertNodeMemory({
        node_run_id: 'node-memory',
        namespace: 'ns-1',
        entry_type: 'fact',
        summary: 'second',
        created_at_ms: 20,
        updated_at_ms: 20,
      });

      const rows = client.readNodeMemory('node-memory', { namespace: 'ns-1', entry_type: 'fact' });
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.summary)).toEqual(['first', 'second']);
    });
  });

  describe('readNodeRun', () => {
    it('returns null for unknown run and parsed row for known run', () => {
      const client = createClient();

      expect(client.readNodeRun('missing')).toBeNull();

      client.upsertNodeRun({
        id: 'run-known',
        node_name: 'node-b',
        status: 'running',
        updated_at_ms: 1,
        status_json: JSON.stringify({ status: 'running' }),
      });

      const row = client.readNodeRun('run-known');
      expect(row).not.toBeNull();
      expect(row?.id).toBe('run-known');
      expect(row?.status).toBe('running');
    });
  });

  describe('listNodeRuns', () => {
    it('returns all runs without filter and only matching runs with status filter', () => {
      const client = createClient();

      client.upsertNodeRun({ id: 'run-1', node_name: 'node', status: 'running', updated_at_ms: 10, status_json: '{"status":"running"}' });
      client.upsertNodeRun({ id: 'run-2', node_name: 'node', status: 'error', updated_at_ms: 20, status_json: '{"status":"error"}' });

      const allRuns = client.listNodeRuns();
      expect(allRuns).toHaveLength(2);
      expect(allRuns.map((row) => row.id)).toEqual(['run-2', 'run-1']);

      const errorRuns = client.listNodeRuns({ status: 'error' });
      expect(errorRuns).toHaveLength(1);
      expect(errorRuns[0].id).toBe('run-2');
    });
  });

  describe('readNodeMembers', () => {
    it('returns empty array for node with no members and ordered rows otherwise', () => {
      const client = createClient();
      client.bootstrapNode('node-read-members', 'coordinator');

      expect(client.readNodeMembers('node-read-members')).toEqual([]);

      client.upsertNodeMember({ node_run_id: 'node-read-members', member_id: 'm1', specialist: 's1', status: 'running' });
      client.upsertNodeMember({ node_run_id: 'node-read-members', member_id: 'm2', specialist: 's2', status: 'running' });

      const members = client.readNodeMembers('node-read-members');
      expect(members.map((member) => member.member_id)).toEqual(['m1', 'm2']);
    });
  });

  describe('readNodeEvents', () => {
    it('supports ordering, type filter, and limit', () => {
      const client = createClient();
      client.bootstrapNode('node-read-events', 'coordinator');

      client.appendNodeEvent('node-read-events', 10, 'member_started', { marker: 'a' });
      client.appendNodeEvent('node-read-events', 20, 'member_state_changed', { marker: 'b' });
      client.appendNodeEvent('node-read-events', 30, 'member_started', { marker: 'c' });

      const ordered = client.readNodeEvents('node-read-events');

      const customEvents = ordered.filter((event) =>
        ['member_started', 'member_state_changed'].includes(event.type),
      );
      expect(customEvents.map((event) => event.type)).toEqual([
        'member_started',
        'member_state_changed',
        'member_started',
      ]);

      const typed = client.readNodeEvents('node-read-events', { type: 'member_started' });
      expect(typed.every((event) => event.type === 'member_started')).toBe(true);
      expect(
        typed
          .map((event) => JSON.parse(event.event_json) as { marker?: string })
          .map((payload) => payload.marker),
      ).toEqual(['a', 'c']);

      const limited = client.readNodeEvents('node-read-events', { limit: 2 });
      expect(limited).toHaveLength(2);
      expect(limited.map((event) => event.id)).toEqual(ordered.slice(0, 2).map((event) => event.id));
    });
  });

  describe('readNodeMemory', () => {
    it('returns memory ordered by created_at_ms and supports namespace + entry_type filters', () => {
      const client = createClient();
      client.bootstrapNode('node-read-memory', 'coordinator');

      client.upsertNodeMemory({ node_run_id: 'node-read-memory', namespace: 'ns-a', entry_type: 'fact', summary: 'a', created_at_ms: 30, updated_at_ms: 30 });
      client.upsertNodeMemory({ node_run_id: 'node-read-memory', namespace: 'ns-b', entry_type: 'question', summary: 'b', created_at_ms: 10, updated_at_ms: 10 });
      client.upsertNodeMemory({ node_run_id: 'node-read-memory', namespace: 'ns-a', entry_type: 'fact', summary: 'c', created_at_ms: 20, updated_at_ms: 20 });

      const all = client.readNodeMemory('node-read-memory');
      expect(all.map((row) => row.summary)).toEqual(['b', 'c', 'a']);

      const byNamespace = client.readNodeMemory('node-read-memory', { namespace: 'ns-a' });
      expect(byNamespace).toHaveLength(2);
      expect(byNamespace.every((row) => row.namespace === 'ns-a')).toBe(true);

      const byType = client.readNodeMemory('node-read-memory', { entry_type: 'question' });
      expect(byType).toHaveLength(1);
      expect(byType[0].entry_type).toBe('question');
    });
  });

  describe('queryMemberContextHealth', () => {
    it('returns null when no turn_summary exists for job', () => {
      const client = createClient();
      expect(client.queryMemberContextHealth('job-none')).toBeNull();
    });

    it('reads latest context_pct from specialist_events (not node_events)', () => {
      const client = createClient();
      const location = resolveObservabilityDbLocation(tempRoot);
      db = new Database(location.dbPath);

      db.run(
        `INSERT INTO specialist_events (seq, job_id, specialist, bead_id, t, type, event_json) VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
        [
          1, 'job-1', 'spec-a', null, 100, 'turn_summary', JSON.stringify({ context_pct: 41 }),
          2, 'job-1', 'spec-a', null, 200, 'turn_summary', JSON.stringify({ context_pct: 77 }),
        ],
      );

      db.run(
        `INSERT INTO node_events (seq, node_run_id, t, type, event_json) VALUES (?, ?, ?, ?, ?)`,
        [1, 'node-ctx', 999, 'node_state_changed', JSON.stringify({ context_pct: 5, note: 'must be ignored' })],
      );

      expect(client.queryMemberContextHealth('job-1')).toBe(77);
    });
  });

  describe('chain identity persistence', () => {
    it('stores prep jobs with explicit prep chain_kind and no chain id', () => {
      const client = createClient();
      client.upsertStatus({
        id: 'prep-1',
        specialist: 'planner',
        status: 'done',
        started_at_ms: 1,
        chain_kind: 'prep',
      });

      expect(client.readChainIdentity('prep-1')).toEqual({ chain_kind: 'prep' });
      expect(client.resolveChainEpicLinkByJobId('prep-1')).toBeNull();
    });

    it('resolves chain membership and chain->epic linkage from sqlite', () => {
      const client = createClient();

      client.upsertStatus({
        id: 'chain-root',
        specialist: 'executor',
        status: 'done',
        started_at_ms: 1,
        bead_id: 'unitAI-100',
        worktree_path: '/tmp/worktree',
        worktree_owner_job_id: 'chain-root',
        chain_kind: 'chain',
        chain_id: 'chain-root',
        chain_root_job_id: 'chain-root',
        chain_root_bead_id: 'unitAI-100',
        epic_id: 'unitAI-epic',
      });

      client.upsertStatus({
        id: 'chain-child',
        specialist: 'reviewer',
        status: 'waiting',
        started_at_ms: 2,
        bead_id: 'unitAI-101',
        worktree_path: '/tmp/worktree',
        worktree_owner_job_id: 'chain-root',
        chain_kind: 'chain',
        chain_id: 'chain-root',
        chain_root_job_id: 'chain-root',
        chain_root_bead_id: 'unitAI-100',
      });

      client.upsertEpicChainMembership({
        chain_id: 'chain-root',
        epic_id: 'unitAI-epic',
        chain_root_bead_id: 'unitAI-100',
        chain_root_job_id: 'chain-root',
        updated_at_ms: 100,
      });

      expect(client.listChainJobIds('chain-root')).toEqual(['chain-root', 'chain-child']);
      expect(client.readChainIdentity('chain-child')).toEqual({
        chain_kind: 'chain',
        chain_id: 'chain-root',
        chain_root_job_id: 'chain-root',
        chain_root_bead_id: 'unitAI-100',
      });
      expect(client.resolveChainEpicLinkByJobId('chain-child')).toEqual({
        chain_id: 'chain-root',
        epic_id: 'unitAI-epic',
        chain_root_job_id: 'chain-root',
        chain_root_bead_id: 'unitAI-100',
      });

      const location = resolveObservabilityDbLocation(tempRoot);
      db = new Database(location.dbPath);
      const persistedRow = db.query(`
        SELECT chain_kind, chain_id, chain_root_job_id, chain_root_bead_id, epic_id
        FROM specialist_jobs
        WHERE job_id = 'chain-root'
        LIMIT 1
      `).get() as {
        chain_kind: string;
        chain_id: string;
        chain_root_job_id: string;
        chain_root_bead_id: string;
        epic_id: string;
      };

      expect(persistedRow.chain_kind).toBe('chain');
      expect(typeof persistedRow.chain_id).toBe('string');
      expect(typeof persistedRow.chain_root_job_id).toBe('string');
      expect(typeof persistedRow.chain_root_bead_id).toBe('string');
      expect(typeof persistedRow.epic_id).toBe('string');
    });

    it('handles migration-style missing metadata deterministically', () => {
      const client = createClient();
      const location = resolveObservabilityDbLocation(tempRoot);
      db = new Database(location.dbPath);

      db.run(
        `INSERT INTO specialist_jobs (job_id, specialist, status, status_json, updated_at_ms, chain_kind)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['legacy-prep', 'explorer', 'done', '{"status":"done"}', 10, ''],
      );

      db.run(
        `INSERT INTO specialist_jobs (job_id, specialist, status, status_json, updated_at_ms, chain_kind, chain_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['legacy-chain', 'executor', 'done', '{"status":"done"}', 11, 'chain', 'chain-legacy'],
      );

      expect(client.readChainIdentity('legacy-prep')).toEqual({ chain_kind: 'prep' });
      expect(client.resolveChainEpicLinkByJobId('legacy-chain')).toEqual({
        chain_id: 'chain-legacy',
        epic_id: null,
        chain_root_job_id: 'chain-legacy',
        chain_root_bead_id: null,
      });
      expect(client.resolveChainEpicLinkByJobId('legacy-prep')).toBeNull();
    });
  });

  describe('epic persistence contract', () => {
    it('persists epic run rows with lifecycle fields and reads them back', () => {
      const client = createClient();

      client.upsertEpicRun({
        epic_id: 'unitAI-epic',
        status: 'resolving',
        updated_at_ms: 100,
        status_json: JSON.stringify({
          status: 'resolving',
          owner_job_id: 'job-owner',
          required_chains: ['chain-a'],
        }),
      });

      client.upsertEpicRun({
        epic_id: 'unitAI-epic',
        status: 'merge_ready',
        updated_at_ms: 200,
        status_json: JSON.stringify({
          status: 'merge_ready',
          owner_job_id: 'job-owner',
          required_chains: ['chain-a'],
          note: 'ready',
        }),
      });

      const row = client.readEpicRun('unitAI-epic');
      expect(row).not.toBeNull();
      expect(row?.epic_id).toBe('unitAI-epic');
      expect(row?.status).toBe('merge_ready');
      expect(row?.updated_at_ms).toBe(200);

      const payload = JSON.parse(row?.status_json ?? '{}') as Record<string, unknown>;
      expect(payload.status).toBe('merge_ready');
      expect(payload.owner_job_id).toBe('job-owner');
      expect(Array.isArray(payload.required_chains)).toBe(true);
    });

    it('persists chain membership and resolves by chain id or chain-root bead id', () => {
      const client = createClient();

      client.upsertEpicChainMembership({
        chain_id: 'chain-a',
        epic_id: 'unitAI-epic',
        chain_root_bead_id: 'unitAI-chain-a',
        chain_root_job_id: 'job-a',
        updated_at_ms: 100,
      });
      client.upsertEpicChainMembership({
        chain_id: 'chain-b',
        epic_id: 'unitAI-epic',
        chain_root_bead_id: 'unitAI-chain-b',
        chain_root_job_id: 'job-b',
        updated_at_ms: 200,
      });

      const byChainId = client.resolveEpicByChainId('chain-a');
      expect(byChainId?.epic_id).toBe('unitAI-epic');
      expect(byChainId?.chain_root_bead_id).toBe('unitAI-chain-a');

      const byRootBead = client.resolveEpicByChainRootBeadId('unitAI-chain-b');
      expect(byRootBead?.chain_id).toBe('chain-b');
      expect(byRootBead?.chain_root_job_id).toBe('job-b');

      const listed = client.listEpicChains('unitAI-epic');
      expect(listed.map((row) => row.chain_id)).toEqual(['chain-b', 'chain-a']);
    });

    it('returns null/empty for unknown epic entities', () => {
      const client = createClient();

      expect(client.readEpicRun('missing-epic')).toBeNull();
      expect(client.resolveEpicByChainId('missing-chain')).toBeNull();
      expect(client.resolveEpicByChainRootBeadId('missing-root')).toBeNull();
      expect(client.listEpicChains('missing-epic')).toEqual([]);
    });
  });

  describe('loadEpicReadinessSummary', () => {
    it('reconstructs merge readiness from persisted sqlite rows after restart', () => {
      const client = createClient();

      client.upsertEpicRun({
        epic_id: 'unitAI-restart-epic',
        status: 'resolving',
        updated_at_ms: 1,
        status_json: JSON.stringify({ status: 'resolving' }),
      });

      client.upsertStatus({
        id: 'prep-done',
        specialist: 'explorer',
        status: 'done',
        started_at_ms: 1,
        epic_id: 'unitAI-restart-epic',
        chain_kind: 'prep',
      });

      client.upsertStatus({
        id: 'chain-review',
        specialist: 'reviewer',
        status: 'done',
        started_at_ms: 2,
        epic_id: 'unitAI-restart-epic',
        chain_kind: 'chain',
        chain_id: 'chain-r',
        chain_root_job_id: 'chain-r',
        chain_root_bead_id: 'unitAI-chain-r',
      });
      client.upsertResult('chain-review', '## Compliance Verdict\n- Verdict: PASS');

      client.upsertEpicChainMembership({
        chain_id: 'chain-r',
        epic_id: 'unitAI-restart-epic',
        chain_root_bead_id: 'unitAI-chain-r',
        chain_root_job_id: 'chain-r',
        updated_at_ms: 2,
      });

      const summary = loadEpicReadinessSummary(client, 'unitAI-restart-epic');

      expect(summary.readiness_state).toBe('merge_ready');
      expect(summary.next_state).toBe('merge_ready');
      expect(summary.chains).toHaveLength(1);
      expect(summary.chains[0]?.chain_id).toBe('chain-r');
      expect(summary.prep.done).toBe(1);
    });

    it('does not treat prep jobs as chain members when membership table is empty', () => {
      const client = createClient();

      client.upsertEpicRun({
        epic_id: 'unitAI-prep-only-restart',
        status: 'resolving',
        updated_at_ms: 1,
        status_json: JSON.stringify({ status: 'resolving' }),
      });
      client.upsertStatus({
        id: 'prep-1',
        specialist: 'explorer',
        status: 'done',
        started_at_ms: 1,
        epic_id: 'unitAI-prep-only-restart',
        chain_kind: 'prep',
      });

      const summary = loadEpicReadinessSummary(client, 'unitAI-prep-only-restart');

      expect(summary.chains).toEqual([]);
      expect(summary.prep.total).toBe(1);
      expect(summary.readiness_state).toBe('merge_ready');
    });
  });

  describe('memories cache ranking', () => {
    it('ranks memory with high access frequency over stale low-access memory', () => {
      const client = createClient();
      const now = Date.now();
      client.syncMemoriesCache([
        { key: 'fts ranking one', value: 'alpha retrieval' },
        { key: 'fts ranking two', value: 'alpha retrieval' },
      ], now - (10 * 24 * 60 * 60 * 1000));

      for (let i = 0; i < 25; i += 1) {
        client.queryRelevantMemories(['alpha'], 1, now - 1_000 + i);
      }

      // Refresh with same keys to keep access stats, then age one row heavily.
      client.syncMemoriesCache([
        { key: 'fts ranking one', value: 'alpha retrieval' },
        { key: 'fts ranking two', value: 'alpha retrieval' },
      ], now);

      const location = resolveObservabilityDbLocation(tempRoot);
      const directDb = new Database(location.dbPath);
      directDb.run('UPDATE memories_cache SET updated_at_ms = ? WHERE memory_key = ?', [now - (45 * 24 * 60 * 60 * 1000), 'fts ranking two']);
      directDb.run('UPDATE memories_cache SET access_count = 0 WHERE memory_key = ?', ['fts ranking two']);
      directDb.close();

      const ranked = client.queryRelevantMemories(['alpha'], 2, now);
      expect(ranked).toHaveLength(2);
      expect(ranked[0]?.key).toBe('fts ranking one');
      expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0);
    });

    it('returns at most requested limit (top-10 behavior)', () => {
      const client = createClient();
      const records = Array.from({ length: 30 }, (_, index) => ({
        key: `memory-key-${index}`,
        value: 'rank alpha beta',
      }));
      client.syncMemoriesCache(records, Date.now());

      const ranked = client.queryRelevantMemories(['rank'], 10, Date.now());
      expect(ranked.length).toBeLessThanOrEqual(10);
    });
  });

  describe('readEventsAfterSeq', () => {
    it('returns only events after the requested sequence in ascending order', () => {
      const client = createClient();
      const now = Date.now();

      client.upsertStatus({
        id: 'job-events-after',
        specialist: 'executor',
        status: 'running',
        started_at_ms: now - 1_000,
        updated_at_ms: now,
      } as any);

      client.appendEvent('job-events-after', 'executor', undefined, { t: now - 300, type: 'run_start', specialist: 'executor' } as any);
      client.appendEvent('job-events-after', 'executor', undefined, { t: now - 200, type: 'text' } as any);
      client.appendEvent('job-events-after', 'executor', undefined, { t: now - 100, type: 'run_complete', status: 'COMPLETE', elapsed_s: 1 } as any);

      const events = client.readEventsAfterSeq('job-events-after', 1);
      expect(events).toHaveLength(2);
      expect(events.map((event) => event.seq)).toEqual([2, 3]);
      expect(events[0]?.type).toBe('text');
      expect(events[1]?.type).toBe('run_complete');
    });
  });

  describe('forensic event persistence', () => {
    it('dual-writes canonical forensic events with redaction and query filters', () => {
      const client = createClient();
      const now = Date.now();

      client.upsertStatus({
        id: 'job-forensic',
        specialist: 'executor',
        status: 'running',
        bead_id: 'unitAI-forensic',
        chain_kind: 'chain',
        chain_id: 'chain-forensic',
        chain_root_job_id: 'job-forensic',
        chain_root_bead_id: 'unitAI-forensic',
        started_at_ms: now - 1_000,
        updated_at_ms: now,
        model: 'openai/gpt-5.4-mini',
        backend: 'openai',
      } as any);

      client.appendEvent('job-forensic', 'executor', 'unitAI-forensic', {
        t: now,
        type: 'tool',
        tool: 'bash',
        phase: 'end',
        args: { raw_command: 'cat ~/.ssh/id_rsa', input_tokens: 42 },
        tool_call_id: 'tool-call-1',
      } as any);

      const forensicRows = client.readForensicEvents({ jobId: 'job-forensic', eventFamily: 'tool' });
      expect(forensicRows).toHaveLength(1);
      expect(forensicRows[0]?.schema_version).toBe('xtrm.forensic.v1');
      expect(forensicRows[0]?.event_name).toBe('tool.call.completed');
      expect(forensicRows[0]?.participant_kind).toBe('specialist');
      expect(forensicRows[0]?.participant_role).toBe('executor');
      // unitAI-rrdnt.2: canonical specialist identity replaces `chain-forensic::executor`.
      expect(forensicRows[0]?.participant_id).toBe('specialist::executor');
      expect(forensicRows[0]?.redaction_status).toBe('redacted');

      const event = JSON.parse(forensicRows[0]!.event_json) as any;
      expect(event.correlation.job_id).toBe('job-forensic');
      expect(event.correlation.chain_id).toBe('chain-forensic');
      expect(event.body.legacy_timeline_event.args).toBe('[REDACTED]');
      expect(event.redaction.fields).toContain('body.legacy_timeline_event.args');
    });

    it('persists lifecycle family rows with canonical names and redaction', () => {
      const client = createClient();
      const now = Date.now();

      client.upsertStatus({
        id: 'job-lifecycle',
        specialist: 'executor',
        status: 'running',
        bead_id: 'unitAI-lifecycle',
        chain_kind: 'chain',
        chain_id: 'chain-lifecycle',
        chain_root_job_id: 'job-lifecycle',
        chain_root_bead_id: 'unitAI-lifecycle',
        started_at_ms: now - 1_000,
        updated_at_ms: now,
        model: 'openai/gpt-5.4-mini',
        backend: 'openai',
      } as any);

      const events = [
        { t: now, type: 'command_completed', command_kind: 'git', duration_ms: 14, command: 'git', args: ['status', '--short'], redacted: true },
        { t: now + 1, type: 'review_verdict_pass', chain_template: 'chain', changed_paths_count: 2, terminal_state: 'merge_ready', result: 'pass' },
        { t: now + 2, type: 'chain_ready_for_review', chain_template: 'chain', changed_paths_count: 2, terminal_state: 'merge_ready', result: 'pass' },
        { t: now + 3, type: 'chain_finalized', chain_template: 'chain', changed_paths_count: 2, terminal_state: 'merged', result: 'success' },
        { t: now + 4, type: 'worktree_merged', changed_paths_count: 2, merge_ref: 'refs/heads/sp/publish-chain', source_ref: 'refs/heads/feature', target_ref: 'refs/heads/main', result: 'success' },
      ] as const;

      for (const event of events) {
        client.appendEvent('job-lifecycle', 'executor', 'unitAI-lifecycle', event as any);
      }

      const forensicRows = client.readForensicEvents({ jobId: 'job-lifecycle' });
      expect(forensicRows.map((row) => row.event_name)).toEqual([
        'command.completed',
        'review.verdict.pass',
        'chain.ready_for_review',
        'chain.finalized',
        'worktree.merged',
      ]);
      expect(forensicRows.every((row) => row.redaction_status === 'redacted')).toBe(true);
      expect(JSON.parse(forensicRows[0]!.event_json).body.command_kind).toBe('git');
      expect(JSON.parse(forensicRows[1]!.event_json).body.terminal_state).toBe('merge_ready');
      expect(JSON.parse(forensicRows[2]!.event_json).body.changed_paths_count).toBe(2);
      expect(JSON.parse(forensicRows[4]!.event_json).body.merge_ref).toBe('refs/heads/sp/publish-chain');
    });

    // Regression for codex PR #125 review finding: `sp log` snapshot fetches
    // `limit * 4` rows then slices the tail. Without `order:'desc'` it
    // received the OLDEST window and the newest events for busy jobs were
    // never surfaced. The fix lets callers request the latest rows directly.
    it('readForensicEvents respects order:asc (default) vs order:desc', () => {
      const client = createClient();
      const now = Date.now();
      client.upsertStatus({
        id: 'job-order',
        specialist: 'executor',
        status: 'running',
        bead_id: 'unitAI-order',
        chain_kind: 'chain',
        chain_id: 'chain-order',
        chain_root_job_id: 'job-order',
        chain_root_bead_id: 'unitAI-order',
        started_at_ms: now - 1_000,
        updated_at_ms: now,
        model: 'openai/gpt-5.4-mini',
        backend: 'openai',
      } as any);

      for (let i = 0; i < 10; i += 1) {
        client.appendEvent('job-order', 'executor', 'unitAI-order', {
          t: now + i,
          type: 'tool',
          tool: 'bash',
          phase: 'end',
          args: { sequence_index: i },
          tool_call_id: `tool-${i}`,
        } as any);
      }

      const ascRows = client.readForensicEvents({ jobId: 'job-order', limit: 3 });
      expect(ascRows).toHaveLength(3);
      const ascTs = ascRows.map((r) => r.t);
      expect(ascTs).toEqual([...ascTs].sort((a, b) => a - b));
      expect(ascRows[0]?.t).toBe(now + 0);

      const descRows = client.readForensicEvents({ jobId: 'job-order', limit: 3, order: 'desc' });
      expect(descRows).toHaveLength(3);
      const descTs = descRows.map((r) => r.t);
      expect(descTs).toEqual([...descTs].sort((a, b) => b - a));
      expect(descRows[0]?.t).toBe(now + 9);
    });
  });

  describe('parseJournalMode', () => {
    it('normalizes journal mode to lowercase', () => {
      expect(parseJournalMode('WAL')).toBe('wal');
      expect(parseJournalMode('wal')).toBe('wal');
      expect(parseJournalMode('WaL')).toBe('wal');
      expect(parseJournalMode(null)).toBe(null);
      expect(parseJournalMode(undefined)).toBe(null);
      expect(parseJournalMode('')).toBe(null);
    });
  });

  describe('job metrics aggregation', () => {
    it('extracts tool counts and runtime split from specialist_events', () => {
      const client = createClient();
      client.upsertStatus({ id: 'job-metrics', specialist: 'executor', status: 'done', started_at_ms: 1, last_event_at_ms: 5 });
      client.appendEvent('job-metrics', 'executor', 'bead-1', { t: 10, type: 'run_start', specialist: 'executor' } as never);
      client.appendEvent('job-metrics', 'executor', 'bead-1', { t: 20, type: 'status_change', status: 'running', previous_status: 'starting' } as never);
      client.appendEvent('job-metrics', 'executor', 'bead-1', { t: 30, type: 'tool', tool: 'bash', phase: 'start' } as never);
      client.appendEvent('job-metrics', 'executor', 'bead-1', { t: 40, type: 'status_change', status: 'waiting', previous_status: 'running' } as never);
      client.appendEvent('job-metrics', 'executor', 'bead-1', { t: 50, type: 'status_change', status: 'running', previous_status: 'waiting' } as never);
      client.appendEvent('job-metrics', 'executor', 'bead-1', { t: 60, type: 'tool', tool: 'bash', phase: 'end' } as never);
      client.appendEvent('job-metrics', 'executor', 'bead-1', { t: 70, type: 'turn_summary', turn_index: 1, token_usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 }, context_pct: 25 } as never);
      client.appendEvent('job-metrics', 'executor', 'bead-1', { t: 80, type: 'token_usage', token_usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 }, source: 'turn_end' } as never);
      client.appendEvent('job-metrics', 'executor', 'bead-1', { t: 90, type: 'stale_warning', reason: 'tool_duration', silence_ms: 9000, threshold_ms: 5000, tool: 'read' } as never);
      client.appendEvent('job-metrics', 'executor', 'bead-1', { t: 100, type: 'run_complete', status: 'COMPLETE', elapsed_s: 0.1, model: 'gpt-5', token_usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } as never);

      const metrics = client.aggregateJobMetrics('job-metrics');
      expect(metrics).not.toBeNull();
      expect(metrics?.total_tools).toBe(2);
      expect(metrics?.total_turns).toBe(1);
      expect(metrics?.active_runtime_ms).toBe(80);
      expect(metrics?.waiting_ms).toBe(10);
      expect(metrics?.elapsed_ms).toBe(100);
      // active + waiting <= elapsed: the gap between started_at_ms and the first run_start
      // event is "startup" time, counted in elapsed but neither active nor waiting.
      expect((metrics?.active_runtime_ms ?? 0) + (metrics?.waiting_ms ?? 0)).toBeLessThanOrEqual(metrics?.elapsed_ms ?? 0);
      expect(JSON.parse(metrics?.tool_call_counts_json ?? '{}')).toEqual({ bash: 2 });
      expect(JSON.parse(metrics?.token_trajectory_json ?? '[]')).toHaveLength(2);
      expect(JSON.parse(metrics?.context_trajectory_json ?? '[]')).toEqual([{ turn_index: 1, t: 70, context_pct: 25 }]);
      expect(JSON.parse(metrics?.stall_gaps_json ?? '[]')).toEqual([{ t: 90, tool: 'read', silence_ms: 9000, threshold_ms: 5000 }]);
    });

    it('is idempotent on repeated aggregation', () => {
      const client = createClient();
      client.upsertStatus({ id: 'job-idempotent', specialist: 'executor', status: 'done', started_at_ms: 1, last_event_at_ms: 5 });
      const location = resolveObservabilityDbLocation(tempRoot);
      db = new Database(location.dbPath);
      db.run(
        `INSERT INTO specialist_events (job_id, seq, specialist, bead_id, t, type, event_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['job-idempotent', 1, 'executor', null, 10, 'run_complete', JSON.stringify({ status: 'COMPLETE', elapsed_s: 1 })],
      );

      const first = client.aggregateJobMetrics('job-idempotent');
      const second = client.aggregateJobMetrics('job-idempotent');
      expect(first).toEqual(second);
      const count = db.query(`SELECT COUNT(*) AS count FROM specialist_job_metrics WHERE job_id = 'job-idempotent'`).get() as { count: number };
      expect(count.count).toBe(1);
    });

    it('prune refuses to delete events when extract throws', () => {
      const client = createClient();
      client.upsertStatus({ id: 'job-prune', specialist: 'executor', status: 'done', started_at_ms: 1, last_event_at_ms: 5 });
      const location = resolveObservabilityDbLocation(tempRoot);
      db = new Database(location.dbPath);
      db.run(`INSERT INTO specialist_events (job_id, seq, specialist, bead_id, t, type, event_json) VALUES (?, ?, ?, ?, ?, ?, ?)`, ['job-prune', 1, 'executor', null, 10, 'run_complete', JSON.stringify({ status: 'COMPLETE', elapsed_s: 1 })]);
      vi.spyOn(client, 'aggregateJobMetrics').mockImplementation(() => { throw new Error('fail metrics'); });

      expect(() => client.pruneObservabilityData({ beforeMs: 1000, includeEpics: false, apply: true })).toThrow(/fail metrics/);
      const remaining = db.query(`SELECT COUNT(*) AS count FROM specialist_events WHERE job_id = 'job-prune'`).get() as { count: number };
      expect(remaining.count).toBe(1);
    });
  });

  // V13 — durable PR/base drift fields on specialist_jobs (specialists-05q.1).
  describe('migrateToV13 — durable PR/base drift fields', () => {
    const V13_COLUMNS = [
      'pr_url', 'pr_head_sha', 'pr_state', 'pr_merge_state', 'pr_classification',
      'pr_base_ref', 'pr_base_sha', 'pr_drift_checked_at_ms',
      'base_sha_pinned', 'base_sha_pinned_at_ms',
    ] as const;

    it('adds all V13 PR/base drift columns to specialist_jobs on a fresh DB', () => {
      db = new Database(tempDbPath);
      initSchema(db);

      const cols = (db.query('PRAGMA table_info(specialist_jobs)').all() as Array<{ name?: string }>)
        .map((c) => c.name)
        .filter((n): n is string => typeof n === 'string');

      for (const col of V13_COLUMNS) {
        expect(cols).toContain(col);
      }
      const versionRow = db.query('SELECT version FROM schema_version WHERE version = 13 LIMIT 1').get() as { version?: number };
      expect(versionRow?.version).toBe(13);
    });

    it('idempotent migration — running initSchema twice does not duplicate columns or fail', () => {
      db = new Database(tempDbPath);
      initSchema(db);
      initSchema(db);

      const cols = (db.query('PRAGMA table_info(specialist_jobs)').all() as Array<{ name?: string }>)
        .map((c) => c.name)
        .filter((n): n is string => typeof n === 'string');
      // Each V13 column appears exactly once.
      for (const col of V13_COLUMNS) {
        expect(cols.filter((c) => c === col).length).toBe(1);
      }
    });

    it('upgrades a legacy DB row (no PR fields written) without data loss; new columns default to NULL', () => {
      // Build a V12-shape DB by initSchema then INSERT a row that does not touch any V13 column.
      // The migration is additive so the row pre-dates V13 semantically even though we wrote it post-migration.
      db = new Database(tempDbPath);
      initSchema(db);
      db.run(`
        INSERT INTO specialist_jobs (job_id, specialist, status, status_json, updated_at_ms)
        VALUES ('legacy-job', 'executor', 'starting', '{"id":"legacy-job","specialist":"executor","status":"starting","started_at_ms":1}', 1)
      `);

      const row = db.query(`
        SELECT job_id, status_json,
               pr_url, pr_head_sha, pr_state, pr_merge_state, pr_classification,
               pr_base_ref, pr_base_sha, pr_drift_checked_at_ms,
               base_sha_pinned, base_sha_pinned_at_ms
        FROM specialist_jobs WHERE job_id = 'legacy-job'
      `).get() as Record<string, unknown>;

      // Identity columns preserved.
      expect(row.job_id).toBe('legacy-job');
      expect(typeof row.status_json).toBe('string');
      // Drift columns NULL — back-compat: never written, never read.
      for (const col of V13_COLUMNS) {
        expect(row[col]).toBeNull();
      }
    });

    it('readStatus on a legacy row returns SupervisorStatus with undefined PR drift fields', () => {
      // The JSON blob has none of the new fields. The type widens via optional `?:`.
      db = new Database(tempDbPath);
      initSchema(db);
      db.run(`
        INSERT INTO specialist_jobs (job_id, specialist, status, status_json, updated_at_ms)
        VALUES ('legacy-status', 'executor', 'starting', '{"id":"legacy-status","specialist":"executor","status":"starting","started_at_ms":1}', 1)
      `);

      const client = createObservabilitySqliteClientAtPath(tempDbPath)!;
      sqliteClient = client;
      const status = client.readStatus('legacy-status');
      expect(status).not.toBeNull();
      // Pre-V13 fields preserved.
      expect(status?.id).toBe('legacy-status');
      // V13 PR drift fields stay `undefined` — never serialized into the blob.
      expect(status?.pr_state).toBeUndefined();
      expect(status?.pr_classification).toBeUndefined();
      expect(status?.base_sha_pinned).toBeUndefined();
    });

    it('updatePrDriftState writes drift columns and readPrDriftState round-trips them', () => {
      db = new Database(tempDbPath);
      initSchema(db);
      db.run(`
        INSERT INTO specialist_jobs (job_id, specialist, status, status_json, updated_at_ms)
        VALUES ('full-drift', 'executor', 'running', '{"id":"full-drift","specialist":"executor","status":"running","started_at_ms":1}', 1)
      `);
      const client = createObservabilitySqliteClientAtPath(tempDbPath)!;
      sqliteClient = client;

      const written = client.updatePrDriftState('full-drift', {
        pr_url: 'https://github.com/o/r/pull/42',
        pr_head_sha: 'aaa111',
        pr_state: 'open',
        pr_merge_state: 'clean',
        pr_classification: 'clean',
        pr_base_ref: 'master',
        pr_base_sha: 'bbb222',
        pr_drift_checked_at_ms: 5_000,
        base_sha_pinned: 'bbb222',
        base_sha_pinned_at_ms: 4_000,
      });
      expect(written).toBe(true);

      const drift = client.readPrDriftState('full-drift');
      expect(drift).toEqual({
        pr_url: 'https://github.com/o/r/pull/42',
        pr_head_sha: 'aaa111',
        pr_state: 'open',
        pr_merge_state: 'clean',
        pr_classification: 'clean',
        pr_base_ref: 'master',
        pr_base_sha: 'bbb222',
        pr_drift_checked_at_ms: 5_000,
        base_sha_pinned: 'bbb222',
        base_sha_pinned_at_ms: 4_000,
      });
    });

    it('updatePrDriftState supports partial patches; omitted keys are unchanged; null clears', () => {
      db = new Database(tempDbPath);
      initSchema(db);
      db.run(`
        INSERT INTO specialist_jobs (job_id, specialist, status, status_json, updated_at_ms)
        VALUES ('partial', 'executor', 'running', '{"id":"partial","specialist":"executor","status":"running","started_at_ms":1}', 1)
      `);
      const client = createObservabilitySqliteClientAtPath(tempDbPath)!;
      sqliteClient = client;

      client.updatePrDriftState('partial', {
        pr_state: 'open',
        pr_classification: 'behind',
        base_sha_pinned: 'pin1',
      });
      let drift = client.readPrDriftState('partial');
      expect(drift?.pr_state).toBe('open');
      expect(drift?.pr_classification).toBe('behind');
      expect(drift?.base_sha_pinned).toBe('pin1');
      expect(drift?.pr_url).toBeNull();

      // Patch: change classification, clear base_sha_pinned, leave pr_state alone.
      client.updatePrDriftState('partial', {
        pr_classification: 'clean',
        base_sha_pinned: null,
      });
      drift = client.readPrDriftState('partial');
      expect(drift?.pr_state).toBe('open');             // unchanged
      expect(drift?.pr_classification).toBe('clean');   // updated
      expect(drift?.base_sha_pinned).toBeNull();        // cleared
    });

    it('readPrDriftState returns null when the job row is missing', () => {
      db = new Database(tempDbPath);
      initSchema(db);
      const client = createObservabilitySqliteClientAtPath(tempDbPath)!;
      sqliteClient = client;
      expect(client.readPrDriftState('does-not-exist')).toBeNull();
    });

    it('updatePrDriftState returns false when the job row is missing', () => {
      db = new Database(tempDbPath);
      initSchema(db);
      const client = createObservabilitySqliteClientAtPath(tempDbPath)!;
      sqliteClient = client;
      const written = client.updatePrDriftState('missing-job', { pr_state: 'open' });
      expect(written).toBe(false);
    });

    it('updatePrDriftState with an empty patch is a no-op and returns false', () => {
      db = new Database(tempDbPath);
      initSchema(db);
      db.run(`
        INSERT INTO specialist_jobs (job_id, specialist, status, status_json, updated_at_ms)
        VALUES ('noop-job', 'executor', 'running', '{"id":"noop-job","specialist":"executor","status":"running","started_at_ms":1}', 1)
      `);
      const client = createObservabilitySqliteClientAtPath(tempDbPath)!;
      sqliteClient = client;
      const written = client.updatePrDriftState('noop-job', {});
      expect(written).toBe(false);
    });
  });

  describe('branch integration events (xtrm.branch.integration.v1)', () => {
    const mkEvent = (overrides: Partial<{ branch: string; commit: string; role: string }> = {}) =>
      createBranchIntegrationEvent({
        source: { job_id: 'job-exec', branch: overrides.branch ?? 'sp/exec-1', worktree: '/wt/sp-exec-1' },
        target: { branch: 'xt/coord-epic', worktree: '/wt/coord', role: overrides.role },
        commit: overrides.commit ?? 'deadbeef',
      });

    it('records a result event and reads it back', () => {
      const client = createClient();
      client.recordBranchIntegration(mkEvent({ role: 'chain-coordinator' }));

      const rows = client.listBranchIntegrations();
      expect(rows).toHaveLength(1);
      expect(rows[0].event.schema_version).toBe('xtrm.branch.integration.v1');
      expect(rows[0].event.source.branch).toBe('sp/exec-1');
      expect(rows[0].event.target.branch).toBe('xt/coord-epic');
      expect(rows[0].event.target.role).toBe('chain-coordinator');
      expect(rows[0].event.status).toBe('merged');
      expect(rows[0].event.commit).toBe('deadbeef');
    });

    it('is idempotent on (source_branch, commit) — no duplicate rows', () => {
      const client = createClient();
      client.recordBranchIntegration(mkEvent());
      client.recordBranchIntegration(mkEvent());
      expect(client.listBranchIntegrations()).toHaveLength(1);
    });

    it('filters by target branch and source job', () => {
      const client = createClient();
      client.recordBranchIntegration(mkEvent({ branch: 'sp/a', commit: 'c1' }));
      client.recordBranchIntegration(mkEvent({ branch: 'sp/b', commit: 'c2' }));

      expect(client.listBranchIntegrations({ targetBranch: 'xt/coord-epic' })).toHaveLength(2);
      expect(client.listBranchIntegrations({ targetBranch: 'nope' })).toHaveLength(0);
      expect(client.listBranchIntegrations({ sourceJobId: 'job-exec', limit: 1 })).toHaveLength(1);
    });
  });
});
