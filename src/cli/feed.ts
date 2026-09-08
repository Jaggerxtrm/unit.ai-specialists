// src/cli/feed.ts
/**
 * Feed v2: unified chronological timeline for specialists jobs.
 *
 * Usage:
 *   specialists|sp feed [options]
 *
 * Options:
 *   --job <id>         Filter to a specific job
 *   --specialist <name> Filter by specialist name
 *   --node <node-ref>  Filter by node id (unique prefix allowed)
 *   --since <timestamp> Start time (ISO 8601 or milliseconds ago like '5m', '1h')
 *   --from <job:seq>   Show only events at/after cursor tuple (job_id:seq)
 *   --limit <n>        Max recent events to show (default: 100)
 *   --follow, -f       Live follow mode (append new events at bottom)
 *   --forever          Stay open even when all jobs complete
 *   --json             Output as pi-compatible NDJSON
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  type TimelineEvent,
  isRunCompleteEvent,
  parseTimelineEvent,
} from '../specialist/timeline-events.js';
import { createObservabilitySqliteClient } from '../specialist/observability-sqlite.js';
import { resolveNodeRefWithClient } from '../specialist/node-resolve.js';
import { queryTimeline } from '../specialist/timeline-query.js';
import { summarizeNativeActivations } from '../specialist/native-activation-summary.js';
import { formatSpecialistModel } from '../specialist/model-display.js';
import {
  bold,
  dim,
  magenta,
  JobColorMap,
  formatEventLine,
} from './format-helpers.js';
import { createPiJsonProjector } from './pi-json-output.js';

// ============================================================================
// CLI Options
// ============================================================================

interface FeedCursor {
  jobId: string;
  seq: number;
}

interface FeedOptions {
  jobId?: string;
  nodeId?: string;
  specialist?: string;
  since?: number;
  from?: FeedCursor;
  limit: number;
  follow: boolean;
  forever: boolean;
  json: boolean;
}

function getHumanEventKey(event: TimelineEvent): string {
  switch (event.type) {
    case 'meta':
      return `meta:${event.backend}:${event.model}`;
    case 'tool':
      return `tool:${event.tool}:${event.phase}:${event.tool_call_id ?? event.t}`;
    case 'text':
      return 'text';
    case 'thinking':
      return 'thinking';
    case 'message':
      return `message:${event.role}:${event.phase}`;
    case 'turn':
      return `turn:${event.phase}`;
    case 'status_change':
      return `status_change:${event.previous_status ?? ''}:${event.status}`;
    case 'run_start':
      return `run_start:${event.specialist}:${event.bead_id ?? ''}`;
    case 'run_complete':
      return `run_complete:${event.status}:${event.error ?? ''}`;
    case 'error':
      return `error:${event.source}:${event.error_message}`;
    case 'token_usage':
      return `token_usage:${event.token_usage.total_tokens ?? ''}:${event.source}`;
    case 'finish_reason':
      return `finish_reason:${event.finish_reason}:${event.source}`;
    case 'turn_summary':
      return `turn_summary:${event.turn_index}`;
    case 'text':
      return `text:${event.seq ?? ''}:${event.char_count ?? ''}:${event.content?.slice(0, 80) ?? ''}`;
    case 'compaction':
    case 'retry':
      return `${event.type}:${event.phase}`;
    default:
      return (event as any).type;
  }
}

function shouldRenderHumanEvent(event: TimelineEvent): boolean {
  if (event.type === 'message' || event.type === 'turn') return false;

  if (event.type === 'tool') {
    // Show actionable tool activity only:
    // - start: includes arguments (often command/path)
    // - end errors: surfaces failures
    // Hide update and successful end events to reduce noise.
    if (event.phase === 'update') return false;
    if (event.phase === 'end' && !event.is_error) return false;
  }

  return true;
}

function shouldSkipHumanEvent(
  event: TimelineEvent,
  jobId: string,
  lastPrintedEventKey: Map<string, string>,
  seenMetaKey: Map<string, string>
): boolean {
  if (event.type === 'meta') {
    const metaKey = `${event.backend}:${event.model}`;
    if (seenMetaKey.get(jobId) === metaKey) return true;
    seenMetaKey.set(jobId, metaKey);
  }

  if (event.type === 'tool') {
    // Tool events are often repeated calls to the same tool (e.g. many bash recalls)
    // with different arguments. Keep all of them for full observability.
    return false;
  }

  const key = getHumanEventKey(event);
  if (lastPrintedEventKey.get(jobId) === key) return true;
  lastPrintedEventKey.set(jobId, key);
  return false;
}

function isWaitingStatusChangeEvent(event: TimelineEvent): event is Extract<TimelineEvent, { type: 'status_change' }> {
  return event.type === 'status_change' && event.status === 'waiting';
}

function formatWaitingBanner(jobId: string, specialist: string): string {
  const prefix = magenta(bold('WAIT'));
  return `${prefix} ${specialist} (${jobId}) is waiting for input. Use: specialists resume ${jobId} "..."`;
}

function formatPayloadBreakdownSummary(payloadBreakdown: { components?: Array<{ name: string; tokens: number; bytes: number }>; totals?: { tokens: number; bytes: number } } | null | undefined): string | null {
  if (!payloadBreakdown) return null;
  const totals = payloadBreakdown.totals;
  if (!totals) return null;
  const components = (payloadBreakdown.components ?? []).filter((component) => Number.isFinite(component.tokens) && component.tokens > 0);
  const kb = (totals.bytes / 1024).toFixed(1);
  const kt = (totals.tokens / 1000).toFixed(1);
  return `payload: ${kb}kb · ${kt}kt across ${components.length} components`;
}

function formatPayloadBreakdownTopComponents(payloadBreakdown: { components?: Array<{ name: string; tokens: number; bytes: number }>; totals?: { tokens: number; bytes: number } } | null | undefined): string | null {
  const components = (payloadBreakdown?.components ?? [])
    .filter((component) => Number.isFinite(component.tokens) && component.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 3)
    .map((component) => `${component.name} (${(component.tokens / 1000).toFixed(1)}kt)`);
  return components.length > 0 ? `top-3: ${components.join(' · ')}` : null;
}

function formatStartupContextLine(event: TimelineEvent): string | null {
  if (event.type === 'run_start') {
    const snapshot = event.startup_snapshot;
    if (!snapshot) return null;

    const parts: string[] = [];
    if (snapshot.job_id) parts.push(`job=${snapshot.job_id}`);
    if (snapshot.specialist_name) parts.push(`specialist=${snapshot.specialist_name}`);
    if (snapshot.bead_id) parts.push(`bead=${snapshot.bead_id}`);
    if (snapshot.reused_from_job_id) parts.push(`reused=${snapshot.reused_from_job_id}`);
    if (snapshot.worktree_owner_job_id) parts.push(`owner=${snapshot.worktree_owner_job_id}`);
    if (snapshot.chain_id) parts.push(`chain=${snapshot.chain_id}`);
    if (snapshot.chain_root_job_id) parts.push(`chain_root_job=${snapshot.chain_root_job_id}`);
    if (snapshot.chain_root_bead_id) parts.push(`chain_root_bead=${snapshot.chain_root_bead_id}`);
    if (snapshot.worktree_path) parts.push(`worktree=${snapshot.worktree_path}`);
    if (snapshot.branch) parts.push(`branch=${snapshot.branch}`);
    if (snapshot.variables_keys) parts.push(`vars=[${snapshot.variables_keys.join(',')}]`);
    if (snapshot.reviewed_job_id_present !== undefined) parts.push(`reviewed_present=${snapshot.reviewed_job_id_present}`);
    if (snapshot.reused_worktree_awareness_present !== undefined) parts.push(`reuse_awareness_present=${snapshot.reused_worktree_awareness_present}`);
    if (snapshot.bead_context_present !== undefined) parts.push(`bead_context_present=${snapshot.bead_context_present}`);
    if (snapshot.skills) parts.push(`skills=${snapshot.skills.count}`);

    return parts.length > 0 ? dim(`  ↳ startup ${parts.join(' ')}`) : null;
  }

  if (event.type === 'payload_breakdown') {
    const summary = formatPayloadBreakdownSummary(event.payload_breakdown);
    if (!summary) return null;
    return dim(`  ↳ ${summary}`);
  }

  if (event.type === 'meta' && event.source === 'mandatory_rules_injection' && event.data) {
    const data = event.data as {
      sets_loaded?: string[];
      rules_count?: number;
      token_estimate?: number;
    };
    return dim(
      `  ↳ mandatory_rules sets=${(data.sets_loaded ?? []).join(',') || 'none'} rules=${data.rules_count ?? 0} tokens=~${data.token_estimate ?? 0}`,
    );
  }

  if (event.type === 'meta' && event.memory_injection) {
    const mem = event.memory_injection;
    return dim(
      `  ↳ memory static=${mem.static_tokens} dynamic=${mem.memory_tokens} gitnexus=${mem.gitnexus_tokens} total=${mem.total_tokens}`,
    );
  }

  return null;
}

function parseSince(value: string): number | undefined {
  // ISO 8601 timestamp
  if (value.includes('T') || value.includes('-')) {
    return new Date(value).getTime();
  }
  // Relative time like '5m', '1h', '30s'
  const match = value.match(/^(\d+)([smhd])$/);
  if (match) {
    const num = parseInt(match[1], 10);
    const unit = match[2];
    const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return Date.now() - num * multipliers[unit];
  }
  return undefined;
}

function parseCursor(value: string, defaultJobId?: string): FeedCursor | undefined {
  const tupleMatch = value.match(/^([^:]+):(\d+)$/);
  if (tupleMatch) {
    return { jobId: tupleMatch[1], seq: Number(tupleMatch[2]) };
  }

  const seq = Number(value);
  if (!Number.isFinite(seq) || seq < 0 || !defaultJobId) return undefined;
  return { jobId: defaultJobId, seq };
}

// ============================================================================
// Job metadata cache (status.json) — read once per job, merged into JSON envelope
// ============================================================================

interface JobMeta {
  model?: string;
  backend?: string;
  cwd?: string;
  beadId?: string;
  nodeId?: string;
  sessionId?: string;
  conversationId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  metrics?: Record<string, unknown>;
  contextPct?: number;
  startedAtMs: number;
}

type ObservabilitySqliteClient = ReturnType<typeof createObservabilitySqliteClient>;
type PiJsonProjector = ReturnType<typeof createPiJsonProjector>;

function getPiJsonProjector(
  projectors: Map<string, PiJsonProjector>,
  jobId: string,
  meta: JobMeta,
): PiJsonProjector {
  const existing = projectors.get(jobId);
  if (existing) return existing;
  const projector = createPiJsonProjector({
    jobId,
    sessionId: meta.sessionId,
    cwd: meta.cwd ?? process.cwd(),
    startedAtMs: meta.startedAtMs,
    model: meta.model,
    backend: meta.backend,
  });
  projectors.set(jobId, projector);
  return projector;
}

function projectPiJson(projector: PiJsonProjector, event: TimelineEvent, meta: JobMeta): Array<Record<string, unknown>> {
  const metadataEvents = meta.model || meta.backend
    ? projector({
      t: event.t,
      type: 'meta',
      model: meta.model ?? 'meta',
      backend: meta.backend ?? 'injected',
    })
    : [];
  return [...metadataEvents, ...projector(event)];
}

function readFileFresh(filePath: string): string | null {
  let fd: number | null = null;

  try {
    fd = openSync(filePath, 'r');
    return readFileSync(fd, 'utf-8');
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
}

function readStatusJson(
  sqliteClient: ObservabilitySqliteClient,
  jobsDir: string,
  jobId: string
): Record<string, unknown> | null {
  try {
    const sqliteStatus = sqliteClient?.readStatus(jobId);
    if (sqliteStatus) return sqliteStatus as unknown as Record<string, unknown>;
  } catch (error) {
    console.warn(`SQLite status read failed for job ${jobId}; falling back to status.json`, error);
  }

  const statusPath = join(jobsDir, jobId, 'status.json');
  const raw = readFileFresh(statusPath);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}


function isTerminalJobStatus(
  sqliteClient: ObservabilitySqliteClient,
  jobsDir: string,
  jobId: string
): boolean {
  const status = readStatusJson(sqliteClient, jobsDir, jobId);
  return status?.status === 'done' || status?.status === 'error' || status?.status === 'cancelled';
}

function isKeepAliveJobStatus(status: Record<string, unknown> | null): boolean {
  return status?.status === 'waiting';
}

function isTerminalStatus(status: Record<string, unknown> | null): boolean {
  return status?.status === 'done' || status?.status === 'error' || status?.status === 'cancelled';
}

function isTerminalEquivalentForFollow(
  status: Record<string, unknown> | null | undefined,
  isGlobalFollow: boolean
): boolean {
  return isTerminalStatus(status ?? null) || (isGlobalFollow && isKeepAliveJobStatus(status ?? null));
}

function isJobCompleteForFollow(
  sqliteClient: ObservabilitySqliteClient,
  jobsDir: string,
  jobId: string,
  events: TimelineEvent[]
): boolean {
  const status = readStatusJson(sqliteClient, jobsDir, jobId);

  // Keep-alive jobs emit run_complete at the end of each turn, so only terminal
  // status transitions should close follow mode for them.
  if (isKeepAliveJobStatus(status)) {
    return false;
  }

  // Single-turn jobs emit one terminal run_complete event.
  if (events.some(isRunCompleteEvent)) {
    return true;
  }

  return status?.status === 'done' || status?.status === 'error' || status?.status === 'cancelled';
}

function readJobMeta(
  sqliteClient: ObservabilitySqliteClient,
  jobsDir: string,
  jobId: string
): JobMeta {
  const status = readStatusJson(sqliteClient, jobsDir, jobId);
  if (!status) return { startedAtMs: Date.now() };

  const rawContextPct = status.context_pct;
  const contextPct = typeof rawContextPct === 'number'
    ? rawContextPct
    : (typeof rawContextPct === 'string' ? Number(rawContextPct) : undefined);

  return {
    model: typeof status.model === 'string' ? status.model : undefined,
    backend: typeof status.backend === 'string' ? status.backend : undefined,
    cwd: typeof status.worktree_path === 'string' ? status.worktree_path : undefined,
    beadId: typeof status.bead_id === 'string' ? status.bead_id : undefined,
    nodeId: typeof status.node_id === 'string' && status.node_id.trim() !== '' ? status.node_id : undefined,
    sessionId: typeof status.session_id === 'string' ? status.session_id : undefined,
    conversationId: typeof status.conversation_id === 'string' ? status.conversation_id : undefined,
    traceId: typeof status.trace_id === 'string' ? status.trace_id : undefined,
    spanId: typeof status.span_id === 'string' ? status.span_id : undefined,
    parentSpanId: typeof status.parent_span_id === 'string' ? status.parent_span_id : undefined,
    metrics: typeof status.metrics === 'object' && status.metrics !== null
      ? status.metrics as Record<string, unknown>
      : undefined,
    contextPct: Number.isFinite(contextPct) ? contextPct : undefined,
    startedAtMs: typeof status.started_at_ms === 'number' ? status.started_at_ms : Date.now(),
  };
}

function makeJobMetaReader(
  sqliteClient: ObservabilitySqliteClient,
  jobsDir: string,
  options: { useCache?: boolean } = {}
): (jobId: string) => JobMeta {
  const useCache = options.useCache ?? true;
  if (!useCache) {
    return (jobId: string): JobMeta => readJobMeta(sqliteClient, jobsDir, jobId);
  }

  const cache = new Map<string, JobMeta>();
  return (jobId: string): JobMeta => {
    const cached = cache.get(jobId);
    if (cached) return cached;

    const meta = readJobMeta(sqliteClient, jobsDir, jobId);
    cache.set(jobId, meta);
    return meta;
  };
}

function parseArgs(argv: string[]): FeedOptions {
  let jobId: string | undefined;
  let specialist: string | undefined;
  let nodeId: string | undefined;
  let since: number | undefined;
  let fromRaw: string | undefined;
  let limit = 100;
  let follow = false;
  let forever = false;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--job' && argv[i + 1]) { jobId = argv[++i]; continue; }
    if (argv[i] === '--specialist' && argv[i + 1]) { specialist = argv[++i]; continue; }
    if (argv[i] === '--node' && argv[i + 1]) { nodeId = argv[++i]; continue; }
    if (argv[i] === '--since' && argv[i + 1]) { since = parseSince(argv[++i]); continue; }
    if (argv[i] === '--from' && argv[i + 1]) {
      fromRaw = argv[++i];
      continue;
    }
    if (argv[i] === '--limit' && argv[i + 1]) { limit = parseInt(argv[++i], 10); continue; }
    if (argv[i] === '--follow' || argv[i] === '-f') { follow = true; continue; }
    if (argv[i] === '--forever') { forever = true; continue; }
    if (argv[i] === '--json') { json = true; continue; }
    if (!jobId && !argv[i].startsWith('--')) jobId = argv[i];
  }

  return {
    jobId,
    specialist,
    nodeId,
    since,
    from: fromRaw ? parseCursor(fromRaw, jobId) : undefined,
    limit,
    follow,
    forever,
    json,
  };
}

// ============================================================================
// Snapshot Mode
// ============================================================================

// unitAI-rrdnt.47: native activations (act:*) have no timeline rows — only
// forensic rows. When the timeline is empty but forensics exist, render the
// lifecycle trail instead of "not found". Output is LAST-KNOWN state, said
// in the open: a separate process cannot see the in-process Fleet registry.
function renderForensicTrail(
  sqliteClient: NonNullable<ObservabilitySqliteClient>,
  jobId: string,
  json: boolean,
): boolean {
  let rows;
  try {
    rows = sqliteClient.readForensicEvents({ jobId, limit: 1000 });
  } catch {
    return false;
  }
  if (rows.length === 0) return false;

  if (json) {
    for (const row of rows) {
      console.log(JSON.stringify({ source: 'forensic', last_known: true, live: false, ...row }));
    }
    return true;
  }

  const [summary] = summarizeNativeActivations(rows);
  console.log(dim(`native activation ${jobId} · LAST-KNOWN trail from forensics — not live (host-session Fleet registry is not visible here)`));
  if (summary) {
    const bead = summary.bead_id ? ` · bead ${summary.bead_id}` : '';
    console.log(dim(`specialist ${summary.specialist}${bead} · last-known state: ${summary.state} · ${summary.turns} turns · ${summary.event_count} events`));
  }
  for (const row of rows) {
    const short = row.event_name.startsWith('activation.') ? row.event_name.slice('activation.'.length) : row.event_name;
    console.log(`  ${new Date(row.t).toISOString()} ${short}`);
  }
  return true;
}

function printSnapshot(
  sqliteClient: ObservabilitySqliteClient,
  merged: Array<{ jobId: string; specialist: string; beadId?: string; event: TimelineEvent }>,
  options: FeedOptions,
  jobsDir?: string,
  piProjectors = new Map<string, PiJsonProjector>(),
): void {
  if (merged.length === 0) {
    if (options.jobId && sqliteClient && renderForensicTrail(sqliteClient, options.jobId, options.json)) {
      return;
    }
    if (!options.json) {
      if (options.jobId && sqliteClient) {
        console.log(dim(`job ${options.jobId} not found in .specialists/db/observability.db`));
      } else {
        console.log(dim('No events found.'));
      }
    }
    return;
  }

  // Build color map for jobs
  const colorMap = new JobColorMap();

  if (options.json) {
    const getJobMeta = jobsDir
      ? makeJobMetaReader(sqliteClient, jobsDir)
      : (): JobMeta => ({ startedAtMs: Date.now() });
    for (const { jobId, event } of orderMergedEvents(merged)) {
      const meta = getJobMeta(jobId);
      const projector = getPiJsonProjector(piProjectors, jobId, meta);
      for (const piEvent of projectPiJson(projector, event, meta)) console.log(JSON.stringify(piEvent));
    }
    return;
  }

  const lastPrintedEventKey = new Map<string, string>();
  const seenMetaKey = new Map<string, string>();
  const getJobMeta = jobsDir
    ? makeJobMetaReader(sqliteClient, jobsDir)
    : (): JobMeta => ({ startedAtMs: Date.now() });

  for (const { jobId, specialist, beadId, event } of merged) {
    if (!shouldRenderHumanEvent(event)) continue;
    if (shouldSkipHumanEvent(event, jobId, lastPrintedEventKey, seenMetaKey)) continue;
    const colorize = colorMap.get(jobId);
    const meta = getJobMeta(jobId);
    const specialistDisplay = formatSpecialistModel(specialist, meta.model ?? (event.type === 'meta' ? event.model : undefined));

    if (isWaitingStatusChangeEvent(event)) {
      console.log(formatWaitingBanner(jobId, specialistDisplay));
      continue;
    }

    console.log(formatEventLine(event, {
      jobId,
      specialist: specialistDisplay,
      beadId,
      nodeId: meta.nodeId,
      contextPct: meta.contextPct,
      colorize,
    }));

    const startupContextLine = formatStartupContextLine(event);
    if (startupContextLine) console.log(startupContextLine);
  }
}

// ============================================================================
// Follow Mode
// ============================================================================

type MergedEvent = { jobId: string; specialist: string; beadId?: string; event: TimelineEvent };

function orderMergedEvents(events: MergedEvent[]): MergedEvent[] {
  const byJob = new Map<string, MergedEvent[]>();
  for (const event of events) {
    const jobEvents = byJob.get(event.jobId) ?? [];
    jobEvents.push(event);
    byJob.set(event.jobId, jobEvents);
  }

  const queues = [...byJob.values()].map((jobEvents) => {
    const hasSequences = jobEvents.every(({ event }) => event.seq !== undefined);
    jobEvents.sort((a, b) =>
      hasSequences
        ? (a.event.seq ?? 0) - (b.event.seq ?? 0)
        : a.event.t - b.event.t || (a.event.seq ?? 0) - (b.event.seq ?? 0)
    );
    return { events: jobEvents, index: 0 };
  });

  const ordered: MergedEvent[] = [];
  while (ordered.length < events.length) {
    let nextQueue: (typeof queues)[number] | undefined;
    for (const queue of queues) {
      const candidate = queue.events[queue.index];
      if (!candidate) continue;
      const next = nextQueue?.events[nextQueue.index];
      if (!next || compareChronologically(candidate, next) < 0) nextQueue = queue;
    }
    if (!nextQueue) break;
    ordered.push(nextQueue.events[nextQueue.index++]);
  }
  return ordered;
}

function compareChronologically(a: MergedEvent, b: MergedEvent): number {
  return (
    a.event.t - b.event.t ||
    a.jobId.localeCompare(b.jobId) ||
    (a.event.seq ?? 0) - (b.event.seq ?? 0)
  );
}

function isEventAtOrAfterCursor(jobId: string, event: TimelineEvent, from?: FeedCursor): boolean {
  if (!from) return true;
  if (jobId !== from.jobId) return false;

  const seq = event.seq;
  if (typeof seq !== 'number') {
    return false;
  }

  return seq >= from.seq;
}

function filterMergedEventsByCursor(
  merged: Array<{ jobId: string; specialist: string; beadId?: string; event: TimelineEvent }>,
  from?: FeedCursor
): Array<{ jobId: string; specialist: string; beadId?: string; event: TimelineEvent }> {
  if (!from) return merged;
  return merged.filter(({ jobId, event }) => isEventAtOrAfterCursor(jobId, event, from));
}

function filterMergedEventsByNode(
  sqliteClient: ObservabilitySqliteClient,
  jobsDir: string,
  merged: Array<{ jobId: string; specialist: string; beadId?: string; event: TimelineEvent }>,
  nodeId?: string,
): Array<{ jobId: string; specialist: string; beadId?: string; event: TimelineEvent }> {
  if (!nodeId) return merged;

  return merged.filter(({ jobId }) => {
    const status = readStatusJson(sqliteClient, jobsDir, jobId);
    return typeof status?.node_id === 'string' && status.node_id === nodeId;
  });
}

function listMatchingJobIds(
  sqliteClient: ObservabilitySqliteClient,
  jobsDir: string,
  options: FeedOptions
): string[] {
  const jobIds = new Set<string>();

  try {
    for (const status of sqliteClient?.listStatuses?.() ?? []) {
      if (!status?.id) continue;
      jobIds.add(status.id);
    }
  } catch {
    // fall back to file discovery only
  }

  if (existsSync(jobsDir)) {
    for (const entry of readdirSync(jobsDir)) {
      const jobDir = join(jobsDir, entry);

      try {
        if (!statSync(jobDir).isDirectory()) continue;
      } catch {
        continue;
      }

      jobIds.add(entry);
    }
  }

  const filtered: string[] = [];
  for (const jobId of jobIds) {
    if (options.jobId && jobId !== options.jobId) continue;

    const status = readStatusJson(sqliteClient, jobsDir, jobId);

    if (options.nodeId) {
      const currentNodeId = typeof status?.node_id === 'string' ? status.node_id : '';
      if (currentNodeId !== options.nodeId) continue;
    }

    if (options.specialist) {
      const specialist = typeof status?.specialist === 'string' ? status.specialist : undefined;
      if (specialist !== options.specialist) continue;
    }

    filtered.push(jobId);
  }

  return filtered;
}

interface JobEventsCacheEntry {
  size: number;
  mtimeMs: number;
}

function sortEvents(events: TimelineEvent[]): TimelineEvent[] {
  events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.t - b.t);
  return events;
}

function readJobEventsFresh(
  sqliteClient: ObservabilitySqliteClient,
  jobsDir: string,
  jobId: string
): TimelineEvent[] {
  try {
    const sqliteEvents = sqliteClient?.readEvents(jobId) ?? [];
    if (sqliteEvents.length > 0) {
      return sortEvents(sqliteEvents);
    }
  } catch (error) {
    console.warn(`SQLite events read failed for job ${jobId}; falling back to events.jsonl`, error);
  }

  const eventsPath = join(jobsDir, jobId, 'events.jsonl');
  const content = readFileFresh(eventsPath);
  if (!content) return [];

  const events: TimelineEvent[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    const parsed = parseTimelineEvent(line);
    if (parsed) events.push(parsed);
  }

  return sortEvents(events);
}

function readJobEventsIncremental(
  sqliteClient: ObservabilitySqliteClient,
  jobsDir: string,
  jobId: string,
  afterSeq: number,
  fileCache: Map<string, JobEventsCacheEntry>,
): TimelineEvent[] {
  try {
    const sqliteEvents = afterSeq > 0
      ? (sqliteClient?.readEventsAfterSeq(jobId, afterSeq) ?? [])
      : (sqliteClient?.readEvents(jobId) ?? []);
    if (sqliteEvents.length > 0) {
      return sortEvents(sqliteEvents);
    }
  } catch (error) {
    console.warn(`SQLite incremental events read failed for job ${jobId}; falling back to events.jsonl`, error);
  }

  const eventsPath = join(jobsDir, jobId, 'events.jsonl');
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(eventsPath);
  } catch {
    return [];
  }

  const cached = fileCache.get(jobId);
  if (afterSeq > 0 && cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
    return [];
  }

  fileCache.set(jobId, { size: stats.size, mtimeMs: stats.mtimeMs });

  const events = readJobEventsFresh(sqliteClient, jobsDir, jobId);
  if (afterSeq <= 0) return events;
  return events.filter((event) => typeof event.seq === 'number' && event.seq > afterSeq);
}

function readFilteredBatchesFresh(
  sqliteClient: ObservabilitySqliteClient,
  jobsDir: string,
  options: FeedOptions
): Array<{ jobId: string; specialist: string; beadId?: string; events: TimelineEvent[] }> {
  const batches: Array<{ jobId: string; specialist: string; beadId?: string; events: TimelineEvent[] }> = [];

  for (const jobId of listMatchingJobIds(sqliteClient, jobsDir, options)) {
    const status = readStatusJson(sqliteClient, jobsDir, jobId);
    const specialist = typeof status?.specialist === 'string' ? status.specialist : 'unknown';
    const beadId = typeof status?.bead_id === 'string' ? status.bead_id : undefined;
    const events = readJobEventsFresh(sqliteClient, jobsDir, jobId);
    if (events.length === 0) continue;
    batches.push({ jobId, specialist, beadId, events });
  }

  return batches;
}

async function followMerged(
  sqliteClient: ObservabilitySqliteClient,
  jobsDir: string,
  options: FeedOptions
): Promise<void> {
  const colorMap = new JobColorMap();
  const getJobMeta = makeJobMetaReader(sqliteClient, jobsDir, { useCache: false });
  const lastSeenSeq = new Map<string, number>();
  const fileEventCache = new Map<string, JobEventsCacheEntry>();
  const initialMatchingJobIds = listMatchingJobIds(sqliteClient, jobsDir, options);
  const hasInitialMatchingJobs = initialMatchingJobIds.length > 0;
  const isGlobalFollow = options.jobId === undefined;
  const trackedJobs = new Set<string>(
    initialMatchingJobIds.filter((jobId) => {
      const status = readStatusJson(sqliteClient, jobsDir, jobId);
      return !isTerminalStatus(status) && !(isGlobalFollow && isKeepAliveJobStatus(status));
    })
  );
  const completedJobs = new Set<string>();
  const piProjectors = new Map<string, PiJsonProjector>();

  const filteredBatches = () => readFilteredBatchesFresh(sqliteClient, jobsDir, options);

  const initial = filterMergedEventsByCursor(
    filterMergedEventsByNode(
      sqliteClient,
      jobsDir,
      queryTimeline(jobsDir, {
        jobId: options.jobId,
        specialist: options.specialist,
        since: options.since,
        limit: options.limit,
      }),
      options.nodeId,
    ),
    options.from,
  );

  printSnapshot(sqliteClient, initial, { ...options, json: options.json }, jobsDir, piProjectors);

  for (const batch of filteredBatches()) {
    const maxSeq = batch.events.reduce((max, event) => Math.max(max, event.seq ?? 0), 0);
    lastSeenSeq.set(batch.jobId, maxSeq);

    if (trackedJobs.has(batch.jobId) && isJobCompleteForFollow(sqliteClient, jobsDir, batch.jobId, batch.events)) {
      completedJobs.add(batch.jobId);
    }
  }

  if (!options.forever && trackedJobs.size === 0) {
    if (!options.json) {
      const message = hasInitialMatchingJobs ? 'All jobs complete.\n' : 'No jobs found.\n';
      process.stderr.write(dim(message));
    }
    return;
  }

  if (!options.forever && hasInitialMatchingJobs && trackedJobs.size > 0 && completedJobs.size === trackedJobs.size) {
    if (!options.json) {
      process.stderr.write('All jobs complete.\n');
    }
    return;
  }

  if (!options.json) {
    process.stderr.write(dim('Following... (Ctrl+C to stop)\n'));
  }

  const lastPrintedEventKey = new Map<string, string>();
  const seenMetaKey = new Map<string, string>();

  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      const currentJobIds = listMatchingJobIds(sqliteClient, jobsDir, options);
      const statusByJobId = new Map<string, Record<string, unknown> | null>();

      for (const jobId of currentJobIds) {
        const status = readStatusJson(sqliteClient, jobsDir, jobId);
        statusByJobId.set(jobId, status);
        if (isTerminalEquivalentForFollow(status, isGlobalFollow)) {
          completedJobs.add(jobId);
          continue;
        }
        trackedJobs.add(jobId);
      }

      const newEvents: MergedEvent[] = [];
      for (const jobId of currentJobIds) {
        const status = statusByJobId.get(jobId);
        const specialist = typeof status?.specialist === 'string' ? status.specialist : 'unknown';
        const beadId = typeof status?.bead_id === 'string' ? status.bead_id : undefined;
        const previousSeq = lastSeenSeq.get(jobId) ?? 0;
        const events = readJobEventsIncremental(sqliteClient, jobsDir, jobId, previousSeq, fileEventCache);
        const maxSeq = events.reduce((max, event) => Math.max(max, event.seq ?? 0), previousSeq);
        lastSeenSeq.set(jobId, maxSeq);

        for (const event of events) {
          if (isEventAtOrAfterCursor(jobId, event, options.from)) {
            newEvents.push({ jobId, specialist, beadId, event });
          }
        }

        if (trackedJobs.has(jobId)) {
          if (isKeepAliveJobStatus(status ?? null)) {
            continue;
          }
          if (events.some(isRunCompleteEvent) || isTerminalStatus(status ?? null) || (isGlobalFollow && isKeepAliveJobStatus(status ?? null))) {
            completedJobs.add(jobId);
          }
        }
      }

      for (const { jobId, specialist, beadId, event } of orderMergedEvents(newEvents)) {
        const meta = getJobMeta(jobId);
        const model = meta.model ?? (event.type === 'meta' ? event.model : undefined);
        const backend = meta.backend ?? (event.type === 'meta' ? event.backend : undefined);

        if (options.json) {
          const projector = getPiJsonProjector(piProjectors, jobId, meta);
          for (const piEvent of projectPiJson(projector, event, meta)) console.log(JSON.stringify(piEvent));
        } else {
          if (!shouldRenderHumanEvent(event)) continue;
          if (shouldSkipHumanEvent(event, jobId, lastPrintedEventKey, seenMetaKey)) continue;
          const colorize = colorMap.get(jobId);
          const specialistDisplay = formatSpecialistModel(specialist, model);

          if (isWaitingStatusChangeEvent(event)) {
            console.log(formatWaitingBanner(jobId, specialistDisplay));
            continue;
          }

          console.log(formatEventLine(event, {
            jobId,
            specialist: specialistDisplay,
            beadId,
            nodeId: meta.nodeId,
            contextPct: meta.contextPct,
            colorize,
          }));

          const startupContextLine = formatStartupContextLine(event);
          if (startupContextLine) console.log(startupContextLine);
        }
      }

      if (!options.forever && trackedJobs.size > 0) {
        const allTrackedTerminal = [...trackedJobs].every((jobId) => {
          const status = statusByJobId.get(jobId) ?? readStatusJson(sqliteClient, jobsDir, jobId);
          return isTerminalEquivalentForFollow(status, isGlobalFollow);
        });
        if (completedJobs.size === trackedJobs.size || allTrackedTerminal) {
          clearInterval(interval);
          resolve();
        }
      }
    }, 750);
  });
}

// ============================================================================
// Main Entry Point
// ============================================================================

function showUsage(): void {
  console.log(`Usage: specialists feed <job-id> [options]
       specialists feed -f [--forever]

Read background job events.

Modes:
  specialists feed <job-id>        Show recent events for one job
  specialists feed <job-id> -f     Follow one job until completion
  specialists feed -f              Follow all jobs globally

Options:
  --node <node-ref> Filter jobs by node id
  --from <job:seq> Show only events at/after cursor tuple
  -f, --follow   Follow live updates
  --forever      Keep following in global mode even when all jobs complete

Node refs accept any unique prefix.

Examples:
  specialists feed 49adda
  specialists feed 49adda --from 49adda:15
  specialists feed 49adda --follow
  specialists feed -f
  specialists feed -f --forever
`);
}

export async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(3));
  const sqliteClient = createObservabilitySqliteClient();

  try {
    const jobsDir = join(process.cwd(), '.specialists', 'jobs');

    const hasSqliteStatuses = (() => {
      try {
        return (sqliteClient?.listStatuses?.() ?? []).length > 0;
      } catch {
        return false;
      }
    })();

    if (!existsSync(jobsDir) && !hasSqliteStatuses) {
      if (options.jobId && sqliteClient) {
        console.log(dim(`job ${options.jobId} not found in .specialists/db/observability.db`));
      } else {
        console.log(dim('No jobs directory found.'));
      }
      return;
    }

    const resolvedOptions = {
      ...options,
      nodeId: options.nodeId && sqliteClient ? resolveNodeRefWithClient(options.nodeId, sqliteClient) : options.nodeId,
    };

    if (resolvedOptions.from && !resolvedOptions.json) {
      console.log(dim(`Showing events from cursor ${resolvedOptions.from.jobId}:${resolvedOptions.from.seq}`));
    }

    if (resolvedOptions.follow) {
      await followMerged(sqliteClient, jobsDir, resolvedOptions);
      return;
    }

    // Snapshot mode
    const merged = filterMergedEventsByCursor(
      filterMergedEventsByNode(
        sqliteClient,
        jobsDir,
        queryTimeline(jobsDir, {
          jobId: resolvedOptions.jobId,
          specialist: resolvedOptions.specialist,
          since: resolvedOptions.since,
          limit: resolvedOptions.limit,
        }),
        resolvedOptions.nodeId,
      ),
      resolvedOptions.from,
    );

    printSnapshot(sqliteClient, merged, resolvedOptions, jobsDir);
  } finally {
    sqliteClient?.close();
  }
}
