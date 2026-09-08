import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from '@earendil-works/pi-tui';
import type { DiffFile, DiffSummary, RuntimeClient, ConsoleJob } from './types.js';
import { formatDateTime } from './runtime.js';
import {
  currentRepo,
  initialConsoleState,
  reduceConsoleState,
  selectedJobRow,
  visibleRepoConfigRows,
  visibleSlice,
  type ConsoleState,
} from './view-model.js';
import {
  fillerLine,
  paint,
  renderBeadBodyLine,
  renderBeadField,
  renderConfigField,
  renderConfigSpecialistRow,
  renderDiffHunkHeader,
  renderDiffHunkLine,
  renderDiffSummaryRow,
  renderFilterPrompt,
  renderGroupRow,
  renderHeader,
  renderInspectField,
  renderJobRow,
  renderKeyBar,
  renderMessage,
  renderMeters,
  renderPlaceholder,
  renderRepoConfigRow,
  renderRepoSectionHeader,
  renderResultFooter,
  renderResultTitle,
  renderSectionTitle,
  renderStatsLine,
  renderTabs,
  renderViewtag,
} from './theme.js';
import { applyFieldEdit, coerceFieldValue, formatConfigValue } from './config-source.js';
import { errorClassOf, logError, type ConsoleView as LogView } from './log.js';
import { snapshotDiff, snapshotHash } from '../../specialist/snapshot-diff.js';
import { SourceQueue } from '../../specialist/source-queue.js';

// Refresh cadence is owned by SourceQueue (unitAI-ctb4u.20). Each repo gets
// its own queue with the gitboard-imported COALESCE_MS=1500 default, so
// repo switching cancels the prior queue's pending dispatch without
// waiting for the in-flight run to finish.
const COALESCE_MS = 50; // ~20Hz dispatch cap (spec §10)
const TOP_CHROME_ROWS = 4; // tabs + meters + viewtag + header
const BOTTOM_CHROME_ROWS = 2; // stats + keys
const CHROME_ROWS = TOP_CHROME_ROWS + BOTTOM_CHROME_ROWS;
const VIEWS: readonly string[] = ['all', 'ps', 'feed', 'job', 'result', 'bead', 'diff', 'config', 'repoConfig'];

interface ConsoleAppOptions {
  runtime: RuntimeClient;
  requestRender: () => void;
  stop: () => void;
  rows: () => number;
}

export class ConsoleApp implements Component {
  private state: ConsoleState = initialConsoleState();
  // Per-repo poll queue. Replaces the prior single setInterval — each
  // repo gets its own coalesce window so tab-switching does not race a
  // stale poll on the prior repo (unitAI-ctb4u.20).
  private queues = new Map<string, SourceQueue>();
  private refreshInFlight = false;
  private disposed = false;
  private renderedDetailRows = 0;
  private lastWidth = 80;
  // Stable key-ordered SHA-256 over the prior snapshot. Used to drop
  // no-op dispatches that would force a re-render. See snapshotHash in
  // src/specialist/snapshot-diff.ts (unitAI-ctb4u.19).
  private lastSnapshotHash: string | undefined;
  // Prior snapshot's job list. Kept across polls so snapshotDiff can
  // compute per-row upsert/tombstone deltas for ProcessView delta
  // rendering (unitAI-ctb4u.21).
  private lastSnapshotJobs: ConsoleJob[] = [];
  // Per-row paint cache keyed by `${jobId}|${status}|${ctxBucket}|${width}|${depth}|${selected}`.
  // Hit means we can reuse the prior rendered string instead of calling
  // renderJobRow again. Cache clears on repo switch (cross-repo bleed
  // would be wrong) and is bounded to totalJobs * 2 to prevent unbounded
  // growth in long sessions (unitAI-ctb4u.21).
  private processRowCache = new Map<string, string>();
  private allSnapshots = new Map<string, import('./types.js').ProcessSnapshot>();
  private lastAllRefreshMs = 0;
  private allViewCursor = 0;
  private allViewRowMap: Array<{ repoId: string; jobId: string } | null> = [];
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeHandler: (() => void) | null = null;

  constructor(private readonly options: ConsoleAppOptions) {}

  async start(): Promise<void> {
    await this.loadRepos();
    await this.refresh();
    // First refresh ran inline; subsequent polls go through the per-repo
    // SourceQueue (unitAI-ctb4u.20). Schedule the next tick now so the
    // queue's internal coalesce timer pulls us back in COALESCE_MS.
    this.scheduleRefresh();
    this.resizeHandler = (): void => this.scheduleRender();
    try {
      process.stdout.on('resize', this.resizeHandler);
    } catch {
      // non-TTY contexts may throw — safe to ignore
    }
  }

  stop(): void {
    this.disposed = true;
    // Cancel pending coalesce timers on every per-repo queue. In-flight
    // runs still drain to completion — the running flag protects callers
    // from torn intermediate state (unitAI-ctb4u.20).
    for (const queue of this.queues.values()) queue.cancel();
    this.queues.clear();
    if (this.coalesceTimer) clearTimeout(this.coalesceTimer);
    this.coalesceTimer = null;
    if (this.resizeHandler) {
      try {
        process.stdout.off('resize', this.resizeHandler);
      } catch {
        // ignore
      }
      this.resizeHandler = null;
    }
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl('c')) || data === 'q') {
      this.options.stop();
      return;
    }

    if (this.state.filtering) {
      if (matchesKey(data, Key.escape)) this.dispatch({ type: 'finishFilter', clear: true });
      else if (matchesKey(data, Key.enter)) this.dispatch({ type: 'finishFilter' });
      else if (matchesKey(data, Key.backspace)) this.dispatch({ type: 'filterBackspace' });
      else if (data.length === 1 && data >= ' ') this.dispatch({ type: 'filterChar', char: data });
      void this.refresh();
      return;
    }

    const viewportRows = this.mainViewportRows();
    const selected = selectedJobRow(this.state);
    const totalRows = this.state.view === 'ps' ? undefined : this.renderedDetailRows;
    // Views where vim-style paging chars (d/u/g/G) scroll; elsewhere they are
    // view-specific shortcuts: ps `d`=diff / `g`=config, config `u`=undo.
    // Key.pageDown/Key.pageUp keyboard events still fire everywhere.
    const isScrollView =
      this.state.view === 'all' ||
      this.state.view === 'feed' ||
      this.state.view === 'job' ||
      this.state.view === 'result' ||
      this.state.view === 'bead';
    // ↑/↓/j/k arrow handlers are gated to ps + scroll views. Config has
    // configCycleField + cycleSpecialist below; diff has diffMove below.
    // Without this gate the generic `move` action eats config + diff arrow
    // keys before the view-specific handlers can win. Same class of bug as
    // unitAI-ctb4u.25 (d/u/g/G gate). unitAI-ctb4u.30.
    const isArrowMoveView = isScrollView || this.state.view === 'ps';

    if ((matchesKey(data, Key.down) || data === 'j') && this.state.view === 'all')
      this.moveAllViewCursor(1);
    else if ((matchesKey(data, Key.up) || data === 'k') && this.state.view === 'all')
      this.moveAllViewCursor(-1);
    else if ((matchesKey(data, Key.down) || data === 'j') && isArrowMoveView)
      this.dispatch({ type: 'move', delta: 1, viewportRows, totalRows });
    else if ((matchesKey(data, Key.up) || data === 'k') && isArrowMoveView)
      this.dispatch({ type: 'move', delta: -1, viewportRows, totalRows });
    else if (matchesKey(data, Key.pageDown) || (data === 'd' && isScrollView))
      this.dispatch({ type: 'move', delta: Math.max(1, viewportRows - 1), viewportRows, totalRows });
    else if (matchesKey(data, Key.pageUp) || (data === 'u' && isScrollView))
      this.dispatch({ type: 'move', delta: -Math.max(1, viewportRows - 1), viewportRows, totalRows });
    else if (data === 'g' && isScrollView) this.dispatch({ type: 'top', viewportRows, totalRows });
    else if (data === 'G' && isScrollView) this.dispatch({ type: 'bottom', viewportRows, totalRows });
    else if (matchesKey(data, Key.enter) && this.state.view === 'ps' && selected)
      this.open('feed', selected.id);
    else if (data === 'r' && this.state.view === 'ps' && selected) this.open('result', selected.id);
    else if (data === 'i' && this.state.view === 'ps' && selected) this.open('job', selected.id);
    // 'b' opens BeadView. Decision (bd notes): shift+enter cannot be reliably distinguished
    // from enter in pi-tui input stream, so 'b' is the documented keybind.
    else if (data === 'b' && this.state.view === 'ps' && selected) this.open('bead', selected.id);
    else if (data === 'd' && this.state.view === 'ps' && selected) this.open('diff', selected.id);
    else if (data === 'x' && this.state.view === 'ps' && selected)
      void this.stopSelectedJob(selected.id);
    else if (data === 'x' && this.state.view === 'all')
      void this.stopSelectedAllViewJob();
    else if (data === 'g' && this.state.view === 'ps') this.open('config', selected?.id ?? '');
    else if (data === 'R' && this.state.view === 'ps') this.openRepoConfig();
    else if (this.state.view === 'repoConfig' && this.state.repoConfig.edit.mode !== 'none') {
      this.handleRepoConfigEditInput(data);
    } else if (this.state.view === 'repoConfig') {
      this.handleRepoConfigViewInput(data);
    }
    else if (this.state.view === 'config' && this.state.configEdit.active) {
      this.handleConfigEditInput(data);
    } else if (data === 'r' && this.state.view === 'config') this.refreshAfter({ type: 'configRefresh' });
    else if (data === 'r' && this.state.view === 'diff') this.refreshAfter({ type: 'diffRefresh' });
    else if (data === 'e' && this.state.view === 'config') this.startConfigEdit();
    else if (data === 'u' && this.state.view === 'config') void this.undoConfigEdit();
    else if (data === 'b' && this.state.view === 'config') void this.openConfigInEditor();
    else if (data === '[' && this.state.view === 'config') this.cycleConfigSpecialist(-1);
    else if (data === ']' && this.state.view === 'config') this.cycleConfigSpecialist(1);
    else if (this.state.view === 'config' && (matchesKey(data, Key.backspace) || matchesKey(data, Key.escape) || matchesKey(data, Key.left))) {
      this.back();
    } else if (this.state.view === 'config' && (data === 'j' || matchesKey(data, Key.down))) {
      this.dispatch({ type: 'configCycleField', delta: 1 });
    } else if (this.state.view === 'config' && (data === 'k' || matchesKey(data, Key.up))) {
      this.dispatch({ type: 'configCycleField', delta: -1 });
    }
    else if (this.state.view === 'diff' && (matchesKey(data, Key.enter) || data === 'l' || matchesKey(data, Key.right))) {
      const idx = this.state.diff.selectedFileIndex;
      const entry = this.state.diff.summary?.entries[idx];
      if (this.state.diff.stage === 'summary' && entry && !entry.binary) {
        this.dispatch({ type: 'diffOpenFile', index: idx, path: entry.path });
        void this.refresh();
      }
    } else if (this.state.view === 'diff' && (data === 'j' || matchesKey(data, Key.down))) {
      this.dispatch({ type: 'diffMove', delta: 1, viewportRows: this.mainViewportRows(), totalRows: this.renderedDetailRows });
    } else if (this.state.view === 'diff' && (data === 'k' || matchesKey(data, Key.up))) {
      this.dispatch({ type: 'diffMove', delta: -1, viewportRows: this.mainViewportRows(), totalRows: this.renderedDetailRows });
    } else if (this.state.view === 'diff' && (matchesKey(data, Key.backspace) || matchesKey(data, Key.escape) || matchesKey(data, Key.left))) {
      this.dispatch({ type: 'diffBack' });
      void this.refresh();
    }
    else if (matchesKey(data, Key.enter) && this.state.view === 'all')
      this.openFromAllView('feed');
    else if (data === 'r' && this.state.view === 'all') this.openFromAllView('result');
    else if (data === 'i' && this.state.view === 'all') this.openFromAllView('job');
    else if (data === 'b' && this.state.view === 'all') this.openFromAllView('bead');
    else if (data === 'd' && this.state.view === 'all') this.openFromAllView('diff');
    else if (data === 'g' && this.state.view === 'all') this.openFromAllView('config');
    else if (data === 'R' && this.state.view === 'all') this.openRepoConfig();
    else if (
      (matchesKey(data, Key.escape) || matchesKey(data, Key.backspace) || matchesKey(data, Key.left)) &&
      this.state.view !== 'ps' && this.state.view !== 'all'
    )
      this.back();
    else if (data === 'h' && this.state.view === 'ps') this.refreshAfter({ type: 'cycleHistory' });
    else if (data === 'a' && this.state.view === 'ps') this.refreshAfter({ type: 'toggleAll' });
    else if (data === 'c' && this.state.view === 'ps') this.refreshAfter({ type: 'toggleCleaned' });
    else if (data === '/' && this.state.view === 'ps') this.dispatch({ type: 'startFilter' });
    else if (data === 'f' && this.state.view === 'feed') this.refreshAfter({ type: 'toggleFollow' });
    else if (data === 't' && this.state.view === 'feed') this.refreshAfter({ type: 'toggleFeedSource' });
    else if (data === '0') { this.allViewCursor = 0; this.refreshAfter({ type: 'viewAll' }); }
    else if (matchesKey(data, Key.tab)) this.refreshAfter({ type: 'nextRepo' });
    else if (/^[1-9]$/.test(data)) this.refreshAfter({ type: 'selectRepo', index: Number(data) - 1 });
  }

  render(width: number): string[] {
    this.lastWidth = width;
    const height = Math.max(1, this.options.rows());
    const repo = currentRepo(this.state);
    const lines: string[] = [];
    lines.push(renderTabs(this.state.repos, this.state.repoIndex, width, this.state.view));
    lines.push(renderMeters(this.metersInput(), width));
    lines.push(renderViewtag(VIEWS, this.state.view, width));
    lines.push(
      this.state.view === 'all'
        ? renderHeader('all', `${this.state.repos.length} repos`, '', width)
        : renderHeader(
            this.detailJobLabel() ?? this.state.view,
            repo?.name ?? 'specialists',
            repo?.path ?? process.cwd(),
            width,
          ),
    );

    const viewportRows = this.mainViewportRows();
    const mainRows = this.renderMain(width, viewportRows).slice(0, viewportRows);
    while (mainRows.length < viewportRows) mainRows.push(fillerLine(width));
    lines.push(...mainRows);

    lines.push(renderStatsLine(this.state.snapshot, width));
    lines.push(renderKeyBar(this.state.view, this.state.follow, width, this.state.feedSource));
    if (this.state.filtering) lines.push(renderFilterPrompt(`/${this.state.filter}_`, width));
    if (this.state.message) lines.push(renderMessage(this.state.message, width));
    return fitFrame(lines, width, height);
  }



  private metersInput() {
    if (this.state.view === 'all') {
      let active = 0, activeTotal = 0;
      for (const snap of this.allSnapshots.values()) {
        active += snap.runningJobs;
        activeTotal += snap.totalJobs;
      }
      return { active, activeTotal };
    }
    const snap = this.state.snapshot;
    const active = snap ? snap.runningJobs : 0;
    const activeTotal = snap ? snap.totalJobs : 0;
    return { active, activeTotal };
  }

  private async loadRepos(): Promise<void> {
    try {
      // Prefer the context-aware seam if the runtime implements it so the
      // first-run discovery message (unitAI-29p39) lands in the existing
      // message area. Falls back to bare listRepos() for runtimes that
      // skip it (test stubs).
      if (typeof this.options.runtime.listReposWithContext === 'function') {
        const { repos, message } = await this.options.runtime.listReposWithContext();
        this.dispatch({ type: 'reposLoaded', repos, message });
        return;
      }
      const repos = await this.options.runtime.listRepos();
      this.dispatch({ type: 'reposLoaded', repos });
    } catch (error) {
      this.dispatch({ type: 'message', message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async refreshAllView(): Promise<void> {
    const repos = this.state.repos;
    if (repos.length === 0) return;
    const now = Date.now();
    if (now - this.lastAllRefreshMs < 5000 && this.lastAllRefreshMs > 0) return;
    this.lastAllRefreshMs = now;
    const results = await Promise.allSettled(
      repos.map((repo) =>
        this.options.runtime.listProcessSnapshot(repo, {
          historyMode: 'default',
          includeCleaned: false,
          textFilter: '',
        }).then((snap) => ({ id: repo.id, snap }))
      )
    );
    for (const r of results) {
      if (r.status === 'fulfilled') this.allSnapshots.set(r.value.id, r.value.snap);
    }
  }

  private async refresh(): Promise<void> {
    if (this.refreshInFlight || this.disposed) return;
    this.refreshInFlight = true;
    try {
      if (this.state.view === 'all') {
        await this.refreshAllView();
        return;
      }
      const repo = currentRepo(this.state);
      if (!repo) return;
      let snapshot;
      try {
        snapshot = await this.options.runtime.listProcessSnapshot(repo, {
          historyMode: this.state.historyMode,
          includeCleaned: this.state.includeCleaned,
          textFilter: this.state.filter,
        });
      } catch (error) {
        logError(this.logViewKey(), 'list_processes', { errorClass: errorClassOf(error) });
        this.dispatch({ type: 'message', message: 'snapshot read failed — runtime unreachable' });
        return;
      }
      // Snapshot dispatch coalesce: skip when nothing changed. Hash is
      // a stable key-ordered SHA-256 (unitAI-ctb4u.19) so property-order
      // drift across runtime updates cannot cause a false miss.
      const hash = snapshotHash(snapshot.jobs, (j) => j.id);
      if (hash !== this.lastSnapshotHash) {
        // Compute upsert/tombstone delta and stash it in the view-model
        // for future ProcessView consumers (unitAI-ctb4u.21). The poll
        // loop itself still dispatches the full snapshot — this just
        // surfaces the delta primitives without altering render shape.
        const delta = snapshotDiff(this.lastSnapshotJobs, snapshot.jobs, (j) => j.id);
        this.lastSnapshotHash = hash;
        this.lastSnapshotJobs = snapshot.jobs;
        this.dispatch({ type: 'snapshotLoaded', snapshot });
        this.dispatch({
          type: 'snapshotDelta',
          upserts: delta.upserts,
          tombstones: delta.tombstones,
        });
        // Drop cache entries for tombstoned jobs so the cache does not
        // grow unbounded across long sessions. Tombstones are rare in
        // steady state — this is O(tombstones) per poll, not per row.
        if (delta.tombstones.length > 0) {
          const dead = new Set(delta.tombstones.map((j) => j.id));
          for (const key of this.processRowCache.keys()) {
            const idEnd = key.indexOf('|');
            if (idEnd > 0 && dead.has(key.slice(0, idEnd))) {
              this.processRowCache.delete(key);
            }
          }
        }
      }

      if (this.state.view === 'feed' && this.state.selectedJobId) {
        const rows = await this.options.runtime.readFeed({
          repo,
          jobId: this.state.selectedJobId,
          limit: 250,
          source: this.state.feedSource,
        });
        this.dispatch({
          type: 'feedLoaded',
          rows,
          totalRows: this.feedLines(rows, this.lastWidth).length,
          viewportRows: this.mainViewportRows(),
        });
      } else if (this.state.view === 'job' && this.state.selectedJobId) {
        this.dispatch({
          type: 'jobLoaded',
          inspect: await this.options.runtime.inspectJob(repo, this.state.selectedJobId),
        });
      } else if (this.state.view === 'result' && this.state.selectedJobId) {
        this.dispatch({
          type: 'resultLoaded',
          result: await this.options.runtime.readResult(repo, this.state.selectedJobId),
        });
      } else if (this.state.view === 'bead' && this.state.selectedJobId) {
        const [doc, live] = await Promise.all([
          this.options.runtime.linkedDetail(repo, this.state.selectedJobId),
          this.options.runtime.liveStateFor(repo, this.state.selectedJobId),
        ]);
        this.dispatch({ type: 'beadLoaded', doc, live });
      } else if (this.state.view === 'config') {
        const snapshot = await this.options.runtime.readGlobalConfig();
        this.dispatch({ type: 'configLoaded', snapshot });
      } else if (this.state.view === 'diff' && this.state.selectedJobId) {
        if (this.state.diff.stage === 'summary') {
          const summary = await this.options.runtime.diffSummary(repo, this.state.selectedJobId);
          this.dispatch({ type: 'diffSummaryLoaded', summary });
        } else if (this.state.diff.filePath) {
          const file = await this.options.runtime.diffFile(repo, this.state.selectedJobId, this.state.diff.filePath);
          this.dispatch({ type: 'diffFileLoaded', file });
        }
      }
    } catch (error) {
      logError(this.logViewKey(), 'render', { errorClass: errorClassOf(error) });
      this.dispatch({ type: 'message', message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.refreshInFlight = false;
      this.scheduleRender();
    }
  }

  private logViewKey(): LogView {
    return this.state.view as LogView;
  }

  private dispatch(action: Parameters<typeof reduceConsoleState>[1]): void {
    this.state = reduceConsoleState(this.state, action);
    this.scheduleRender();
  }

  // Coalesce frequent re-render requests into one paint per ~50ms tick
  // (spec §10: feed dispatch coalesces bursts ≤ 20Hz).
  private scheduleRender(): void {
    if (this.coalesceTimer || this.disposed) return;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      if (this.disposed) return;
      this.options.requestRender();
    }, COALESCE_MS);
  }

  private refreshAfter(action: Parameters<typeof reduceConsoleState>[1]): void {
    // Capture the prior repo id BEFORE the reducer runs so we can cancel
    // its queue on switch (unitAI-ctb4u.20).
    const priorRepoId = currentRepo(this.state)?.id;
    this.dispatch(action);
    const nextRepoId = currentRepo(this.state)?.id;
    if (priorRepoId && nextRepoId && priorRepoId !== nextRepoId) {
      // Cancel the old repo's pending dispatch, drop the per-row paint
      // cache (cross-repo bleed would render the wrong rows), and
      // refresh the new repo immediately rather than waiting a full
      // COALESCE_MS window. (unitAI-ctb4u.20 + unitAI-ctb4u.21)
      this.queues.get(priorRepoId)?.cancel();
      this.invalidateProcessRowCache();
      void this.refresh();
      return;
    }
    void this.refresh();
  }

  // Schedule the next refresh on the active repo's queue. Each repo gets
  // its own SourceQueue so tab-switching cannot let a stale poll on the
  // prior repo race the destination repo's first render. Errors route
  // through the centralized logError sink (unitAI-21sn4 invariant).
  private scheduleRefresh(): void {
    const repo = currentRepo(this.state);
    if (!repo || this.disposed) return;
    let queue = this.queues.get(repo.id);
    if (!queue) {
      queue = new SourceQueue((_sourceKey, error) => {
        logError(this.logViewKey(), 'list_processes', { errorClass: errorClassOf(error) });
      });
      this.queues.set(repo.id, queue);
    }
    queue.enqueue(repo.id, async () => {
      await this.refresh();
      if (!this.disposed) this.scheduleRefresh();
    });
  }

  private open(view: 'feed' | 'job' | 'result' | 'bead' | 'diff' | 'config', jobId: string): void {
    this.dispatch({ type: 'open', view, jobId });
    void this.refresh();
  }

  private openRepoConfig(): void {
    // RepoConfigView has no associated jobId — reuse the existing `open`
    // action shape with an empty jobId so the reducer's back-handling +
    // chrome reset paths apply uniformly. The dedicated dispatch keeps
    // the view-specific load detached from the per-job lookups.
    this.dispatch({ type: 'open', view: 'repoConfig', jobId: '' });
    this.dispatch({ type: 'repoConfigLoading' });
    void this.loadRepoConfigSnapshot();
  }

  private async loadRepoConfigSnapshot(): Promise<void> {
    const runtime = this.options.runtime;
    if (typeof runtime.readRepoConfigSnapshot !== 'function') {
      this.dispatch({ type: 'repoConfigMessage', message: 'repo config not supported by runtime' });
      return;
    }
    try {
      const snapshot = await runtime.readRepoConfigSnapshot();
      this.dispatch({ type: 'repoConfigLoaded', snapshot });
    } catch (error) {
      logError(this.logViewKey(), 'render', { errorClass: errorClassOf(error) });
      this.dispatch({
        type: 'repoConfigMessage',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.scheduleRender();
    }
  }

  private handleRepoConfigViewInput(data: string): void {
    const repoConfig = this.state.repoConfig;
    if (matchesKey(data, Key.backspace) || matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
      this.back();
      return;
    }
    if (data === 'j' || matchesKey(data, Key.down)) {
      this.dispatch({ type: 'repoConfigMove', delta: 1 });
      return;
    }
    if (data === 'k' || matchesKey(data, Key.up)) {
      this.dispatch({ type: 'repoConfigMove', delta: -1 });
      return;
    }
    if (data === '+') {
      this.dispatch({ type: 'repoConfigStartAdd' });
      return;
    }
    if (data === 's') {
      this.dispatch({ type: 'repoConfigToggleInactive' });
      return;
    }
    if (data === 'r') {
      void this.rescanRepoConfig();
      return;
    }
    const selectedName = this.selectedRepoConfigName();
    if (!selectedName) return;
    if (data === 'd') {
      void this.removeRepoConfigEntry(selectedName);
      return;
    }
    if (data === 'e') {
      // Default to editing the path — most common drift. Operator can
      // re-press `e` after Esc to pick name in a follow-up if needed.
      this.dispatch({ type: 'repoConfigStartEdit', field: 'path', targetName: selectedName });
      return;
    }
    if (data === 'n') {
      // Edit name shortcut (mnemonic). Not advertised in the keybar to
      // keep it terse, but kept available for parity with config view's
      // `[`/`]` style add-on bindings.
      this.dispatch({ type: 'repoConfigStartEdit', field: 'name', targetName: selectedName });
      // Ensure repoConfig is exhaustively reachable lint-wise.
      void repoConfig;
    }
  }

  private basenameFromPath(p: string): string {
    const trimmed = p.replace(/[\\/]+$/, '');
    const last = trimmed.split(/[\\/]/).pop() ?? '';
    return last || trimmed || 'repo';
  }

  private handleRepoConfigEditInput(data: string): void {
    const mode = this.state.repoConfig.edit.mode;
    if (matchesKey(data, Key.escape)) {
      this.dispatch({ type: 'repoConfigEditCancel' });
      return;
    }
    if (matchesKey(data, Key.enter)) {
      void this.submitRepoConfigEdit();
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      this.dispatch({ type: 'repoConfigEditBackspace' });
      return;
    }
    if (data.length === 1 && data >= ' ' && data !== '\x7f') {
      this.dispatch({ type: 'repoConfigEditChar', char: data });
    }
    void mode;
  }

  private async submitRepoConfigEdit(): Promise<void> {
    const edit = this.state.repoConfig.edit;
    const runtime = this.options.runtime;
    if (edit.mode === 'add-path') {
      if (!edit.buffer.trim()) {
        this.dispatch({ type: 'repoConfigEditError', error: 'path required' });
        return;
      }
      this.dispatch({ type: 'repoConfigEditAdvance' });
      return;
    }
    if (edit.mode === 'add-name') {
      const path = edit.pendingPath?.trim() ?? '';
      const name = edit.buffer.trim() || this.basenameFromPath(path);
      if (!path || !name) {
        this.dispatch({ type: 'repoConfigEditError', error: 'path and name required' });
        return;
      }
      if (typeof runtime.addRepoConfigEntry !== 'function') {
        this.dispatch({ type: 'repoConfigEditError', error: 'runtime missing addRepoConfigEntry' });
        return;
      }
      try {
        const result = await runtime.addRepoConfigEntry({ name, path });
        if (!result.ok) {
          this.dispatch({ type: 'repoConfigEditError', error: result.error ?? 'add failed' });
          return;
        }
        this.dispatch({ type: 'repoConfigEditCommit', snapshot: result.snapshot, message: `added ${name}` });
      } catch (error) {
        this.dispatch({
          type: 'repoConfigEditError',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (edit.mode === 'edit-name' || edit.mode === 'edit-path') {
      const target = edit.targetName;
      if (!target) {
        this.dispatch({ type: 'repoConfigEditCancel' });
        return;
      }
      const value = edit.buffer.trim();
      if (!value) {
        this.dispatch({ type: 'repoConfigEditError', error: 'value required' });
        return;
      }
      if (typeof runtime.editRepoConfigEntry !== 'function') {
        this.dispatch({ type: 'repoConfigEditError', error: 'runtime missing editRepoConfigEntry' });
        return;
      }
      try {
        const field = edit.mode === 'edit-name' ? 'name' : 'path';
        const result = await runtime.editRepoConfigEntry(target, field, value);
        if (!result.ok) {
          this.dispatch({ type: 'repoConfigEditError', error: result.error ?? 'edit failed' });
          return;
        }
        this.dispatch({
          type: 'repoConfigEditCommit',
          snapshot: result.snapshot,
          message: `updated ${target}`,
        });
      } catch (error) {
        this.dispatch({
          type: 'repoConfigEditError',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async removeRepoConfigEntry(name: string): Promise<void> {
    const runtime = this.options.runtime;
    if (typeof runtime.removeRepoConfigEntry !== 'function') return;
    try {
      const result = await runtime.removeRepoConfigEntry(name);
      if (!result.ok) {
        this.dispatch({ type: 'repoConfigMessage', message: result.error ?? 'remove failed' });
        return;
      }
      if (result.snapshot) this.dispatch({ type: 'repoConfigLoaded', snapshot: result.snapshot });
      this.dispatch({ type: 'repoConfigMessage', message: `removed ${name}` });
    } catch (error) {
      this.dispatch({
        type: 'repoConfigMessage',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.scheduleRender();
    }
  }

  private async rescanRepoConfig(): Promise<void> {
    const runtime = this.options.runtime;
    if (typeof runtime.rescanRepoConfig !== 'function') return;
    try {
      const result = await runtime.rescanRepoConfig();
      if (!result.ok) {
        this.dispatch({ type: 'repoConfigMessage', message: result.error ?? 'rescan failed' });
        return;
      }
      if (result.snapshot) this.dispatch({ type: 'repoConfigLoaded', snapshot: result.snapshot });
      const added = result.discoveredCount ?? 0;
      this.dispatch({
        type: 'repoConfigMessage',
        message: added > 0 ? `discovered ${added} new repo${added === 1 ? '' : 's'}` : 'rescan complete · no new repos',
      });
    } catch (error) {
      this.dispatch({
        type: 'repoConfigMessage',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.scheduleRender();
    }
  }

  private selectedRepoConfigName(): string | undefined {
    const rows = visibleRepoConfigRows(this.state.repoConfig);
    return rows[this.state.repoConfig.selectedIndex]?.name;
  }

  private back(): void {
    this.dispatch({ type: 'back' });
    void this.refresh();
  }

  private moveAllViewCursor(delta: number): void {
    const selectable: number[] = [];
    this.allViewRowMap.forEach((e, i) => { if (e !== null) selectable.push(i); });
    if (!selectable.length) return;
    const cur = selectable.indexOf(this.allViewCursor);
    const curIdx = cur >= 0 ? cur : 0;
    const nextIdx = Math.max(0, Math.min(selectable.length - 1, curIdx + delta));
    this.allViewCursor = selectable[nextIdx] ?? 0;
    const viewportRows = this.mainViewportRows();
    const scroll = this.state.scroll;
    if (this.allViewCursor < scroll) {
      this.dispatch({ type: 'move', delta: this.allViewCursor - scroll, viewportRows, totalRows: this.renderedDetailRows });
    } else if (this.allViewCursor >= scroll + viewportRows) {
      this.dispatch({ type: 'move', delta: this.allViewCursor - (scroll + viewportRows - 1), viewportRows, totalRows: this.renderedDetailRows });
    } else {
      this.scheduleRender();
    }
  }

  private openFromAllView(view: 'feed' | 'job' | 'result' | 'bead' | 'diff' | 'config'): void {
    const entry = this.allViewRowMap[this.allViewCursor];
    if (!entry) return;
    const repoIdx = this.state.repos.findIndex(r => r.id === entry.repoId);
    if (repoIdx < 0) return;
    this.refreshAfter({ type: 'selectRepo', index: repoIdx });
    this.open(view, entry.jobId);
  }

  private async stopSelectedJob(jobId: string): Promise<void> {
    const repo = currentRepo(this.state);
    const runtime = this.options.runtime;
    if (!repo || typeof runtime.stopJob !== 'function') return;
    try {
      this.dispatch({ type: 'message', message: `stopping ${jobId}…` });
      await runtime.stopJob(repo, jobId);
      this.dispatch({ type: 'message', message: `sent SIGTERM to ${jobId}` });
    } catch (error) {
      this.dispatch({ type: 'message', message: error instanceof Error ? error.message : String(error) });
    } finally {
      void this.refresh();
    }
  }

  private async stopSelectedAllViewJob(): Promise<void> {
    const entry = this.allViewRowMap[this.allViewCursor];
    if (!entry) return;
    const repo = this.state.repos.find(r => r.id === entry.repoId);
    const runtime = this.options.runtime;
    if (!repo || typeof runtime.stopJob !== 'function') return;
    try {
      this.dispatch({ type: 'message', message: `stopping ${entry.jobId}…` });
      await runtime.stopJob(repo, entry.jobId);
      this.dispatch({ type: 'message', message: `sent SIGTERM to ${entry.jobId}` });
    } catch (error) {
      this.dispatch({ type: 'message', message: error instanceof Error ? error.message : String(error) });
    } finally {
      void this.refresh();
    }
  }

  private renderAllRows(width: number, viewportRows: number): string[] {
    const repos = this.state.repos;
    if (repos.length === 0) return [renderPlaceholder('no repos configured', width)];

    const rows: string[] = [];
    const newRowMap: Array<{ repoId: string; jobId: string } | null> = [];
    const sorted = [...repos].sort((a, b) => {
      const aActive = this.allSnapshots.get(a.id)?.runningJobs ?? 0;
      const bActive = this.allSnapshots.get(b.id)?.runningJobs ?? 0;
      return bActive - aActive;
    });

    for (const repo of sorted) {
      const snap = this.allSnapshots.get(repo.id);
      const activeRows = (snap?.rows ?? []).filter(
        (r): r is Extract<typeof r, { kind: 'job' }> =>
          r.kind === 'job' && (r.job.status === 'running' || r.job.status === 'waiting'),
      );
      newRowMap.push(null); // section header is not selectable
      rows.push(renderRepoSectionHeader(repo.name, repo.path, activeRows.length, width));
      if (activeRows.length === 0) {
        newRowMap.push(null);
        rows.push(renderPlaceholder('  no active jobs', width));
      } else {
        for (const row of activeRows) {
          const rowIdx = rows.length;
          const isSelected = rowIdx === this.allViewCursor;
          newRowMap.push({ repoId: repo.id, jobId: row.job.id });
          const prefix = isSelected ? '› ' : '  ';
          rows.push(prefix + renderJobRow(row.job, Math.max(1, width - 2), 0, false));
        }
      }
      newRowMap.push(null); // spacer
      rows.push('');
    }

    this.allViewRowMap = newRowMap;
    // Auto-advance cursor off non-selectable rows (headers/spacers) on first render
    if (this.allViewRowMap[this.allViewCursor] === null) {
      const first = this.allViewRowMap.findIndex(e => e !== null);
      if (first >= 0) this.allViewCursor = first;
    }

    const total = rows.length;
    this.renderedDetailRows = total;
    const maxScroll = Math.max(0, total - Math.max(1, viewportRows));
    const scroll = Math.min(this.state.scroll, maxScroll);
    return [...visibleSlice(rows, scroll, viewportRows)];
  }

  private renderMain(width: number, viewportRows: number): string[] {
    if (this.state.view === 'all') return this.renderAllRows(width, viewportRows);
    if (this.state.view === 'ps') return this.renderProcessRows(width, viewportRows);
    if (this.state.view === 'feed') return this.renderFeedRows(width, viewportRows);
    if (this.state.view === 'job') return this.renderJobRows(width, viewportRows);
    if (this.state.view === 'bead') return this.renderBeadRows(width, viewportRows);
    if (this.state.view === 'diff') return this.renderDiffRows(width, viewportRows);
    if (this.state.view === 'config') return this.renderConfigRows(width, viewportRows);
    if (this.state.view === 'repoConfig') return this.renderRepoConfigRows(width, viewportRows);
    return this.renderResultRows(width, viewportRows);
  }

  private cycleConfigSpecialist(delta: number): void {
    const snapshot = this.state.config;
    if (!snapshot || snapshot.specialists.length === 0) return;
    const names = snapshot.specialists.map((s) => s.name);
    const current = this.state.configSelectedSpecialist ?? names[0];
    const idx = Math.max(0, names.indexOf(current ?? ''));
    const next = Math.max(0, Math.min(names.length - 1, idx + delta));
    const name = names[next];
    if (name) this.dispatch({ type: 'configSelectSpecialist', name });
  }

  private selectedConfigField(): { specialist: string; fieldPath: string } | undefined {
    const snapshot = this.state.config;
    if (!snapshot) return undefined;
    const specialist = snapshot.specialists.find((s) => s.name === this.state.configSelectedSpecialist);
    if (!specialist) return undefined;
    const field = specialist.fields[this.state.configSelectedFieldIndex];
    if (!field) return undefined;
    return { specialist: specialist.name, fieldPath: field.path };
  }

  private startConfigEdit(): void {
    const target = this.selectedConfigField();
    if (!target) return;
    this.dispatch({
      type: 'configEditStart',
      specialist: target.specialist,
      fieldPath: target.fieldPath,
      expectedMtimeMs: this.state.configRawMtimeMs,
    });
  }

  private handleConfigEditInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.dispatch({ type: 'configEditCancel' });
      return;
    }
    if (matchesKey(data, Key.enter)) {
      void this.submitConfigEdit();
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      this.dispatch({ type: 'configEditBackspace' });
      return;
    }
    if (data.length === 1 && data >= ' ' && data !== '\x7f') {
      this.dispatch({ type: 'configEditChar', char: data });
    }
  }

  private async submitConfigEdit(): Promise<void> {
    const edit = this.state.configEdit;
    if (!edit.active || !edit.specialist || !edit.fieldPath) return;
    const coerce = coerceFieldValue(edit.fieldPath, edit.buffer);
    if (!coerce.ok) {
      this.dispatch({ type: 'configEditError', error: coerce.error ?? 'invalid input' });
      return;
    }
    try {
      const { raw, mtimeMs } = await this.options.runtime.readRawGlobalConfig();
      const prevRaw = structuredCloneCompat(raw);
      const candidate = applyFieldEdit(raw, edit.specialist, edit.fieldPath, coerce.value);
      const outcome = await this.options.runtime.writeGlobalConfig(candidate, edit.expectedMtimeMs ?? mtimeMs);
      if (!outcome.ok) {
        const msg = outcome.errorClass === 'mtime_mismatch'
          ? 'user.json changed on disk — press `r` to refresh'
          : outcome.errors && outcome.errors[0]
            ? `${outcome.errors[0].path}: ${outcome.errors[0].message}`
            : `write failed (${outcome.errorClass ?? 'unknown'})`;
        this.dispatch({ type: 'configEditError', error: msg });
        return;
      }
      const nextSnapshot = await this.options.runtime.readGlobalConfig();
      const next = await this.options.runtime.readRawGlobalConfig();
      this.dispatch({
        type: 'configEditCommit',
        nextSnapshot,
        rawMtimeMs: next.mtimeMs,
        prevRaw,
      });
    } catch (error) {
      this.dispatch({
        type: 'configEditError',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async undoConfigEdit(): Promise<void> {
    const stack = this.state.configUndoStack;
    if (stack.length === 0) return;
    const target = stack[0]!;
    try {
      const outcome = await this.options.runtime.writeGlobalConfig(target);
      if (!outcome.ok) return;
      const restoredSnapshot = await this.options.runtime.readGlobalConfig();
      const next = await this.options.runtime.readRawGlobalConfig();
      this.dispatch({ type: 'configUndo', restoredSnapshot, rawMtimeMs: next.mtimeMs });
    } catch {
      // swallow — undo is best-effort
    }
  }

  private async openConfigInEditor(): Promise<void> {
    await this.options.runtime.openConfigInEditor();
    this.refreshAfter({ type: 'configRefresh' });
  }

  private renderRepoConfigRows(width: number, viewportRows: number): string[] {
    const repoConfig = this.state.repoConfig;
    const snapshot = repoConfig.snapshot;
    const rows: string[] = [];
    if (repoConfig.loading && !snapshot) {
      this.renderedDetailRows = 1;
      return [renderPlaceholder('loading repo config…', width)];
    }
    if (!snapshot) {
      this.renderedDetailRows = 1;
      return [renderPlaceholder('no repo config snapshot', width)];
    }
    const headerBits = [
      `path: ${snapshot.configPath}`,
      snapshot.configExists ? 'exists' : 'will be created on first write',
    ];
    if (snapshot.autoDiscoveredAt) headerBits.push(`last scan: ${snapshot.autoDiscoveredAt}`);
    if (snapshot.baseDirs.length > 0) headerBits.push(`base dirs: ${snapshot.baseDirs.join(', ')}`);
    rows.push(renderPlaceholder(headerBits.join(' · '), width));

    const visibleRows = visibleRepoConfigRows(repoConfig);
    const hiddenCount = snapshot.rows.length - visibleRows.length;
    rows.push(renderSectionTitle(
      `repos (${visibleRows.length}${hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ''})`,
      width,
    ));
    if (visibleRows.length === 0) {
      rows.push(renderPlaceholder('(no repos — press + to add or r to rescan)', width));
    } else {
      visibleRows.forEach((row, idx) => {
        rows.push(renderRepoConfigRow(row, width, idx === repoConfig.selectedIndex));
      });
    }

    const edit = repoConfig.edit;
    if (edit.mode !== 'none') {
      const label = edit.mode === 'add-path'
        ? 'add · path'
        : edit.mode === 'add-name'
          ? `add · name (path=${edit.pendingPath ?? ''})`
          : edit.mode === 'edit-name'
            ? `edit name (${edit.targetName ?? ''})`
            : `edit path (${edit.targetName ?? ''})`;
      rows.push(renderPlaceholder(`${label} > ${edit.buffer}_`, width));
      if (edit.error) rows.push(renderPlaceholder(`! ${edit.error}`, width));
    }

    if (repoConfig.message) rows.push(renderPlaceholder(repoConfig.message, width));

    this.renderedDetailRows = rows.length;
    return visibleSlice(rows, 0, viewportRows).map((r) => truncateToWidth(r, width));
  }

  private renderConfigRows(width: number, viewportRows: number): string[] {
    const snapshot = this.state.config;
    if (this.state.configLoading || !snapshot) {
      this.renderedDetailRows = 1;
      return [renderPlaceholder('loading config…', width)];
    }
    const rows: string[] = [];
    rows.push(renderPlaceholder(`path: ${snapshot.displayPath} (${snapshot.source})`, width));
    if (!snapshot.exists) {
      rows.push(renderPlaceholder('no user.json — run `sp init --global` to create', width));
      this.renderedDetailRows = rows.length;
      return visibleSlice(rows, 0, viewportRows).map((row) => truncateToWidth(row, width));
    }
    if (snapshot.parseError) {
      rows.push(renderPlaceholder(snapshot.parseError, width));
      this.renderedDetailRows = rows.length;
      return visibleSlice(rows, 0, viewportRows).map((row) => truncateToWidth(row, width));
    }
    rows.push(renderSectionTitle('specialists', width));
    const selectedName = this.state.configSelectedSpecialist ?? snapshot.specialists[0]?.name;
    snapshot.specialists.forEach((s) => {
      rows.push(renderConfigSpecialistRow(s.name, s.hasOverride, s.name === selectedName, width));
    });
    const selected = snapshot.specialists.find((s) => s.name === selectedName);
    if (selected) {
      rows.push(renderSectionTitle(`${selected.name} · fields`, width));
      selected.fields.forEach((field, idx) => {
        const isInherit = field.value === undefined || field.value === null;
        const fieldSelected = idx === this.state.configSelectedFieldIndex;
        const cursor = fieldSelected ? '›' : ' ';
        const row = renderConfigField(
          field.path,
          formatConfigValue(field.value),
          field.allowedHint,
          width - 2,
          {
            isOverride: field.isOverride,
            isInherit,
            defaultValue: isInherit && field.defaultValue !== undefined && field.defaultValue !== null
              ? formatConfigValue(field.defaultValue)
              : undefined,
          },
        );
        rows.push(`${cursor} ${row}`);
        if (this.state.configEdit.active
          && this.state.configEdit.fieldPath === field.path
          && this.state.configEdit.specialist === selected.name) {
          rows.push(renderPlaceholder(`  edit > ${this.state.configEdit.buffer}_`, width));
          if (this.state.configEdit.error) {
            rows.push(renderPlaceholder(`  ! ${this.state.configEdit.error}`, width));
          }
        }
      });
      if (selected.blockedWarnings.length > 0) {
        rows.push(renderSectionTitle('blocked-field warnings', width));
        for (const warn of selected.blockedWarnings) rows.push(renderPlaceholder(warn, width));
      }
    }
    if (snapshot.validationErrors.length > 0) {
      rows.push(renderSectionTitle('validation errors', width));
      for (const err of snapshot.validationErrors.slice(0, 5)) {
        rows.push(renderPlaceholder(`${err.path}: ${err.message}`, width));
      }
    }
    this.renderedDetailRows = rows.length;
    const maxScroll = Math.max(0, rows.length - Math.max(1, viewportRows));
    const scroll = Math.max(0, Math.min(this.state.configScroll, maxScroll));
    return visibleSlice(rows, scroll, viewportRows).map((row) => truncateToWidth(row, width));
  }

  private renderDiffRows(width: number, viewportRows: number): string[] {
    const diff = this.state.diff;
    if (diff.loading) {
      this.renderedDetailRows = 1;
      return [renderPlaceholder('loading diff…', width)];
    }
    const summaryTitle = diffSummaryTitle(diff.summary);
    if (diff.stage === 'summary') {
      if (diff.error || !diff.summary || diff.summary.entries.length === 0) {
        const msg = diff.error ?? diff.summary?.error ?? 'no changes in worktree';
        this.renderedDetailRows = 2;
        return [
          renderSectionTitle(summaryTitle, width),
          renderPlaceholder(msg, width),
        ];
      }
      const rows = [renderSectionTitle(summaryTitle, width)];
      diff.summary.entries.forEach((entry, idx) => {
        rows.push(renderDiffSummaryRow(entry, width, idx === diff.selectedFileIndex));
      });
      this.renderedDetailRows = rows.length;
      return visibleSlice(rows, 0, viewportRows).map((row) => truncateToWidth(row, width));
    }
    // file stage
    const file = diff.fileDoc;
    if (!file) {
      this.renderedDetailRows = 1;
      return [renderPlaceholder('loading file…', width)];
    }
    if (file.error) {
      this.renderedDetailRows = 1;
      return [renderPlaceholder(file.error, width)];
    }
    const fileTitle = diffFileTitle(file);
    const rows: string[] = [renderSectionTitle(fileTitle, width)];
    if (file.binary) {
      rows.push(renderPlaceholder('binary file (no diff rendered)', width));
    } else {
      for (const h of file.hunks) {
        rows.push(renderDiffHunkHeader(h.header, width));
        for (const ln of h.lines) rows.push(renderDiffHunkLine(ln.kind, ln.text, width));
      }
      if (file.truncated) {
        rows.push(renderPlaceholder(`… truncated (${Math.round((file.totalLines ?? 0) / 1000)}k lines) — press r to re-load`, width));
      }
    }
    this.renderedDetailRows = rows.length;
    return visibleSlice(rows, diff.fileScroll, viewportRows).map((row) => truncateToWidth(row, width));
  }

  private renderBeadRows(width: number, viewportRows: number): string[] {
    if (this.state.beadLoading) {
      this.renderedDetailRows = 1;
      return [renderPlaceholder('loading bead…', width)];
    }
    const doc = this.state.beadDoc;
    const live = this.state.beadLive;
    const rows: string[] = [];
    if (doc?.error) {
      rows.push(renderPlaceholder(doc.error, width));
    } else if (doc) {
      for (const f of doc.fields) rows.push(renderBeadField(f.key, f.value, width));
    }
    rows.push(renderSectionTitle('live state', width));
    if (live?.error) {
      rows.push(renderPlaceholder(live.error, width));
    } else if (live && live.rows.length > 0) {
      for (const r of live.rows) rows.push(renderBeadField(r.key, r.value, width));
    } else {
      rows.push(renderPlaceholder('no live state — job terminated', width));
    }
    if (doc && !doc.error) {
      for (const section of doc.sections) {
        rows.push(renderSectionTitle(section.title, width));
        for (const line of section.body.split('\n')) {
          rows.push(renderBeadBodyLine(line || ' ', width));
        }
      }
    }
    this.renderedDetailRows = rows.length;
    const maxScroll = Math.max(0, rows.length - Math.max(1, viewportRows));
    const scroll = Math.max(0, Math.min(this.state.scroll, maxScroll));
    return visibleSlice(rows, scroll, viewportRows).map((row) => truncateToWidth(row, width));
  }

  private renderProcessRows(width: number, viewportRows: number): string[] {
    const rows = this.state.snapshot?.rows ?? [];
    if (rows.length === 0) return [renderPlaceholder('no jobs match current filters', width)];
    // Bound the cache so a long-running session doesn't grow it without
    // limit. totalJobs * 2 leaves headroom for transitioning rows.
    const cacheCap = Math.max(64, (this.state.snapshot?.totalJobs ?? rows.length) * 2);
    if (this.processRowCache.size > cacheCap) {
      this.processRowCache = new Map(
        [...this.processRowCache.entries()].slice(-Math.floor(cacheCap / 2)),
      );
    }
    return visibleSlice(rows, this.state.scroll, viewportRows).map((row, offset) => {
      const index = this.state.scroll + offset;
      if (row.kind === 'group') {
        // legacy group rows from runtime.ts still pass {kind:'group', label, depth}
        return renderGroupRow('label', row.label, width, row.depth);
      }
      const selected = index === this.state.selectedRow;
      const job = row.job;
      const datePrefix =
        this.state.historyMode === 'default' ? '' : `${formatDateTime(job.started_at_ms)} `;
      // Cache key composes everything the rendered string depends on:
      // job identity + visible state + width + tree depth + selection.
      // ctxBucket rounds context_pct down to 5% to keep the cache stable
      // when ctx drifts within a poll window. (unitAI-ctb4u.21)
      const ctxBucket = job.context_pct === undefined ? '-' : Math.floor(job.context_pct / 5) * 5;
      const cacheKey = `${job.id}|${job.status ?? '-'}|${ctxBucket}|${width}|${row.depth}|${selected ? '1' : '0'}|${datePrefix ? '1' : '0'}`;
      const cached = this.processRowCache.get(cacheKey);
      if (cached !== undefined) return cached;
      // datePrefix is rendered through theme via paint() to keep the no-raw-ANSI invariant.
      // Per-row try/catch is a backstop for any future render-time drift; the
      // upstream isWellFormedJob filter + theme.ts:asString coercion should
      // make this branch dead code in practice. (unitAI-ctb4u.27)
      try {
        const rendered = datePrefix
          ? truncateToWidth(paint(datePrefix, 'dim') + renderJobRow(job, Math.max(1, width - datePrefix.length), row.depth, selected), width)
          : renderJobRow(job, width, row.depth, selected);
        this.processRowCache.set(cacheKey, rendered);
        return rendered;
      } catch (error) {
        logError(this.logViewKey(), 'render', { errorClass: errorClassOf(error) });
        return renderPlaceholder('  ?? <malformed row dropped>', width);
      }
    });
  }

  // Drop the per-row paint cache. Called on repo switch so the new
  // repo's rows are painted fresh, and on tombstone delivery so removed
  // jobs don't linger as ghost entries in the cache (unitAI-ctb4u.21).
  private invalidateProcessRowCache(): void {
    this.processRowCache.clear();
  }

  private renderFeedRows(width: number, viewportRows: number): string[] {
    const lines = this.feedLines(this.state.feedRows, width);
    const rows = lines.length > 0 ? lines : [renderPlaceholder('no feed events found', width)];
    this.renderedDetailRows = rows.length;
    const maxScroll = Math.max(0, rows.length - Math.max(1, viewportRows));
    const scroll = this.state.follow
      ? maxScroll
      : Math.max(0, Math.min(this.state.scroll, maxScroll));
    return [...visibleSlice(rows, scroll, viewportRows)];
  }

  private renderJobRows(width: number, viewportRows: number): string[] {
    const inspect = this.state.jobInspect;
    if (!inspect) {
      this.renderedDetailRows = 1;
      return [renderPlaceholder('loading job inspect…', width)];
    }
    const rows = [
      renderSectionTitle('inspect', width),
      ...inspect.fields.map((field) => renderInspectField(field.label, field.value, width)),
      renderSectionTitle('actions', width),
      renderPlaceholder(inspect.actions.join(' | ') || 'none', width),
    ];
    this.renderedDetailRows = rows.length;
    return visibleSlice(rows, this.state.scroll, viewportRows).map((row) => truncateToWidth(row, width));
  }

  private renderResultRows(width: number, viewportRows: number): string[] {
    const result = this.state.jobResult;
    if (!result) {
      this.renderedDetailRows = 1;
      return [renderPlaceholder('loading result…', width)];
    }
    const rows = [
      renderResultTitle(result.title, width),
      renderSectionTitle('output', width),
      ...wrapTextWithAnsi(result.output, width),
      renderSectionTitle('footer', width),
      renderResultFooter(result.footer, width),
    ];
    this.renderedDetailRows = rows.length;
    const maxScroll = Math.max(0, rows.length - Math.max(1, viewportRows));
    const scroll = Math.max(0, Math.min(this.state.scroll, maxScroll));
    return visibleSlice(rows, scroll, viewportRows).map((row) => truncateToWidth(row, width));
  }

  private feedLines(rows: readonly { line: string }[], width: number): string[] {
    return rows.flatMap((row) => wrapTextWithAnsi(row.line, width));
  }

  private detailJobLabel(): string | undefined {
    if (this.state.view === 'ps' || !this.state.selectedJobId) return undefined;
    const job = this.findSelectedJob();
    const specialist = job?.specialist ?? 'specialist';
    if (this.state.view === 'bead') {
      const beadId = job?.bead_id ?? this.state.beadDoc?.beadId ?? '(unlinked)';
      return `bead · ${beadId}`;
    }
    if (this.state.view === 'feed') {
      return `feed · ${specialist}:${this.state.selectedJobId} · ${this.state.feedSource}`;
    }
    return `${this.state.view} · ${specialist}:${this.state.selectedJobId}`;
  }

  private findSelectedJob(): ConsoleJob | undefined {
    const id = this.state.selectedJobId;
    if (!id) return undefined;
    return (
      this.state.snapshot?.jobs.find((job) => job.id.startsWith(id)) ??
      this.state.jobInspect?.job ??
      this.state.jobResult?.job ??
      undefined
    );
  }

  private mainViewportRows(): number {
    const overhead = CHROME_ROWS + (this.state.filtering ? 1 : 0) + (this.state.message ? 1 : 0);
    return Math.max(1, this.options.rows() - overhead);
  }
}

// Diff section titles signal which lookup path produced the rendering so the
// operator knows whether they're looking at a live worktree patch or the
// historical SHA snapshot (unitAI-ctb4u.29).
export function diffSummaryTitle(summary?: DiffSummary): string {
  if (summary?.source === 'commit' && summary.commitSha) {
    return `diff summary · @${summary.commitSha.slice(0, 7)} (commit)`;
  }
  return 'diff summary';
}

export function diffFileTitle(file: DiffFile): string {
  if (file.source === 'commit' && file.commitSha) {
    return `${file.path} · @${file.commitSha.slice(0, 7)} (commit)`;
  }
  return file.path;
}

function structuredCloneCompat<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export function fitFrame(lines: string[], width: number, height: number): string[] {
  const frame = lines.slice(0, height).map((line) => truncateToWidth(line, width));
  while (frame.length < height) frame.push(fillerLine(width));
  return frame;
}
