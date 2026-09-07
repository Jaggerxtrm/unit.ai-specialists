import type { ConsoleJob, ProcessSnapshot } from './types.js';
export type ThemeColor = 'txt' | 'bright' | 'dim' | 'rail' | 'sel' | 'running' | 'done' | 'reviewing' | 'waiting' | 'idle' | 'blocked';
export declare function paint(text: string, color: ThemeColor): string;
export declare function paintBg(text: string, color: ThemeColor): string;
export declare const STATUS_GLYPH: {
    readonly running: "●";
    readonly waiting: "◐";
    readonly starting: "◐";
    readonly done: "○";
    readonly error: "✕";
    readonly cancelled: "○";
    readonly dead: "✕";
};
export declare const CONTAINER_GLYPH: {
    readonly epic: "◆";
    readonly chain: "◇";
    readonly node: "▦";
};
export declare function statusColor(status: string, dead?: boolean): ThemeColor;
export declare function statusGlyph(status: string, dead?: boolean): string;
export declare function ctxColor(pct?: number): ThemeColor;
export type JobColumnKey = 'id' | 'spec' | 'status' | 'ctxPct' | 'elapsed' | 'payloadKb' | 'payloadTok' | 'bead' | 'next' | 'title';
export declare const COLUMNS: Record<JobColumnKey, {
    width: number;
    align: 'L' | 'R';
}>;
export declare function padR(s: string, n: number): string;
export declare function padL(s: string, n: number): string;
export declare function truncEllipsis(s: string, n: number): string;
export declare function renderRail(depth: number): string;
export declare function composeElapsed(job: ConsoleJob): string;
export declare function jobRowFieldValues(job: ConsoleJob): Record<JobColumnKey, string>;
export declare function selectJobColumns(width: number, depth: number): JobColumnKey[];
export declare function renderJobRow(job: ConsoleJob, width: number, depth: number, selected: boolean): string;
export type GroupKind = 'epic' | 'chain' | 'node' | 'branch' | 'worktree' | 'label';
export declare function renderGroupRow(kind: GroupKind, label: string, width: number, depth: number): string;
export declare function renderStatsLine(snapshot: ProcessSnapshot | undefined, width: number): string;
export declare function renderRepoSectionHeader(name: string, path: string, activeCount: number, width: number): string;
export declare function renderKeyBar(view: string, follow: boolean, width: number, feedSource?: 'sp_feed' | 'forensic'): string;
export declare function renderTabs(repos: Array<{
    name: string;
}>, currentIndex: number, width: number, currentView?: string): string;
export interface MetersInput {
    active: number;
    activeTotal: number;
}
export declare function renderMeters(input: MetersInput, width: number): string;
export declare function renderViewtag(views: readonly string[], currentView: string, width: number): string;
export declare function renderSectionTitle(text: string, width: number): string;
export declare function fillerLine(width: number): string;
export declare function renderHeader(viewLabel: string, repoName: string, repoPath: string, width: number): string;
export declare function renderInspectField(label: string, value: string, width: number): string;
export declare function renderResultTitle(title: string, width: number): string;
export declare function renderResultFooter(footer: string, width: number): string;
export declare function renderMessage(message: string, width: number): string;
export declare function renderFilterPrompt(text: string, width: number): string;
export declare function renderPlaceholder(text: string, width: number): string;
export declare function renderConfigField(path: string, valueText: string, hint: string, width: number, flags?: {
    isOverride: boolean;
    isInherit: boolean;
    defaultValue?: string;
}): string;
export declare function renderConfigSpecialistRow(name: string, hasOverride: boolean, selected: boolean, width: number): string;
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
export declare function renderRepoConfigRow(row: RepoConfigRowInput, width: number, selected: boolean): string;
export declare function renderDiffSummaryRow(entry: {
    path: string;
    status: string;
    added: number;
    deleted: number;
    binary: boolean;
}, width: number, selected: boolean): string;
export declare function renderDiffHunkHeader(text: string, width: number): string;
export declare function renderDiffHunkLine(kind: 'context' | 'add' | 'del' | 'meta', text: string, width: number): string;
export declare function renderBeadField(key: string, value: string, width: number): string;
export declare function renderBeadBodyLine(line: string, width: number): string;
export declare function visibleLength(s: string): number;
//# sourceMappingURL=theme.d.ts.map