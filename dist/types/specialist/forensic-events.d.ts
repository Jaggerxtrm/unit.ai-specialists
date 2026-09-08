export declare const FORENSIC_SCHEMA_VERSION: "xtrm.forensic.v1";
export declare function deploymentEnvironment(): string;
export type ForensicSeverity = 'debug' | 'info' | 'warn' | 'error' | 'critical';
export type RedactionStatus = 'clean' | 'redacted' | 'unknown';
export interface ForensicResource {
    service_namespace: string;
    service_name: string;
    service_component: string;
    deployment_environment: string;
    repo: string;
    service_version?: string;
    runtime?: string;
    participant_kind?: string;
    participant_role?: string;
    model_provider?: string;
    model?: string;
    worktree_mode?: string;
    chain_kind?: string;
    [key: string]: unknown;
}
export interface ForensicCorrelation {
    participant_id?: string;
    job_id?: string;
    bead_id?: string;
    issue_id?: string;
    container_id?: string;
    attempt_id?: string;
    pi_session_id?: string;
    workspace_id?: string;
    chain_id?: string;
    chain_root_job_id?: string;
    chain_root_bead_id?: string;
    epic_id?: string;
    node_id?: string;
    pulse_id?: string;
    turn_id?: string;
    tool_call_id?: string;
    trace_id?: string;
    span_id?: string;
    parent_span_id?: string;
    session_id?: string;
    conversation_id?: string;
    mcp_session_id?: string;
    jsonrpc_request_id?: string;
    eval_id?: string;
    policy_decision_id?: string;
    identity_request_id?: string;
    commit_sha?: string;
    /**
     * xtmux runtime-origin: parent specialist job id (spec §13.5).
     * Set only for child jobs whose spawn_origin.kind === 'specialist.job'.
     * Never promoted to a Prometheus label — see FORBIDDEN_PROMETHEUS_LABELS.
     */
    parent_job_id?: string;
    [key: string]: unknown;
}
/**
 * Typed spawn-lineage link on `job.started` (spec §13.5).
 *
 * A direct spawn from a pane emits `xtmux.agent_instance`. A child spawned
 * by another specialist emits `specialist.job`. The reader sees at most one
 * `links.spawned_by` entry — never a `kind:'unknown'` placeholder.
 */
export type ForensicSpawnedByLink = {
    kind: 'xtmux.agent_instance';
    host_id: string;
    tmux_session_id: string;
    tmux_window_id: string;
    tmux_pane_id: string;
    agent_instance_id?: string;
} | {
    kind: 'specialist.job';
    job_id: string;
};
/**
 * Compact projection of the root pane origin (spec §13.5). Only the fields
 * needed to reconnect a job to its originating pane; no bead_id / server_id /
 * captured_at_ms / capture_source / verified — those live on the source
 * RuntimeOriginV1 in status_json and are not part of the durable forensic link.
 */
export interface ForensicRootRuntimeOrigin {
    kind: 'xtmux.agent_instance';
    host_id: string;
    tmux_pane_id: string;
    agent_instance_id?: string;
}
export interface ForensicRedaction {
    status: RedactionStatus;
    fields?: string[];
    rules?: string[];
}
export interface ForensicEvent<TBody extends Record<string, unknown> = Record<string, unknown>> {
    schema_version: typeof FORENSIC_SCHEMA_VERSION;
    timestamp: string;
    t_unix_ms: number;
    seq?: number;
    severity: ForensicSeverity;
    event_family: string;
    event_name: string;
    event_version: number;
    resource: ForensicResource;
    correlation: ForensicCorrelation;
    body: TBody;
    redaction: ForensicRedaction;
    trace?: Record<string, unknown>;
    otel?: Record<string, unknown>;
    links?: Record<string, unknown>;
    diagnostics?: Record<string, unknown>;
}
export interface CreateForensicEventOptions<TBody extends Record<string, unknown> = Record<string, unknown>> {
    event_family: string;
    event_name: string;
    resource: ForensicResource;
    correlation?: ForensicCorrelation;
    body?: TBody;
    severity?: ForensicSeverity;
    event_version?: number;
    redaction?: ForensicRedaction;
    t_unix_ms?: number;
    timestamp?: string;
    seq?: number;
    trace?: Record<string, unknown>;
    otel?: Record<string, unknown>;
    links?: Record<string, unknown>;
    diagnostics?: Record<string, unknown>;
}
export declare const FORBIDDEN_PROMETHEUS_LABELS: Set<string>;
export declare const DEFAULT_LABEL_ALLOWLIST: Set<string>;
interface RedactionResult<T = unknown> {
    value: T;
    fields: string[];
    rules: string[];
}
export declare function redactForensicValue<T>(value: T, path?: string): RedactionResult<T>;
export declare function createForensicEvent<TBody extends Record<string, unknown> = Record<string, unknown>>(options: CreateForensicEventOptions<TBody>): ForensicEvent<TBody>;
export declare function normalizeResource(resource: ForensicResource): ForensicResource;
export interface ParticipantIdentityInput {
    participant_kind?: string;
    participant_role: string;
    chain_id?: string;
    container_id?: string;
    session_uuid?: string;
    node_id?: string;
    member_index?: number;
    adapter_id?: string;
}
export declare function deriveParticipantId(input: ParticipantIdentityInput): string;
export declare function assertKnownTopLevelFields(event: Record<string, unknown>): void;
export declare function assertNoForbiddenLabels(labels: Record<string, unknown>): void;
export declare function pickAllowedLabels(source: Record<string, unknown>, allowlist?: Set<string>): Record<string, string>;
export interface TimelineForensicContext {
    jobId: string;
    specialist: string;
    beadId?: string;
    nodeId?: string;
    repo?: string;
    serviceComponent?: string;
    model?: string;
    backend?: string;
    chainKind?: string;
    chainId?: string;
    chainRootJobId?: string;
    chainRootBeadId?: string;
    epicId?: string;
    sessionId?: string;
    attemptId?: string;
    piSessionId?: string;
    workspaceId?: string;
    conversationId?: string;
    traceId?: string;
    spanId?: string;
    parentSpanId?: string;
    parentJobId?: string;
    spawnOrigin?: unknown;
    rootRuntimeOrigin?: unknown;
}
/** Origin-source enum for `run_start` body (spec §13.5). */
export type ForensicOriginSource = 'xtmux-context' | 'propagated' | 'child-of-specialist' | 'none';
/**
 * Project the persisted spawn_origin into a strictly-shaped
 * `links.spawned_by` payload. Whitelists exact keys — future extra fields on
 * RuntimeOriginV1 require a deliberate change here, not silent pass-through.
 * Returns undefined if the input is unset, malformed, or `kind:'unknown'`.
 */
export declare function projectSpawnedByLink(spawnOrigin: unknown): ForensicSpawnedByLink | undefined;
/**
 * Project the persisted root_runtime_origin into a compact
 * `links.root_runtime_origin` payload. Same whitelist rules as above.
 */
export declare function projectRootRuntimeOrigin(rootRuntimeOrigin: unknown): ForensicRootRuntimeOrigin | undefined;
export declare function forensicEventFromTimelineEvent(event: {
    t: number;
    seq?: number;
    type: string;
    [key: string]: unknown;
}, context: TimelineForensicContext): ForensicEvent;
export {};
//# sourceMappingURL=forensic-events.d.ts.map