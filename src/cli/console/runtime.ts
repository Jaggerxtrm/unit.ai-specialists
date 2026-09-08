import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { JobColorMap, bold, formatElapsed, formatEventLine, formatTokenUsageSummary, magenta } from '../format-helpers.js';
import { resolveObservabilityDbLocation } from '../../specialist/observability-db.js';
import { createObservabilitySqliteClient, createObservabilitySqliteClientAtPath, type ObservabilitySqliteClient } from '../../specialist/observability-sqlite.js';
import { resolveJobsDir } from '../../specialist/job-root.js';
import { stopJob as stopJobControl } from '../../specialist/control.js';
import { collectProcessHealth } from '../../specialist/process-health.js';
import { aggregateLiveSnapshot } from '../../specialist/live-aggregates.js';
import { isJobDead } from '../../specialist/supervisor.js';
import type { SupervisorStatus } from '../../specialist/supervisor.js';
import { compareTimelineEvents, parseTimelineEvent, type TimelineEvent } from '../../specialist/timeline-events.js';
import type {
  BeadDoc,
  BeadField,
  BeadSection,
  ConsoleJob,
  DiffFile,
  DiffSummary,
  FeedEventRow,
  FeedSource,
  JobInspect,
  JobResult,
  LiveStateRows,
  ProcessFilter,
  ProcessRow,
  ProcessSnapshot,
  RepoConfigRow,
  RepoConfigSnapshot,
  RepoRef,
  RuntimeClient,
  WorktreeRef,
} from './types.js';
import { BEAD_ID_RE } from './types.js';
import { timelineToForensicRow } from './forensic.js';
import {
  buildDiffSummary,
  HUNK_DISPLAY_CEILING,
  isValidGitRef,
  parseNumstat,
  parsePorcelainStatus,
  parseUnifiedDiff,
} from './git.js';
import { logError } from './log.js';
import {
  buildConsoleConfigTemplate,
  getConsoleConfigPath,
  readConsoleConfig,
  writeConsoleConfig,
  type ConsoleConfig,
  type ConsoleConfigRepoEntry,
} from './repo-config.js';
import { discoverRepos } from './repo-discovery.js';

const ACTIVE_STATES: ReadonlyArray<SupervisorStatus['status']> = ['starting', 'running', 'waiting'];
const TERMINAL_STATES: ReadonlyArray<SupervisorStatus['status']> = ['done', 'error', 'cancelled'];
const colorMap = new JobColorMap();

export function createRuntimeClient(cwd = process.cwd()): RuntimeClient {
  return new LocalRuntimeClient(cwd);
}

// Surfaces context from listRepos so the caller (ConsoleApp) can show a
// one-line "discovered N repos in ..." message after first-run. Optional;
// callers that don't need it just call listRepos().
export interface ListReposResult {
  repos: RepoRef[];
  message?: string;
}

class LocalRuntimeClient implements RuntimeClient {
  constructor(private readonly cwd: string) {}

  async listRepos(): Promise<RepoRef[]> {
    return (await this.listReposWithContext()).repos;
  }

  // Precedence chain (unitAI-29p39):
  //   1) SPECIALISTS_CONSOLE_REPOS env var (always wins)
  //   2) ~/.config/specialists/console.json (loaded if present)
  //   3) cwd-as-repo + parent-scan for siblings
  //   4) first-run auto-discovery across DEFAULT_BASE_DIR_CANDIDATES,
  //      persisted to console.json so subsequent runs are cheap
  async listReposWithContext(): Promise<ListReposResult> {
    const configured = parseConfiguredRepos();
    if (configured.length > 0) return { repos: configured };

    const persisted = readConsoleConfig();
    if (persisted && persisted.repos.length > 0) {
      const repos = persisted.repos
        .flatMap((entry) => {
          const ref = resolveRepoRef(entry.path, false, entry.name);
          return ref ? [ref] : [];
        });
      if (repos.length > 0) {
        markCurrent(repos, this.cwd);
        return { repos };
      }
    }

    // (3) cwd-as-repo + sibling scan via its parent dir.
    const cwdRepo = resolveRepoRef(this.cwd, true);
    if (cwdRepo) {
      const sibs = scanSiblingsForRepos(cwdRepo.path);
      const repos = sibs.length > 0
        ? mergeCurrentWithSiblings(cwdRepo, sibs)
        : [cwdRepo];
      return { repos };
    }

    // (4) first-run auto-discovery — write the result so future starts are
    //     cheap.
    const discovery = discoverRepos();
    if (discovery.repos.length > 0) {
      const nowIso = new Date().toISOString();
      try {
        writeConsoleConfig(buildConsoleConfigTemplate(discovery.repos, discovery.scannedBaseDirs, nowIso));
      } catch {
        // logged through logError inside writeConsoleConfig; never crash
        // the TUI on a config write failure.
      }
      const repos = discovery.repos
        .flatMap((entry) => {
          const ref = resolveRepoRef(entry.path, false, entry.name);
          return ref ? [ref] : [];
        });
      if (repos.length > 0) {
        markCurrent(repos, this.cwd);
        const baseStr = discovery.scannedBaseDirs.join(', ') || 'default base dirs';
        const message = `discovered ${repos.length} repo${repos.length === 1 ? '' : 's'} in ${baseStr} · saved to console.json`;
        return { repos, message };
      }
    }

    // Last resort: surface cwd as a placeholder so the TUI doesn't crash.
    return { repos: [{ id: 'cwd', name: basename(this.cwd), path: this.cwd, current: true }] };
  }

  // ── RepoConfigView (unitAI-hneld) ────────────────────────────────────────

  async readRepoConfigSnapshot(cwd: string = this.cwd): Promise<RepoConfigSnapshot> {
    return buildRepoConfigSnapshot(cwd);
  }

  async addRepoConfigEntry(entry: { name: string; path: string }): Promise<{ ok: boolean; error?: string; snapshot?: RepoConfigSnapshot }> {
    const validation = validateRepoEntry(entry);
    if (!validation.ok) return validation;
    const current = readConsoleConfig() ?? buildConsoleConfigTemplate([], [], new Date().toISOString());
    // Reject dup-by-name and dup-by-path.
    const normPath = entry.path.replace(/[\\/]+$/, '');
    const exists = current.repos.some((r) => r.name === entry.name || r.path.replace(/[\\/]+$/, '') === normPath);
    if (exists) return { ok: false, error: `repo already configured: ${entry.name}` };
    const next: ConsoleConfig = {
      ...current,
      repos: sortByName([...current.repos, { name: entry.name, path: entry.path }]),
    };
    try {
      writeConsoleConfig(next);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true, snapshot: buildRepoConfigSnapshot(this.cwd) };
  }

  async removeRepoConfigEntry(name: string): Promise<{ ok: boolean; error?: string; snapshot?: RepoConfigSnapshot }> {
    const current = readConsoleConfig();
    if (!current) return { ok: false, error: 'no console.json to edit' };
    const filtered = current.repos.filter((r) => r.name !== name);
    if (filtered.length === current.repos.length) return { ok: false, error: `repo not configured: ${name}` };
    try {
      writeConsoleConfig({ ...current, repos: filtered });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true, snapshot: buildRepoConfigSnapshot(this.cwd) };
  }

  async editRepoConfigEntry(name: string, field: 'name' | 'path', value: string): Promise<{ ok: boolean; error?: string; snapshot?: RepoConfigSnapshot }> {
    const current = readConsoleConfig();
    if (!current) return { ok: false, error: 'no console.json to edit' };
    const idx = current.repos.findIndex((r) => r.name === name);
    if (idx < 0) return { ok: false, error: `repo not configured: ${name}` };
    const updated: ConsoleConfigRepoEntry = field === 'name'
      ? { ...current.repos[idx]!, name: value }
      : { ...current.repos[idx]!, path: value };
    const validation = validateRepoEntry(updated);
    if (!validation.ok) return validation;
    // Reject name collision with an existing OTHER entry.
    if (field === 'name' && current.repos.some((r, i) => i !== idx && r.name === value)) {
      return { ok: false, error: `name already in use: ${value}` };
    }
    const repos = sortByName(current.repos.map((r, i) => (i === idx ? updated : r)));
    try {
      writeConsoleConfig({ ...current, repos });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true, snapshot: buildRepoConfigSnapshot(this.cwd) };
  }

  async rescanRepoConfig(): Promise<{ ok: boolean; error?: string; snapshot?: RepoConfigSnapshot; discoveredCount?: number }> {
    const current = readConsoleConfig() ?? buildConsoleConfigTemplate([], [], new Date().toISOString());
    const discovery = discoverRepos();
    // Merge discovery into existing repos — dedup by absolute path.
    const byPath = new Map<string, ConsoleConfigRepoEntry>();
    for (const r of current.repos) byPath.set(r.path.replace(/[\\/]+$/, ''), r);
    let added = 0;
    for (const found of discovery.repos) {
      const key = found.path.replace(/[\\/]+$/, '');
      if (!byPath.has(key)) {
        byPath.set(key, found);
        added += 1;
      }
    }
    const next: ConsoleConfig = {
      ...current,
      base_dirs: discovery.scannedBaseDirs.length > 0 ? discovery.scannedBaseDirs : current.base_dirs,
      repos: sortByName([...byPath.values()]),
      auto_discovered_at: new Date().toISOString(),
    };
    try {
      writeConsoleConfig(next);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true, snapshot: buildRepoConfigSnapshot(this.cwd), discoveredCount: added };
  }

  async stopJob(repo: RepoRef, jobId: string): Promise<void> {
    const jobsDir = resolveJobsDir(repo.path);
    await stopJobControl(jobId, { jobsDir });
  }

  async listProcessSnapshot(repo: RepoRef, filter: ProcessFilter): Promise<ProcessSnapshot> {
    const raw = readStatuses(repo).map(enrichJob);
    // Filter malformed rows (id/specialist/status undefined) before any
    // downstream use. Without this, render() crashes on the first bad row.
    // (unitAI-ctb4u.27)
    const statuses = raw.filter(isWellFormedJob);
    const visible = statuses.filter((job) => isVisible(job, filter));
    const filtered = applyTextFilter(visible, filter.textFilter);
    const rows = buildRows(filtered, filter.historyMode);
    const health = safeCollectHealth();

    const live = aggregateLiveSnapshot(filtered, {
      nowMs: Date.now(),
      isDead: (s) => Boolean((s as ConsoleJob).is_dead),
    });

    return {
      generatedAtMs: live.generatedAtMs,
      repo,
      filter,
      rows,
      jobs: filtered,
      totalJobs: statuses.length,
      visibleJobs: filtered.length,
      runningJobs: live.counts.running,
      waitingJobs: live.counts.waiting,
      epics: live.containers.epics,
      nodes: live.containers.nodes,
      worktrees: live.containers.worktrees,
      maxContextPct: live.context.ctxMaxPct,
      totalTokens: live.tokens.totalTokens,
      health,
    };
  }

  async readFeed(args: { repo: RepoRef; jobId: string; fromSeq?: number; limit?: number; source?: FeedSource }): Promise<FeedEventRow[]> {
    const job = resolveJob(args.repo, args.jobId);
    if (!job) return [];
    const source: FeedSource = args.source ?? 'forensic';
    const raw = readEvents(args.repo, job.id)
      .filter((event) => typeof args.fromSeq !== 'number' || (event.seq ?? -1) >= args.fromSeq)
      .sort(compareTimelineEvents);

    if (source === 'forensic') {
      const limited = raw.slice(-Math.max(1, args.limit ?? 200));
      const ctx = {
        jobId: job.id,
        specialist: job.specialist,
        beadId: job.bead_id,
        nodeId: job.node_id,
        backend: job.backend,
        model: job.model,
        chainKind: job.chain_kind,
        chainId: job.chain_id,
        chainRootJobId: job.chain_root_job_id,
        chainRootBeadId: job.chain_root_bead_id,
        epicId: job.epic_id,
      };
      return limited.map((event, idx) => timelineToForensicRow(event, ctx, idx));
    }

    // legacy sp_feed path (human-formatted timeline rendering)
    const filtered = raw.filter(shouldRenderHumanEvent);
    const visibleEvents = dedupeHumanEvents(job.id, filtered);
    const limited = visibleEvents.slice(-Math.max(1, args.limit ?? 200));
    const colorize = colorMap.get(job.id);
    return limited.map((event) => ({
      jobId: job.id,
      specialist: job.specialist,
      beadId: job.bead_id,
      seq: event.seq,
      t: event.t,
      type: event.type,
      line: isWaitingStatusChangeEvent(event)
        ? formatWaitingBanner(job.id, job.specialist)
        : formatEventLine(event, {
          jobId: job.id,
          specialist: job.specialist,
          beadId: job.bead_id,
          nodeId: job.node_id,
          colorize,
        }),
    }));
  }

  async inspectJob(repo: RepoRef, jobIdPrefix: string): Promise<JobInspect> {
    const job = resolveJob(repo, jobIdPrefix);
    if (!job) throw new Error(`Job not found: ${jobIdPrefix}`);
    const tokenParts = formatTokenUsageSummary(job.metrics?.token_usage).filter((part) => !part.startsWith('cost='));
    const fields = [
      field('job', job.id),
      field('specialist', job.specialist),
      field('status', `${job.status}${job.is_dead ? ' dead' : ''}`),
      field('model', [job.model, job.backend ? `(${job.backend})` : ''].filter(Boolean).join(' ') || '--'),
      field('bead', [job.bead_id, job.bead_title ? `— ${job.bead_title}` : ''].filter(Boolean).join(' ') || '--'),
      field('epic', job.epic_id ?? '--'),
      field('node', job.node_id ?? '--'),
      field('worktree', [job.branch, job.worktree_path].filter(Boolean).join(' ') || '--'),
      field('role', job.chain_kind ?? '--'),
      field('chain_id', job.chain_id ?? job.worktree_owner_job_id ?? '--'),
      field('chain_root_job', job.chain_root_job_id ?? '--'),
      field('chain_root_bead', job.chain_root_bead_id ?? '--'),
      field('started', formatDateTime(job.started_at_ms)),
      field('elapsed', `${formatElapsed(job.elapsed_s ?? 0)} · ${job.metrics?.turns ?? 0} turns · ${job.metrics?.tool_calls ?? 0} tools`),
      field('tokens', tokenParts.join(' · ') || '--'),
      field('context', job.context_pct === undefined ? '--' : `${Math.round(job.context_pct)}% ${job.context_health ?? ''}`),
      field('current', job.current_tool ?? '--'),
      field('payload', `${job.payload_kb ?? '--'} · ${job.payload_tokens ?? '--'}`),
    ];

    return { job, fields, actions: actionsFor(job) };
  }

  async readResult(repo: RepoRef, jobIdPrefix: string): Promise<JobResult> {
    const job = resolveJob(repo, jobIdPrefix);
    if (!job) return { job: null, title: `result ${jobIdPrefix}`, output: '', footer: `Job not found: ${jobIdPrefix}` };

    const events = readEvents(repo, job.id);
    const output = readResultOutput(repo, job.id, events);
    const reason = job.error ?? deriveTerminalReason(events);
    const logHint = `feed/log replay: sp feed ${job.id} · sp log ${job.id} --limit 200`;

    if (job.status === 'running' || job.status === 'starting') {
      return {
        job,
        title: `${job.id} is ${job.status}`,
        output: output ?? 'No persisted result yet. Open feed for live timeline replay.',
        footer: output ? 'Showing last completed output while the job continues.' : `Use feed for live progress. ${logHint}`,
      };
    }

    if (job.status === 'waiting') {
      return {
        job,
        title: `${job.id} is waiting`,
        output: output ?? 'No persisted output yet.',
        footer: `Use: sp resume ${job.id} "..."`,
      };
    }

    if (job.status === 'error' || job.status === 'cancelled') {
      return {
        job,
        title: `${job.id} ${job.status}`,
        output: output ?? `${job.status}: ${reason ?? 'no persisted result'}`,
        footer: logHint,
        error: reason ?? undefined,
      };
    }

    return {
      job,
      title: `${job.id} result`,
      output: output ?? 'Result not found. Use feed/log replay for traceability.',
      footer: metricFooter(job),
    };
  }

  async linkedDetail(repo: RepoRef, jobIdPrefix: string): Promise<BeadDoc> {
    const job = resolveJob(repo, jobIdPrefix);
    const beadId = job?.bead_id;
    if (!beadId) {
      return { beadId: '', fields: [], sections: [], error: 'no linked bead' };
    }
    return fetchBeadDoc(beadId);
  }

  async readGlobalConfig(): Promise<import('./config-source.js').ConfigSnapshot> {
    const { readGlobalConfigSnapshot } = await import('./config-source.js');
    return readGlobalConfigSnapshot();
  }

  async writeGlobalConfig(
    rawObj: Record<string, unknown>,
    expectedMtimeMs?: number,
  ): Promise<import('./config-source.js').WriteOutcome> {
    const { writeGlobalConfigSafe } = await import('./config-source.js');
    return writeGlobalConfigSafe(rawObj, expectedMtimeMs);
  }

  async readRawGlobalConfig(): Promise<{ raw: Record<string, unknown>; mtimeMs?: number; exists: boolean }> {
    const { getGlobalUserConfigPath } = await import('../../specialist/global-config.js');
    const location = getGlobalUserConfigPath();
    if (!existsSync(location.path)) return { raw: {}, exists: false };
    try {
      const raw = JSON.parse(readFileSync(location.path, 'utf-8')) as Record<string, unknown>;
      const { statSync } = await import('node:fs');
      const mtimeMs = statSync(location.path).mtimeMs;
      return { raw, exists: true, mtimeMs };
    } catch {
      return { raw: {}, exists: true };
    }
  }

  async openConfigInEditor(): Promise<{ ok: boolean; errorClass?: string }> {
    const { getGlobalUserConfigPath } = await import('../../specialist/global-config.js');
    const location = getGlobalUserConfigPath();
    const editor = process.env.EDITOR?.trim() || process.env.VISUAL?.trim() || 'vi';
    try {
      const result = spawnSync(editor, [location.path], { stdio: 'inherit' });
      if (result.error) {
        return { ok: false, errorClass: (result.error as NodeJS.ErrnoException).code ?? 'editor_failed' };
      }
      if (result.status !== 0) return { ok: false, errorClass: `editor_exit_${result.status}` };
      return { ok: true };
    } catch (error) {
      return { ok: false, errorClass: (error as NodeJS.ErrnoException).code ?? 'editor_failed' };
    }
  }

  async resolveWorktree(repo: RepoRef, jobIdPrefix: string): Promise<WorktreeRef | null> {
    const job = resolveJob(repo, jobIdPrefix);
    if (!job) return null;
    const path = job.worktree_path;
    if (!path || !existsSync(path)) return null;
    const branch = job.branch;
    const base = resolveDiffBase(path, branch);
    return { path, branch, base };
  }

  async diffSummary(repo: RepoRef, jobIdPrefix: string): Promise<DiffSummary> {
    const worktree = await this.resolveWorktree(repo, jobIdPrefix);
    if (worktree) {
      if (!isValidGitRef(worktree.base)) {
        return { worktree, entries: [], error: `invalid base ref: ${worktree.base}`, source: 'worktree' };
      }
      try {
        const numstat = runGit(['diff', '--numstat', worktree.base], worktree.path, 'git_numstat');
        const porcelain = runGit(['status', '--porcelain=v1', '--untracked-files=all'], worktree.path, 'git_status');
        const entries = buildDiffSummary(parseNumstat(numstat), parsePorcelainStatus(porcelain));
        return { worktree, entries, source: 'worktree' };
      } catch (error) {
        return { worktree, entries: [], error: error instanceof Error ? error.message : String(error), source: 'worktree' };
      }
    }

    // Worktree gone — try the recorded auto-commit SHA fallback (unitAI-ctb4u.29).
    // executor + debugger record last_auto_commit_sha on each checkpoint, so
    // their work survives even when the worktree has been cleaned.
    const job = resolveJob(repo, jobIdPrefix);
    const commitSha = job?.last_auto_commit_sha;
    if (commitSha && isValidGitRef(commitSha)) {
      try {
        // `git show --numstat --format=` strips the commit header — we only
        // want the file change list.
        const numstat = runGit(['show', '--numstat', '--format=', commitSha], repo.path, 'git_show');
        const entries = buildDiffSummary(parseNumstat(numstat), new Map());
        return { worktree: null, entries, source: 'commit', commitSha };
      } catch (error) {
        return {
          worktree: null,
          entries: [],
          source: 'commit',
          commitSha,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return { worktree: null, entries: [], error: 'no worktree for this job' };
  }

  async diffFile(repo: RepoRef, jobIdPrefix: string, file: string): Promise<DiffFile> {
    const worktree = await this.resolveWorktree(repo, jobIdPrefix);
    if (worktree) {
      if (!isValidGitRef(worktree.base)) {
        return { path: file, binary: false, hunks: [], error: `invalid base ref: ${worktree.base}`, source: 'worktree' };
      }
      try {
        const raw = runGit(['diff', worktree.base, '--', file], worktree.path, 'git_diff');
        return buildDiffFileResult(file, raw, { source: 'worktree' });
      } catch (error) {
        return { path: file, binary: false, hunks: [], error: error instanceof Error ? error.message : String(error), source: 'worktree' };
      }
    }

    // SHA fallback for dead-worktree jobs (unitAI-ctb4u.29).
    const job = resolveJob(repo, jobIdPrefix);
    const commitSha = job?.last_auto_commit_sha;
    if (commitSha && isValidGitRef(commitSha)) {
      try {
        const raw = runGit(['show', '--format=', commitSha, '--', file], repo.path, 'git_show');
        return buildDiffFileResult(file, raw, { source: 'commit', commitSha });
      } catch (error) {
        return {
          path: file,
          binary: false,
          hunks: [],
          source: 'commit',
          commitSha,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return { path: file, binary: false, hunks: [], error: 'no worktree for this job' };
  }

  async liveStateFor(repo: RepoRef, jobIdPrefix: string): Promise<LiveStateRows> {
    const job = resolveJob(repo, jobIdPrefix);
    if (!job) return { rows: [], error: 'no live state — job terminated' };
    const rows = [
      kvRow('state', `${job.status}${job.is_dead ? ' dead' : ''}`),
      kvRow('role', job.chain_kind ?? '--'),
      kvRow('worktree', [job.branch, job.worktree_path].filter(Boolean).join(' ') || '--'),
      kvRow('owner', job.worktree_owner_job_id ?? job.chain_id ?? '--'),
      kvRow('ctx', job.context_pct === undefined ? '--' : `${Math.round(job.context_pct)}%${job.context_health ? ` ${job.context_health}` : ''}`),
      kvRow('deps', job.chain_root_bead_id ?? '--'),
      kvRow('current', job.current_tool ?? '--'),
    ];
    return { rows };
  }
}

function kvRow(key: string, value: string): { key: string; value: string } {
  return { key, value };
}

function resolveDiffBase(worktreePath: string, branch?: string): string {
  // Prefer merge-base against the repo's default branch.
  const candidates = ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master'];
  for (const ref of candidates) {
    const result = spawnSync('git', ['-C', worktreePath, 'merge-base', 'HEAD', ref], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    });
    if (result.status === 0 && result.stdout) return result.stdout.trim();
  }
  // Fall back to the branch's tracking ref if available.
  if (branch) {
    const result = spawnSync('git', ['-C', worktreePath, 'rev-parse', `${branch}@{u}`], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    });
    if (result.status === 0 && result.stdout) return result.stdout.trim();
  }
  // Last resort: parent of HEAD (a single-commit diff).
  const fallback = spawnSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD^'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 1500,
  });
  return fallback.status === 0 && fallback.stdout ? fallback.stdout.trim() : 'HEAD';
}

function buildDiffFileResult(
  file: string,
  raw: string,
  meta: { source: 'worktree' | 'commit'; commitSha?: string },
): DiffFile {
  const hunks = parseUnifiedDiff(raw);
  const totalLines = hunks.reduce((acc, h) => acc + h.lines.length, 0);
  const binary = /^Binary files /m.test(raw);
  if (binary) {
    return { path: file, binary: true, hunks: [], totalLines: 0, ...meta };
  }
  if (totalLines > HUNK_DISPLAY_CEILING) {
    const cap = HUNK_DISPLAY_CEILING;
    let remaining = cap;
    const trimmed: typeof hunks = [];
    for (const h of hunks) {
      if (remaining <= 0) break;
      const slice = h.lines.slice(0, remaining);
      remaining -= slice.length;
      trimmed.push({ header: h.header, lines: slice });
    }
    return { path: file, binary: false, hunks: trimmed, truncated: true, totalLines, ...meta };
  }
  return { path: file, binary: false, hunks, totalLines, ...meta };
}

function runGit(args: string[], cwd: string, op: 'git_numstat' | 'git_status' | 'git_diff' | 'git_show'): string {
  const started = Date.now();
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  if (result.error || result.status !== 0) {
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    const errorClass = code ?? (result.signal ? `signal:${result.signal}` : `exit:${result.status}`);
    // diff view owns every runGit callsite (diffSummary numstat/status,
    // diffFile diff). Route through the single-sink dedupe in log.ts so
    // burst failures collapse to one envelope per errorClass.
    logError('diff', op, {
      exitCode: result.status,
      durationMs,
      errorClass: String(errorClass),
    });
    throw new Error(`git ${op} failed (${errorClass})`);
  }
  return result.stdout ?? '';
}

const BEAD_DOC_CACHE = new Map<string, { doc: BeadDoc; at: number }>();
const BEAD_DOC_TTL_MS = 3000;

function fetchBeadDoc(beadId: string): BeadDoc {
  if (!BEAD_ID_RE.test(beadId)) {
    logBeadShowError(beadId, -1, 0, 'invalid_bead_id');
    return { beadId, fields: [], sections: [], error: `invalid bead id: ${beadId}` };
  }

  const now = Date.now();
  const cached = BEAD_DOC_CACHE.get(beadId);
  if (cached && now - cached.at < BEAD_DOC_TTL_MS) return cached.doc;

  const started = now;
  const result = spawnSync('bd', ['show', beadId, '--json'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 3000,
  });
  const durationMs = Date.now() - started;

  if (result.error || result.status !== 0 || !result.stdout) {
    const errCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    const errorClass = errCode ?? (result.signal ? `signal:${result.signal}` : `exit:${result.status}`);
    logBeadShowError(beadId, result.status ?? -1, durationMs, String(errorClass));
    const doc: BeadDoc = { beadId, fields: [], sections: [], error: `bd show failed: ${errorClass}` };
    BEAD_DOC_CACHE.set(beadId, { doc, at: now });
    return doc;
  }

  try {
    const doc = parseBdShowJson(beadId, result.stdout);
    BEAD_DOC_CACHE.set(beadId, { doc, at: now });
    return doc;
  } catch (error) {
    logBeadShowError(beadId, result.status ?? 0, durationMs, 'parse_error');
    const doc: BeadDoc = {
      beadId,
      fields: [],
      sections: [],
      error: `bd show parse error: ${error instanceof Error ? error.message : String(error)}`,
    };
    BEAD_DOC_CACHE.set(beadId, { doc, at: now });
    return doc;
  }
}

function logBeadShowError(beadId: string, exitCode: number, durationMs: number, errorClass: string): void {
  // bd_show is the BeadView surface. Single-sink dedupe via log.ts caps
  // burst stderr to one envelope per errorClass; log.ts also enforces
  // the 24-char beadId cap (BEAD_ID_MAX) so we don't repeat it here.
  logError('bead', 'bd_show', { exitCode, durationMs, errorClass, beadId });
}

export function parseBdShowJson(beadId: string, stdout: string): BeadDoc {
  const parsed = JSON.parse(stdout) as unknown;
  const payload = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | null;
  if (!payload || typeof payload !== 'object') {
    return { beadId, fields: [], sections: [], error: 'empty bd show payload' };
  }

  const issue = (payload.issue && typeof payload.issue === 'object' ? payload.issue : payload) as Record<string, unknown>;
  const fields: BeadField[] = [];
  const push = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    if (!str || str === 'null') return;
    fields.push({ key, value: str.replace(/\s+/g, ' ').trim() });
  };
  push('issue', issue.id ?? payload.id);
  push('title', issue.title ?? payload.title);
  push('type', issue.type ?? payload.type);
  push('priority', issue.priority ?? payload.priority);
  push('status', issue.status ?? payload.status);
  push('assignee', issue.assignee ?? payload.assignee);
  push('owner', issue.owner ?? payload.owner);
  push('parent', issue.parent ?? payload.parent);
  push('epic', issue.epic_id ?? payload.epic_id);
  push('created', issue.created ?? issue.created_at ?? payload.created_at);
  push('updated', issue.updated ?? issue.updated_at ?? payload.updated_at);

  const description = typeof issue.description === 'string'
    ? issue.description
    : typeof payload.description === 'string'
      ? payload.description
      : '';
  const notes = typeof issue.notes === 'string'
    ? issue.notes
    : typeof payload.notes === 'string'
      ? payload.notes
      : '';
  const design = typeof issue.design === 'string'
    ? issue.design
    : typeof payload.design === 'string'
      ? payload.design
      : '';
  const acceptance = typeof issue.acceptance === 'string'
    ? issue.acceptance
    : typeof payload.acceptance === 'string'
      ? payload.acceptance
      : '';

  const sections: BeadSection[] = [];
  if (description.trim()) sections.push({ title: 'description', body: description.trim() });
  if (design.trim()) sections.push({ title: 'design', body: design.trim() });
  if (acceptance.trim()) sections.push({ title: 'acceptance', body: acceptance.trim() });
  if (notes.trim()) sections.push({ title: 'notes', body: notes.trim() });

  return { beadId, fields, sections };
}

// Scan the immediate parent of a known repo root for sibling repos that
// also have a `.specialists/db/observability.db`. Only one level up,
// dotdirs skipped. Cheap by design — used as the auto-multi-repo path
// when cwd is INSIDE a git root but no console.json has been written yet.
function scanSiblingsForRepos(repoRoot: string): RepoRef[] {
  const parent = dirname(repoRoot);
  if (parent === repoRoot) return []; // at filesystem root
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return [];
  }
  const repos: RepoRef[] = [];
  const seen = new Set<string>([repoRoot]);
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const root = join(parent, entry);
    if (seen.has(root)) continue;
    try {
      if (!statSync(root).isDirectory()) continue;
    } catch {
      continue;
    }
    const ref = resolveRepoRef(root, false);
    if (ref) {
      seen.add(root);
      repos.push(ref);
    }
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name));
}

// Mark the repo whose path the operator is currently inside as `current`.
// Used when loading from console.json: console.json stores repos sorted
// alphabetically, but the operator expects the tab matching their cwd to
// be the active one on startup. Falls back to repos[0] when cwd is
// outside all configured repos.
function markCurrent(repos: RepoRef[], cwd: string): void {
  // Normalize cwd + repo paths to never end with `/` so prefix checks are
  // unambiguous (resolveRepoRef sometimes returns paths with a trailing
  // separator depending on git resolution).
  const normCwd = cwd.replace(/[\\/]+$/, '');
  let matchIndex = -1;
  let matchLen = -1;
  for (let i = 0; i < repos.length; i += 1) {
    const normRepo = repos[i]!.path.replace(/[\\/]+$/, '');
    if (normCwd === normRepo
      || normCwd.startsWith(`${normRepo}/`)
      || normCwd.startsWith(`${normRepo}\\`)) {
      // Prefer the longest-prefix match (deepest repo) when paths nest.
      if (normRepo.length > matchLen) {
        matchIndex = i;
        matchLen = normRepo.length;
      }
    }
  }
  const chosen = matchIndex >= 0 ? matchIndex : 0;
  for (let i = 0; i < repos.length; i += 1) {
    repos[i]!.current = i === chosen;
  }
}

// Place the operator's current repo at index 0 (carries current:true)
// followed by deduped siblings sorted by name.
function mergeCurrentWithSiblings(current: RepoRef, siblings: RepoRef[]): RepoRef[] {
  const ordered: RepoRef[] = [current];
  for (const sib of siblings) {
    if (sib.path !== current.path) ordered.push(sib);
  }
  return ordered;
}

function sortByName<T extends { name: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.name.localeCompare(b.name));
}

function validateRepoEntry(entry: { name: string; path: string }): { ok: boolean; error?: string } {
  const name = entry.name.trim();
  const path = entry.path.trim();
  if (!name) return { ok: false, error: 'name required' };
  if (!path) return { ok: false, error: 'path required' };
  // path-traversal hygiene — every other write path uses absolute paths.
  if (!path.startsWith('/') && !path.startsWith('~')) {
    return { ok: false, error: 'path must be absolute or start with ~' };
  }
  return { ok: true };
}

function buildRepoConfigSnapshot(cwd: string): RepoConfigSnapshot {
  const location = getConsoleConfigPath();
  const config = readConsoleConfig();
  if (!config) {
    return {
      rows: [],
      baseDirs: [],
      configPath: displayablePath(location.path),
      configExists: false,
    };
  }
  // Mark `current` so the operator sees which configured repo their cwd
  // maps onto (mirrors markCurrent's longest-prefix logic but operates on
  // ConsoleConfigRepoEntry, not RepoRef).
  const normCwd = cwd.replace(/[\\/]+$/, '');
  let currentIdx = -1;
  let currentLen = -1;
  config.repos.forEach((repo, i) => {
    const normRepo = repo.path.replace(/[\\/]+$/, '');
    if (normCwd === normRepo || normCwd.startsWith(`${normRepo}/`)) {
      if (normRepo.length > currentLen) {
        currentIdx = i;
        currentLen = normRepo.length;
      }
    }
  });
  const rows: RepoConfigRow[] = config.repos.map((entry, i) =>
    buildRepoConfigRow(entry, i === currentIdx),
  );
  return {
    rows,
    baseDirs: config.base_dirs,
    autoDiscoveredAt: config.auto_discovered_at,
    configPath: displayablePath(location.path),
    configExists: true,
  };
}

function buildRepoConfigRow(entry: ConsoleConfigRepoEntry, current: boolean): RepoConfigRow {
  // Disk + DB existence checks are cheap (statSync) — RepoConfigView is
  // refreshed on open/edit/rescan, not on every tick.
  let exists = false;
  try {
    exists = statSync(entry.path).isDirectory();
  } catch {
    exists = false;
  }
  let dbExists = false;
  let dbSizeBytes = 0;
  let lastActivityMs: number | undefined;
  let runningJobs = 0;
  let waitingJobs = 0;
  if (exists) {
    try {
      const location = resolveObservabilityDbLocation(entry.path);
      if (existsSync(location.dbPath)) {
        const st = statSync(location.dbPath);
        dbExists = true;
        dbSizeBytes = st.size;
        const client = createObservabilitySqliteClientAtPath(location.dbPath);
        if (client) {
          try {
            const statuses = client.listStatuses();
            for (const s of statuses) {
              if (s.status === 'running' || s.status === 'starting') runningJobs += 1;
              else if (s.status === 'waiting') waitingJobs += 1;
              const last = s.last_event_at_ms ?? s.started_at_ms;
              if (typeof last === 'number'
                && Number.isFinite(last)
                && (lastActivityMs === undefined || last > lastActivityMs)) {
                lastActivityMs = last;
              }
            }
          } finally {
            client.close();
          }
        }
      }
    } catch {
      // Best-effort metrics — leave defaults on failure.
    }
  }
  return {
    name: entry.name,
    path: entry.path,
    exists,
    dbExists,
    dbSizeBytes,
    lastActivityMs,
    runningJobs,
    waitingJobs,
    current,
  };
}

function displayablePath(p: string): string {
  const home = process.env.HOME?.trim();
  if (home && p.startsWith(`${home}/`)) return `~/${p.slice(home.length + 1)}`;
  return p;
}

function parseConfiguredRepos(): RepoRef[] {
  const raw = process.env.SPECIALISTS_CONSOLE_REPOS?.trim();
  if (!raw) return [];
  return raw.split(',').map((entry, index) => {
    const [nameRaw, pathRaw] = entry.includes('=') ? entry.split('=', 2) : ['', entry];
    const path = (pathRaw ?? '').trim();
    const name = (nameRaw || basename(path)).trim();
    return path ? resolveRepoRef(path, index === 0, name) : null;
  }).filter((repo): repo is RepoRef => repo !== null);
}

function resolveRepoRef(path: string, current: boolean, nameOverride?: string): RepoRef | null {
  const location = resolveObservabilityDbLocation(path);
  const jobsDir = resolveJobsDir(path);
  if (!existsSync(location.dbPath) && !existsSync(jobsDir)) return null;
  const name = nameOverride ?? basename(location.gitRoot || path);
  return { id: name, name, path: location.gitRoot || path, dbPath: location.dbPath, current };
}

function openClient(repo: RepoRef): ObservabilitySqliteClient | null {
  if (repo.dbPath && existsSync(repo.dbPath)) return createObservabilitySqliteClientAtPath(repo.dbPath);
  return createObservabilitySqliteClient(repo.path);
}

function readStatuses(repo: RepoRef): SupervisorStatus[] {
  const client = openClient(repo);
  try {
    const sqlite = client?.listStatuses() ?? [];
    const files = readFileStatuses(resolveJobsDir(repo.path));
    const byId = new Map<string, SupervisorStatus>();
    for (const status of files) byId.set(status.id, status);
    for (const status of sqlite) {
      const current = byId.get(status.id);
      if (!current || status.started_at_ms >= current.started_at_ms) byId.set(status.id, status);
    }
    return [...byId.values()].sort((a, b) => b.started_at_ms - a.started_at_ms);
  } finally {
    client?.close();
  }
}

function readFileStatuses(jobsDir: string): SupervisorStatus[] {
  if (!existsSync(jobsDir)) return [];
  return readdirSync(jobsDir).flatMap((entry) => {
    const path = join(jobsDir, entry, 'status.json');
    if (!existsSync(path)) return [];
    try {
      return [JSON.parse(readFileSync(path, 'utf-8')) as SupervisorStatus];
    } catch {
      return [];
    }
  });
}

function readEvents(repo: RepoRef, jobId: string): TimelineEvent[] {
  const client = openClient(repo);
  try {
    const sqlite = client?.readEvents(jobId) ?? [];
    if (sqlite.length > 0) return sqlite.sort(compareTimelineEvents);
  } catch {
    // fallback below
  } finally {
    client?.close();
  }

  const eventsPath = join(resolveJobsDir(repo.path), jobId, 'events.jsonl');
  if (!existsSync(eventsPath)) return [];
  return readFileSync(eventsPath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseTimelineEvent(line))
    .filter((event): event is TimelineEvent => event !== null)
    .sort(compareTimelineEvents);
}

function readResultOutput(repo: RepoRef, jobId: string, events: TimelineEvent[]): string | null {
  const client = openClient(repo);
  try {
    const sqlite = client?.readResult(jobId) ?? null;
    if (sqlite) return sqlite;
  } catch {
    // fallback below
  } finally {
    client?.close();
  }

  const resultPath = join(resolveJobsDir(repo.path), jobId, 'result.txt');
  if (existsSync(resultPath)) return readFileSync(resultPath, 'utf-8');

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === 'run_complete' && typeof event.output === 'string' && event.output.length > 0) return event.output;
  }
  return null;
}

function resolveJob(repo: RepoRef, prefix: string): ConsoleJob | null {
  return readStatuses(repo).map(enrichJob).find((job) => job.id.startsWith(prefix)) ?? null;
}

function enrichJob(status: SupervisorStatus): ConsoleJob {
  const payload = formatPayloadStats(status.startup_payload_json);
  return {
    ...status,
    is_dead: isJobDead(status),
    bead_title: typeof (status as SupervisorStatus & { bead_title?: unknown }).bead_title === 'string'
      ? String((status as SupervisorStatus & { bead_title?: string }).bead_title).replace(/\s+/g, ' ').trim()
      : undefined,
    payload_kb: payload.payload_kb,
    payload_tokens: payload.payload_tokens,
    next_action: nextAction(status),
  };
}

// Production DBs can carry historical status_json rows where the top-level
// id is null (16 of 1389 observed on a 2026-06 dev box). Filter them out
// before they reach buildRows so the snapshot count stays honest and the
// theme-level defensive coercion is a last-line-of-defense, not the
// primary handler. (unitAI-ctb4u.27)
function isWellFormedJob(job: ConsoleJob): boolean {
  return typeof job.id === 'string' && job.id.length > 0
    && typeof job.specialist === 'string' && job.specialist.length > 0
    && typeof job.status === 'string' && job.status.length > 0;
}

function isVisible(job: ConsoleJob, filter: ProcessFilter): boolean {
  const cleaned = isPsCleaned(job);
  if (filter.historyMode === 'all') return true;
  if (cleaned && !filter.includeCleaned) return false;
  if (cleaned && filter.includeCleaned && TERMINAL_STATES.includes(job.status)) return true;
  if (job.is_dead) return false;
  if (ACTIVE_STATES.includes(job.status)) return true;
  // unitAI-ctb4u.26: align default mode with `sp ps` shell default — only
  // active jobs (starting/running/waiting). Terminal rows (error/cancelled/
  // done) appear when the operator presses `h` to widen historyMode to
  // 'history' or 'all'. This eliminates the "85 surplus terminal rows in
  // TUI default vs 0 jobs in `sp ps`" discrepancy reported in the v2
  // operator walkthrough §2.
  if (filter.historyMode === 'history' && TERMINAL_STATES.includes(job.status)) return true;
  return false;
}

function isPsCleaned(job: SupervisorStatus): boolean {
  const typed = job as SupervisorStatus & { ps_hidden_at?: number; ps_hidden_from_dashboard_at?: number };
  return Boolean(typed.ps_hidden_at ?? typed.ps_hidden_from_dashboard_at);
}

function applyTextFilter(jobs: ConsoleJob[], filter: string): ConsoleJob[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return jobs;
  return jobs.filter((job) => [
    job.id,
    job.specialist,
    job.status,
    job.bead_id,
    job.bead_title,
    job.node_id,
    job.epic_id,
    job.chain_id,
    job.branch,
    job.worktree_path,
  ].filter(Boolean).join(' ').toLowerCase().includes(needle));
}

function buildRows(jobs: ConsoleJob[], historyMode: ProcessFilter['historyMode']): ProcessRow[] {
  if (historyMode !== 'default') return buildChronologicalRows(jobs);

  const rows: ProcessRow[] = [];
  const rendered = new Set<string>();

  const addGroup = (id: string, label: string, depth: number): void => {
    rows.push({ kind: 'group', id, label, depth });
  };
  const addJobs = (groupJobs: ConsoleJob[], depth: number): void => {
    for (const job of groupJobs.sort(compareJobs)) {
      if (rendered.has(job.id)) continue;
      rendered.add(job.id);
      rows.push({ kind: 'job', id: job.id, job, depth });
    }
  };

  const epics = groupBy(jobs.filter((job) => job.epic_id), (job) => job.epic_id!);
  for (const [epicId, epicJobs] of [...epics.entries()].sort(sortGroupByNewest)) {
    addGroup(`epic:${epicId}`, `EPIC ${epicId}`, 0);
    const chains = groupBy(epicJobs, (job) => job.chain_id ?? job.worktree_owner_job_id ?? 'prep');
    for (const [chainId, chainJobs] of [...chains.entries()].sort(sortGroupByNewest)) {
      addGroup(`chain:${epicId}:${chainId}`, chainId === 'prep' ? 'Prep' : `Chain ${chainId}`, 1);
      addJobs(chainJobs, 2);
    }
  }

  const nodeJobs = jobs.filter((job) => !rendered.has(job.id) && job.node_id);
  for (const [nodeId, groupJobs] of [...groupBy(nodeJobs, (job) => job.node_id!).entries()].sort(sortGroupByNewest)) {
    addGroup(`node:${nodeId}`, `⬢ ${nodeId}`, 0);
    addJobs(groupJobs, 1);
  }

  const worktreeJobs = jobs.filter((job) => !rendered.has(job.id) && (job.worktree_owner_job_id || job.worktree_path || job.branch));
  for (const [treeId, groupJobs] of [...groupBy(worktreeJobs, (job) => job.worktree_owner_job_id ?? job.worktree_path ?? job.branch ?? 'worktree').entries()].sort(sortGroupByNewest)) {
    const representative = groupJobs[0];
    addGroup(`worktree:${treeId}`, representative?.branch ?? representative?.worktree_path ?? treeId, 0);
    addJobs(groupJobs, 1);
  }

  const standalone = jobs.filter((job) => !rendered.has(job.id));
  if (standalone.length > 0) {
    addGroup('standalone', 'Standalone', 0);
    addJobs(standalone, 1);
  }

  return rows;
}

export function buildChronologicalRows(jobs: ConsoleJob[]): ProcessRow[] {
  return [...jobs]
    .sort((a, b) => b.started_at_ms - a.started_at_ms || a.id.localeCompare(b.id))
    .map((job) => ({ kind: 'job' as const, id: job.id, job, depth: 0 }));
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

function sortGroupByNewest(a: [string, ConsoleJob[]], b: [string, ConsoleJob[]]): number {
  const newestA = Math.max(...a[1].map((job) => job.started_at_ms), 0);
  const newestB = Math.max(...b[1].map((job) => job.started_at_ms), 0);
  return newestB - newestA || a[0].localeCompare(b[0]);
}

function compareJobs(a: ConsoleJob, b: ConsoleJob): number {
  const priority = (job: ConsoleJob): number => job.status === 'waiting' ? 3 : job.status === 'running' ? 2 : job.status === 'starting' ? 1 : 0;
  return priority(b) - priority(a) || b.started_at_ms - a.started_at_ms || a.id.localeCompare(b.id);
}

function nextAction(job: SupervisorStatus): string {
  if (isJobDead(job)) return 'dead';
  if (job.status === 'running' || job.status === 'starting') return 'feed';
  if (job.status === 'waiting') return 'resume';
  if (job.status === 'done') return 'result';
  if (job.status === 'error') return 'result';
  if (job.status === 'cancelled') return 'feed';
  return '';
}

function formatPayloadStats(payloadJson: string | null | undefined): { payload_kb: string; payload_tokens: string } {
  if (!payloadJson) return { payload_kb: '--', payload_tokens: '--' };
  try {
    const payload = JSON.parse(payloadJson) as { totals?: { bytes?: number; tokens?: number } };
    const bytes = payload.totals?.bytes;
    const tokens = payload.totals?.tokens;
    if (!Number.isFinite(bytes) || !Number.isFinite(tokens)) return { payload_kb: '--', payload_tokens: '--' };
    return { payload_kb: `${((bytes ?? 0) / 1024).toFixed(1)}kb`, payload_tokens: `${Math.round(tokens ?? 0)}t` };
  } catch {
    return { payload_kb: '--', payload_tokens: '--' };
  }
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
    case 'compaction':
    case 'retry':
      return `${event.type}:${event.phase}`;
    default:
      return event.type;
  }
}

function shouldRenderHumanEvent(event: TimelineEvent): boolean {
  if (event.type === 'message' || event.type === 'turn') return false;
  if (event.type === 'tool') {
    if (event.phase === 'update') return false;
    if (event.phase === 'end' && !event.is_error) return false;
  }
  return true;
}

export function dedupeHumanEvents(jobId: string, events: TimelineEvent[]): TimelineEvent[] {
  const visible: TimelineEvent[] = [];
  const lastPrintedEventKey = new Map<string, string>();
  const seenMetaKey = new Map<string, string>();

  for (const event of events) {
    if (event.type === 'meta') {
      const metaKey = `${event.backend}:${event.model}`;
      if (seenMetaKey.get(jobId) === metaKey) continue;
      seenMetaKey.set(jobId, metaKey);
    }

    if (event.type !== 'tool') {
      const key = getHumanEventKey(event);
      if (lastPrintedEventKey.get(jobId) === key) continue;
      lastPrintedEventKey.set(jobId, key);
    }

    visible.push(event);
  }

  return visible;
}

function isWaitingStatusChangeEvent(event: TimelineEvent): boolean {
  return event.type === 'status_change' && event.status === 'waiting';
}

function formatWaitingBanner(jobId: string, specialist: string): string {
  return `${magenta(bold('WAIT'))} ${specialist} (${jobId}) is waiting for input. Use: specialists resume ${jobId} "..."`;
}

function field(label: string, value: string): { label: string; value: string } {
  return { label, value };
}

function actionsFor(job: ConsoleJob): string[] {
  const actions: string[] = [];
  if (job.status === 'running' || job.status === 'starting') actions.push(`feed -f ${job.id}`);
  if (job.status === 'waiting') actions.push(`resume ${job.id} "..."`);
  if (job.status === 'running') actions.push(`steer ${job.id} "..."`);
  if (job.status === 'done' || job.status === 'error') actions.push(`result ${job.id}`);
  if (job.is_dead) actions.push('clean --zombies');
  return actions;
}

function deriveTerminalReason(events: TimelineEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'run_complete') return event.error ?? event.exit_reason ?? event.status;
    if (event?.type === 'control_signal') return event.error_message ?? event.reason ?? event.action;
    if (event?.type === 'status_change') return `status ${event.previous_status ?? '?'} -> ${event.status}`;
  }
  return null;
}

function metricFooter(job: ConsoleJob): string {
  const tokenParts = formatTokenUsageSummary(job.metrics?.token_usage).filter((part) => !part.startsWith('cost='));
  return tokenParts.length > 0 ? `metrics: ${tokenParts.join(' · ')}` : 'done';
}

export function formatDateTime(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '--';
  const date = new Date(ms);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function safeCollectHealth() {
  try {
    return collectProcessHealth();
  } catch {
    return null;
  }
}
