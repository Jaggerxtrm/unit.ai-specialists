// unitAI-rrdnt.47: last-known summaries of native activations for the CLI.
//
// Native activations live in an in-process FleetRegistry inside their host
// session, so a separate CLI process can never read live registry state.
// What it CAN read is the forensic trail in specialist_forensic_events
// (event_family='activation'), written since unitAI-rrdnt.37.1.1. Everything
// here is therefore LAST-KNOWN state: a crashed host stops writing without
// a disposed row, so absence of a terminal event must never be rendered as
// "running". Callers must label the output accordingly.
import type { ForensicEventRecord } from './observability-sqlite.js';

export interface NativeActivationSummary {
  activation_id: string;
  specialist: string;
  bead_id?: string;
  /** Last-known lifecycle state derived from the latest forensic event. */
  state: string;
  last_event: string;
  last_event_at_ms: number;
  first_event_at_ms: number;
  event_count: number;
  turns: number;
  pi_session_id?: string;
  /** Error / stop reason for failed or disposed activations. */
  detail?: string;
}

/** Latest-event wins; unknown names fall back to the raw suffix. */
function stateForEventName(eventName: string): string {
  const short = eventName.startsWith('activation.') ? eventName.slice('activation.'.length) : eventName;
  switch (short) {
    case 'activation_requested': return 'requested';
    case 'activation_admitted': return 'admitted';
    case 'activation_starting':
    case 'step_contract_compiled': return 'starting';
    case 'activation_started':
    case 'turn_started':
    case 'turn_completed':
    case 'output_validation_started':
    case 'output_validation_passed': return 'active';
    case 'activation_settled': return 'settled';
    case 'activation_completed': return 'completed';
    case 'activation_failed': return 'failed';
    case 'activation_disposed': return 'disposed';
    case 'activation_rejected': return 'rejected';
    default: return short;
  }
}

interface ParsedBody {
  bead_id?: string;
  pi_session_id?: string;
  error?: string;
  stop_reason?: string;
  reason?: string;
}

function parseBody(eventJson: string): ParsedBody {
  try {
    const parsed = JSON.parse(eventJson) as {
      correlation?: { bead_id?: unknown };
      body?: { pi_session_id?: unknown; error?: unknown; stop_reason?: unknown; reason?: unknown };
    };
    const out: ParsedBody = {};
    if (typeof parsed.correlation?.bead_id === 'string') out.bead_id = parsed.correlation.bead_id;
    if (typeof parsed.body?.pi_session_id === 'string') out.pi_session_id = parsed.body.pi_session_id;
    if (typeof parsed.body?.error === 'string') out.error = parsed.body.error;
    if (typeof parsed.body?.stop_reason === 'string') out.stop_reason = parsed.body.stop_reason;
    if (typeof parsed.body?.reason === 'string') out.reason = parsed.body.reason;
    return out;
  } catch {
    return {};
  }
}

/**
 * Group forensic activation rows by job (activation) id and derive one
 * last-known summary per activation, newest first. Pure: takes rows, returns
 * summaries. Rows are expected from readForensicEvents({eventFamily:
 * 'activation'}) but any order is tolerated — latest is picked by (t, seq).
 */
export function summarizeNativeActivations(rows: readonly ForensicEventRecord[]): NativeActivationSummary[] {
  const byId = new Map<string, ForensicEventRecord[]>();
  for (const row of rows) {
    if (!row.job_id) continue;
    const group = byId.get(row.job_id) ?? [];
    group.push(row);
    byId.set(row.job_id, group);
  }

  const summaries: NativeActivationSummary[] = [];
  for (const [activationId, events] of byId.entries()) {
    const ordered = [...events].sort((a, b) => a.t - b.t || a.seq - b.seq);
    const first = ordered[0]!;
    const last = ordered[ordered.length - 1]!;
    const bodies = ordered.map((event) => parseBody(event.event_json));
    const beadId = [...bodies.map((b) => b.bead_id)].find((v): v is string => typeof v === 'string');
    const piSessionId = [...bodies.map((b) => b.pi_session_id)].find((v): v is string => typeof v === 'string');
    const lastBody = bodies[bodies.length - 1]!;
    const detail = lastBody.error
      ?? (lastBody.stop_reason ? `stop_reason=${lastBody.stop_reason}` : undefined)
      ?? lastBody.reason;
    const role = last.participant_role?.trim();
    summaries.push({
      activation_id: activationId,
      specialist: role && role.length > 0 ? role : 'unknown',
      ...(beadId ? { bead_id: beadId } : {}),
      state: stateForEventName(last.event_name),
      last_event: last.event_name,
      last_event_at_ms: last.t,
      first_event_at_ms: first.t,
      event_count: ordered.length,
      turns: ordered.filter((event) => event.event_name === 'activation.turn_started').length,
      ...(piSessionId ? { pi_session_id: piSessionId } : {}),
      ...(detail ? { detail } : {}),
    });
  }

  summaries.sort((a, b) => b.last_event_at_ms - a.last_event_at_ms);
  return summaries;
}

export function formatActivationAge(nowMs: number, atMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
