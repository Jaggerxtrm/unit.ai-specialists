// unitAI-rrdnt.47: tests for summarizeNativeActivations.
//
// Provenance: the row shapes below (correlation.bead_id, resource fields,
// body.attempt_id/pi_session_id/error, event ordering) were copied from
// LIVE rows measured 2026-09-07 in .specialists/db/observability.db —
// activation act:198ce538-0c7 (explorer, bead unitAI-89b8i,
// requested→admitted→step_contract_compiled→starting→started→
// turn_started→turn_completed→settled→disposed→failed). These are recorded
// system output, not invented fixtures: if the forensic writer changes its
// envelope, the honest response is to update this file from a fresh live
// measurement, not to keep these rows passing.
import { describe, expect, it } from 'vitest';
import {
  formatActivationAge,
  summarizeNativeActivations,
} from '../../../src/specialist/native-activation-summary.js';
import type { ForensicEventRecord } from '../../../src/specialist/observability-sqlite.js';

let seq = 0;

function row(
  jobId: string,
  eventName: string,
  t: number,
  body: Record<string, unknown> = {},
  role = 'explorer',
): ForensicEventRecord {
  seq += 1;
  return {
    id: seq,
    job_id: jobId,
    seq,
    t,
    schema_version: 'xtrm.forensic.v1',
    event_family: 'activation',
    event_name: eventName,
    participant_kind: 'specialist',
    participant_role: role,
    participant_id: `specialist::${role}`,
    attempt_id: `att:${jobId}:1`,
    redaction_status: 'clean',
    event_json: JSON.stringify({
      schema_version: 'xtrm.forensic.v1',
      t_unix_ms: t,
      event_family: 'activation',
      event_name: eventName,
      resource: {
        service_namespace: 'xtrm',
        service_name: 'specialists',
        service_component: 'native-activation-host',
        participant_kind: 'specialist',
        participant_role: role,
      },
      correlation: { participant_id: `specialist::${role}`, job_id: jobId, bead_id: 'unitAI-89b8i' },
      body: { attempt_id: `att:${jobId}:1`, ...body },
      redaction: { status: 'clean' },
    }),
  };
}

const T0 = 1_788_824_247_906;

function fullLifecycle(jobId: string): ForensicEventRecord[] {
  return [
    row(jobId, 'activation.activation_requested', T0),
    row(jobId, 'activation.activation_admitted', T0 + 11_000),
    row(jobId, 'activation.step_contract_compiled', T0 + 12_000),
    row(jobId, 'activation.activation_starting', T0 + 15_000),
    row(jobId, 'activation.activation_started', T0 + 24_000, { pi_session_id: '01a07e3c-1ce4-7561-a37a-0c6cbf844fed' }),
    row(jobId, 'activation.turn_started', T0 + 24_500),
    row(jobId, 'activation.turn_completed', T0 + 70_000),
    row(jobId, 'activation.activation_settled', T0 + 71_000),
    // Measured order quirk: disposed was written BEFORE failed (t 38741 < 38755).
    row(jobId, 'activation.activation_disposed', T0 + 71_500, { reason: 'session shutdown' }),
    row(jobId, 'activation.activation_failed', T0 + 71_600, { error: 'This operation was aborted', stop_reason: 'error' }),
  ];
}

describe('summarizeNativeActivations', () => {
  it('derives failed + error detail from a full measured lifecycle (latest event wins)', () => {
    const [summary] = summarizeNativeActivations(fullLifecycle('act:198ce538-0c7'));
    expect(summary.activation_id).toBe('act:198ce538-0c7');
    expect(summary.specialist).toBe('explorer');
    expect(summary.bead_id).toBe('unitAI-89b8i');
    expect(summary.state).toBe('failed');
    expect(summary.detail).toBe('This operation was aborted');
    expect(summary.turns).toBe(1);
    expect(summary.event_count).toBe(10);
    expect(summary.pi_session_id).toBe('01a07e3c-1ce4-7561-a37a-0c6cbf844fed');
  });

  it('reports a mid-flight activation as last-known active, never as running', () => {
    const rows = fullLifecycle('act:live-1').slice(0, 6);
    const [summary] = summarizeNativeActivations(rows);
    expect(summary.state).toBe('active');
    expect(summary.state).not.toBe('running');
  });

  it('maps rejected and pre-start states without inventing liveness', () => {
    const rejected = summarizeNativeActivations([row('act:r', 'activation.activation_rejected', T0)]);
    expect(rejected[0].state).toBe('rejected');
    const requested = summarizeNativeActivations([row('act:q', 'activation.activation_requested', T0)]);
    expect(requested[0].state).toBe('requested');
  });

  it('sorts newest-first across activations', () => {
    const summaries = summarizeNativeActivations([
      ...fullLifecycle('act:old'),
      row('act:new', 'activation.activation_requested', T0 + 1_000_000),
    ]);
    expect(summaries.map((s) => s.activation_id)).toEqual(['act:new', 'act:old']);
  });

  it('tolerates malformed event_json instead of throwing the whole section', () => {
    const bad: ForensicEventRecord = { ...row('act:bad', 'activation.activation_started', T0), event_json: '{nope' };
    const [summary] = summarizeNativeActivations([bad]);
    expect(summary.state).toBe('active');
    expect(summary.bead_id).toBeUndefined();
  });

  it('returns [] for no rows so ps can omit the section', () => {
    expect(summarizeNativeActivations([])).toEqual([]);
  });
});

describe('formatActivationAge', () => {
  it('renders compact ages', () => {
    expect(formatActivationAge(1_000_000, 955_000)).toBe('45s ago');
    expect(formatActivationAge(4_000_000, 1_000_000)).toBe('50m ago');
    expect(formatActivationAge(10_000_000, 2_800_000)).toBe('2h ago');
  });
});
