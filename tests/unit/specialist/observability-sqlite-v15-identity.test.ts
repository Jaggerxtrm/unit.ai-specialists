import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize, resolve } from 'node:path';
import {
  createObservabilitySqliteClientAtPath,
  initSchema,
} from '../../../src/specialist/observability-sqlite.js';
import { deriveParticipantId } from '../../../src/specialist/forensic-events.js';
import { OBSERVABILITY_SCHEMA_VERSION } from '../../../src/specialist/observability-db.js';

/**
 * V15 identity lineage acceptance (unitAI-rrdnt.2, PRD AK/AL/AM).
 * Focused v15 coverage; superseded legacy expectations are updated in place.
 */
describe('observability-sqlite v15 identity lineage', () => {
  let tempRoot: string;
  let tempDbPath: string;
  let sqliteClient: ReturnType<typeof createObservabilitySqliteClientAtPath> | null = null;
  let db: Database | null = null;

  beforeEach(() => {
    tempRoot = join(tmpdir(), `test-v15-identity-${crypto.randomUUID()}`);
    mkdirSync(tempRoot, { recursive: true });
    tempDbPath = join(tempRoot, 'observability.db');
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
    const client = createObservabilitySqliteClientAtPath(tempDbPath);
    expect(client).not.toBeNull();
    sqliteClient = client;
    return client!;
  };

  const closeClient = () => {
    if (sqliteClient) {
      try { sqliteClient.close(); } catch { /* ignore */ }
      sqliteClient = null;
    }
  };

  const openRaw = () => {
    db = new Database(tempDbPath);
    return db;
  };

  const closeRaw = () => {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
      db = null;
    }
  };

  it('exposes schema version 15', () => {
    const client = createClient();
    closeClient();
    const raw = openRaw();
    const row = raw.query('SELECT MAX(version) AS version FROM schema_version').get() as { version?: number };
    expect(row.version).toBe(15);
    expect(OBSERVABILITY_SCHEMA_VERSION).toBe(15);
    closeRaw();
    void client;
  });

  it('AM: two retry starts produce distinct attempt_ids under ONE job_id and ONE participant_id', () => {
    const client = createClient();
    const now = Date.now();
    const worktreePath = join(tempRoot, 'wt-am');

    client.upsertStatus({
      id: 'job-am',
      specialist: 'executor',
      status: 'running',
      bead_id: 'unitAI-rrdnt.2',
      session_id: 'pi-session-am',
      worktree_path: worktreePath,
      started_at_ms: now - 1_000,
      updated_at_ms: now,
    } as never);

    const at = (offset: number) => now + offset;
    client.appendEvent('job-am', 'executor', 'unitAI-rrdnt.2', { t: at(1), type: 'run_start', specialist: 'executor' } as never);
    client.appendEvent('job-am', 'executor', 'unitAI-rrdnt.2', { t: at(2), type: 'tool', tool: 'bash', phase: 'end' } as never);
    client.appendEvent('job-am', 'executor', 'unitAI-rrdnt.2', { t: at(3), type: 'retry', phase: 'start' } as never);
    client.appendEvent('job-am', 'executor', 'unitAI-rrdnt.2', { t: at(4), type: 'tool', tool: 'bash', phase: 'end' } as never);
    client.appendEvent('job-am', 'executor', 'unitAI-rrdnt.2', { t: at(5), type: 'retry', phase: 'start' } as never);
    client.appendEvent('job-am', 'executor', 'unitAI-rrdnt.2', { t: at(6), type: 'tool', tool: 'bash', phase: 'end' } as never);

    closeClient();
    const raw = openRaw();

    const eventRows = raw.query(
      'SELECT seq, type, attempt_id FROM specialist_events WHERE job_id = ? ORDER BY seq ASC',
    ).all('job-am') as Array<{ seq: number; type: string; attempt_id: string | null }>;
    expect(eventRows).toHaveLength(6);
    const attempts = eventRows.map((row) => row.attempt_id);
    expect(attempts[0]).toBe('job-am::attempt::1');
    expect(attempts[1]).toBe('job-am::attempt::1');
    expect(attempts[2]).toBe('job-am::attempt::2');
    expect(attempts[3]).toBe('job-am::attempt::2');
    expect(attempts[4]).toBe('job-am::attempt::3');
    expect(attempts[5]).toBe('job-am::attempt::3');
    expect(new Set(attempts).size).toBe(3);

    const forensicRows = raw.query(
      'SELECT seq, attempt_id, participant_id, event_json FROM specialist_forensic_events WHERE job_id = ? ORDER BY seq ASC',
    ).all('job-am') as Array<{ seq: number; attempt_id: string | null; participant_id: string | null; event_json: string }>;
    expect(forensicRows).toHaveLength(6);
    // Same attempt_id on both normal timeline and forensic rows.
    for (let index = 0; index < eventRows.length; index += 1) {
      expect(forensicRows[index]?.attempt_id).toBe(eventRows[index]?.attempt_id);
    }
    // ONE participant across all attempts — retries are not new participants.
    const participants = new Set(forensicRows.map((row) => row.participant_id));
    expect([...participants]).toEqual(['specialist::executor']);
    // Correlation inside the blob carries the same attempt lineage.
    for (const row of forensicRows) {
      const parsed = JSON.parse(row.event_json) as { correlation?: Record<string, unknown> };
      expect(parsed.correlation?.attempt_id).toBe(row.attempt_id);
      expect(parsed.correlation?.participant_id).toBe('specialist::executor');
    }

    const jobRow = raw.query(
      'SELECT job_id, participant_id, pi_session_id, workspace_id, attempt_no, attempt_id FROM specialist_jobs WHERE job_id = ?',
    ).get('job-am') as Record<string, unknown>;
    expect(jobRow.participant_id).toBe('specialist::executor');
    expect(jobRow.pi_session_id).toBe('pi-session-am');
    expect(jobRow.workspace_id).toBe(normalize(resolve(worktreePath)));
    expect(jobRow.attempt_no).toBe(3);
    expect(jobRow.attempt_id).toBe('job-am::attempt::3');
    closeRaw();
  });

  it('AL: query recovers job -> participant -> attempt -> session/workspace and the forensic chain', () => {
    const client = createClient();
    const now = Date.now();
    const worktreePath = join(tempRoot, 'wt-al');

    client.upsertStatus({
      id: 'job-al',
      specialist: 'reviewer',
      status: 'running',
      bead_id: 'unitAI-rrdnt.2',
      session_id: 'pi-session-al',
      worktree_path: worktreePath,
      started_at_ms: now - 1_000,
      updated_at_ms: now,
    } as never);
    client.appendEvent('job-al', 'reviewer', 'unitAI-rrdnt.2', { t: now + 1, type: 'run_start', specialist: 'reviewer' } as never);
    client.appendEvent('job-al', 'reviewer', 'unitAI-rrdnt.2', { t: now + 2, type: 'retry', phase: 'start' } as never);
    client.appendEvent('job-al', 'reviewer', 'unitAI-rrdnt.2', { t: now + 3, type: 'tool', tool: 'bash', phase: 'end' } as never);

    closeClient();
    const raw = openRaw();

    // Acceptance query: sentinel rows are never a participant, so every
    // participant rollup excludes them explicitly.
    const chain = raw.query(`
      SELECT j.job_id, j.participant_id, j.pi_session_id, j.workspace_id,
             e.seq, e.attempt_id, e.type, f.event_name
      FROM specialist_jobs j
      JOIN specialist_events e ON e.job_id = j.job_id
      JOIN specialist_forensic_events f ON f.job_id = j.job_id AND f.seq = e.seq
      WHERE j.job_id = ?
        AND j.participant_id IS NOT NULL
        AND j.participant_id != 'specialist::<unknown>'
        AND (f.participant_id IS NULL OR f.participant_id != 'specialist::<unknown>')
      ORDER BY e.seq ASC
    `).all('job-al') as Array<Record<string, unknown>>;
    expect(chain).toHaveLength(3);
    for (const row of chain) {
      expect(row.job_id).toBe('job-al');
      expect(row.participant_id).toBe('specialist::reviewer');
      expect(row.pi_session_id).toBe('pi-session-al');
      expect(row.workspace_id).toBe(normalize(resolve(worktreePath)));
    }
    expect(chain.map((row) => row.attempt_id)).toEqual([
      'job-al::attempt::1',
      'job-al::attempt::2',
      'job-al::attempt::2',
    ]);
    expect(chain[0]?.event_name).toBe('job.started');
    closeRaw();
  });

  it('migration from legacy v14: blobs unchanged, projections rewritten, legacy attempts stay NULL/0, old reads work', () => {
    const client = createClient();
    closeClient();

    const raw = openRaw();
    const legacyWorktree = join(tempRoot, 'wt-legacy');
    const legacyStatusJson = JSON.stringify({
      id: 'job-legacy',
      specialist: 'executor',
      status: 'done',
      started_at_ms: 1,
      session_id: 'pi-session-legacy',
      worktree_path: legacyWorktree,
    });
    const legacyEventJson = JSON.stringify({ t: 2, seq: 1, type: 'tool', tool: 'bash', phase: 'end' });
    const legacyForensicJson = JSON.stringify({
      schema_version: 'xtrm.forensic.v1',
      event_family: 'tool',
      event_name: 'tool.call.completed',
      correlation: { participant_id: 'chain:old::executor', job_id: 'job-legacy' },
    });
    const orphanForensicJson = JSON.stringify({
      schema_version: 'xtrm.forensic.v1',
      event_family: 'job',
      event_name: 'job.started',
      correlation: { job_id: 'job-missing' },
    });

    raw.run(
      `INSERT INTO specialist_jobs (job_id, specialist, worktree_column, bead_id, status, status_json, updated_at_ms,
        participant_id, pi_session_id, workspace_id, attempt_no, attempt_id)
       VALUES ('job-legacy', 'executor', ?, 'unitAI-legacy', 'done', ?, 1000,
        'chain:old::executor', NULL, NULL, 0, NULL)`,
      [legacyWorktree, legacyStatusJson],
    );
    raw.run(
      `INSERT INTO specialist_jobs (job_id, specialist, worktree_column, status, status_json, updated_at_ms,
        participant_id, attempt_no, attempt_id)
       VALUES ('job-whitespace', 'reviewer', '   ', 'done',
        '{"id":"job-whitespace","specialist":"reviewer","status":"done"}', 1000,
        'chain:old::reviewer', 0, NULL)`,
    );
    raw.run(
      `INSERT INTO specialist_events (job_id, seq, specialist, bead_id, t, type, event_json, attempt_id)
       VALUES ('job-legacy', 1, 'executor', 'unitAI-legacy', 2, 'tool', ?, NULL)`,
      [legacyEventJson],
    );
    raw.run(
      `INSERT INTO specialist_forensic_events (job_id, seq, t, schema_version, event_family, event_name,
        participant_kind, participant_role, participant_id, redaction_status, event_json, attempt_id)
       VALUES ('job-legacy', 1, 2, 'xtrm.forensic.v1', 'tool', 'tool.call.completed',
        'specialist', 'executor', 'chain:old::executor', 'redacted', ?, NULL)`,
      [legacyForensicJson],
    );
    // No recoverable role and no parent job: backfill must use the sentinel.
    raw.run(
      `INSERT INTO specialist_forensic_events (job_id, seq, t, schema_version, event_family, event_name,
        participant_kind, participant_role, participant_id, redaction_status, event_json, attempt_id)
       VALUES ('job-missing', 1, 3, 'xtrm.forensic.v1', 'job', 'job.started',
        'specialist', NULL, 'chain:old::executor', 'clean', ?, NULL)`,
      [orphanForensicJson],
    );
    raw.run('DELETE FROM schema_version WHERE version = 15');
    closeRaw();

    // Re-open through the client: initSchema re-runs the v15 backfill.
    const migrated = createObservabilitySqliteClientAtPath(tempDbPath);
    expect(migrated).not.toBeNull();

    // Old-style reads still work against migrated rows.
    expect(migrated!.readStatus('job-legacy')).toMatchObject({ id: 'job-legacy', specialist: 'executor' });
    expect(migrated!.readEvents('job-legacy')).toHaveLength(1);
    expect(migrated!.readForensicEvents({ jobId: 'job-legacy' })).toHaveLength(1);
    sqliteClient = migrated;
    closeClient();

    const check = openRaw();
    // Blobs are byte-for-byte identical: the column is a projection, never a rewrite.
    const jobBlob = check.query('SELECT status_json FROM specialist_jobs WHERE job_id = ?').get('job-legacy') as { status_json: string };
    expect(jobBlob.status_json).toBe(legacyStatusJson);
    const eventBlob = check.query('SELECT event_json FROM specialist_events WHERE job_id = ?').get('job-legacy') as { event_json: string };
    expect(eventBlob.event_json).toBe(legacyEventJson);
    const forensicBlob = check.query('SELECT event_json FROM specialist_forensic_events WHERE job_id = ?').get('job-legacy') as { event_json: string };
    expect(forensicBlob.event_json).toBe(legacyForensicJson);

    const job = check.query(
      'SELECT participant_id, pi_session_id, workspace_id, attempt_no, attempt_id FROM specialist_jobs WHERE job_id = ?',
    ).get('job-legacy') as Record<string, unknown>;
    expect(job.participant_id).toBe('specialist::executor');
    expect(job.pi_session_id).toBe('pi-session-legacy');
    expect(job.workspace_id).toBe(normalize(resolve(legacyWorktree)));
    expect(job.attempt_no).toBe(0);
    expect(job.attempt_id).toBeNull();
    const whitespaceWorkspace = check.query(
      'SELECT workspace_id FROM specialist_jobs WHERE job_id = ?',
    ).get('job-whitespace') as { workspace_id: string | null };
    expect(whitespaceWorkspace.workspace_id).toBeNull();

    const forensic = check.query(
      'SELECT participant_id, attempt_id FROM specialist_forensic_events WHERE job_id = ?',
    ).get('job-legacy') as Record<string, unknown>;
    expect(forensic.participant_id).toBe('specialist::executor');
    expect(forensic.attempt_id).toBeNull();

    // Sentinel count from this backfill: exactly the one unrecoverable row.
    const sentinelRows = check.query(
      `SELECT COUNT(*) AS count FROM specialist_forensic_events WHERE participant_id = 'specialist::<unknown>'`,
    ).get() as { count: number };
    expect(sentinelRows.count).toBe(1);

    // Acceptance queries exclude the sentinel: unfiltered sees it, filtered does not.
    const unfiltered = check.query(
      'SELECT DISTINCT participant_id FROM specialist_forensic_events',
    ).all() as Array<{ participant_id: string }>;
    const filtered = check.query(
      `SELECT DISTINCT participant_id FROM specialist_forensic_events
       WHERE participant_id != 'specialist::<unknown>'`,
    ).all() as Array<{ participant_id: string }>;
    expect(unfiltered.map((row) => row.participant_id)).toContain('specialist::<unknown>');
    expect(filtered.map((row) => row.participant_id)).not.toContain('specialist::<unknown>');
    expect(filtered.length).toBe(unfiltered.length - 1);

    expect(() => initSchema(check)).not.toThrow();
    const versionRows = check.query(
      'SELECT COUNT(*) AS count FROM schema_version WHERE version = 15',
    ).get() as { count: number };
    expect(versionRows.count).toBe(1);
    closeRaw();
  });

  it('workspace rule is normalize(resolve(path)): linked worktree paths stay distinct, no realpath collapse', () => {
    const realDir = join(tempRoot, 'real-wt');
    mkdirSync(realDir, { recursive: true });
    const linkPath = join(tempRoot, 'link-wt');
    symlinkSync(realDir, linkPath);

    const client = createClient();
    const now = Date.now();
    client.upsertStatus({
      id: 'job-link',
      specialist: 'executor',
      status: 'running',
      worktree_path: linkPath,
      started_at_ms: now,
      updated_at_ms: now,
    } as never);
    closeClient();

    const raw = openRaw();
    const row = raw.query('SELECT workspace_id FROM specialist_jobs WHERE job_id = ?').get('job-link') as { workspace_id: string };
    expect(row.workspace_id).toBe(normalize(resolve(linkPath)));
    closeRaw();
  });

  it('deriveParticipantId is chain-independent with a nonthrowing sentinel for missing roles', () => {
    expect(deriveParticipantId({ participant_kind: 'specialist', participant_role: 'executor', chain_id: 'chain:7f3a' }))
      .toBe('specialist::executor');
    expect(deriveParticipantId({ participant_kind: 'specialist', participant_role: 'reviewer' }))
      .toBe('specialist::reviewer');
    expect(deriveParticipantId({ participant_kind: 'specialist', participant_role: '' })).toBe('specialist::<unknown>');
    expect(deriveParticipantId({ participant_kind: 'specialist', participant_role: '   ' })).toBe('specialist::<unknown>');
    expect(deriveParticipantId({ participant_kind: 'specialist', participant_role: 42 as never })).toBe('specialist::<unknown>');
    // Valid non-specialist outputs are unchanged.
    expect(deriveParticipantId({ participant_kind: 'orchestrator', participant_role: 'claude-code-session', session_uuid: 's1' })).toBe('orch::s1');
    expect(deriveParticipantId({ participant_kind: 'pulse_emitter', participant_role: 'devops-advisor', container_id: 'chain:1' })).toBe('chain:1::emitter::devops-advisor');
    expect(deriveParticipantId({ participant_kind: 'adapter', participant_role: 'mcp-grafana', adapter_id: 'adapter:grafana' })).toBe('adapter:grafana');
    expect(deriveParticipantId({ participant_kind: 'node_member', participant_role: 'coordinator', node_id: 'node:1', member_index: 2 })).toBe('node::node:1::coordinator::2');
  });
});
