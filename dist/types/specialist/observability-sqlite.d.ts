/**
 * The sqlite driver, resolved at first use — `bun:sqlite` when running under bun, and
 * `node:sqlite` otherwise, behind a shim that presents bun's surface.
 *
 * The node path is not a convenience. `pi` ships with `#!/usr/bin/env node`, so every
 * in-process activation — including the Pi extension, which the PRD calls the PRIMARY
 * coordinator surface — runs under node. With bun-only loading, `require('bun:sqlite')`
 * threw MODULE_NOT_FOUND, the client came back null, the sink degraded to a no-op, and
 * every such activation wrote ZERO forensic rows while appearing to succeed. Measured in
 * an interactive TUI run and independently noticed by the operator as "job progress is not
 * being persisted" (unitAI-rrdnt.37.1.1).
 *
 * Both drivers write the same file, which the bun CLI reads. Returning null remains a
 * supported outcome — an older node without `node:sqlite` degrades to the no-op sink
 * exactly as before, because a forensics failure must never fail an activation.
 */
type BunDb = any;
import type { TimelineEvent, TimelineEventTool } from './timeline-events.js';
import { type ForensicEvent } from './forensic-events.js';
import type { BranchIntegrationEvent } from './branch-integration-events.js';
import type { SupervisorStatus } from './supervisor.js';
import type { EpicChainRecord, EpicRunRecord } from './epic-lifecycle.js';
import type { PersistedChainIdentity } from './chain-identity.js';
export declare function parseJournalMode(mode: string | null | undefined): string | null;
export declare function enforceWalMode(db: BunDb): void;
export declare function verifyWalMode(db: BunDb): void;
export declare function initSchema(db: BunDb): void;
export type NodeRunStatus = 'created' | 'starting' | 'running' | 'waiting' | 'degraded' | 'awaiting_merge' | 'fixing_after_review' | 'failed' | 'error' | 'done' | 'stopped';
export type NodeEventType = 'node_created' | 'node_started' | 'node_state_changed' | 'member_started' | 'member_state_changed' | 'member_output_received' | 'member_failed' | 'member_recovered' | 'member_respawned' | 'member_job_rebound' | 'member_disabled' | 'coordinator_resumed' | 'coordinator_resume_state' | 'coordinator_resume_skipped' | 'coordinator_first_turn_context_built' | 'coordinator_output_received' | 'coordinator_output_invalid' | 'coordinator_repair_requested' | 'memory_updated' | 'memory_patch_rejected' | 'memory_patch_deduplicated' | 'action_queued' | 'action_written' | 'action_observed' | 'action_superseded' | 'action_completed' | 'action_failed' | 'action_dropped' | 'node_recovered' | 'node_waiting' | 'node_done' | 'node_error' | 'node_stopped' | 'phase_started' | 'phase_completed' | 'bead_created' | 'worktree_provisioned' | 'member_spawned_dynamic' | 'member_replaced' | 'coordinator_restarted' | 'pr_created' | 'pr_updated' | 'node_completed';
export interface NodeRunRow {
    id: string;
    node_name: string;
    status: NodeRunStatus;
    coordinator_job_id?: string;
    started_at_ms?: number;
    updated_at_ms: number;
    waiting_on?: string;
    error?: string;
    memory_namespace?: string;
    status_json: string;
    pr_number?: number;
    pr_url?: string;
    pr_head_sha?: string;
    gate_results?: string;
    completion_strategy?: string;
}
export interface NodeMemberRow {
    node_run_id: string;
    member_id: string;
    job_id?: string;
    specialist: string;
    model?: string;
    role?: string;
    status: string;
    enabled?: boolean;
    generation?: number;
    worktree_path?: string;
    parent_member_id?: string;
    replaced_member_id?: string;
    phase_id?: string;
}
export interface NodeMemoryRow {
    node_run_id: string;
    namespace?: string;
    entry_type?: 'fact' | 'question' | 'decision';
    entry_id?: string;
    summary?: string;
    source_member_id?: string;
    confidence?: number;
    provenance_json?: string;
    created_at_ms?: number;
    updated_at_ms?: number;
}
export interface ChainEpicLinkRecord {
    chain_id: string;
    epic_id?: string;
    chain_root_job_id?: string;
    chain_root_bead_id?: string;
}
export interface MemoryCacheState {
    lastSyncAtMs: number;
    memoryCount: number;
}
export interface MemoryCacheInputRecord {
    key: string;
    value: string;
}
export interface RelevantMemoryRecord {
    key: string;
    value: string;
    bm25: number;
    recency: number;
    accessFrequency: number;
    score: number;
}
export interface EpicChainLatestJobRecord {
    chain_id: string;
    epic_id: string;
    chain_root_bead_id?: string;
    chain_root_job_id?: string;
    job_id: string;
    status?: string;
    branch?: string;
    updated_at_ms: number;
}
export interface PruneObservabilityOptions {
    beforeMs: number;
    includeEpics: boolean;
    apply: boolean;
    nowMs?: number;
    eventsRetentionMs?: number;
    skipExtract?: boolean;
}
export interface ForensicEventRecord {
    id: number;
    job_id: string;
    seq: number;
    t: number;
    schema_version: string;
    event_family: string;
    event_name: string;
    participant_kind: string | null;
    participant_role: string | null;
    participant_id: string | null;
    attempt_id?: string | null;
    redaction_status: string;
    event_json: string;
}
export interface ListForensicEventsFilters {
    jobId?: string;
    sinceMs?: number;
    eventFamily?: string;
    eventName?: string;
    limit?: number;
    order?: 'asc' | 'desc';
}
export interface JobMetricsRecord {
    job_id: string;
    specialist: string;
    model: string | null;
    status: string;
    chain_kind: string | null;
    chain_id: string | null;
    bead_id: string | null;
    node_id: string | null;
    epic_id: string | null;
    started_at_ms: number | null;
    completed_at_ms: number | null;
    elapsed_ms: number | null;
    active_runtime_ms: number | null;
    waiting_ms: number | null;
    total_turns: number;
    total_tools: number;
    tool_call_counts_json: string;
    token_trajectory_json: string;
    context_trajectory_json: string;
    stall_gaps_json: string;
    run_complete_json: string | null;
    startup_payload_json: string | null;
    updated_at_ms: number;
}
export interface PruneObservabilityReport {
    dryRun: boolean;
    beforeMs: number;
    eventsCutoffMs: number;
    includeEpics: boolean;
    deletedEvents: number;
    deletedResults: number;
    deletedJobs: number;
    deletedEpicRuns: number;
    skippedActiveChainJobs: number;
    extractedJobs: number;
}
export interface OrphanScanFinding {
    kind: 'orphan' | 'stale-pointer' | 'integrity-violation';
    code: 'chain_membership_without_jobs' | 'epic_without_chains' | 'job_epic_without_membership' | 'worktree_missing_on_disk';
    message: string;
    details: Record<string, string | number | boolean | null>;
}
type ClaimJobStartResult = {
    ok: true;
} | {
    ok: false;
    existingJobId: string;
    existingStatus: string;
};
interface ActiveJobRow {
    job_id?: string;
    status?: string;
    pid?: number;
    updated_at_ms?: number;
}
interface ClaimJobStartStore {
    transaction<T>(callback: () => T): T;
    findActiveJob(beadId: string | null, specialist: string): ActiveJobRow | undefined;
    writeStatusRow(status: SupervisorStatus): void;
    writeEventRow(jobId: string, specialist: string, beadId: string | undefined, event: TimelineEvent): void;
    /** Mark a stale claim row as cancelled. Optional for backward-compat with simpler test stores. */
    cancelStaleClaim?(jobId: string): void;
}
/** Minimum age for a 'starting'/'running' row to be considered orphaned and reclaim-eligible. */
export declare const STALE_CLAIM_AGE_MS = 60000;
export interface ClaimJobStartOptions {
    isPidAlive?: (pid: number | undefined) => boolean;
    nowMs?: () => number;
    staleClaimAgeMs?: number;
}
export declare function claimJobStartWithStore(store: ClaimJobStartStore, status: SupervisorStatus, event: TimelineEvent, options?: ClaimJobStartOptions): ClaimJobStartResult;
/**
 * Durable PR/base drift state for a specialist job (specialists-05q.1).
 *
 * Bridge → substrate mapping (specialists-roadmap §B.3): every field renames 1:1 onto
 * `containers.*` when the substrate daemon ships (`pr_*` → `containers.pr_*`,
 * `base_sha_pinned*` → `containers.base_sha_pinned*`). Pre-substrate columns live on
 * `specialist_jobs`; mirror on `SupervisorStatus` for serialization symmetry.
 *
 * Schema/model only — refresh logic (GitHub/git lookup, classification, attention scoring)
 * is owned by specialists-05q.2. Fields are populated lazily; `null` is a meaningful "checked
 * and unset" value, `undefined` is "never checked".
 */
export interface PrDriftState {
    /** PR URL as recorded by xt at PR creation. */
    pr_url: string | null;
    /** Head SHA observed at last drift check. */
    pr_head_sha: string | null;
    /** Raw GitHub PR state (open / closed / merged / draft). */
    pr_state: string | null;
    /** Raw GitHub merge state (clean / dirty / blocked / behind / unstable / unknown / has_hooks). */
    pr_merge_state: string | null;
    /** Local classification derived from raw state (clean / behind / conflicted / unknown / dead).
     *  Distinct from `pr_merge_state` so a future GitHub label change does not silently shift the
     *  semantics specialists relies on for attention scoring. */
    pr_classification: string | null;
    /** Base branch ref (e.g. "master"). */
    pr_base_ref: string | null;
    /** Observed base tip SHA at last drift check — compared against `base_sha_pinned`
     *  to detect commits-behind without re-fetching. */
    pr_base_sha: string | null;
    /** Epoch ms when drift state was last computed. */
    pr_drift_checked_at_ms: number | null;
    /** Base SHA pinned at chain start (specialists-05q.3 / Opp 7 extension). Used as the
     *  authoritative "what this run measured against" reference. */
    base_sha_pinned: string | null;
    /** Epoch ms when the base SHA pin was set. */
    base_sha_pinned_at_ms: number | null;
}
/** Partial update of {@link PrDriftState}. Omitted keys are left unchanged; explicit `null` clears. */
export type PrDriftStatePatch = Partial<PrDriftState>;
export interface ListBranchIntegrationFilters {
    targetBranch?: string;
    sourceJobId?: string;
    limit?: number;
}
export interface BranchIntegrationEventRecord {
    id: number;
    t: number;
    event: BranchIntegrationEvent;
}
export interface ObservabilityIdentityProjection {
    /** Runtime-owned attempt identity. Omit on legacy writes to retain automatic sequencing. */
    attemptId: string;
    attemptNo: number;
}
export interface ObservabilitySqliteClient {
    upsertStatus(status: SupervisorStatus, identity?: ObservabilityIdentityProjection): void;
    markSpecialistJobCancelled(jobId: string, reason: string): void;
    upsertEpicRun(epic: EpicRunRecord): void;
    upsertEpicChainMembership(chain: EpicChainRecord): void;
    upsertStatusWithEvent(status: SupervisorStatus, event: TimelineEvent): void;
    upsertStatusWithEvents(status: SupervisorStatus, events: readonly TimelineEvent[], identity?: ObservabilityIdentityProjection): void;
    upsertStatusWithEventAndResult(status: SupervisorStatus, event: TimelineEvent, output: string): void;
    appendEvent(jobId: string, specialist: string, beadId: string | undefined, event: TimelineEvent, identity?: ObservabilityIdentityProjection): void;
    appendForensicEvent(jobId: string, specialist: string, beadId: string | undefined, forensicEvent: ForensicEvent): void;
    recordBranchIntegration(event: BranchIntegrationEvent): void;
    listBranchIntegrations(filters?: ListBranchIntegrationFilters): BranchIntegrationEventRecord[];
    claimJobStart(status: SupervisorStatus, event: TimelineEvent): {
        ok: true;
    } | {
        ok: false;
        existingJobId: string;
        existingStatus: string;
    };
    findActiveJob(beadId: string | null, specialist: string): {
        job_id?: string;
        status?: string;
        pid?: number;
        updated_at_ms?: number;
    } | undefined;
    upsertResult(jobId: string, output: string): void;
    bootstrapNode(nodeRunId: string, nodeName: string, memoryNamespace?: string): void;
    upsertNodeRun(nodeRun: NodeRunRow): void;
    upsertNodeMember(member: NodeMemberRow): void;
    appendNodeEvent(nodeRunId: string, t: number, type: NodeEventType, eventJson: unknown): void;
    upsertNodeMemory(entry: NodeMemoryRow): void;
    upsertNodeRunWithEvent(nodeRun: NodeRunRow, t: number, type: NodeEventType, eventJson: unknown): void;
    upsertNodeMemberWithEvent(member: NodeMemberRow, nodeRunId: string, t: number, type: NodeEventType, eventJson: unknown): void;
    upsertNodeMemoryWithEvent(entry: NodeMemoryRow, nodeRunId: string, t: number, type: NodeEventType, eventJson: unknown): void;
    readNodeRun(nodeRunId: string): NodeRunRow | null;
    listNodeRuns(filter?: {
        status?: NodeRunStatus;
    }): NodeRunRow[];
    listNodeRunsByRef(partialRef: string, statuses: readonly NodeRunStatus[]): NodeRunRow[];
    listNodeRunsByStatuses(statuses: readonly NodeRunStatus[]): NodeRunRow[];
    readNodeMembers(nodeRunId: string): NodeMemberRow[];
    readNodeEvents(nodeRunId: string, opts?: {
        type?: NodeEventType;
        limit?: number;
    }): Array<{
        id: number;
        seq: number;
        t: number;
        type: string;
        event_json: string;
    }>;
    readNodeMemory(nodeRunId: string, opts?: {
        namespace?: string;
        entry_type?: 'fact' | 'question' | 'decision';
    }): NodeMemoryRow[];
    queryMemberContextHealth(jobId: string): number | null;
    readStatus(jobId: string): SupervisorStatus | null;
    listStatuses(): SupervisorStatus[];
    /** Read durable PR/base drift state for a job. Returns null when the job row is missing.
     *  Specialists-05q.1: schema/model only — refresh logic lives in .2. */
    readPrDriftState(jobId: string): PrDriftState | null;
    /** Write durable PR/base drift state to specialist_jobs columns. Partial updates supported;
     *  passing `null` clears a field; omitting a field leaves it unchanged. Returns true on
     *  successful row touch, false when the job row does not exist. Updates `updated_at_ms`. */
    updatePrDriftState(jobId: string, drift: PrDriftStatePatch): boolean;
    /** List stale specialist job rows that may be dead after container restart.
     *  Core predicate: status IN ('starting','running','waiting') AND pid IS NOT NULL
     *  AND updated_at_ms < (nowMs - minAgeMs).  ORDER BY updated_at_ms ASC LIMIT 200.
     *  @param opts.minAgeMs minimum age in ms to consider a row stale. Default 60_000.
     *  @param opts.nowMs epoch ms anchor. Default Date.now().
     *  @returns rows with job_id, specialist, status, pid, updated_at_ms, bead_id, chain_id */
    listStaleSpecialistJobs(opts?: {
        minAgeMs?: number;
        nowMs?: number;
    }): Array<{
        job_id: string;
        specialist: string;
        status: string;
        pid: number;
        updated_at_ms: number;
        bead_id: string | null;
        chain_id: string | null;
    }>;
    /** List jobs with PR URLs that haven't been checked recently, ordered by
     *  pr_drift_checked_at_ms ascending (NULLs first). Limit 50.
     *  @param olderThanMs Epoch ms threshold; rows with pr_drift_checked_at_ms
     *    >= olderThanMs are excluded. Defaults to Date.now() - 5*60*1000 (5 min). */
    listJobsNeedingPrDriftRefresh(olderThanMs?: number): Array<{
        job_id: string;
        pr_url: string;
        pr_head_sha: string | null;
        pr_drift_checked_at_ms: number | null;
        branch: string | null;
    }>;
    removeJobs(jobIds: readonly string[]): number;
    readEpicRun(epicId: string): EpicRunRecord | null;
    listEpicRuns(): EpicRunRecord[];
    resolveEpicByChainId(chainId: string): EpicChainRecord | null;
    resolveEpicByChainRootBeadId(chainRootBeadId: string): EpicChainRecord | null;
    listEpicChains(epicId: string): EpicChainRecord[];
    deleteEpicChainMembership(epicId: string, chainIds: readonly string[]): string[];
    listReferencedChainRootJobIds(): string[];
    listEpicChainsWithLatestJob(epicId: string): EpicChainLatestJobRecord[];
    readChainIdentity(jobId: string): PersistedChainIdentity | null;
    listChainJobIds(chainId: string): string[];
    listLiveJobsForBead(beadId: string): string[];
    resolveChainEpicLinkByJobId(jobId: string): ChainEpicLinkRecord | null;
    readEvents(jobId: string): TimelineEvent[];
    readEventsAfterSeq(jobId: string, afterSeq: number): TimelineEvent[];
    readForensicEvents(filters?: ListForensicEventsFilters): ForensicEventRecord[];
    readLatestToolEvent(jobId: string): TimelineEventTool | null;
    getLastActivityTimestampMs(jobId: string): number | null;
    aggregateJobMetrics(jobId: string): JobMetricsRecord | null;
    listJobMetrics(filters?: {
        spec?: string;
        model?: string;
        sinceMs?: number;
    }): JobMetricsRecord[];
    listElapsedMsBySpecialist(sinceMs: number, limitPerSpecialist?: number): Record<string, number[]>;
    readResult(jobId: string): string | null;
    syncMemoriesCache(memories: readonly MemoryCacheInputRecord[], syncedAtMs?: number): void;
    getMemoriesCacheState(): MemoryCacheState | null;
    queryRelevantMemories(keywords: readonly string[], limit?: number, nowMs?: number): RelevantMemoryRecord[];
    invalidateMemoriesCache(): void;
    hasActiveJobs(statuses?: readonly string[]): boolean;
    listActiveJobs(statuses?: readonly string[]): Array<{
        job_id: string;
        specialist: string;
        status: string;
    }>;
    getDatabaseSizeBytes(): number;
    vacuumDatabase(): {
        beforeBytes: number;
        afterBytes: number;
    };
    pruneObservabilityData(options: PruneObservabilityOptions): PruneObservabilityReport;
    scanOrphans(): OrphanScanFinding[];
    close(): void;
}
export declare function hasRunCompleteEvent(jobId: string, cwd?: string): boolean;
export declare function createObservabilitySqliteClient(cwd?: string): ObservabilitySqliteClient | null;
export declare function createObservabilitySqliteClientAtPath(dbPath: string): ObservabilitySqliteClient | null;
export {};
//# sourceMappingURL=observability-sqlite.d.ts.map