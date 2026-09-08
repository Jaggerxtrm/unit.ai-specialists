import { spawnSync } from 'node:child_process';
import { bold, cyan, dim, formatTokenUsageSummary, green, magenta, red, yellow } from './format-helpers.js';
// unitAI-ugw4s: import the TUI's themed row + stats renderers so `sp ps`
// uses the same visual language as `sp console`'s ps view. The CLI keeps
// its prefix-based tree (`└ `/`├ `) but the per-row body and the bottom
// stats line share the TUI's column order, palette, and ctx coloring.
import {
  renderJobRow as themedJobRow,
  renderStatsLine as themedStatsLine,
} from './console/theme.js';
import type { ConsoleJob, ProcessSnapshot } from './console/types.js';
import { isJobDead } from '../specialist/supervisor.js';
import type { SupervisorStatus } from '../specialist/supervisor.js';
import type { TimelineEvent, TimelineEventRunComplete, TimelineTokenUsage } from '../specialist/timeline-events.js';
// TODO(u4fdd.6): shared status loading now lives in src/specialist/status-load.ts for ChatStatus reuse.
import { loadStatuses } from '../specialist/status-load.js';
import { createObservabilitySqliteClient } from '../specialist/observability-sqlite.js';
import { formatActivationAge, summarizeNativeActivations, type NativeActivationSummary } from '../specialist/native-activation-summary.js';
import { resolveNodeRefWithClient } from '../specialist/node-resolve.js';
import { loadEpicReadinessSummary, syncEpicStateFromReadiness, type EpicReadinessSummary } from '../specialist/epic-readiness.js';
import { collectProcessHealth, type ProcessHealthProcess, type ProcessHealthReport } from '../specialist/process-health.js';

type JobState = SupervisorStatus['status'];

interface PsArgs {
  json: boolean;
  all: boolean;
  follow: boolean;
  includeTerminal: boolean;
  includeCleaned: boolean;
  active: boolean;
  running: boolean;
  mine: boolean;
  needsAttention: boolean;
  beadFilter?: string;
  sinceMs?: number;
  nodeId?: string;
  inspectId?: string;
  health: boolean;
}

interface JobNode {
  kind: 'job';
  id: string;
  specialist: string;
  status: JobState;
  pid?: number;
  is_dead?: boolean;
  bead_id?: string;
  bead_title?: string;
  node_id?: string;
  worktree_owner_job_id?: string;
  reused_from_job_id?: string;
  worktree_path?: string;
  branch?: string;
  epic_id?: string;
  started_at_ms: number;
  elapsed_s?: number;
  context_pct?: number;
  context_health?: SupervisorStatus['context_health'];
  metrics?: SupervisorStatus['metrics'];
  startup_payload_json?: string | null;
  payload_kb?: string;
  payload_tokens?: string;
  pr_classification?: string;
  children: JobNode[];
}

interface WorktreeTree {
  owner_job_id: string;
  worktree_path?: string;
  branch?: string;
  children: JobNode[];
}

type EpicReadinessMap = Map<string, EpicReadinessSummary>;

interface NodeTree {
  node_id: string;
  node_name: string;
  status: string;
  member_count: number;
  newest_activity_ms: number;
  members: JobNode[];
}

interface EpicChainGroup {
  chain_id: string;
  chain_root_bead_id?: string;
  trees: WorktreeTree[];
}

interface EpicGroup {
  epic_id: string;
  readiness?: EpicReadinessSummary;
  prep_jobs: JobNode[];
  chains: EpicChainGroup[];
}

const ACTIVE_STATES: readonly JobState[] = ['starting', 'running', 'waiting'];
const TERMINAL_STATES: readonly JobState[] = ['done', 'error', 'cancelled'];
const BEAD_TITLE_CACHE = new Map<string, string>();
const STATUS_PRIORITY: Readonly<Record<JobState, number>> = {
  waiting: 3,
  running: 2,
  starting: 1,
  done: 0,
  error: 0,
  cancelled: 0,
};
const SPINNER_FRAMES = ['⣾', '⣽', '⣻', '⣺', '⣹', '⣸', '⣷', '⣶'] as const;

function loadBeadIdsForCurrentUser(): Set<string> {
  // Shell out to `bd query` rather than re-implementing assignee resolution
  // here. Returns an empty set on any failure so --mine becomes a no-op
  // filter (everything visible) rather than crashing.
  const ids = new Set<string>();
  try {
    const result = spawnSync('bd', ['query', 'assignee=me', '--json'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    });
    if (result.status !== 0 || !result.stdout) return ids;
    const parsed = JSON.parse(result.stdout) as Array<{ id?: string }>;
    for (const row of parsed) {
      if (row?.id) ids.add(row.id);
    }
  } catch {
    // ignore
  }
  return ids;
}

function parseSinceArg(value: string): number | undefined {
  const trimmed = value.trim();
  const match = /^(\d+)([smhd])$/.exec(trimmed);
  if (!match) return undefined;
  const n = Number(match[1]);
  const unit = match[2];
  const ms = unit === 's' ? n * 1_000
    : unit === 'm' ? n * 60_000
    : unit === 'h' ? n * 3_600_000
    : n * 86_400_000;
  return Date.now() - ms;
}

function parseArgs(argv: string[]): PsArgs {
  const allowedBooleanFlags = new Set([
    '--json', '--all', '--follow', '-f', '--include-terminal', '--include-merged',
    '--include-cleaned', '--active', '--running', '--mine', '--health', '--needs-attention',
  ]);
  const valueFlags = new Set(['--node', '--bead', '--since']);
  let nodeId: string | undefined;
  let beadFilter: string | undefined;
  let sinceMs: number | undefined;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('-') && !allowedBooleanFlags.has(token) && !valueFlags.has(token)) {
      const hint = token === '--ps' ? ' Did you mean `sp clean --ps`?' : '';
      throw new Error(`Unknown ps option: ${token}.${hint}`);
    }
    if (token === '--node' && argv[i + 1]) {
      nodeId = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--bead' && argv[i + 1]) {
      beadFilter = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--since' && argv[i + 1]) {
      sinceMs = parseSinceArg(argv[i + 1]);
      i += 1;
      continue;
    }

    if (!token.startsWith('-')) {
      positional.push(token);
    }
  }

  // --include-merged is preserved as an alias for backward compatibility;
  // --include-terminal is the canonical flag (covers merged + abandoned).
  const includeTerminal = argv.includes('--include-terminal') || argv.includes('--include-merged');

  return {
    json: argv.includes('--json'),
    all: argv.includes('--all'),
    follow: argv.includes('--follow') || argv.includes('-f'),
    includeTerminal,
    includeCleaned: argv.includes('--include-cleaned'),
    active: argv.includes('--active'),
    running: argv.includes('--running') || argv.includes('--active'),
    mine: argv.includes('--mine'),
    health: argv.includes('--health'),
    needsAttention: argv.includes('--needs-attention'),
    beadFilter,
    sinceMs,
    nodeId,
    inspectId: positional[0],
  };
}


function isPsCleaned(job: SupervisorStatus): boolean {
  const typed = job as SupervisorStatus & { ps_hidden_at?: number; ps_hidden_from_dashboard_at?: number };
  return Boolean(typed.ps_hidden_at ?? typed.ps_hidden_from_dashboard_at);
}

function isDefaultActionableTerminal(job: SupervisorStatus): boolean {
  return job.status === 'error' || job.status === 'cancelled';
}

function isVisibleStatus(status: JobState, all: boolean): boolean {
  if (all) return true;
  return ACTIVE_STATES.includes(status);
}

function toJobNode(job: SupervisorStatus & { is_dead?: boolean }): JobNode {
  const beadAwareStatus = job as SupervisorStatus & { bead_title?: string };

  return {
    kind: 'job',
    id: job.id,
    specialist: job.specialist,
    status: job.status,
    pid: job.pid,
    is_dead: job.is_dead,
    bead_id: job.bead_id,
    bead_title: beadAwareStatus.bead_title,
    node_id: job.node_id,
    worktree_owner_job_id: job.worktree_owner_job_id,
    reused_from_job_id: job.reused_from_job_id,
    worktree_path: job.worktree_path,
    branch: job.branch,
    epic_id: job.epic_id,
    started_at_ms: job.started_at_ms,
    elapsed_s: job.elapsed_s,
    context_pct: job.context_pct,
    context_health: job.context_health,
    metrics: job.metrics,
    startup_payload_json: job.startup_payload_json ?? null,
    pr_classification: job.pr_classification,
    children: [],
  };
}

function buildReuseForest(jobs: SupervisorStatus[]): JobNode[] {
  const nodes = new Map<string, JobNode>();
  for (const job of jobs) nodes.set(job.id, toJobNode(job));

  const roots: JobNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.reused_from_job_id;
    if (parentId && nodes.has(parentId)) {
      nodes.get(parentId)!.children.push(node);
      continue;
    }
    roots.push(node);
  }

  const sortTree = (jobNode: JobNode): void => {
    jobNode.children.sort((a, b) => a.started_at_ms - b.started_at_ms);
    for (const child of jobNode.children) sortTree(child);
  };

  roots.sort((a, b) => a.started_at_ms - b.started_at_ms);
  for (const root of roots) sortTree(root);
  return roots;
}

function getTreeUrgency(jobs: readonly SupervisorStatus[]): number {
  return jobs.reduce((highest, job) => Math.max(highest, STATUS_PRIORITY[job.status]), 0);
}

function getTreeNewestStart(jobs: readonly SupervisorStatus[]): number {
  return jobs.reduce((latest, job) => Math.max(latest, job.started_at_ms), 0);
}

function groupByTree(jobs: SupervisorStatus[]): WorktreeTree[] {
  const groups = new Map<string, SupervisorStatus[]>();

  for (const job of jobs) {
    if (job.node_id) continue;
    const ownerId = job.worktree_owner_job_id ?? job.id;
    if (!groups.has(ownerId)) groups.set(ownerId, []);
    groups.get(ownerId)!.push(job);
  }

  return groupTreeEntries([...groups.entries()]);
}

function groupTreeEntries(groupEntries: Array<[string, SupervisorStatus[]]>): WorktreeTree[] {
  const trees: WorktreeTree[] = [];

  const sortedGroups = groupEntries.sort(([ownerA, jobsA], [ownerB, jobsB]) => {
    const urgencyDelta = getTreeUrgency(jobsB) - getTreeUrgency(jobsA);
    if (urgencyDelta !== 0) return urgencyDelta;
    const startDelta = getTreeNewestStart(jobsB) - getTreeNewestStart(jobsA);
    if (startDelta !== 0) return startDelta;
    return ownerA.localeCompare(ownerB);
  });

  for (const [ownerJobId, treeJobs] of sortedGroups) {
    const representative = treeJobs.find((job) => job.id === ownerJobId) ?? treeJobs[0];

    trees.push({
      owner_job_id: ownerJobId,
      worktree_path: representative.worktree_path,
      branch: representative.branch,
      children: buildReuseForest(treeJobs),
    });
  }

  return trees;
}

function normalizeChainId(job: SupervisorStatus): string {
  if (job.chain_kind === 'chain') {
    if (job.chain_id) return job.chain_id;
    if (job.worktree_owner_job_id) return job.worktree_owner_job_id;
    return `chain:${job.id}`;
  }

  return 'prep';
}

function buildEpicGroups(jobs: SupervisorStatus[], epicReadiness: EpicReadinessMap): EpicGroup[] {
  const byEpic = new Map<string, SupervisorStatus[]>();
  for (const job of jobs) {
    if (!job.epic_id) continue;
    if (!byEpic.has(job.epic_id)) byEpic.set(job.epic_id, []);
    byEpic.get(job.epic_id)!.push(job);
  }

  const groups: EpicGroup[] = [];

  for (const [epicId, epicJobs] of byEpic.entries()) {
    const prepJobs = epicJobs
      .filter((job) => job.chain_kind !== 'chain')
      .map((job) => toJobNode(job))
      .sort((a, b) => {
        const urgencyDelta = STATUS_PRIORITY[b.status] - STATUS_PRIORITY[a.status];
        if (urgencyDelta !== 0) return urgencyDelta;
        return b.started_at_ms - a.started_at_ms;
      });

    const chainBuckets = new Map<string, SupervisorStatus[]>();
    for (const job of epicJobs) {
      if (job.chain_kind !== 'chain') continue;
      const chainId = normalizeChainId(job);
      if (!chainBuckets.has(chainId)) chainBuckets.set(chainId, []);
      chainBuckets.get(chainId)!.push(job);
    }

    const chains: EpicChainGroup[] = [...chainBuckets.entries()]
      .map(([chainId, chainJobs]) => {
        const treeBuckets = new Map<string, SupervisorStatus[]>();
        for (const chainJob of chainJobs) {
          const ownerId = chainJob.worktree_owner_job_id ?? chainJob.id;
          if (!treeBuckets.has(ownerId)) treeBuckets.set(ownerId, []);
          treeBuckets.get(ownerId)!.push(chainJob);
        }

        const chainSummary = epicReadiness.get(epicId)?.chains.find((chain) => chain.chain_id === chainId);

        return {
          chain_id: chainId,
          chain_root_bead_id: chainSummary?.chain_root_bead_id ?? chainJobs[0]?.chain_root_bead_id,
          trees: groupTreeEntries([...treeBuckets.entries()]),
        };
      })
      .sort((a, b) => a.chain_id.localeCompare(b.chain_id));

    groups.push({
      epic_id: epicId,
      readiness: epicReadiness.get(epicId),
      prep_jobs: prepJobs,
      chains,
    });
  }

  groups.sort((a, b) => {
    const aNewest = Math.max(
      ...a.prep_jobs.map((job) => job.started_at_ms),
      ...a.chains.flatMap((chain) => chain.trees.flatMap((tree) => tree.children.map((child) => child.started_at_ms))),
      0,
    );
    const bNewest = Math.max(
      ...b.prep_jobs.map((job) => job.started_at_ms),
      ...b.chains.flatMap((chain) => chain.trees.flatMap((tree) => tree.children.map((child) => child.started_at_ms))),
      0,
    );
    return bNewest - aNewest;
  });

  return groups;
}

function resolveNodeRunMap(nodeIds: readonly string[]): Map<string, { node_name: string; status: string }> {
  const nodeIdSet = new Set(nodeIds.filter((nodeId) => nodeId.length > 0));
  if (nodeIdSet.size === 0) return new Map();

  const sqliteClient = createObservabilitySqliteClient();
  if (!sqliteClient) return new Map();

  try {
    const byId = new Map<string, { node_name: string; status: string }>();
    const rows = sqliteClient.listNodeRuns();
    for (const row of rows) {
      if (!nodeIdSet.has(row.id)) continue;
      byId.set(row.id, { node_name: row.node_name, status: row.status });
    }
    return byId;
  } catch {
    return new Map();
  } finally {
    sqliteClient.close();
  }
}

function groupByNode(jobs: SupervisorStatus[]): NodeTree[] {
  const nodeGroups = new Map<string, SupervisorStatus[]>();
  for (const job of jobs) {
    if (!job.node_id) continue;
    if (!nodeGroups.has(job.node_id)) nodeGroups.set(job.node_id, []);
    nodeGroups.get(job.node_id)!.push(job);
  }

  const nodeInfoById = resolveNodeRunMap([...nodeGroups.keys()]);
  const nodeTrees: NodeTree[] = [];

  for (const [nodeId, nodeJobs] of nodeGroups.entries()) {
    const representative = nodeJobs[0];
    const nodeInfo = nodeInfoById.get(nodeId);

    const members = nodeJobs
      .map((job) => toJobNode(job))
      .sort((a, b) => {
        const urgencyDelta = STATUS_PRIORITY[b.status] - STATUS_PRIORITY[a.status];
        if (urgencyDelta !== 0) return urgencyDelta;
        return b.started_at_ms - a.started_at_ms;
      });

    nodeTrees.push({
      node_id: nodeId,
      node_name: nodeInfo?.node_name ?? representative?.specialist ?? 'node',
      status: nodeInfo?.status ?? representative?.status ?? 'unknown',
      member_count: members.length,
      newest_activity_ms: getTreeNewestStart(nodeJobs),
      members,
    });
  }

  nodeTrees.sort((a, b) => {
    const timeDelta = b.newest_activity_ms - a.newest_activity_ms;
    if (timeDelta !== 0) return timeDelta;
    return a.node_id.localeCompare(b.node_id);
  });

  return nodeTrees;
}

function statusLabel(status: JobState): string {
  if (status === 'running') return bold(green(status));
  if (status === 'waiting') return bold(magenta(status));
  if (status === 'done') return dim(status);
  if (status === 'error') return bold(red(status));
  if (status === 'cancelled') return dim(status);
  return bold(yellow(status));
}

function epicStateLabel(state: EpicReadinessSummary['readiness_state'] | undefined): string {
  if (state === 'merge_ready') return green('pass');
  if (state === 'merged') return dim('merged');
  if (state === 'failed') return red('failed');
  if (state === 'blocked') return yellow('blocked');
  if (state === 'resolving') return cyan('merge_ready');
  if (state === 'abandoned') return dim('abandoned');
  return magenta('no pass yet');
}

function withPidLiveness(statuses: SupervisorStatus[]): Array<SupervisorStatus & { is_dead: boolean }> {
  return statuses.map((job) => ({
    ...job,
    is_dead: isJobDead(job),
  }));
}

function formatElapsed(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '--';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m${String(remainder).padStart(2, '0')}s`;
}

function formatPayloadStats(payloadJson: string | null | undefined): { payload_kb: string; payload_tokens: string } {
  if (!payloadJson) return { payload_kb: '--', payload_tokens: '--' };
  try {
    const payload = JSON.parse(payloadJson) as { totals?: { bytes?: number; tokens?: number } };
    const bytes = payload.totals?.bytes;
    const tokens = payload.totals?.tokens;
    if (!Number.isFinite(bytes) || !Number.isFinite(tokens)) return { payload_kb: '--', payload_tokens: '--' };
    return {
      payload_kb: `${((bytes ?? 0) / 1024).toFixed(1)}kb`,
      payload_tokens: `${Math.round(tokens ?? 0)}t`,
    };
  } catch {
    return { payload_kb: '--', payload_tokens: '--' };
  }
}

function getBeadTitleFromBd(beadId: string): string | null {
  const result = spawnSync('bd', ['show', beadId, '--json'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 1500,
  });

  if (result.status !== 0 || !result.stdout) return null;

  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    const payload = (Array.isArray(parsed) ? parsed[0] : parsed) as {
      title?: unknown;
      issue?: { title?: unknown };
    };

    if (typeof payload?.title === 'string' && payload.title.trim().length > 0) return payload.title.trim();
    if (typeof payload?.issue?.title === 'string' && payload.issue.title.trim().length > 0) {
      return payload.issue.title.trim();
    }
  } catch {
    return null;
  }

  return null;
}

function sanitizeBeadTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim();
}

function buildBeadTitleCache(jobs: SupervisorStatus[]): Map<string, string> {
  const titles = new Map(BEAD_TITLE_CACHE);

  for (const job of jobs) {
    const beadAwareStatus = job as SupervisorStatus & { bead_title?: string };
    const beadId = job.bead_id;
    if (!beadId || titles.has(beadId)) continue;

    const cachedTitle = beadAwareStatus.bead_title;
    if (typeof cachedTitle === 'string' && cachedTitle.trim().length > 0) {
      const title = sanitizeBeadTitle(cachedTitle);
      titles.set(beadId, title);
      BEAD_TITLE_CACHE.set(beadId, title);
      continue;
    }

    const resolvedTitle = getBeadTitleFromBd(beadId);
    if (resolvedTitle) {
      const title = sanitizeBeadTitle(resolvedTitle);
      titles.set(beadId, title);
      BEAD_TITLE_CACHE.set(beadId, title);
    }
  }

  return titles;
}

function getStatusIcon(job: JobNode): string {
  if (job.is_dead) return red('◉');
  if (job.status === 'running') return cyan('◉');
  if (job.status === 'waiting') return magenta('◐');
  if (job.status === 'starting') return yellow('◐');
  if (job.status === 'done') return green('○');
  if (job.status === 'error') return red('○');
  return dim('○');
}

function getNextAction(job: JobNode): string {
  if (job.is_dead) return 'dead';
  if (job.status === 'running' || job.status === 'starting') return 'feed';
  if (job.status === 'waiting') return 'resume';
  if (job.status === 'done') return 'result';
  if (job.status === 'error') return 'result';
  return '';
}

function formatCtxWithIndicator(contextPct: number | undefined, contextHealth: string | undefined): string {
  if (contextPct === undefined || !Number.isFinite(contextPct)) return '  --';
  const pct = `${Math.round(contextPct)}%`;
  const warn = contextHealth === 'WARN' || contextHealth === 'CRITICAL' ? '▲' : '';
  return `${pct}${warn}`.padStart(4);
}

function jobNodeToConsoleJob(node: JobNode, beadTitles: Map<string, string>): ConsoleJob {
  // ConsoleJob extends SupervisorStatus; renderJobRow only reads a narrow
  // subset, so casting a partial-shape object back is safe at the surface
  // we exercise here.
  const payloadStats = formatPayloadStats(node.startup_payload_json);
  return {
    id: node.id,
    specialist: node.specialist,
    status: node.status,
    started_at_ms: node.started_at_ms,
    elapsed_s: node.elapsed_s,
    context_pct: node.context_pct,
    context_health: node.context_health,
    metrics: node.metrics,
    bead_id: node.bead_id,
    bead_title: node.bead_id ? beadTitles.get(node.bead_id) : undefined,
    payload_kb: node.payload_kb ?? payloadStats.payload_kb,
    payload_tokens: node.payload_tokens ?? payloadStats.payload_tokens,
    next_action: getNextAction(node),
    is_dead: node.is_dead,
  } as ConsoleJob;
}

function renderJobLine(
  job: JobNode,
  beadTitles: Map<string, string>,
  prefix: string,
  connector: string,
): string {
  const consoleJob = jobNodeToConsoleJob(job, beadTitles);
  const width = Math.max(80, (process.stdout.columns ?? 160) - prefix.length - connector.length);
  // renderJobRow starts each line with "  " (selection marker + space).
  // The CLI uses prefix+connector to draw its tree glyphs (└ ├) instead,
  // so strip that leading pair before grafting.
  const themed = themedJobRow(consoleJob, width, 0, false);
  const body = themed.startsWith('  ') ? themed.slice(2) : themed;
  const driftBadge = job.pr_classification && job.pr_classification !== 'clean'
    ? red(` [drift:${job.pr_classification}]`)
    : '';
  return `${prefix}${connector}${body}${driftBadge}`;
}

function renderTreeNodes(
  nodes: readonly JobNode[],
  beadTitles: Map<string, string>,
  prefix: string,
  renderedJobIds: Set<string>,
): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const isLast = i === nodes.length - 1;
    const connector = prefix === '' ? '  ' : isLast ? '└ ' : '├ ';
    const childPrefix = prefix === '' ? '  ' : prefix + (isLast ? '  ' : '│ ');

    if (!renderedJobIds.has(node.id)) {
      renderedJobIds.add(node.id);
      console.log(renderJobLine(node, beadTitles, prefix, connector));
    }

    if (node.children.length > 0) {
      renderTreeNodes(node.children, beadTitles, childPrefix, renderedJobIds);
    }
  }
}

function formatProcessRow(process: ProcessHealthProcess): string {
  const cwd = process.cwd ?? '--';
  const rssMb = `${(process.rssBytes / (1024 * 1024)).toFixed(1)}MB`;
  const cpu = `${process.cpuPct.toFixed(1)}%`;
  const age = `${Math.floor(process.ageSeconds / 60)}m`;
  return `  ${String(process.pid).padEnd(7)} ${process.role.padEnd(14)} ${rssMb.padEnd(8)} ${cpu.padEnd(7)} ${age.padEnd(5)} ${cwd}`;
}

function renderProcessHealthBlock(report: ProcessHealthReport, includeDetails: boolean): void {
  const percent = report.thresholdPct.toFixed(1);
  const severity = report.status === 'REFUSE' ? red('REFUSE') : report.status === 'WARN' ? yellow('WARN') : green('OK');
  console.log(bold(cyan('System health')));
  console.log(`  ${severity} rss=${(report.totalRssBytes / (1024 * 1024)).toFixed(1)}MB avail=${(report.memAvailableBytes / (1024 * 1024)).toFixed(1)}MB used=${percent}% warn=${report.warnPct}% refuse=${report.refusePct}% cpu=${report.totalCpuPct.toFixed(1)}%`);
  console.log(`  specialists=${report.specialistCount} dolt=${report.doltCount} serena-lsp=${report.serenaLspCount} orphans=${report.orphanCount}`);
  if (report.statusReasons.length > 0) console.log(`  alerts=${report.statusReasons.join('; ')}`);

  if (!includeDetails) {
    console.log('');
    return;
  }

  if (report.doltProcesses.length > 0) {
    console.log(bold('  Dolt sql-server'));
    for (const process of report.doltProcesses) console.log(formatProcessRow(process));
  }

  if (report.serenaWorkspaces.length > 0) {
    console.log(bold('  Serena LSP'));
    for (const workspace of report.serenaWorkspaces) {
      console.log(`  ${workspace.workspace} · ${workspace.count} procs · ${(workspace.rssBytes / (1024 * 1024)).toFixed(1)}MB`);
      for (const process of workspace.processes) console.log(formatProcessRow(process));
    }
  }

  if (report.specialistProcesses.length > 0) {
    console.log(bold('  Specialists'));
    for (const process of report.specialistProcesses) console.log(formatProcessRow(process));
  }

  if (report.orphanProcesses.length > 0) {
    console.log(bold('  Orphans'));
    for (const process of report.orphanProcesses) console.log(formatProcessRow(process));
  }

  console.log('');
}

function resolveEpicReadinessMap(jobs: readonly SupervisorStatus[], includeTerminal: boolean): EpicReadinessMap {
  const epicIds = new Set(jobs.map((job) => job.epic_id).filter((epicId): epicId is string => Boolean(epicId)));
  const sqlite = createObservabilitySqliteClient();
  if (!sqlite) return new Map();

  try {
    if (includeTerminal) {
      for (const epicRun of sqlite.listEpicRuns()) {
        if (epicRun.status === 'merged' || epicRun.status === 'failed' || epicRun.status === 'abandoned') {
          epicIds.add(epicRun.epic_id);
        }
      }
    }

    const readinessMap: EpicReadinessMap = new Map();
    for (const epicId of epicIds) {
      const summary = loadEpicReadinessSummary(sqlite, epicId);
      syncEpicStateFromReadiness(sqlite, summary);
      readinessMap.set(epicId, summary);
    }
    return readinessMap;
  } catch {
    return new Map();
  } finally {
    sqlite.close();
  }
}

function loadNativeActivationSummaries(args: PsArgs, mineBeadIds?: Set<string>): NativeActivationSummary[] {
  const sqliteClient = createObservabilitySqliteClient();
  if (!sqliteClient) return [];
  try {
    const rows = sqliteClient.readForensicEvents({
      eventFamily: 'activation',
      sinceMs: args.sinceMs,
      limit: 1000,
    });
    return summarizeNativeActivations(rows).filter((summary) => {
      if (args.beadFilter && summary.bead_id !== args.beadFilter) return false;
      if (mineBeadIds && (!summary.bead_id || !mineBeadIds.has(summary.bead_id))) return false;
      return true;
    });
  } catch {
    return [];
  } finally {
    sqliteClient.close();
  }
}

const NATIVE_ACTIVATION_DISPLAY_LIMIT = 10;

function renderNativeActivationsBlock(summaries: NativeActivationSummary[]): void {
  if (summaries.length === 0) return;
  console.log(bold(cyan('Native activations')) + dim(' · LAST-KNOWN from forensics — not live (the Fleet registry is in-process in the host session)'));
  const now = Date.now();
  for (const summary of summaries.slice(0, NATIVE_ACTIVATION_DISPLAY_LIMIT)) {
    const bead = summary.bead_id ? ` ${summary.bead_id}` : '';
    const detail = summary.detail ? ` · ${summary.detail}` : '';
    console.log(`  ${summary.activation_id} ${summary.specialist}${bead} ${statusLabel(summary.state as JobState)} · ${summary.event_count} events · ${summary.turns} turns · ${formatActivationAge(now, summary.last_event_at_ms)}${detail}`);
  }
  if (summaries.length > NATIVE_ACTIVATION_DISPLAY_LIMIT) {
    console.log(dim(`  +${summaries.length - NATIVE_ACTIVATION_DISPLAY_LIMIT} older omitted — narrow with --since/--bead`));
  }
  console.log('');
}

function renderHuman(jobs: SupervisorStatus[], nodes: NodeTree[], trees: WorktreeTree[], all: boolean, includeTerminal: boolean, epicReadiness: EpicReadinessMap, health: ProcessHealthReport, includeHealthDetails: boolean, nativeActivations: NativeActivationSummary[] = []): void {
  const beadTitles = buildBeadTitleCache(jobs);
  const renderedJobIds = new Set<string>();
  const epicGroups = buildEpicGroups(jobs, epicReadiness);
  const renderedEpicIds = new Set(epicGroups.map((epic) => epic.epic_id));

  renderProcessHealthBlock(health, includeHealthDetails);

  for (const epic of epicGroups) {
    const prepCount = epic.prep_jobs.length;
    const chainCount = epic.chains.length;
    const readiness = epic.readiness;
    const readinessState = readiness?.readiness_state ?? 'unresolved';
    const persistedState = readiness?.persisted_state ?? 'open';
    const prepSummary = readiness?.prep
      ? `prep ${readiness.prep.done}/${readiness.prep.total} done${readiness.prep.running > 0 ? ` ${readiness.prep.running} running` : ''}${readiness.prep.failed > 0 ? ` ${readiness.prep.failed} failed` : ''}`
      : `prep ${prepCount}`;
    const chainSummary = readiness?.chains
      ? `chains ${readiness.chains.filter((chain) => chain.state === 'pass').length}/${readiness.chains.length} pass`
      : `chains ${chainCount}`;

    const epicBanner = bold(cyan(`┏━ EPIC ${epic.epic_id} ━ ${epicStateLabel(readiness?.readiness_state)} ━ ${prepSummary} ━ ${chainSummary}`));
    console.log(epicBanner);
    console.log(`  ${dim(`derived:${readinessState}`)} · ${dim(`stored:${persistedState}`)}`);

    console.log(`  ${bold('Prep')}`);
    if (epic.prep_jobs.length === 0) {
      console.log(dim('    (none)'));
    } else {
      for (const prepJob of epic.prep_jobs) {
        if (!renderedJobIds.has(prepJob.id)) {
          renderedJobIds.add(prepJob.id);
          console.log(renderJobLine(prepJob, beadTitles, '    ', ''));
        }
      }
    }

    console.log(`  ${bold('Chains')}`);
    if (epic.chains.length === 0) {
      console.log(dim('    (none)'));
    } else {
      for (const chain of epic.chains) {
        const chainReadiness = readiness?.chains.find((entry) => entry.chain_id === chain.chain_id);
        const readinessLabel = chainReadiness ? ` · ${chainReadiness.state}` : '';
        const rootBeadSuffix = chain.chain_root_bead_id ? ` · root:${chain.chain_root_bead_id}` : '';
        console.log(`    ${bold(chain.chain_id)}${dim(rootBeadSuffix)}${dim(readinessLabel)}`);

        for (const tree of chain.trees) {
          const branch = tree.branch ?? 'master';
          console.log(`      ${dim(branch)}`);
          renderTreeNodes(tree.children, beadTitles, '      ', renderedJobIds);
        }
      }
    }

    console.log('');
  }

  if (includeTerminal) {
    for (const [epicId, readiness] of epicReadiness.entries()) {
      if (renderedEpicIds.has(epicId)) continue;

      const chainCount = readiness.chains.length;
      const epicBanner = bold(cyan(`┏━ EPIC ${epicId} ━ ${String(readiness.readiness_state).toUpperCase()} ━ prep 0 ━ chains ${chainCount}`));
      console.log(epicBanner);
      console.log(`  ${dim(`state:${readiness.persisted_state}`)} · ${epicStateLabel(readiness.readiness_state)}`);
      console.log(`  ${bold('Prep')}`);
      console.log(dim('    (none retained)'));
      console.log(`  ${bold('Chains')}`);
      if (readiness.chains.length === 0) {
        console.log(dim('    (none)'));
      } else {
        for (const chain of readiness.chains) {
          const rootBeadSuffix = chain.chain_root_bead_id ? ` · root:${chain.chain_root_bead_id}` : '';
          console.log(`    ${bold(chain.chain_id)}${dim(rootBeadSuffix)}${dim(' · no retained jobs')}`);
        }
      }
      console.log('');
    }
  }

  const legacyNodes = nodes.filter((node) => !node.members.some((member) => member.epic_id));
  const legacyTrees = trees.filter((tree) => !tree.children.some((child) => child.epic_id));

  for (const node of legacyNodes) {
    console.log(`${cyan('⬢')} ${node.node_id} · ${node.node_name} · ${statusLabel(node.status as JobState)} · ${node.member_count} members`);
    for (const member of node.members) {
      if (!renderedJobIds.has(member.id)) {
        renderedJobIds.add(member.id);
        console.log(renderJobLine(member, beadTitles, '    ', ''));
      }
    }
    console.log('');
  }

  for (const tree of legacyTrees) {
    const branch = tree.branch ?? 'master';
    const beadId = tree.children[0]?.bead_id;
    const beadSuffix = beadId ? ` · ${beadId}` : '';
    console.log(`${dim(branch)}${dim(beadSuffix)}`);

    renderTreeNodes(tree.children, beadTitles, '', renderedJobIds);
    console.log('');
  }

  if (epicGroups.length === 0 && legacyNodes.length === 0 && legacyTrees.length === 0) {
    console.log(dim('  no active jobs'));
    console.log('');
  }

  renderNativeActivationsBlock(nativeActivations);

  const renderedJobs = jobs.filter((job) => renderedJobIds.has(job.id));
  const runningCount = renderedJobs.filter((job) => job.status === 'running').length;
  const waitingCount = renderedJobs.filter((job) => job.status === 'waiting').length;

  // Build a minimal ProcessSnapshot so the TUI's stats renderer can do
  // the formatting. The maxContextPct / totalTokens fields aggregate from
  // already-loaded jobs without an extra read pass.
  const ctxValues = renderedJobs
    .map((j) => j.context_pct)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const totalTokens = renderedJobs.reduce(
    (acc, j) => acc + (j.metrics?.token_usage?.total_tokens ?? 0),
    0,
  );
  const statsSnapshot: ProcessSnapshot = {
    generatedAtMs: Date.now(),
    repo: { id: '-', name: '-', path: process.cwd() },
    filter: { historyMode: 'default', includeCleaned: false, textFilter: '' },
    rows: [],
    jobs: [],
    totalJobs: jobs.length,
    visibleJobs: renderedJobIds.size,
    runningJobs: runningCount,
    waitingJobs: waitingCount,
    epics: epicGroups.length,
    nodes: legacyNodes.length,
    worktrees: legacyTrees.length,
    maxContextPct: ctxValues.length > 0 ? Math.max(...ctxValues) : undefined,
    totalTokens,
    health: null,
  };
  const width = Math.max(80, process.stdout.columns ?? 160);
  const includeSuffix = all ? '  ' + dim('· include terminal') : '';
  console.log(themedStatsLine(statsSnapshot, width) + includeSuffix);
}

function statusFromRunComplete(status: TimelineEventRunComplete['status'] | undefined): JobState {
  if (status === 'COMPLETE') return 'done';
  if (status === 'CANCELLED') return 'cancelled';
  if (status === 'ERROR') return 'error';
  return 'running';
}

function latestTokenUsage(events: readonly TimelineEvent[], complete?: TimelineEventRunComplete): TimelineTokenUsage | undefined {
  if (complete?.token_usage) return complete.token_usage;
  if (complete?.metrics?.token_usage) return complete.metrics.token_usage;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as TimelineEvent & { token_usage?: TimelineTokenUsage };
    if (event.token_usage) return event.token_usage;
  }
  return undefined;
}

function synthesizeStatusFromEvents(jobId: string): SupervisorStatus | null {
  const sqliteClient = createObservabilitySqliteClient();
  try {
    const events = sqliteClient?.readEvents(jobId) ?? [];
    if (events.length === 0) return null;

    const first = events[0]!;
    const runStart = events.find((event) => event.type === 'run_start') as (TimelineEvent & { specialist?: string; bead_id?: string; startup_snapshot?: Record<string, unknown> }) | undefined;
    const runComplete = [...events].reverse().find((event) => event.type === 'run_complete') as TimelineEventRunComplete | undefined;
    const latestMeta = [...events].reverse().find((event) => event.type === 'meta') as (TimelineEvent & { model?: string; backend?: string }) | undefined;
    const last = events[events.length - 1]!;
    const startup = runStart?.startup_snapshot;
    const specialist = runStart?.specialist
      ?? (typeof startup?.specialist_name === 'string' ? startup.specialist_name : undefined)
      ?? 'unknown';

    return {
      id: jobId,
      specialist,
      status: statusFromRunComplete(runComplete?.status),
      started_at_ms: first.t,
      elapsed_s: runComplete?.elapsed_s ?? Math.max(0, Math.round((last.t - first.t) / 1000)),
      last_event_at_ms: last.t,
      bead_id: runStart?.bead_id ?? (typeof startup?.bead_id === 'string' ? startup.bead_id : undefined),
      model: runComplete?.model ?? latestMeta?.model,
      backend: runComplete?.backend ?? latestMeta?.backend,
      output_type: runComplete?.metrics?.output_type,
      chain_kind: typeof startup?.chain_id === 'string' ? 'chain' : 'prep',
      chain_id: typeof startup?.chain_id === 'string' ? startup.chain_id : undefined,
      chain_root_job_id: typeof startup?.chain_root_job_id === 'string' ? startup.chain_root_job_id : undefined,
      chain_root_bead_id: typeof startup?.chain_root_bead_id === 'string' ? startup.chain_root_bead_id : undefined,
      worktree_path: typeof startup?.worktree_path === 'string' ? startup.worktree_path : undefined,
      branch: typeof startup?.branch === 'string' ? startup.branch : undefined,
      reused_from_job_id: typeof startup?.reused_from_job_id === 'string' ? startup.reused_from_job_id : undefined,
      worktree_owner_job_id: typeof startup?.worktree_owner_job_id === 'string' ? startup.worktree_owner_job_id : undefined,
      metrics: {
        ...runComplete?.metrics,
        ...(latestTokenUsage(events, runComplete) ? { token_usage: latestTokenUsage(events, runComplete) } : {}),
      },
    };
  } finally {
    sqliteClient?.close();
  }
}

/**
 * Compact "spawned-by" line for `sp ps` human output (spec §13.7). Returns
 * undefined when the job has no origin — no misleading "unknown" line.
 */
export function formatSpawnedByLine(job: SupervisorStatus): string | undefined {
  const spawn = job.spawn_origin;
  if (!spawn) return undefined;
  if (spawn.kind === 'specialist.job') {
    const parent = spawn.parent_job_id.slice(0, 8);
    return `spawned-by specialist.job ${parent}`;
  }
  if (spawn.kind === 'xtmux.agent_instance') {
    const ro = spawn.runtime_origin;
    const host = ro.host_id.replace(/^host-/, '').slice(0, 8);
    const paneRef = `${ro.tmux_session_id}:${ro.tmux_pane_id}`;
    const agent = ro.agent_instance_id ? ` / agent ${ro.agent_instance_id.slice(0, 8)}` : '';
    return `spawned-by host-${host} / ${paneRef}${agent}`;
  }
  return undefined;
}

function renderInspectJson(job: SupervisorStatus & { is_dead: boolean; recovered_from_events?: boolean }): void {
  console.log(JSON.stringify({
    job: {
      id: job.id,
      specialist: job.specialist,
      status: job.status,
      model: job.model ?? null,
      backend: job.backend ?? null,
      bead_id: job.bead_id ?? null,
      chain_kind: job.chain_kind ?? null,
      chain_id: job.chain_id ?? null,
      started_at_ms: job.started_at_ms,
      elapsed_s: job.elapsed_s ?? null,
      metrics: job.metrics ?? null,
      recovered_from_events: Boolean(job.recovered_from_events),
      // xtmux runtime origin (spec §13.7). Absent when the job has no binding —
      // shape stays additive so consumers reading legacy rows are unaffected.
      ...(job.spawn_origin ? { spawn_origin: job.spawn_origin } : {}),
      ...(job.parent_job_id ? { parent_job_id: job.parent_job_id } : {}),
      ...(job.root_runtime_origin ? { root_runtime_origin: job.root_runtime_origin } : {}),
    },
  }, null, 2));
}

function renderInspect(jobId: string, args: PsArgs): void {
  const statuses = withPidLiveness(loadStatuses());
  const epicReadiness = resolveEpicReadinessMap(statuses, false);
  const statusJob = statuses.find((s) => s.id.startsWith(jobId));
  const fallbackJob = statusJob ? null : synthesizeStatusFromEvents(jobId);
  const job = statusJob ?? (fallbackJob ? { ...fallbackJob, is_dead: false, recovered_from_events: true } : null);
  if (!job) {
    if (args.json) {
      console.log(JSON.stringify({ error: `Job not found: ${jobId}` }, null, 2));
    } else {
      console.error(`Job not found: ${jobId}`);
    }
    process.exitCode = 1;
    return;
  }

  if (args.json) {
    renderInspectJson(job);
    return;
  }

  const beadTitles = buildBeadTitleCache([job]);
  const beadTitle = job.bead_id ? beadTitles.get(job.bead_id) : undefined;
  const ctx = job.context_pct !== undefined ? `${Math.round(job.context_pct)}% ${job.context_health ?? ''}` : '--';
  const deadLabel = job.is_dead ? ` ${red('dead')}` : '';

  // Find chain via worktree_owner_job_id
  const chainJobs = job.worktree_owner_job_id
    ? statuses.filter((s) => s.worktree_owner_job_id === job.worktree_owner_job_id).sort((a, b) => a.started_at_ms - b.started_at_ms)
    : [job];
  const chainStr = chainJobs.map((j) => j.id === job.id ? bold(j.id) : dim(j.id)).join(' → ');

  console.log(`\n${job.id}  ${job.specialist}  ${getStatusIcon(toJobNode(job))} ${statusLabel(job.status)}  ${ctx}${deadLabel}`);
  if (job.epic_id) {
    const readiness = epicReadiness.get(job.epic_id);
    const readinessSuffix = readiness ? ` · ${readiness.readiness_state} (${readiness.persisted_state})` : '';
    console.log(`  epic      ${job.epic_id}${readinessSuffix}`);
  }
  console.log(`  model     ${job.model ?? '--'} ${job.backend ? `(${job.backend})` : ''}`);
  if (job.bead_id) console.log(`  bead      ${job.bead_id}${beadTitle ? ` — ${beadTitle}` : ''}`);
  if (job.worktree_path || job.branch) {
    const wt = job.worktree_path ? dim(` ${job.worktree_path}`) : '';
    console.log(`  worktree  ${job.branch ?? 'master'}${wt}`);
  }
  const chainRole = job.chain_kind === 'chain' ? 'chain' : 'prep';
  const chainIdentity = job.chain_kind === 'chain' ? (job.chain_id ?? job.worktree_owner_job_id ?? '--') : '--';
  console.log(`  role      ${chainRole}`);
  console.log(`  chain_id  ${chainIdentity}`);
  const spawnedByLine = formatSpawnedByLine(job);
  if (spawnedByLine) console.log(`  ${spawnedByLine}`);
  if (chainJobs.length > 1) console.log(`  chain     ${chainStr}`);
  console.log(`  elapsed   ${formatElapsed(job.elapsed_s)}${job.metrics ? ` · ${job.metrics.turns ?? 0} turns · ${job.metrics.tool_calls ?? 0} tools` : ''}`);
  const tokenUsage = job.metrics?.token_usage;
  const tokenSummaryParts = formatTokenUsageSummary(tokenUsage);
  if (tokenSummaryParts.length > 0) {
    console.log(`  tokens    ${tokenSummaryParts.join(' · ')}`);
  }
  console.log(`  context   ${ctx}`);
  if (job.current_tool) console.log(`  current   ${job.current_tool}`);
  const inspectActions: string[] = [];
  if (job.status === 'running' || job.status === 'starting') inspectActions.push(`feed -f ${job.id}`);
  if (job.status === 'waiting') inspectActions.push(`resume ${job.id} "..."`);
  if (job.status === 'running') inspectActions.push(`steer ${job.id} "..."`);
  if (job.tmux_session) inspectActions.push(`attach ${job.id}`);
  if (job.status === 'done' || job.status === 'error') inspectActions.push(`result ${job.id}`);
  if (job.is_dead) inspectActions.push('clean --zombies');
  console.log(`\n  ${dim(inspectActions.join(' | '))}`);
}

function renderJson(
  jobs: Array<SupervisorStatus & { is_dead: boolean }>,
  nodes: NodeTree[],
  trees: WorktreeTree[],
  _all: boolean,
  epicReadiness: EpicReadinessMap,
  args: PsArgs,
  health: ProcessHealthReport,
  nativeActivations: NativeActivationSummary[] = [],
): void {
  console.log(JSON.stringify({
    generated_at_ms: Date.now(),
    include_terminal: args.includeTerminal,
    counts: {
      jobs: jobs.length,
      nodes: nodes.length,
      trees: trees.length,
    },
    flat: jobs.map((job) => ({
      id: job.id,
      specialist: job.specialist,
      status: job.status,
      pid: job.pid,
      is_dead: job.is_dead,
      bead_id: job.bead_id,
      bead_title: (job as SupervisorStatus & { bead_title?: string }).bead_title,
      node_id: job.node_id,
      worktree_owner_job_id: job.worktree_owner_job_id,
      reused_from_job_id: job.reused_from_job_id,
      worktree_path: job.worktree_path,
      branch: job.branch,
      epic_id: job.epic_id,
      chain_kind: job.chain_kind,
      chain_id: job.chain_id,
      chain_root_job_id: job.chain_root_job_id,
      chain_root_bead_id: job.chain_root_bead_id,
      started_at_ms: job.started_at_ms,
      elapsed_s: job.elapsed_s,
      context_pct: job.context_pct,
      context_health: job.context_health,
      startup_payload_json: job.startup_payload_json ?? null,
      payload_kb: formatPayloadStats(job.startup_payload_json).payload_kb,
      payload_tokens: formatPayloadStats(job.startup_payload_json).payload_tokens,
      attention_reasons: [
        ...(job.pr_classification && job.pr_classification !== 'clean' ? [`pr_drift:${job.pr_classification}`] : []),
      ],
      ...(job.spawn_origin ? { spawn_origin: job.spawn_origin } : {}),
      ...(job.parent_job_id ? { parent_job_id: job.parent_job_id } : {}),
      ...(job.root_runtime_origin ? { root_runtime_origin: job.root_runtime_origin } : {}),
    })),
    nodes,
    trees,
    native_activations: nativeActivations.map((summary) => ({ ...summary, last_known: true as const, live: false as const })),
    native_activations_note: 'LAST-KNOWN state from forensics, not live registry state.',
    epics: buildEpicGroups(jobs, epicReadiness),
    epic_readiness: Object.fromEntries([...epicReadiness.entries()].map(([epicId, summary]) => [epicId, summary])),
    process_health: health,
  }, null, 2));
}

function dedupeStatusesById(statuses: Array<SupervisorStatus & { is_dead: boolean }>): Array<SupervisorStatus & { is_dead: boolean }> {
  const byId = new Map<string, SupervisorStatus & { is_dead: boolean }>();

  for (const status of statuses) {
    const existing = byId.get(status.id);
    if (!existing) {
      byId.set(status.id, status);
      continue;
    }

    const shouldReplace = status.started_at_ms >= existing.started_at_ms;
    if (shouldReplace) byId.set(status.id, status);
  }

  return [...byId.values()].sort((a, b) => b.started_at_ms - a.started_at_ms);
}

function render(args: PsArgs): void {
  const statusesWithLiveness = dedupeStatusesById(withPidLiveness(loadStatuses()));
  const epicReadiness = resolveEpicReadinessMap(statusesWithLiveness, args.includeTerminal);

  const mineBeadIds = args.mine ? loadBeadIdsForCurrentUser() : undefined;

  const visibleStatuses = statusesWithLiveness.filter((job) => {
    const readiness = job.epic_id ? epicReadiness.get(job.epic_id) : undefined;
    const readinessState = readiness?.readiness_state;

    // Explicit filters: applied before the default visibility heuristics so
    // they win over --all and the epic-grouping fallback at the bottom.
    if (args.nodeId && job.node_id !== args.nodeId) return false;
    if (args.beadFilter && job.bead_id !== args.beadFilter) return false;
    if (args.sinceMs !== undefined && job.started_at_ms < args.sinceMs) return false;
    if (args.running && !ACTIVE_STATES.includes(job.status)) return false;
    if (mineBeadIds && (!job.bead_id || !mineBeadIds.has(job.bead_id))) return false;
    if (args.needsAttention && (!job.pr_classification || job.pr_classification === 'clean')) return false;

    const cleaned = isPsCleaned(job);

    if (args.all) return true;
    if (cleaned && !args.includeCleaned) return false;
    if (cleaned && args.includeCleaned && TERMINAL_STATES.includes(job.status)) return true;
    if (job.is_dead) return true;
    if (ACTIVE_STATES.includes(job.status)) return true;
    if (args.active) return false;
    if (args.includeTerminal && TERMINAL_STATES.includes(job.status)) return true;
    return isDefaultActionableTerminal(job);
  });

  const nodes = groupByNode(visibleStatuses);
  const trees = groupByTree(visibleStatuses);
  const health = collectProcessHealth();
  const nativeActivations = loadNativeActivationSummaries(args, mineBeadIds);

  if (args.json) {
    renderJson(visibleStatuses, nodes, trees, args.all, epicReadiness, args, health, nativeActivations);
    return;
  }

  renderHuman(visibleStatuses, nodes, trees, args.all, args.includeTerminal, epicReadiness, health, args.health, nativeActivations);
}

function renderBuffered(args: PsArgs): string {
  const lines: string[] = [];
  const origLog = console.log;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  console.log = (...logArgs: any[]) => lines.push(logArgs.map(String).join(' '));
  try {
    render(args);
  } finally {
    console.log = origLog;
  }
  return lines.join('\n');
}

const ANSI_ENTER_ALT_SCREEN = '\x1B[?1049h';
const ANSI_EXIT_ALT_SCREEN = '\x1B[?1049l';
const ANSI_HIDE_CURSOR = '\x1B[?25l';
const ANSI_SHOW_CURSOR = '\x1B[?25h';
const ANSI_CURSOR_HOME = '\x1B[H';
const ANSI_ERASE_DOWN = '\x1B[J';
const ANSI_ESCAPE_SEQUENCE_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;

function stripAnsiEscapeSequences(text: string): string {
  return text.replace(ANSI_ESCAPE_SEQUENCE_PATTERN, '');
}

async function follow(args: PsArgs): Promise<void> {
  const isTTY = Boolean(process.stdout.isTTY);
  let lastFrame = '';
  let interval: ReturnType<typeof setInterval> | undefined;
  let cleanedUp = false;

  const write = (text: string): void => {
    process.stdout.write(text);
  };

  const enterFollowMode = (): void => {
    if (!isTTY) return;
    write(ANSI_ENTER_ALT_SCREEN);
    write(ANSI_HIDE_CURSOR);
  };

  const exitFollowMode = (): void => {
    if (!isTTY || cleanedUp) return;
    cleanedUp = true;
    write(ANSI_SHOW_CURSOR);
    write(ANSI_EXIT_ALT_SCREEN);
  };

  const drawFrame = (): void => {
    const frame = renderBuffered(args);
    if (frame === lastFrame) return;
    lastFrame = frame;

    if (!isTTY) {
      write(`${stripAnsiEscapeSequences(frame)}\n\n`);
      return;
    }

    write(`${ANSI_CURSOR_HOME}${ANSI_ERASE_DOWN}${frame}\n`);
  };

  const cleanup = (exitCode?: number): void => {
    if (interval) clearInterval(interval);
    exitFollowMode();
    if (exitCode !== undefined) process.exit(exitCode);
  };

  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') {
      cleanup(0);
      return;
    }
    throw error;
  });
  process.once('SIGINT', () => cleanup(130));
  process.once('SIGTERM', () => cleanup(143));
  process.once('exit', () => cleanup());

  enterFollowMode();
  drawFrame();

  await new Promise<void>(() => {
    interval = setInterval(drawFrame, 1000);
  });
}

export async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(3));
  const sqliteClient = createObservabilitySqliteClient();
  try {
    const resolvedArgs: PsArgs = {
      ...args,
      nodeId: args.nodeId && sqliteClient ? resolveNodeRefWithClient(args.nodeId, sqliteClient) : args.nodeId,
    };

    if (resolvedArgs.inspectId) {
      renderInspect(resolvedArgs.inspectId, resolvedArgs);
      return;
    }
    if (resolvedArgs.follow) {
      await follow(resolvedArgs);
      return;
    }
    render(resolvedArgs);
  } finally {
    sqliteClient?.close();
  }
}
