import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createActivationForensicSink } from '../../../src/activation/forensic-sink.js';
import {
  NATIVE_LIFECYCLE_OBSERVABILITY_GAPS,
  NATIVE_SESSION_OBSERVABILITY_GAPS,
  mapNativeLifecycleEvent,
  mapNativeSessionEvent,
} from '../../../src/specialist/native-activation-observability.js';
import { createObservabilitySqliteClientAtPath } from '../../../src/specialist/observability-sqlite.js';

interface JobIdentityRow {
  job_id: string;
  participant_id: string | null;
  pi_session_id: string | null;
  workspace_id: string | null;
  attempt_no: number;
  attempt_id: string | null;
}

interface EventIdentityRow {
  seq: number;
  type: string;
  attempt_id: string | null;
}

interface ForensicIdentityRow {
  seq: number;
  participant_id: string | null;
  attempt_id: string | null;
  event_json: string;
}

describe('native activation observability parity', () => {
  let tempRoot: string;
  let dbPath: string;
  let client: ReturnType<typeof createObservabilitySqliteClientAtPath> | null;
  let raw: Database | null;

  // Worktree-local scratch, not /tmp: the shared box has a 2GB /tmp limit other
  // sessions keep hitting. Each test owns its subdir and removes it afterwards.
  const scratchRoot = join(import.meta.dirname, '..', '..', '.phase7-test-scratch');

  beforeEach(() => {
    tempRoot = join(scratchRoot, `native-observability-${crypto.randomUUID()}`);
    mkdirSync(tempRoot, { recursive: true });
    dbPath = join(tempRoot, 'observability.db');
    client = null;
    raw = null;
  });

  afterEach(() => {
    try { client?.close(); } catch { /* ignore */ }
    try { raw?.close(); } catch { /* ignore */ }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('stores native and legacy jobs under one Bead query with full v15 lineage', () => {
    client = createObservabilitySqliteClientAtPath(dbPath);
    expect(client).not.toBeNull();
    const observability = client!;
    const beadId = 'unitAI-parity';
    const worktreePath = join(tempRoot, 'worktree');
    mkdirSync(worktreePath);

    // Existing legacy path: no identity override and canonical job-derived attempt ID.
    observability.upsertStatus({
      id: 'legacy-job', specialist: 'researcher', status: 'done', bead_id: beadId,
      session_id: 'legacy-pi', worktree_path: worktreePath, started_at_ms: Date.now(),
    });
    observability.appendEvent('legacy-job', 'researcher', beadId, {
      t: Date.now(), type: 'run_start', specialist: 'researcher', bead_id: beadId,
    });

    // Native path: lifecycle + public Pi AgentSession events use the same writer.
    const sink = createActivationForensicSink(observability);
    const base = {
      activationId: 'act:native', attemptId: 'att:native:1',
      participantId: 'specialist::researcher', specialist: 'researcher', beadId,
    };
    sink.emit({ ...base, name: 'activation_requested' });
    sink.emit({ ...base, name: 'activation_admitted', payload: {
      workspace: worktreePath, resolved_model: 'provider/model',
    } });
    sink.emit({ ...base, name: 'activation_started', payload: { pi_session_id: 'native-pi' } });

    const sessionBase = {
      ...base,
      piSessionId: 'native-pi',
      workspacePath: worktreePath,
    };
    sink.sessionEvent?.({ ...sessionBase, event: { type: 'turn_start' } });
    sink.sessionEvent?.({ ...sessionBase, event: {
      type: 'message_start', message: { role: 'assistant', provider: 'provider', model: 'model', content: [] },
    } });
    sink.sessionEvent?.({ ...sessionBase, event: {
      type: 'message_end', message: {
        role: 'assistant', provider: 'provider', model: 'model', stopReason: 'stop',
        usage: { input: 10, output: 4, totalTokens: 14 },
        content: [{ type: 'text', text: 'native answer' }],
      },
    } });
    sink.sessionEvent?.({ ...sessionBase, event: {
      type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read', args: { path: 'README.md' },
    } });
    sink.sessionEvent?.({ ...sessionBase, event: {
      type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'read',
      result: { content: [{ type: 'text', text: 'ok' }] }, isError: false,
    } });
    sink.sessionEvent?.({ ...sessionBase, event: {
      type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: 'retry one',
    } });
    sink.sessionEvent?.({ ...sessionBase, event: { type: 'auto_retry_end', attempt: 1, success: true } });
    sink.sessionEvent?.({ ...sessionBase, event: {
      type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 1, errorMessage: 'retry two',
    } });
    sink.sessionEvent?.({ ...sessionBase, event: { type: 'turn_end' } });
    sink.emit({ ...base, name: 'activation_completed', payload: { pi_session_id: 'native-pi' } });

    observability.close();
    client = null;
    raw = new Database(dbPath);

    // The query has no native/legacy branch: bead_id is the shared key.
    const jobs = raw.query(`
      SELECT job_id, participant_id, pi_session_id, workspace_id, attempt_no, attempt_id
      FROM specialist_jobs WHERE bead_id = ? ORDER BY job_id
    `).all(beadId) as JobIdentityRow[];
    expect(jobs.map(row => row.job_id)).toEqual(['act:native', 'legacy-job']);

    const nativeJob = jobs[0];
    expect(nativeJob).toEqual({
      job_id: 'act:native',
      participant_id: 'specialist::researcher',
      pi_session_id: 'native-pi',
      workspace_id: normalize(resolve(worktreePath)),
      attempt_no: 3,
      attempt_id: 'att:native:3',
    });
    expect(jobs[1]?.attempt_id).toBe('legacy-job::attempt::1');
    expect((raw.query(
      'SELECT DISTINCT job_id FROM specialist_events WHERE bead_id = ? ORDER BY job_id',
    ).all(beadId) as Array<{ job_id: string }>).map(row => row.job_id)).toEqual(['act:native', 'legacy-job']);

    const events = raw.query(`
      SELECT seq, type, attempt_id FROM specialist_events
      WHERE job_id = 'act:native' ORDER BY seq
    `).all() as EventIdentityRow[];
    expect(events.map(row => row.type)).toEqual([
      'run_start', 'turn', 'meta', 'message', 'text', 'message', 'token_usage',
      'finish_reason', 'turn_summary', 'tool', 'tool', 'retry', 'retry', 'retry',
      'turn', 'run_complete',
    ]);
    expect(events.every(row => row.attempt_id !== null)).toBe(true);
    expect(events.filter(row => row.attempt_id === 'att:native:1')).toHaveLength(11);
    expect(events.filter(row => row.attempt_id === 'att:native:2')).toHaveLength(2);
    expect(events.filter(row => row.attempt_id === 'att:native:3')).toHaveLength(3);

    const forensic = raw.query(`
      SELECT seq, participant_id, attempt_id, event_json
      FROM specialist_forensic_events WHERE job_id = 'act:native' ORDER BY seq
    `).all() as ForensicIdentityRow[];
    expect(forensic).toHaveLength(events.length);
    for (let index = 0; index < forensic.length; index += 1) {
      const row = forensic[index]!;
      const event = JSON.parse(row.event_json) as { correlation: Record<string, unknown> };
      expect(row.attempt_id).toBe(events[index]?.attempt_id);
      expect(row.participant_id).toBe('specialist::researcher');
      expect(event.correlation).toMatchObject({
        participant_id: 'specialist::researcher',
        attempt_id: row.attempt_id,
        pi_session_id: 'native-pi',
        workspace_id: normalize(resolve(worktreePath)),
      });
    }
  });

  it('never lets a blank session identity clear the projected pi_session_id', () => {
    client = createObservabilitySqliteClientAtPath(dbPath);
    expect(client).not.toBeNull();
    const observability = client!;
    const sink = createActivationForensicSink(observability);
    const base = {
      activationId: 'act:blank', attemptId: 'att:blank:1',
      participantId: 'specialist::researcher', specialist: 'researcher', beadId: 'unitAI-blank',
    };
    sink.emit({ ...base, name: 'activation_started', payload: { pi_session_id: 'pi-real' } });
    // The host passes `snapshot.piSessionId ?? ''`; a blank must not clobber the row.
    sink.sessionEvent?.({ ...base, piSessionId: '', workspacePath: tempRoot, event: { type: 'turn_start' } });
    observability.close();
    client = null;
    raw = new Database(dbPath);
    expect(raw.query("SELECT pi_session_id FROM specialist_jobs WHERE job_id = 'act:blank'").get()).toEqual({
      pi_session_id: 'pi-real',
    });
  });

  it('rolls back status and events together when a projected event batch fails', () => {
    client = createObservabilitySqliteClientAtPath(dbPath);
    expect(client).not.toBeNull();
    const status = {
      id: 'act:atomic', specialist: 'researcher', status: 'running' as const,
      bead_id: 'unitAI-atomic', session_id: 'pi-atomic', worktree_path: tempRoot,
      started_at_ms: Date.now(),
    };

    expect(() => client!.upsertStatusWithEvents(status, [
      { t: Date.now(), seq: 1, type: 'turn', phase: 'start' },
      { t: Date.now(), seq: 1, type: 'turn', phase: 'end' },
    ], { attemptId: 'att:atomic:1', attemptNo: 1 })).toThrow();

    client!.close();
    client = null;
    raw = new Database(dbPath);
    expect(raw.query("SELECT COUNT(*) AS count FROM specialist_jobs WHERE job_id = 'act:atomic'").get()).toEqual({ count: 0 });
    expect(raw.query("SELECT COUNT(*) AS count FROM specialist_events WHERE job_id = 'act:atomic'").get()).toEqual({ count: 0 });
  });

  it('uses only shared event kinds and names every intentional native gap', () => {
    expect(mapNativeSessionEvent({ type: 'turn_start' }).map(event => event.type)).toEqual(['turn']);
    expect(mapNativeSessionEvent({
      type: 'tool_execution_start', toolCallId: '1', toolName: 'read', args: {},
    }).map(event => event.type)).toEqual(['tool']);
    expect(mapNativeSessionEvent({ type: 'auto_retry_start', attempt: 1 }).map(event => event.type)).toEqual(['retry']);
    expect(mapNativeSessionEvent({ type: 'queue_update' })).toEqual([]);

    const lifecycleContext = { startedAtMs: Date.now() };
    const lifecycleBase = { activationId: 'act:dedup', specialist: 'researcher' };
    for (const alias of [
      'turn_started', 'turn_completed', 'retry_started', 'retry_completed',
      'compaction_started', 'compaction_completed',
    ]) {
      expect(mapNativeLifecycleEvent({ ...lifecycleBase, name: alias }, lifecycleContext)).toBeNull();
    }
    expect(mapNativeLifecycleEvent(
      { ...lifecycleBase, name: 'activation_settled' }, lifecycleContext,
    )?.type).toBe('status_change');

    expect(Object.keys(NATIVE_LIFECYCLE_OBSERVABILITY_GAPS)).toEqual(expect.arrayContaining([
      'activation_requested', 'step_contract_compiled', 'activation_admitted',
      'activation_starting', 'activation_resumed', 'output_validation_started',
      'output_validation_passed', 'output_validation_failed', 'activation_disposed',
      // lease_acquired, lease_denied, lease_uncertain and tool_blocked were listed here and
      // are now MAPPED as control_signal rows (unitAI-rrdnt.58): a blocked write has to leave
      // a durable trace, and "no legacy equivalent" makes them uncomparable rather than
      // unimportant. lease_released and lease_reconciled stay gaps — teardown of a lease that
      // was granted is already implied by the activation's terminal event.
      'lease_released', 'lease_reconciled',
      'clarification_requested', 'clarification_answered',
      'escalation_raised', 'escalation_resolved',
      'turn_started', 'turn_completed',
      'retry_started', 'retry_completed', 'compaction_started', 'compaction_completed',
    ]));
    expect(Object.keys(NATIVE_SESSION_OBSERVABILITY_GAPS)).toEqual(expect.arrayContaining([
      'agent_start', 'agent_end', 'agent_settled', 'message_update', 'message_user', 'queue_update',
      'entry_appended', 'session_info_changed', 'thinking_level_changed',
      'summarization_retry_scheduled', 'summarization_retry_attempt_start',
      'summarization_retry_finished', 'bash_execution_update',
    ]));
  });
});
