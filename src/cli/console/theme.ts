// Single source of truth for sp console visual contract.
// Owns 24-bit palette, status/container glyphs, column widths, status→color map,
// paint() helper, and pure row-rendering helpers.
//
// Invariant: every `\x1b[` literal in src/cli/console/ lives in this file.
// Normative source: docs/design/sp-console-tui-mock-v2.html + bead unitAI-ctb4u.2.

import { truncateToWidth } from '@earendil-works/pi-tui';
import type { ConsoleJob, ProcessSnapshot } from './types.js';

// ---------- Palette (24-bit ANSI from grounded mock-v2) ----------

export type ThemeColor =
  | 'txt'
  | 'bright'
  | 'dim'
  | 'rail'
  | 'sel'
  | 'running'
  | 'done'
  | 'reviewing'
  | 'waiting'
  | 'idle'
  | 'blocked';

const PALETTE: Record<ThemeColor, readonly [number, number, number]> = {
  txt: [200, 200, 200],
  bright: [228, 228, 228],
  dim: [125, 125, 125],
  rail: [58, 58, 58],
  sel: [38, 38, 38],
  running: [195, 154, 94],
  done: [140, 170, 106],
  reviewing: [159, 136, 191],
  waiting: [128, 149, 168],
  idle: [74, 74, 74],
  blocked: [196, 128, 111],
};

export function paint(text: string, color: ThemeColor): string {
  const [r, g, b] = PALETTE[color];
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

export function paintBg(text: string, color: ThemeColor): string {
  const [r, g, b] = PALETTE[color];
  return `\x1b[48;2;${r};${g};${b}m${text}\x1b[0m`;
}

function paintBar(text: string, fgRgb: readonly [number, number, number], bgRgb: readonly [number, number, number], width: number): string {
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, '');
  const padded = stripped.padEnd(width, ' ').slice(0, width);
  const [fr, fg, fb] = fgRgb;
  const [br, bg, bb] = bgRgb;
  return `\x1b[38;2;${fr};${fg};${fb}m\x1b[48;2;${br};${bg};${bb}m${padded}\x1b[0m`;
}

const KEYBAR_FG: readonly [number, number, number] = [0, 0, 0];          // black text
const KEYBAR_BG: readonly [number, number, number] = [255, 255, 255];    // white

// ---------- Glyphs (mock-v2 §3.2; D2 resolved: node label, ▦ glyph) ----------

export const STATUS_GLYPH = {
  running: '●',
  waiting: '◐',
  starting: '◐',
  done: '○',
  error: '✕',
  cancelled: '○',
  dead: '✕',
} as const;

export const CONTAINER_GLYPH = {
  epic: '◆',
  chain: '◇',
  node: '▦',
} as const;

const STATUS_COLOR: Record<string, ThemeColor> = {
  running: 'running',
  waiting: 'waiting',
  starting: 'waiting',
  done: 'done',
  error: 'blocked',
  cancelled: 'idle',
  dead: 'blocked',
};

export function statusColor(status: string, dead?: boolean): ThemeColor {
  if (dead) return 'blocked';
  return STATUS_COLOR[status] ?? 'idle';
}

export function statusGlyph(status: string, dead?: boolean): string {
  if (dead) return STATUS_GLYPH.dead;
  return (STATUS_GLYPH as Record<string, string>)[status] ?? '○';
}

export function ctxColor(pct?: number): ThemeColor {
  if (pct === undefined) return 'dim';
  if (pct >= 95) return 'blocked';
  if (pct >= 80) return 'running';
  return 'dim';
}

// ---------- Column widths (spec §6.4 normative) ----------

export type JobColumnKey =
  | 'id'
  | 'spec'
  | 'status'
  | 'ctxPct'
  | 'elapsed'
  | 'payloadKb'
  | 'payloadTok'
  | 'bead'
  | 'next'
  | 'title';

export const COLUMNS: Record<JobColumnKey, { width: number; align: 'L' | 'R' }> = {
  id: { width: 8, align: 'L' },
  spec: { width: 13, align: 'L' },
  status: { width: 9, align: 'L' },
  ctxPct: { width: 4, align: 'R' },
  elapsed: { width: 20, align: 'L' },
  payloadKb: { width: 8, align: 'L' },
  payloadTok: { width: 7, align: 'L' },
  bead: { width: 14, align: 'L' },
  next: { width: 7, align: 'L' },
  title: { width: 42, align: 'L' },
};

const JOB_COLUMN_ORDER: JobColumnKey[] = [
  'id',
  'spec',
  'status',
  'ctxPct',
  'elapsed',
  'payloadKb',
  'payloadTok',
  'bead',
  'next',
  'title',
];

// Drop right-to-left when row would overflow terminal width.
const JOB_DROP_ORDER: JobColumnKey[] = [
  'title',
  'next',
  'bead',
  'payloadTok',
  'payloadKb',
  'elapsed',
];

// ---------- Padding helpers ----------

export function padR(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return s + ' '.repeat(n - s.length);
}

export function padL(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return ' '.repeat(n - s.length) + s;
}

export function truncEllipsis(s: string, n: number): string {
  if (s.length <= n) return s;
  if (n <= 1) return s.slice(0, n);
  return s.slice(0, n - 1) + '…';
}

// ---------- Rail (continuous │ , no connectors) ----------

export function renderRail(depth: number): string {
  if (depth <= 0) return '';
  return paint('│ '.repeat(depth), 'rail');
}

// ---------- Composite elapsed (spec §6.4: `Xm Ys Tt·Ctc·Ktok`) ----------

function formatElapsedRaw(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m${String(remainder).padStart(2, '0')}s`;
}

export function composeElapsed(job: ConsoleJob): string {
  if (job.elapsed_s === undefined) return padR('—', COLUMNS.elapsed.width);
  const head = formatElapsedRaw(job.elapsed_s);
  const parts: string[] = [];
  const turns = job.metrics?.turns;
  const toolCalls = job.metrics?.tool_calls;
  const totalTokens = job.metrics?.token_usage?.total_tokens;
  if (turns) parts.push(`${turns}t`);
  if (toolCalls) parts.push(`${toolCalls}tc`);
  if (totalTokens && totalTokens > 0) {
    parts.push(totalTokens >= 1000 ? `${Math.round(totalTokens / 1000)}ktok` : `${totalTokens}tok`);
  }
  const composite = parts.length > 0 ? `${head} ${parts.join('·')}` : head;
  return padR(composite, COLUMNS.elapsed.width);
}

// ---------- Job row ----------

// Defensive coercion: production DBs can ship malformed status_json rows
// (16 of 1389 observed on a 2026-06 dev box had id: null after JSON.parse).
// A single bad row used to throw TypeError on `.slice()` and kill the whole
// TUI process via the uncaughtException handler. Coerce missing strings to
// placeholders so renders never crash on per-row drift. (unitAI-ctb4u.27)
function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

export function jobRowFieldValues(job: ConsoleJob): Record<JobColumnKey, string> {
  const ctxRaw = job.context_pct === undefined ? '--' : `${Math.round(job.context_pct)}%`;
  const ctxMark = job.context_health === 'WARN' || job.context_health === 'CRITICAL' ? '▲' : '';
  const id = asString(job.id, '????????');
  const specialist = asString(job.specialist, '?');
  const status = asString(job.status, '?');
  return {
    id: padR(id.slice(0, COLUMNS.id.width), COLUMNS.id.width),
    spec: padR(specialist.slice(0, COLUMNS.spec.width), COLUMNS.spec.width),
    status: padR(status.slice(0, COLUMNS.status.width), COLUMNS.status.width),
    ctxPct: padL((ctxRaw + ctxMark).slice(0, COLUMNS.ctxPct.width), COLUMNS.ctxPct.width),
    elapsed: composeElapsed(job),
    payloadKb: padR(job.payload_kb ?? '--', COLUMNS.payloadKb.width),
    payloadTok: padR(job.payload_tokens ?? '--', COLUMNS.payloadTok.width),
    bead: padR(job.bead_id ?? '', COLUMNS.bead.width),
    next: padR(job.next_action ?? '', COLUMNS.next.width),
    title: padR(truncEllipsis(job.bead_title ?? '', COLUMNS.title.width), COLUMNS.title.width),
  };
}

// Pure column-selection: drop right-to-left until row fits the given width.
// Exported for unit tests.
export function selectJobColumns(width: number, depth: number): JobColumnKey[] {
  const visible = [...JOB_COLUMN_ORDER];
  const overhead = 1 /* marker */ + 1 /* space */ + depth * 2 /* rail */ + 1 /* icon */ + 1; /* space */
  const computeCost = (): number => {
    let cost = overhead;
    visible.forEach((k, idx) => {
      cost += COLUMNS[k].width + (idx === 0 ? 0 : 1);
    });
    return cost;
  };
  for (const drop of JOB_DROP_ORDER) {
    if (computeCost() <= width) break;
    const idx = visible.indexOf(drop);
    if (idx === -1) continue;
    visible.splice(idx, 1);
  }
  return visible;
}

export function renderJobRow(
  job: ConsoleJob,
  width: number,
  depth: number,
  selected: boolean,
): string {
  const marker = selected ? '›' : ' ';
  const railText = '│ '.repeat(depth);
  const sColor = statusColor(job.status, job.is_dead);
  const icon = statusGlyph(job.status, job.is_dead);
  const values = jobRowFieldValues(job);
  const visible = selectJobColumns(width, depth);

  const paintField: Record<JobColumnKey, ThemeColor> = {
    id: 'dim',
    spec: 'txt',
    status: sColor,
    ctxPct: ctxColor(job.context_pct),
    elapsed: 'dim',
    payloadKb: 'dim',
    payloadTok: 'dim',
    bead: 'dim',
    next: 'dim',
    title: 'dim',
  };

  const parts: string[] = [marker, ' ', paint(railText, 'rail'), paint(icon, sColor), ' '];
  visible.forEach((k, idx) => {
    if (idx > 0) parts.push(' ');
    parts.push(paint(values[k], paintField[k]));
  });
  return truncateToWidth(parts.join(''), width);
}

// ---------- Group row (epic/chain/node/branch/worktree/label) ----------

export type GroupKind = 'epic' | 'chain' | 'node' | 'branch' | 'worktree' | 'label';

export function renderGroupRow(
  kind: GroupKind,
  label: string,
  width: number,
  depth: number,
): string {
  const railText = '│ '.repeat(depth);
  const rail = paint(railText, 'rail');
  const containerKey = kind === 'epic' || kind === 'chain' || kind === 'node' ? kind : null;
  const glyph = containerKey ? CONTAINER_GLYPH[containerKey] + ' ' : '';
  const body = glyph ? paint(glyph + label, 'bright') : paint(label, 'dim');
  return truncateToWidth('  ' + rail + body, width);
}

// ---------- StatsLine (spec §8.1 normative priority order) ----------

const STATS_FIELD_ORDER = [
  'jobs',
  'runWait',
  'ctx',
  'tokens',
  'enw',
  'health',
  'rssCpu',
  'orphans',
] as const;

type StatsKey = typeof STATS_FIELD_ORDER[number];

export function renderStatsLine(snapshot: ProcessSnapshot | undefined, width: number): string {
  if (!snapshot) return paint('jobs --', 'dim');

  const fields: Partial<Record<StatsKey, string>> = {
    jobs: paint(`jobs ${snapshot.visibleJobs}/${snapshot.totalJobs}`, 'dim'),
    runWait: paint(`running ${snapshot.runningJobs} waiting ${snapshot.waitingJobs}`, 'dim'),
  };
  if (snapshot.maxContextPct !== undefined) {
    const ctxPct = Math.round(snapshot.maxContextPct);
    fields.ctx = paint('ctx max ', 'dim') + paint(`${ctxPct}%`, ctxColor(snapshot.maxContextPct));
  }
  if (snapshot.totalTokens > 0) {
    fields.tokens = paint(`tokens ${snapshot.totalTokens}`, 'dim');
  }
  fields.enw = paint(
    `epics ${snapshot.epics} nodes ${snapshot.nodes} worktrees ${snapshot.worktrees}`,
    'dim',
  );
  const health = snapshot.health;
  if (health) {
    fields.health = paint(`health ${health.status}`, 'dim');
    const rssMb = (health.totalRssBytes / (1024 * 1024)).toFixed(0);
    const cpuPct = health.totalCpuPct.toFixed(1);
    fields.rssCpu = paint(`rss=${rssMb}MB cpu=${cpuPct}%`, 'dim');
    fields.orphans = paint(`orphans ${health.orphanCount ?? 0}`, 'dim');
  }

  const sep = ' · ';
  const keys = STATS_FIELD_ORDER.filter((k) => fields[k] !== undefined) as StatsKey[];
  while (keys.length > 0) {
    const line = keys.map((k) => fields[k]!).join(sep);
    if (visibleLength(line) <= width) return line;
    keys.pop();
  }
  return paint('jobs --', 'dim');
}

// ---------- KeyBar ----------

export function renderRepoSectionHeader(
  name: string,
  path: string,
  activeCount: number,
  width: number,
): string {
  const dot = activeCount > 0 ? paint('●', 'running') : paint('○', 'dim');
  const label = paint(name, activeCount > 0 ? 'bright' : 'dim');
  const home = process.env['HOME'] ?? '';
  const shortPath = home && path.startsWith(home) ? path.replace(home, '~') : path;
  const pathStr = paint(`  ${shortPath}`, 'dim');
  const countStr = activeCount > 0 ? paint(`  ${activeCount} active`, 'running') : paint('  idle', 'dim');
  return truncateToWidth(`${dot} ${label}${pathStr}${countStr}`, width);
}

export function renderKeyBar(
  view: string,
  follow: boolean,
  width: number,
  feedSource: 'sp_feed' | 'forensic' = 'forensic',
): string {
  const line =
    view === 'all'
      ? '↑↓ nav  ↵ feed  r result  i inspect  b bead  d diff  x stop  g config  R repos  tab/1-9 repo  q quit'
      : view === 'ps'
      ? '↑↓ nav  ↵ feed  r result  i inspect  b bead  d diff  x stop  g config  R repos  h history  a all  / filter  0 ALL  tab repo  q quit'
      : view === 'feed'
        ? `↑↓ scroll  PgUp/PgDn page  f follow:${follow ? 'on' : 'off'}  t ${feedSource === 'forensic' ? 'legacy' : 'forensic'}  ⌫ back  g/G top/end  q quit`
        : view === 'bead'
          ? '↑↓ scroll  PgUp/PgDn page  ⌫ back  g/G top/end  q quit'
          : view === 'diff'
            ? '↑↓ nav  ↵ open file  r refresh  ⌫ back  q quit'
            : view === 'config'
              ? '↑↓ field  [/] specialist  e edit  u undo  b $EDITOR  r refresh  ⌫ back  q quit'
              : view === 'repoConfig'
                ? '↑↓ nav  + add  d remove  e edit-path  n edit-name  r rescan  s show-inactive  ⌫ back  q quit'
                : '↑↓ scroll  ⌫ back  g/G top/end  q quit';
  return paintBar(truncateToWidth(line, width), KEYBAR_FG, KEYBAR_BG, width);
}

// ---------- Top chrome (tabs / meters / viewtag) ----------

export function renderTabs(
  repos: Array<{ name: string }>,
  currentIndex: number,
  width: number,
  currentView?: string,
): string {
  if (repos.length === 0) return paint('(no repos)', 'dim');
  const allTab = currentView === 'all' ? paint('[0] ALL', 'bright') : paint('[0] ALL', 'dim');
  const parts = repos.map((r, i) => {
    const label = `[${i + 1}] ${r.name}`;
    return (currentView !== 'all' && i === currentIndex) ? paint(label, 'bright') : paint(label, 'dim');
  });
  return truncateToWidth([allTab, ...parts].join('  '), width);
}

export interface MetersInput {
  active: number;
  activeTotal: number;
}

export function renderMeters(input: MetersInput, width: number): string {
  return paint(truncateToWidth(`active ${input.active}/${input.activeTotal}`, width), 'dim');
}

export function renderViewtag(
  views: readonly string[],
  currentView: string,
  width: number,
): string {
  const parts = views.map((v) => (v === currentView ? paint(v, 'bright') : paint(v, 'dim')));
  return truncateToWidth(parts.join('  '), width);
}

// ---------- Section title (replaces empty separator lines) ----------

export function renderSectionTitle(text: string, width: number): string {
  const prefix = '── ';
  const baseLen = prefix.length + text.length + 1;
  if (baseLen >= width) return paint(prefix + text, 'dim');
  const fill = '─'.repeat(Math.max(0, width - baseLen));
  return paint(`${prefix}${text} ${fill}`, 'dim');
}

// ---------- Filler line (frame padding; never emits ^$) ----------

export function fillerLine(width: number): string {
  return ' '.repeat(Math.max(1, width));
}

// ---------- Header banner ----------

export function renderHeader(viewLabel: string, repoName: string, repoPath: string, width: number): string {
  return paint(truncateToWidth(`${viewLabel} · ${repoName} · ${repoPath}`, width), 'dim');
}

// ---------- Inspect/result helpers ----------

export function renderInspectField(label: string, value: string, width: number): string {
  const padded = `${padR(label, 16)} ${value}`;
  return paint(truncateToWidth(padded, width), 'txt');
}

export function renderResultTitle(title: string, width: number): string {
  return paint(truncateToWidth(title, width), 'bright');
}

export function renderResultFooter(footer: string, width: number): string {
  return paint(truncateToWidth(footer, width), 'dim');
}

export function renderMessage(message: string, width: number): string {
  return paint(truncateToWidth(message, width), 'running');
}

export function renderFilterPrompt(text: string, width: number): string {
  return paint(truncateToWidth(text, width), 'txt');
}

export function renderPlaceholder(text: string, width: number): string {
  return paint(truncateToWidth(text, width), 'dim');
}

// ---------- ConfigView rows ----------

export function renderConfigField(
  path: string,
  valueText: string,
  hint: string,
  width: number,
  flags: { isOverride: boolean; isInherit: boolean; defaultValue?: string } = { isOverride: false, isInherit: true },
): string {
  const keyText = padR(path, 28);
  const head = paint(keyText, flags.isOverride ? 'bright' : 'dim');
  const inheritText = flags.isInherit && flags.defaultValue !== undefined
    ? `inherit (${flags.defaultValue})`
    : 'inherit';
  const value = paint(flags.isInherit ? inheritText : valueText, flags.isInherit ? 'dim' : 'txt');
  const minBody = visibleLength(head) + 1 + visibleLength(value) + 1;
  const hintWidth = Math.max(0, width - minBody);
  const hintText = hintWidth > 0
    ? paint(' '.repeat(Math.max(0, hintWidth - hint.length)) + hint, 'dim')
    : '';
  return truncateToWidth(head + ' ' + value + ' ' + hintText, width);
}

export function renderConfigSpecialistRow(
  name: string,
  hasOverride: boolean,
  selected: boolean,
  width: number,
): string {
  const marker = selected ? '›' : ' ';
  const tag = hasOverride ? paint('●', 'running') : paint('○', 'dim');
  const label = paint(name, selected || hasOverride ? 'bright' : 'dim');
  return truncateToWidth(`${marker} ${tag} ${label}`, width);
}

// ---------- RepoConfigView rows (unitAI-hneld) ----------

export interface RepoConfigRowInput {
  name: string;
  path: string;
  exists: boolean;
  dbExists: boolean;
  dbSizeBytes: number;
  lastActivityMs?: number;
  runningJobs: number;
  waitingJobs: number;
  current: boolean;
}

export function renderRepoConfigRow(row: RepoConfigRowInput, width: number, selected: boolean): string {
  const marker = selected ? '›' : ' ';
  // Status glyph: ● current, ◌ healthy w/ db, ✗ missing path, · no db yet.
  const glyph = !row.exists
    ? paint('✗', 'blocked')
    : row.current
      ? paint('●', 'running')
      : row.dbExists
        ? paint('◌', 'dim')
        : paint('·', 'dim');
  const name = paint(padR(row.name, 16), row.exists ? (selected || row.current ? 'bright' : 'txt') : 'dim');
  const sizeText = row.dbExists ? formatBytes(row.dbSizeBytes) : '   --';
  const sizeCol = paint(padL(sizeText, 6), 'dim');
  const activity = paint(padL(formatRelativeAge(row.lastActivityMs), 8), 'dim');
  const jobs = formatJobCounts(row.runningJobs, row.waitingJobs);
  const pathPaint: ThemeColor = row.exists ? 'dim' : 'blocked';
  const head = `${marker} ${glyph} ${name} ${sizeCol} ${activity} ${jobs} `;
  const headLen = visibleLength(head);
  const pathRoom = Math.max(0, width - headLen);
  const pathText = paint(truncateToWidth(row.path, pathRoom), pathPaint);
  return truncateToWidth(head + pathText, width);
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '   0B';
  const units = ['B', 'K', 'M', 'G'];
  let value = bytes;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx += 1;
  }
  const rendered = value >= 100 || unitIdx === 0
    ? `${Math.round(value)}${units[unitIdx]}`
    : `${value.toFixed(1)}${units[unitIdx]}`;
  return rendered;
}

function formatRelativeAge(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return 'never';
  const delta = Date.now() - ms;
  if (delta < 0) return 'now';
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

function formatJobCounts(running: number, waiting: number): string {
  const r = running > 0 ? paint(`R${running}`, 'running') : paint('R0', 'dim');
  const w = waiting > 0 ? paint(`W${waiting}`, 'blocked') : paint('W0', 'dim');
  return `${r} ${w}`;
}

// ---------- DiffView rows ----------

export function renderDiffSummaryRow(
  entry: { path: string; status: string; added: number; deleted: number; binary: boolean },
  width: number,
  selected: boolean,
): string {
  const marker = selected ? '›' : ' ';
  const status = padR(entry.status, 1);
  const added = entry.binary ? '   bin' : padL(`+${entry.added}`, 6);
  const deleted = entry.binary ? '      ' : padL(`-${entry.deleted}`, 6);
  const head = paint(`${marker} ${status} ${added} ${deleted}`, 'dim');
  const pathPaint = entry.status === '?' ? 'dim' : 'bright';
  return truncateToWidth(head + ' ' + paint(entry.path, pathPaint), width);
}

export function renderDiffHunkHeader(text: string, width: number): string {
  return paint(truncateToWidth(text, width), 'dim');
}

export function renderDiffHunkLine(
  kind: 'context' | 'add' | 'del' | 'meta',
  text: string,
  width: number,
): string {
  const color: ThemeColor =
    kind === 'add' ? 'done' : kind === 'del' ? 'blocked' : kind === 'meta' ? 'dim' : 'txt';
  return paint(truncateToWidth(text, width), color);
}

// ---------- BeadView rows ----------

export function renderBeadField(key: string, value: string, width: number): string {
  const k = padR(key.slice(0, 12), 12);
  const head = paint(k, 'bright');
  const tail = paint(value, 'txt');
  return truncateToWidth(head + ' ' + tail, width);
}

export function renderBeadBodyLine(line: string, width: number): string {
  return paint(truncateToWidth(line, width), 'txt');
}

// ---------- Utility: visible (non-ANSI) length ----------

export function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}
