// src/specialist/supervisor.ts
// Wraps SpecialistRunner to provide file-based job state for background execution.

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import type { SpecialistRunner, RunOptions } from './runner.js';
import { resolveSpawnOrigin, validateRuntimeOrigin, type RuntimeOriginV1, type SpecialistSpawnOriginV1 } from './runtime-origin.js';
import { resolveJobsDir, resolveCurrentBranch } from './job-root.js';
import { isJobFileOutputEnabled } from './job-file-output.js';
import type { BeadsClient } from './beads.js';
import {
  type TimelineEvent,
  type TimelineEventControlSignal,
  type TimelineEventRunComplete,
  TIMELINE_EVENT_TYPES,
  createRunStartEvent,
  createMetaEvent,
  createRunCompleteEvent,
  createStatusChangeEvent,
  createStaleWarningEvent,
  createTokenUsageEvent,
  createFinishReasonEvent,
  createTurnSummaryEvent,
  createCompactionEvent,
  createRetryEvent,
  createAutoCommitEvent,
  createControlSignalEvent,
  createCommandEvent,
  createReviewVerdictEvent,
  createChainEvent,
  mapCallbackEventToTimelineEvent,
} from './timeline-events.js';
import { buildGitDiffEvidence, willHunksBeInline, writeGitDiffHunksArtifact } from './git-diff-evidence.js';
import type { SessionMetricEvent, SessionRunMetrics, SessionTokenUsage } from '../pi/session.js';

type ActivePiSession = {
  close(): Promise<void>;
  kill(reason?: Error): void;
};
import type { StallDetectionConfig } from './loader.js';
import { createObservabilitySqliteClient, type ObservabilitySqliteClient } from './observability-sqlite.js';
import { resolveObservabilityDbLocation } from './observability-db.js';
import { resolveChainId } from './epic-lifecycle.js';
import { loadEpicReadinessSummary, syncEpicStateFromReadiness } from './epic-readiness.js';
import { derivePersistedChainIdentity } from './chain-identity.js';
import { isTmuxSessionAlive } from '../cli/tmux-utils.js';
import { parsePorcelainStatus } from './porcelain-parser.js';
import { createForensicEvent, deploymentEnvironment } from './forensic-events.js';

const JOB_TTL_DAYS = Number(process.env.SPECIALISTS_JOB_TTL_DAYS ?? 7);
const PARENT_NOTIFICATION_MAX_BYTES = 4 * 1024;
const PARENT_NOTIFICATION_TIMEOUT_MS = 5_000;

export interface MandatoryRulesInjectionProjection {
  sets_loaded: string[];
  rules_count: number;
  inline_rules_count: number;
  globals_disabled: boolean;
  token_estimate: number;
  budget_limit: number;
  candidate_tokens: number;
  injected_tokens: number;
  injected_section_ids: string[];
  evicted_section_ids: string[];
  payload_digest: string;
  outcome: 'full' | 'degraded' | 'impossible';
}

export function projectMandatoryRulesInjection(
  data: Partial<MandatoryRulesInjectionProjection>,
): MandatoryRulesInjectionProjection {
  return {
    sets_loaded: data.sets_loaded ?? [],
    rules_count: data.rules_count ?? 0,
    inline_rules_count: data.inline_rules_count ?? 0,
    globals_disabled: data.globals_disabled ?? false,
    token_estimate: data.token_estimate ?? 0,
    budget_limit: data.budget_limit ?? 0,
    candidate_tokens: data.candidate_tokens ?? 0,
    injected_tokens: data.injected_tokens ?? 0,
    injected_section_ids: data.injected_section_ids ?? [],
    evicted_section_ids: data.evicted_section_ids ?? [],
    payload_digest: data.payload_digest ?? '',
    outcome: data.outcome ?? 'full',
  };
}

export const STALL_DETECTION_DEFAULTS: Required<StallDetectionConfig> = {
  running_silence_warn_ms: 60_000,
  running_silence_error_ms: 300_000,
  waiting_stale_ms: 3_600_000,
  waiting_auto_close_ms: 0,
  tool_duration_warn_ms: 120_000,
};

const WAITING_AUTO_CLOSE_GRACE_MS = 5_000;

export type SupervisorJobStatus = 'starting' | 'running' | 'waiting' | 'done' | 'error' | 'cancelled';

export interface SupervisorStatus {
  id: string;
  specialist: string;
  status: SupervisorJobStatus;
  current_event?: string;
  current_tool?: string;
  model?: string;
  backend?: string;
  output_type?: string;
  pid?: number;
  started_at_ms: number;
  elapsed_s?: number;
  last_event_at_ms?: number;
  bead_id?: string;
  node_id?: string;
  session_id?: string;
  conversation_id?: string;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  session_file?: string;
  fifo_path?: string;
  tmux_session?: string;
  worktree_path?: string;
  reused_from_job_id?: string;
  worktree_owner_job_id?: string;
  chain_kind?: 'chain' | 'prep';
  chain_id?: string;
  chain_root_job_id?: string;
  chain_root_bead_id?: string;
  epic_id?: string;
  branch?: string;
  startup_payload_json?: string;
  startup_context?: {
    job_id?: string;
    specialist_name?: string;
    bead_id?: string;
    reused_from_job_id?: string;
    worktree_owner_job_id?: string;
    chain_id?: string;
    chain_root_job_id?: string;
    chain_root_bead_id?: string;
    worktree_path?: string;
    branch?: string;
    variables_keys?: string[];
    reviewed_job_id_present?: boolean;
    reused_worktree_awareness_present?: boolean;
    bead_context_present?: boolean;
    memory_injection?: {
      static_tokens: number;
      memory_tokens: number;
      gitnexus_tokens: number;
      total_tokens: number;
    };
    mandatory_rules_injection?: MandatoryRulesInjectionProjection;
    skills?: {
      count: number;
      activated: string[];
    };
    // Compact origin projection for run_start / status inspection.
    // Full origin lives in SupervisorStatus.spawn_origin / .root_runtime_origin.
    spawn_origin_kind?: 'xtmux.agent_instance' | 'specialist.job' | 'unknown';
    parent_job_id?: string;
    root_pane_id?: string;
    root_agent_instance_id?: string;
  };
  metrics?: SessionRunMetrics;
  context_pct?: number;
  context_health?: ContextHealth;
  error?: string;
  auto_commit_count?: number;
  last_auto_commit_sha?: string;
  last_auto_commit_at_ms?: number;
  // PR/base drift state (specialists-05q.1). Optional + nullable for back-compat with rows
  // written before schema V13. Mirrored to specialist_jobs columns for queryability via
  // ObservabilitySqliteClient.updatePrDriftState / readPrDriftState. Refresh logic lives in
  // specialists-05q.2 (refresh/attention) — this bead only carries the durable shape.
  // Bridge → substrate: each field renames 1:1 onto containers.* per specialists-roadmap §B.3.
  pr_url?: string;
  pr_head_sha?: string;
  pr_state?: string;
  pr_merge_state?: string;
  pr_classification?: string;
  pr_base_ref?: string;
  pr_base_sha?: string;
  pr_drift_checked_at_ms?: number;
  base_sha_pinned?: string;
  base_sha_pinned_at_ms?: number;
  // xtmux runtime origin binding (spec docs/xtmux-gaps.md §13.3).
  // Recorded once at initial status construction via resolveSpawnOrigin.
  spawn_origin?: SpecialistSpawnOriginV1;
  parent_job_id?: string;
  root_runtime_origin?: RuntimeOriginV1;
}

export type SupervisorStatusView = SupervisorStatus & { is_dead: boolean };

export interface SupervisorOptions {
  runner: SpecialistRunner;
  runOptions: RunOptions;
  /** Absolute path to .specialists/jobs/. Defaults to the git-common-root-anchored path. */
  jobsDir?: string;
  beadsClient?: BeadsClient;
  /** Optional callback to stream progress deltas to stdout/elsewhere */
  onProgress?: (delta: string) => void;
  /** Optional callback for meta events (backend/model) */
  onMeta?: (meta: { backend: string; model: string; sessionId?: string }) => void;
  /** Optional callback fired as soon as a job id is allocated and persisted */
  onJobStarted?: (job: { id: string }) => void;
  /** Stall detection thresholds — merged with STALL_DETECTION_DEFAULTS */
  stallDetection?: StallDetectionConfig;
}

export function emitParentNotification(statusSnapshot: SupervisorStatus, activeSiblingAssignee?: string): void {
  try {
    if (statusSnapshot.status !== 'done' && statusSnapshot.status !== 'error') return;
    if (statusSnapshot.spawn_origin?.kind !== 'xtmux.agent_instance') return;

    const parent = validateRuntimeOrigin(statusSnapshot.spawn_origin.runtime_origin);
    if ('error' in parent || !parent.verified) return;

    const idempotencyKey = `${statusSnapshot.id}:${statusSnapshot.status}`;
    const resultCommand = `sp result ${statusSnapshot.id} --json`;
    const payload = createForensicEvent({
      event_family: 'job',
      event_name: statusSnapshot.status === 'done' ? 'job.completed' : 'job.failed',
      resource: {
        service_namespace: 'xtrm',
        service_name: 'specialists',
        service_component: 'supervisor',
        deployment_environment: deploymentEnvironment(),
        repo: 'specialists',
        participant_kind: 'specialist',
        participant_role: statusSnapshot.specialist,
      },
      correlation: {
        job_id: statusSnapshot.id,
        ...(statusSnapshot.bead_id ? { bead_id: statusSnapshot.bead_id } : {}),
        ...(statusSnapshot.trace_id ? { trace_id: statusSnapshot.trace_id } : {}),
        ...(statusSnapshot.span_id ? { span_id: statusSnapshot.span_id } : {}),
        ...(statusSnapshot.parent_span_id ? { parent_span_id: statusSnapshot.parent_span_id } : {}),
      },
      body: {
        transition: statusSnapshot.status,
        job_id: statusSnapshot.id,
        specialist: statusSnapshot.specialist,
        parent: {
          kind: parent.kind,
          tmux_session_id: parent.tmux_session_id,
          tmux_pane_id: parent.tmux_pane_id,
          ...(parent.agent_instance_id ? { agent_instance_id: parent.agent_instance_id } : {}),
          verified: true,
        },
        summary: `Specialist ${statusSnapshot.specialist} job ${statusSnapshot.id} is ${statusSnapshot.status}.`,
        result_command: resultCommand,
        idempotency_key: idempotencyKey,
      },
      t_unix_ms: statusSnapshot.last_event_at_ms ?? statusSnapshot.started_at_ms,
    });
    const text = JSON.stringify(payload);
    if (Buffer.byteLength(text) > PARENT_NOTIFICATION_MAX_BYTES) {
      console.warn('[supervisor] Parent notification skipped: payload exceeds limit');
      return;
    }

    const args = [
      'message-send',
      '--to', parent.tmux_session_id,
      '--to-pane', parent.tmux_pane_id,
      ...(statusSnapshot.bead_id ? ['--bead', statusSnapshot.bead_id] : []),
      '--expects-reply=false',
      '--id', idempotencyKey,
      '--text', text,
      '--json',
    ];
    const result = spawnSync('xtmux', args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PARENT_NOTIFICATION_TIMEOUT_MS,
    });
    if (result.error || result.status !== 0) {
      console.warn(`[supervisor] Parent notification failed: exit=${result.status ?? 'unknown'}`);
    }

    if (!statusSnapshot.bead_id) return;
    const show = spawnSync('bd', ['show', statusSnapshot.bead_id, '--json'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PARENT_NOTIFICATION_TIMEOUT_MS,
    });
    if (show.error || show.status !== 0) {
      console.warn(`[supervisor] Parent bead assignee read failed: exit=${show.status ?? 'unknown'}`);
      return;
    }

    let currentAssignee: string | undefined;
    try {
      const bead = JSON.parse(show.stdout ?? '') as Array<{ assignee?: string }> | { assignee?: string };
      currentAssignee = Array.isArray(bead) ? bead[0]?.assignee : bead.assignee;
    } catch {
      console.warn('[supervisor] Parent bead assignee read failed: invalid bd show output');
      return;
    }
    const automaticAssignee = !currentAssignee
      || /^(?:(?:pi|claude)\/[a-z0-9]{5}|[a-z][a-z0-9-]*\/(?:[a-f0-9]{6}|job-[a-z0-9]+))$/i.test(currentAssignee);
    if (!automaticAssignee) {
      console.info(`[supervisor] Parent bead assignee preserved: ${statusSnapshot.bead_id}`);
      return;
    }

    const assignee = activeSiblingAssignee ?? `${statusSnapshot.specialist}/${statusSnapshot.id}`;
    const update = spawnSync('bd', ['update', statusSnapshot.bead_id, `--assignee=${assignee}`, '--json'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PARENT_NOTIFICATION_TIMEOUT_MS,
    });
    if (update.error || update.status !== 0) {
      console.warn(`[supervisor] Parent bead assignee update failed: exit=${update.status ?? 'unknown'}`);
    }
  } catch {
    console.warn('[supervisor] Parent notification failed: exception');
  }
}

function getCurrentGitSha(): string | undefined {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return undefined;
  const sha = result.stdout?.trim();
  return sha || undefined;
}

function normalizeHandoffModel(model: string): string {
  return model.split('/').at(-1) ?? model;
}

export function formatHandoffBlock(result: { output: string; promptHash?: string; durationMs?: number; model: string; backend: string; specialist: string; jobId: string; status: SupervisorJobStatus; timestamp: string; tokenUsage?: SessionTokenUsage; turnIndex?: number }, options: { final: boolean }): string {
  const statusToken = options.final
    ? `FINAL · ${result.status === 'cancelled' ? 'CANCELLED' : result.status === 'error' ? 'ERROR' : 'DONE'}`
    : result.status === 'waiting'
      ? 'WAITING'
      : 'WORKING';
  const model = normalizeHandoffModel(result.model);
  const header = options.final
    ? `## ${result.specialist} · ${model} · [${statusToken}]`
    : `### ${result.specialist} · ${model} · [turn ${result.turnIndex ?? 'unknown'} · ${statusToken}]`;
  const tokenUsage = result.tokenUsage;
  const gitSha = getCurrentGitSha();
  const footerParts = [
    options.final ? 'final' : `turn ${result.turnIndex ?? 'unknown'}`,
    result.durationMs !== undefined ? `${Math.round(result.durationMs)} ms` : undefined,
    tokenUsage?.input_tokens && tokenUsage?.output_tokens
      ? `${tokenUsage.input_tokens} to ${tokenUsage.output_tokens} tok`
      : tokenUsage?.input_tokens
        ? `${tokenUsage.input_tokens} tok in`
        : tokenUsage?.output_tokens
          ? `${tokenUsage.output_tokens} tok out`
          : undefined,
    result.timestamp ? new Date(result.timestamp).toISOString().slice(0, 16).replace('T', ' ') : undefined,
    gitSha ? `git ${gitSha.slice(0, 8)}` : undefined,
  ].filter((part): part is string => Boolean(part));
  const footer = footerParts.length > 0 ? `_${footerParts.join(' · ')}_` : '';
  return `\n\n${header}\n\n${result.output}${footer ? `\n\n${footer}` : ''}`;
}

export function shouldPersistHandoffBlock(params: { output: string; notesMode: 'full-trail' | 'final-only'; final: boolean }): boolean {
  if (!params.output.trim()) return false;
  if (params.notesMode === 'final-only' && !params.final) return false;
  return true;
}

const GITNEXUS_RISK_ORDER: Record<'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL', number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

type ContextHealth = 'OK' | 'MONITOR' | 'WARN' | 'CRITICAL';

const MODEL_CONTEXT_WINDOWS: Array<{ matcher: (model: string) => boolean; windowTokens: number }> = [
  { matcher: (model) => model.includes('gemini-3.1-pro'), windowTokens: 1_000_000 },
  { matcher: (model) => model.includes('qwen3.5') || model.includes('glm-5'), windowTokens: 128_000 },
  { matcher: (model) => model.includes('claude'), windowTokens: 200_000 },
];

const TERMINAL_COMPLIANCE_VERDICT_REGEX = /## Compliance Verdict[\s\S]*?- Verdict:\s*\**\s*(PASS|PARTIAL|FAIL|WAIVED)\s*\**/i;
const PASS_COMPLIANCE_VERDICT_REGEX = /## Compliance Verdict[\s\S]*?- Verdict:\s*\**\s*PASS\s*\**/i;
const REVIEW_VERDICT_REGEX = /## Compliance Verdict[\s\S]*?- Verdict:\s*\**\s*(PASS|PARTIAL|FAIL|WAIVED)\s*\**/i;

function getModelContextWindow(model: string | undefined): number | undefined {
  if (!model) return undefined;
  const normalizedModel = model.toLowerCase();
  return MODEL_CONTEXT_WINDOWS.find(({ matcher }) => matcher(normalizedModel))?.windowTokens;
}

function getContextHealth(contextPct: number): ContextHealth {
  if (contextPct < 40) return 'OK';
  if (contextPct <= 65) return 'MONITOR';
  if (contextPct <= 80) return 'WARN';
  return 'CRITICAL';
}

function parseReviewVerdict(output: string): 'pass' | 'partial' | 'fail' | 'waived' | undefined {
  const match = output.match(REVIEW_VERDICT_REGEX);
  if (!match?.[1]) return undefined;
  const verdict = match[1].toLowerCase();
  return verdict === 'pass' || verdict === 'partial' || verdict === 'fail' || verdict === 'waived' ? verdict : undefined;
}

function calculateContextUtilization(
  contextInputTokens: number,
  model: string | undefined,
): { context_pct: number; context_health: ContextHealth } | undefined {
  const contextWindow = getModelContextWindow(model);
  if (!contextWindow || contextInputTokens < 0) return undefined;

  const contextPct = (contextInputTokens / contextWindow) * 100;
  return {
    context_pct: Number(contextPct.toFixed(2)),
    context_health: getContextHealth(contextPct),
  };
}

function normalizeGitnexusRisk(value: unknown): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toUpperCase();
  if (normalized === 'LOW' || normalized === 'MEDIUM' || normalized === 'HIGH' || normalized === 'CRITICAL') {
    return normalized;
  }
  return undefined;
}

function collectStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function extractGitnexusFiles(tool: string, resultRaw?: Record<string, unknown>): string[] {
  if (!resultRaw) return [];
  if (tool === 'gitnexus_impact') {
    return collectStringArray(resultRaw.files);
  }
  if (tool === 'gitnexus_detect_changes') {
    return collectStringArray(resultRaw.files_changed);
  }
  return [];
}

function extractGitnexusSymbols(resultRaw?: Record<string, unknown>, args?: Record<string, unknown>): string[] {
  if (!resultRaw) return [];
  const symbols = [
    ...collectStringArray(resultRaw.symbols_analyzed),
    ...collectStringArray(resultRaw.affected_symbols),
    ...collectStringArray(resultRaw.symbols_modified),
  ];

  const argTarget = args?.target;
  if (typeof argTarget === 'string' && argTarget.trim().length > 0) {
    symbols.push(argTarget);
  }

  return symbols;
}

function extractGitnexusRisk(resultRaw?: Record<string, unknown>): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | undefined {
  if (!resultRaw) return undefined;
  const direct = normalizeGitnexusRisk(resultRaw.risk_level)
    ?? normalizeGitnexusRisk(resultRaw.riskLevel)
    ?? normalizeGitnexusRisk(resultRaw.highest_risk)
    ?? normalizeGitnexusRisk(resultRaw.risk);
  if (direct) return direct;

  const blastRadius = resultRaw.blast_radius;
  if (blastRadius && typeof blastRadius === 'object' && !Array.isArray(blastRadius)) {
    const blastRadiusRecord = blastRadius as Record<string, unknown>;
    return normalizeGitnexusRisk(blastRadiusRecord.risk_level)
      ?? normalizeGitnexusRisk(blastRadiusRecord.riskLevel)
      ?? normalizeGitnexusRisk(blastRadiusRecord.highest_risk)
      ?? normalizeGitnexusRisk(blastRadiusRecord.risk);
  }

  return undefined;
}

function isGitnexusAnalyzeRequired(permissionRequired: string | undefined): boolean {
  return permissionRequired === 'MEDIUM' || permissionRequired === 'HIGH';
}

export const AUTO_COMMIT_NOISE_PREFIXES = ['.xtrm/', '.wolf/', '.specialists/jobs/', '.beads/', '.pi/'] as const;

function isAutoCommitNoisePath(path: string): boolean {
  return AUTO_COMMIT_NOISE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function listSubstantiveWorktreeFiles(worktreePath: string): string[] {
  const status = spawnSync('git', ['status', '--porcelain'], {
    cwd: worktreePath,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (status.status !== 0) {
    throw new Error((status.stderr ?? status.stdout ?? 'git status failed').trim());
  }

  return parsePorcelainStatus(status.stdout ?? '')
    .filter((path) => !isAutoCommitNoisePath(path));
}

function buildAutoCommitMessage(specialist: string, beadId: string | undefined, turnNumber: number): string {
  const beadLabel = beadId ?? 'no-bead';
  return `checkpoint(${specialist}): ${beadLabel} turn ${turnNumber}`;
}

function runAutoCommitCheckpoint(options: {
  autoCommitPolicy: 'never' | 'checkpoint_on_waiting' | 'checkpoint_on_terminal' | undefined;
  target: 'waiting' | 'terminal';
  worktreePath: string | undefined;
  specialist: string;
  beadId: string | undefined;
  turnNumber: number;
  emitCommandEvent?: (status: 'completed' | 'failed', options: { command_kind: string; duration_ms?: number; command?: string; args?: string[]; exit_code?: number; stderr?: string; redacted?: boolean }) => void;
}):
  | { status: 'skipped'; reason: string }
  | { status: 'success'; sha: string; files: string[]; committedAtMs: number }
  | { status: 'failed'; reason: string } {
  const { autoCommitPolicy, target, worktreePath, specialist, beadId, turnNumber, emitCommandEvent } = options;
  if (!worktreePath) return { status: 'skipped', reason: 'no_worktree' };
  if (!autoCommitPolicy || autoCommitPolicy === 'never') return { status: 'skipped', reason: 'policy_never' };
  if (autoCommitPolicy === 'checkpoint_on_waiting' && target !== 'waiting') {
    return { status: 'skipped', reason: 'policy_waiting_only' };
  }
  if (autoCommitPolicy === 'checkpoint_on_terminal' && target !== 'terminal') {
    return { status: 'skipped', reason: 'policy_terminal_only' };
  }

  try {
    const substantiveFiles = listSubstantiveWorktreeFiles(worktreePath);
    if (substantiveFiles.length === 0) {
      return { status: 'skipped', reason: 'no_substantive_changes' };
    }

    const addStart = Date.now();
    const addResult = spawnSync('git', ['add', '--', ...substantiveFiles], {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const addDuration = Date.now() - addStart;
    if (addResult.status !== 0) {
      emitCommandEvent?.('failed', { command_kind: 'git', duration_ms: addDuration, command: 'git', args: ['add', '--', ...substantiveFiles], exit_code: typeof addResult.status === 'number' ? addResult.status : undefined, stderr: (addResult.stderr ?? addResult.stdout ?? 'git add failed').trim(), redacted: true });
      return { status: 'failed', reason: (addResult.stderr ?? addResult.stdout ?? 'git add failed').trim() };
    }
    emitCommandEvent?.('completed', { command_kind: 'git', duration_ms: addDuration, command: 'git', args: ['add', '--', ...substantiveFiles], exit_code: 0, redacted: true });

    const commitMessage = buildAutoCommitMessage(specialist, beadId, turnNumber);
    const commitStart = Date.now();
    const commitResult = spawnSync('git', ['commit', '-m', commitMessage], {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const commitDuration = Date.now() - commitStart;
    if (commitResult.status !== 0) {
      emitCommandEvent?.('failed', { command_kind: 'git', duration_ms: commitDuration, command: 'git', args: ['commit', '-m', commitMessage], exit_code: typeof commitResult.status === 'number' ? commitResult.status : undefined, stderr: (commitResult.stderr ?? commitResult.stdout ?? 'git commit failed').trim(), redacted: true });
      return { status: 'failed', reason: (commitResult.stderr ?? commitResult.stdout ?? 'git commit failed').trim() };
    }
    emitCommandEvent?.('completed', { command_kind: 'git', duration_ms: commitDuration, command: 'git', args: ['commit', '-m', commitMessage], exit_code: 0, redacted: true });

    const shaStart = Date.now();
    const shaResult = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const shaDuration = Date.now() - shaStart;
    if (shaResult.status !== 0) {
      emitCommandEvent?.('failed', { command_kind: 'git', duration_ms: shaDuration, command: 'git', args: ['rev-parse', 'HEAD'], exit_code: typeof shaResult.status === 'number' ? shaResult.status : undefined, stderr: (shaResult.stderr ?? shaResult.stdout ?? 'git rev-parse failed').trim(), redacted: true });
      return { status: 'failed', reason: (shaResult.stderr ?? shaResult.stdout ?? 'git rev-parse failed').trim() };
    }
    emitCommandEvent?.('completed', { command_kind: 'git', duration_ms: shaDuration, command: 'git', args: ['rev-parse', 'HEAD'], exit_code: 0, redacted: true });

    return {
      status: 'success',
      sha: (shaResult.stdout ?? '').trim(),
      files: substantiveFiles,
      committedAtMs: Date.now(),
    };
  } catch (error: unknown) {
    emitCommandEvent?.('failed', { command_kind: 'git', command: 'git', args: ['status', '--porcelain'], redacted: true, stderr: String(error) });
    return { status: 'failed', reason: String(error) };
  }
}

/** Detects whether the GitNexus index in `cwd` has embeddings, so a re-analyze
 *  preserves them via `--embeddings`. Reads `.gitnexus/meta.json` and inspects
 *  `stats.embeddings`. Falls back to `false` (no `--embeddings`) on any error. */
export function gitnexusHasEmbeddings(cwd: string): boolean {
  try {
    const metaPath = join(cwd, '.gitnexus', 'meta.json');
    const raw = readFileSync(metaPath, 'utf-8');
    const meta = JSON.parse(raw) as { stats?: { embeddings?: number } };
    return typeof meta.stats?.embeddings === 'number' && meta.stats.embeddings > 0;
  } catch {
    return false;
  }
}

function startDetachedGitnexusAnalyze(cwd: string): void {
  // `--skip-agents-md --no-stats` skips the AGENTS.md / CLAUDE.md edit pass
  // (volatile counts that would dirty the worktree branch every checkpoint)
  // and the file/symbol-count refresh in those docs. The graph itself is
  // still re-indexed for downstream gitnexus_impact/context queries.
  const baseArgs = ['gitnexus', 'analyze', '--skip-agents-md', '--no-stats'];
  const args = gitnexusHasEmbeddings(cwd) ? [...baseArgs, '--embeddings'] : baseArgs;
  const child = spawn('npx', args, {
    cwd,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

const STATUS_WATCHDOG_INTERVAL_MS = 5_000;
const STATUS_WATCHDOG_STALE_AFTER_MS = 30_000;

function resolveDetachedRuntime(): string {
  if (process.execPath.endsWith('/bun')) return process.execPath;

  const envRuntime = process.env.SPECIALISTS_BUN_PATH ?? process.env.BUN_PATH;
  if (envRuntime) return envRuntime;

  const whichResult = spawnSync('which', ['bun'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (whichResult.status === 0) {
    const resolved = (whichResult.stdout ?? '').trim();
    if (resolved) return resolved;
  }

  if (String(process.env.SPECIALISTS_JOB_FILE_OUTPUT ?? '').trim().toLowerCase() === 'on') {
    return process.execPath;
  }

  throw new Error('bun:sqlite watchdog requires Bun runtime; either run under Bun or set SPECIALISTS_JOB_FILE_OUTPUT=on');
}

function startDetachedStatusWatchdog(dbPath: string, statusPath: string, jobId: string, pid: number): number | undefined {
  const watchdogScript = `
const { existsSync, readFileSync, writeFileSync, renameSync } = require('node:fs');

const dbPath = process.env.SPECIALISTS_OBSERVABILITY_DB_PATH;
const statusPath = process.env.SPECIALISTS_STATUS_PATH;
const jobId = process.env.SPECIALISTS_STATUS_JOB_ID;
const pidRaw = process.env.SPECIALISTS_STATUS_PID;
const intervalRaw = process.env.SPECIALISTS_STATUS_WATCHDOG_INTERVAL_MS;
const staleAfterRaw = process.env.SPECIALISTS_STATUS_WATCHDOG_STALE_AFTER_MS;
const mode = process.env.SPECIALISTS_STATUS_WATCHDOG_MODE;

const targetPid = Number(pidRaw);
const intervalMs = Number(intervalRaw);
const staleAfterMs = Number(staleAfterRaw);

if (!dbPath || !statusPath || !jobId || !Number.isFinite(targetPid) || targetPid <= 0 || !Number.isFinite(intervalMs) || intervalMs <= 0 || !Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
  console.error('[watchdog] invalid env');
  process.exit(1);
}

let Database;
try {
  ({ Database } = require('bun:sqlite'));
} catch (error) {
  console.error('[watchdog] bun:sqlite unavailable:', error?.message ?? String(error));
  process.exit(1);
}

const isPidAlive = () => {
  try {
    process.kill(targetPid, 0);
    return true;
  } catch {
    return false;
  }
};

if (mode === 'db') {
  const readJobStatus = () => {
    const db = new Database(dbPath, { readonly: true, create: false });
    try {
      const row = db.query('SELECT status_json FROM specialist_jobs WHERE job_id = ? LIMIT 1').get(jobId);
      return row?.status_json ? JSON.parse(row.status_json) : null;
    } finally {
      db.close();
    }
  };

  const run = () => {
    const status = readJobStatus();
    if (!status) {
      if (!isPidAlive()) process.exit(0);
      return;
    }
    if (status.status === 'done' || status.status === 'error') process.exit(0);
    if (!isPidAlive()) process.exit(0);
  };

  setInterval(run, intervalMs);
  run();
  return;
}

if (mode === 'file') {
  const run = () => {
    if (!existsSync(statusPath)) return;
    let status;
    try {
      status = JSON.parse(readFileSync(statusPath, 'utf-8'));
    } catch {
      return;
    }
    if (!status || typeof status !== 'object') return;
    if (status.status === 'done' || status.status === 'error') {
      process.exit(0);
      return;
    }
    const updatedAtMs = Number(status.updated_at_ms ?? status.last_event_at_ms ?? status.started_at_ms ?? 0);
    if (Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs > staleAfterMs) {
      process.exit(0);
      return;
    }
    if (!isPidAlive()) process.exit(0);
  };

  console.warn('[watchdog] file mode degraded; Bun unavailable, polling status file');
  setInterval(run, intervalMs);
  run();
  return;
}

console.error('[watchdog] invalid watchdog mode');
process.exit(1);
`;

  const runtime = resolveDetachedRuntime();
  const watchdogMode = String(process.env.SPECIALISTS_JOB_FILE_OUTPUT ?? '').trim().toLowerCase() === 'on' && runtime === process.execPath ? 'file' : 'db';
  const watchdog = spawn(runtime, ['-e', watchdogScript], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      SPECIALISTS_OBSERVABILITY_DB_PATH: dbPath,
      SPECIALISTS_STATUS_PATH: statusPath,
      SPECIALISTS_STATUS_JOB_ID: jobId,
      SPECIALISTS_STATUS_PID: String(pid),
      SPECIALISTS_STATUS_WATCHDOG_INTERVAL_MS: String(STATUS_WATCHDOG_INTERVAL_MS),
      SPECIALISTS_STATUS_WATCHDOG_STALE_AFTER_MS: String(STATUS_WATCHDOG_STALE_AFTER_MS),
      SPECIALISTS_STATUS_WATCHDOG_MODE: watchdogMode,
    },
  });

  watchdog.unref();
  return watchdog.pid ?? undefined;
}

export function isPidAlive(pid: number | undefined): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we lack permission to signal it — still alive.
    // ESRCH (and anything else) means gone.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export function isJobDead(status: Pick<SupervisorStatus, 'status' | 'pid' | 'tmux_session'>): boolean {
  if (status.status !== 'starting' && status.status !== 'running' && status.status !== 'waiting') return false;
  if (status.pid !== undefined && !isPidAlive(status.pid)) return true;
  if (status.tmux_session && !isTmuxSessionAlive(status.tmux_session)) return true;
  return false;
}

export const DEAD_JOB_ERROR = 'Process crashed or was killed';

/**
 * Terminal transition for a job whose process (or tmux session) is gone: the error
 * status plus the run_complete event that carries it. Returns null when the job is
 * still live or has no usable start time.
 *
 * Callers persist both and must then call `emitParentNotification` — a dead job left
 * in a non-terminal status never notifies its parent, which waits forever
 * (xtrm-wiy5n.4.13).
 */
export function buildDeadJobRecovery(
  status: SupervisorStatus,
  now: number = Date.now(),
): { status: SupervisorStatus; event: TimelineEventRunComplete } | null {
  if (!isJobDead(status) || !Number.isFinite(status.started_at_ms)) return null;

  const recovered: SupervisorStatus = {
    ...status,
    status: 'error',
    current_event: undefined,
    error: DEAD_JOB_ERROR,
    last_event_at_ms: now,
  };
  const elapsed = Math.max(0, Math.round((now - status.started_at_ms) / 1000));

  return {
    status: recovered,
    event: createRunCompleteEvent('ERROR', elapsed, { error: recovered.error, exit_reason: 'crashed' }),
  };
}

/**
 * Best-effort death-cause artifact so a job dir that only ever held steer.pipe still
 * names why the job vanished.
 */
export function writeDeadJobArtifact(jobsDir: string, status: SupervisorStatus): void {
  try {
    const dir = join(jobsDir, status.id);
    mkdirSync(dir, { recursive: true });
    const line = `${new Date(status.last_event_at_ms ?? Date.now()).toISOString()} ${DEAD_JOB_ERROR}`
      + ` (job=${status.id} specialist=${status.specialist} pid=${status.pid ?? 'unknown'}`
      + ` tmux_session=${status.tmux_session ?? 'none'})\n`;
    appendFileSync(join(dir, 'death.txt'), line, 'utf-8');
  } catch {
    // diagnostics only — never block the terminal transition
  }
}

export class Supervisor {
  private readonly sqliteClient: ObservabilitySqliteClient | null;
  private readonly resolvedJobsDir: string;
  private isDisposed = false;
  private disposePromise: Promise<void> | null = null;
  private pendingSqliteOperations = 0;
  private readonly pendingSqliteDrainResolvers = new Set<() => void>();
  private activeSession: ActivePiSession | null = null;
  private readonly isJobFileOutputEnabled: boolean;

  constructor(private opts: SupervisorOptions) {
    this.sqliteClient = createObservabilitySqliteClient();
    // Anchor jobs dir to the git common root so worktree sessions share state with
    // the main checkout. Fall back to cwd-relative path when git is unavailable.
    const cwd = opts.runOptions?.workingDirectory ?? process.cwd();
    this.resolvedJobsDir = opts.jobsDir ?? resolveJobsDir(cwd);
    this.isJobFileOutputEnabled = isJobFileOutputEnabled();
  }

  private createDisposedSqliteError(operation: string): Error {
    return new Error(`[supervisor] SQLite operation "${operation}" rejected: supervisor is disposed`);
  }

  private withSqliteOperation<T>(operation: string, fn: (client: ObservabilitySqliteClient) => T): T | undefined {
    const client = this.sqliteClient;
    if (!client) return undefined;
    if (this.isDisposed) throw this.createDisposedSqliteError(operation);

    this.pendingSqliteOperations += 1;
    try {
      return fn(client);
    } finally {
      this.pendingSqliteOperations -= 1;
      if (this.pendingSqliteOperations === 0) {
        for (const resolve of this.pendingSqliteDrainResolvers) {
          resolve();
        }
        this.pendingSqliteDrainResolvers.clear();
      }
    }
  }

  private async waitForPendingSqliteOperations(): Promise<void> {
    if (this.pendingSqliteOperations === 0) return;

    await new Promise<void>((resolve) => {
      this.pendingSqliteDrainResolvers.add(resolve);
    });
  }

  setActiveSession(session: ActivePiSession): void {
    this.activeSession = session;
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) {
      await this.disposePromise;
      return;
    }

    this.isDisposed = true;
    this.disposePromise = (async () => {
      await this.waitForPendingSqliteOperations();
      await this.closeActiveSession();
      if (!this.sqliteClient) return;
      try {
        this.sqliteClient.close();
      } catch (error: unknown) {
        console.warn(`[supervisor] Failed to close sqlite client: ${String(error)}`);
      }
    })();

    await this.disposePromise;
  }

  private async closeActiveSession(): Promise<void> {
    const session = this.activeSession;
    if (!session) return;

    this.activeSession = null;
    try {
      // Flush pending SQLite writes before closing pi so terminal telemetry from the session is durable.
      await session.close();
    } catch (error: unknown) {
      console.warn(`[supervisor] Failed to close active pi session: ${String(error)}`);
      session.kill(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private jobDir(id: string): string {
    return join(this.resolvedJobsDir, id);
  }

  private statusPath(id: string): string {
    return join(this.jobDir(id), 'status.json');
  }

  private resultPath(id: string): string {
    return join(this.jobDir(id), 'result.txt');
  }

  private observabilityDbPath(): string {
    return resolveObservabilityDbLocation(this.opts.runOptions?.workingDirectory ?? process.cwd()).dbPath;
  }


  private eventsPath(id: string): string {
    return join(this.jobDir(id), 'events.jsonl');
  }

  private readyDir(): string {
    return join(this.resolvedJobsDir, '..', 'ready');
  }

  private writeReadyMarker(id: string): void {
    mkdirSync(this.readyDir(), { recursive: true });
    writeFileSync(join(this.readyDir(), id), '', 'utf-8');
  }

  private withComputedLiveness(status: SupervisorStatus): SupervisorStatusView {
    return {
      ...status,
      is_dead: isJobDead(status),
    };
  }

  private reconcileDeadStatus(id: string, status: SupervisorStatus): SupervisorStatusView {
    if (!isJobDead(status) || (status.status !== 'running' && status.status !== 'starting')) {
      return this.withComputedLiveness(status);
    }

    const recovery = buildDeadJobRecovery(status);
    if (!recovery) {
      return this.withComputedLiveness(status);
    }

    const { status: recoveredStatus, event: runCompleteEvent } = recovery;

    if (this.sqliteClient) {
      const persisted = this.withSqliteOperation('upsertStatusWithEvent:readStatus', (client) => {
        client.upsertStatusWithEvent(recoveredStatus, runCompleteEvent);
        return true;
      });
      if (persisted === undefined) {
        throw new Error('[supervisor] SQLite upsertStatusWithEvent failed during readStatus recovery: database client unavailable');
      }
    } else {
      this.writeStatusFileOnly(id, recoveredStatus);
      if (this.isJobFileOutputEnabled) {
        const eventsPath = this.eventsPath(id);
        mkdirSync(this.jobDir(id), { recursive: true });
        appendFileSync(eventsPath, JSON.stringify(runCompleteEvent) + '\n', 'utf-8');
      }
    }

    writeDeadJobArtifact(this.resolvedJobsDir, recoveredStatus);
    emitParentNotification(recoveredStatus, this.activeSiblingAssignee(recoveredStatus));

    return this.withComputedLiveness(recoveredStatus);
  }

  readStatus(id: string): SupervisorStatusView | null {
    try {
      if (this.isDisposed) {
        throw this.createDisposedSqliteError('readStatus');
      }
      const sqliteStatus = this.withSqliteOperation('readStatus', (client) => client.readStatus(id));
      if (sqliteStatus) return this.reconcileDeadStatus(id, sqliteStatus);
    } catch (error: unknown) {
      if (!(error instanceof Error && error.message.includes('supervisor is disposed'))) {
        console.warn(`[supervisor] SQLite readStatus failed, falling back to file state: ${String(error)}`);
      }
    }

    const path = this.statusPath(id);
    if (!existsSync(path)) return null;
    try {
      const status = JSON.parse(readFileSync(path, 'utf-8')) as SupervisorStatus;
      return this.reconcileDeadStatus(id, status);
    } catch {
      return null;
    }
  }

  listLiveJobsForBead(beadId: string): string[] {
    try {
      if (this.isDisposed) {
        throw this.createDisposedSqliteError('listLiveJobsForBead');
      }
      return this.withSqliteOperation('listLiveJobsForBead', (client) => client.listLiveJobsForBead(beadId)) ?? [];
    } catch (error: unknown) {
      console.warn(`[supervisor] SQLite listLiveJobsForBead failed: ${String(error)}`);
      return [];
    }
  }

  private activeSiblingAssignee(statusSnapshot: SupervisorStatus): string | undefined {
    if (!statusSnapshot.bead_id) return undefined;
    for (const id of this.listLiveJobsForBead(statusSnapshot.bead_id)) {
      if (id === statusSnapshot.id) continue;
      const sibling = this.readStatus(id);
      if (sibling && (sibling.status === 'starting' || sibling.status === 'running' || sibling.status === 'waiting')) {
        return `${sibling.specialist}/${id}`;
      }
    }
    return undefined;
  }

  listChainJobIds(chainId: string): string[] {
    try {
      if (this.isDisposed) {
        throw this.createDisposedSqliteError('listChainJobIds');
      }
      return this.withSqliteOperation('listChainJobIds', (client) => client.listChainJobIds(chainId)) ?? [];
    } catch (error: unknown) {
      console.warn(`[supervisor] SQLite listChainJobIds failed: ${String(error)}`);
      return [];
    }
  }

  readResult(id: string): string | null {
    try {
      if (this.isDisposed) {
        throw this.createDisposedSqliteError('readResult');
      }
      const sqliteResult = this.withSqliteOperation('readResult', (client) => client.readResult(id));
      if (typeof sqliteResult === 'string' && sqliteResult.trim().length > 0) return sqliteResult;
    } catch (error: unknown) {
      if (!(error instanceof Error && error.message.includes('supervisor is disposed'))) {
        console.warn(`[supervisor] SQLite readResult failed, falling back to file state: ${String(error)}`);
      }
    }

    const path = this.resultPath(id);
    if (!existsSync(path)) return null;
    try {
      return readFileSync(path, 'utf-8');
    } catch {
      return null;
    }
  }

  finalizeWaitingJob(id: string): SupervisorStatusView | null {
    const currentStatus = this.readStatus(id);
    if (!currentStatus) return null;
    if (currentStatus.status !== 'waiting') return currentStatus;

    if (currentStatus.fifo_path) {
      writeFileSync(currentStatus.fifo_path, JSON.stringify({ type: 'close' }) + '\n', { flag: 'a' });
    }

    const finalized = this.updateJobStatus(id, 'done');
    if (!finalized) return null;
    this.aggregateJobMetricsBestEffort(id);

    if (finalized.bead_id && this.opts.beadsClient) {
      const outputPath = this.resultPath(id);
      const output = existsSync(outputPath)
        ? (readFileSync(outputPath, 'utf-8') || this.readResult(id) || '')
        : (this.readResult(id) || '');
      if (output.trim()) {
        this.opts.beadsClient.updateBeadNotes(finalized.bead_id, formatHandoffBlock({
          output,
          model: finalized.model ?? 'unknown',
          backend: finalized.backend ?? 'unknown',
          specialist: finalized.specialist,
          jobId: id,
          status: 'done',
          timestamp: new Date().toISOString(),
        }, { final: true }));
      }
    }

    return finalized;
  }

  private appendEventBestEffort(jobId: string, operation: string, event: TimelineEvent): void {
    try {
      const status = this.readStatus(jobId);
      const persisted = this.withSqliteOperation(operation, (client) => {
        client.appendEvent(jobId, status?.specialist ?? 'unknown', status?.bead_id, event);
        return true;
      });
      if (persisted === undefined) {
        console.warn(`[supervisor] SQLite ${operation} skipped: database client unavailable`);
      }
    } catch (error: unknown) {
      console.warn(`[supervisor] SQLite ${operation} failed: ${String(error)}`);
    }
  }

  emitMetaEvent(jobId: string, model: string, backend: string): void {
    if (this.isDisposed) return;
    this.appendEventBestEffort(jobId, 'appendEvent', createMetaEvent(model, backend));
  }

  emitControlEvent(
    jobId: string,
    action: string,
    options: Omit<TimelineEventControlSignal, 't' | 'type' | 'action'>,
  ): void {
    if (this.isDisposed) return;
    this.appendEventBestEffort(jobId, 'appendEvent', createControlSignalEvent(action, options));
  }

  emitTimelineEvent(jobId: string, event: TimelineEvent): void {
    if (this.isDisposed) return;
    this.appendEventBestEffort(jobId, 'appendEvent', event);
  }

  updateJobStatus(id: string, status: Extract<SupervisorJobStatus, 'done' | 'cancelled' | 'error' | 'waiting' | 'running' | 'starting'>, error?: string): SupervisorStatusView | null {
    const currentStatus = this.readStatus(id);
    if (!currentStatus) return null;

    const previousStatus = currentStatus.status;
    const updatedStatus: SupervisorStatus = {
      ...currentStatus,
      status,
      current_event: undefined,
      error,
      last_event_at_ms: previousStatus === status
        ? currentStatus.last_event_at_ms ?? Date.now()
        : Date.now(),
    };

    this.writeStatusFile(id, updatedStatus, { sqliteFailureMode: 'warn' });

    if (previousStatus !== status) {
      this.appendEventBestEffort(id, 'appendEvent:status_change', createStatusChangeEvent(status, previousStatus));
    }
    if (status === 'error') emitParentNotification(updatedStatus, this.activeSiblingAssignee(updatedStatus));

    return this.withComputedLiveness(updatedStatus);
  }

  aggregateJobMetricsBestEffort(jobId: string): void {
    try {
      this.withSqliteOperation('aggregateJobMetrics', (client) => client.aggregateJobMetrics(jobId));
    } catch (error: unknown) {
      console.warn(`[supervisor] Failed to aggregate job metrics for ${jobId}: ${String(error)}`);
    }
  }

  /** List all jobs sorted newest-first. */
  listJobs(): SupervisorStatusView[] {
    try {
      if (this.isDisposed) {
        throw this.createDisposedSqliteError('listStatuses');
      }
      const sqliteJobs = this.withSqliteOperation('listStatuses', (client) => client.listStatuses()) ?? [];
      if (sqliteJobs.length > 0) {
        return sqliteJobs
          .map((status) => this.withComputedLiveness(status))
          .sort((a, b) => b.started_at_ms - a.started_at_ms);
      }
    } catch (error: unknown) {
      if (!(error instanceof Error && error.message.includes('supervisor is disposed'))) {
        console.warn(`[supervisor] SQLite listStatuses failed, falling back to file state: ${String(error)}`);
      }
    }

    if (!existsSync(this.resolvedJobsDir)) return [];
    const jobs: SupervisorStatusView[] = [];
    for (const entry of readdirSync(this.resolvedJobsDir)) {
      const path = join(this.resolvedJobsDir, entry, 'status.json');
      if (!existsSync(path)) continue;
      try {
        const status = JSON.parse(readFileSync(path, 'utf-8')) as SupervisorStatus;
        jobs.push(this.withComputedLiveness(status));
      } catch { /* skip */ }
    }
    return jobs.sort((a, b) => b.started_at_ms - a.started_at_ms);
  }

  private withStatusLineageDefaults(id: string, status: SupervisorStatus): SupervisorStatus {
    const chainRootJobId = status.chain_root_job_id ?? status.worktree_owner_job_id;
    const chainRootSnapshot = chainRootJobId && chainRootJobId !== id
      ? this.readStatus(chainRootJobId) ?? undefined
      : undefined;

    const identity = derivePersistedChainIdentity(status, chainRootSnapshot);

    if (identity.chain_kind === 'prep') {
      return {
        ...status,
        chain_kind: 'prep',
        chain_id: undefined,
        chain_root_job_id: undefined,
        chain_root_bead_id: undefined,
      };
    }

    return {
      ...status,
      worktree_owner_job_id: identity.chain_root_job_id,
      trace_id: identity.trace_id,
      span_id: identity.span_id,
      parent_span_id: identity.parent_span_id,
      chain_kind: 'chain',
      chain_id: identity.chain_id,
      chain_root_job_id: identity.chain_root_job_id,
      chain_root_bead_id: identity.chain_root_bead_id,
    };
  }

  private writeStatusFileOnly(id: string, data: SupervisorStatus): void {
    if (!this.isJobFileOutputEnabled) return;
    const normalizedStatus = this.withStatusLineageDefaults(id, data);
    mkdirSync(this.jobDir(id), { recursive: true });
    const path = this.statusPath(id);
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(normalizedStatus, null, 2), 'utf-8');
    renameSync(tmp, path);
  }

  private writeStatusFile(
    id: string,
    data: SupervisorStatus,
    options: { sqliteFailureMode?: 'throw' | 'warn' } = {},
  ): void {
    const normalizedStatus = this.withStatusLineageDefaults(id, data);
    this.writeStatusFileOnly(id, normalizedStatus);

    try {
      const persisted = this.withSqliteOperation('upsertStatus', (client) => {
        client.upsertStatus(normalizedStatus);

        const chainId = resolveChainId(normalizedStatus);
        if (!normalizedStatus.epic_id || !chainId) {
          return true;
        }

        client.upsertEpicRun({
          epic_id: normalizedStatus.epic_id,
          status: 'open',
          updated_at_ms: Date.now(),
          status_json: JSON.stringify({
            epic_id: normalizedStatus.epic_id,
            status: 'open',
            source: 'supervisor',
            chain_id: chainId,
            chain_root_bead_id: normalizedStatus.chain_root_bead_id ?? null,
            chain_root_job_id: normalizedStatus.chain_root_job_id ?? normalizedStatus.id,
          }),
        });

        client.upsertEpicChainMembership({
          chain_id: chainId,
          epic_id: normalizedStatus.epic_id,
          chain_root_bead_id: normalizedStatus.chain_root_bead_id,
          chain_root_job_id: normalizedStatus.chain_root_job_id ?? normalizedStatus.id,
          updated_at_ms: Date.now(),
        });

        const readiness = loadEpicReadinessSummary(client, normalizedStatus.epic_id);
        syncEpicStateFromReadiness(client, readiness);
        return true;
      });

      if (persisted === undefined) {
        throw new Error('[supervisor] SQLite upsertStatus failed: database client unavailable');
      }
    } catch (error: unknown) {
      if (options.sqliteFailureMode === 'warn') {
        console.warn(`[supervisor] SQLite upsertStatus failed: ${String(error)}`);
        return;
      }
      throw error;
    }
  }


  /** GC: remove job dirs older than JOB_TTL_DAYS. */
  private gc(): void {
    if (!existsSync(this.resolvedJobsDir)) return;
    const cutoff = Date.now() - JOB_TTL_DAYS * 86_400_000;
    for (const entry of readdirSync(this.resolvedJobsDir)) {
      const dir = join(this.resolvedJobsDir, entry);
      try {
        const stat = statSync(dir);
        if (!stat.isDirectory()) continue;
        if (stat.mtimeMs < cutoff) rmSync(dir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  }

  /** Crash recovery: mark running jobs with dead PID as error, and emit stale warnings. */
  private crashRecovery(): void {
    if (!existsSync(this.resolvedJobsDir)) return;
    const thresholds = {
      ...STALL_DETECTION_DEFAULTS,
      ...this.opts.stallDetection,
      waiting_auto_close_ms: this.opts.stallDetection?.waiting_auto_close_ms ?? STALL_DETECTION_DEFAULTS.waiting_auto_close_ms,
    };
    const now = Date.now();
    const shouldUseFiles = String(process.env.SPECIALISTS_JOB_FILE_OUTPUT ?? '').trim().toLowerCase() !== 'off';

    if (this.sqliteClient && !shouldUseFiles) {
      for (const job of this.sqliteClient.listActiveJobs(['running', 'starting', 'waiting'])) {
        const status = (this.sqliteClient as unknown as { readStatus(jobId: string): SupervisorStatus | null }).readStatus(job.job_id);
        if (!status) continue;
        if (status.status === 'running' || status.status === 'starting') {
          if (!status.pid || isPidAlive(status.pid)) continue;
          const tmp = this.statusPath(status.id) + '.tmp';
          const updated: SupervisorStatus = {
            ...status,
            status: 'error',
            error: 'orphaned (parent supervisor died)',
            last_event_at_ms: now,
          };
          writeFileSync(tmp, JSON.stringify(updated, null, 2), 'utf-8');
          renameSync(tmp, this.statusPath(status.id));
          continue;
        }
        if (status.status === 'waiting') {
          const lastEventAt = status.last_event_at_ms ?? status.started_at_ms;
          const silenceMs = now - lastEventAt;
          if (silenceMs > thresholds.waiting_stale_ms) {
            const eventsPath = join(this.resolvedJobsDir, status.id, 'events.jsonl');
            const event = createStaleWarningEvent('waiting_stale', {
              silence_ms: silenceMs,
              threshold_ms: thresholds.waiting_stale_ms,
            });
            try { appendFileSync(eventsPath, JSON.stringify(event) + '\n'); } catch { /* best effort */ }
          }
        }
      }
      return;
    }

    for (const entry of readdirSync(this.resolvedJobsDir)) {
      const statusPath = join(this.resolvedJobsDir, entry, 'status.json');
      if (!existsSync(statusPath)) continue;
      try {
        const s: SupervisorStatus = JSON.parse(readFileSync(statusPath, 'utf-8'));

        if (s.status === 'running' || s.status === 'starting') {
          if (!s.pid) continue;
          if (!isPidAlive(s.pid)) {
            const tmp = statusPath + '.tmp';
            const updated: SupervisorStatus = {
              ...s,
              status: 'error',
              error: 'orphaned (parent supervisor died)',
              last_event_at_ms: now,
            };
            writeFileSync(tmp, JSON.stringify(updated, null, 2), 'utf-8');
            renameSync(tmp, statusPath);
          } else if (s.status === 'running') {
            const lastEventAt = s.last_event_at_ms ?? s.started_at_ms;
            const silenceMs = now - lastEventAt;
            if (silenceMs > thresholds.running_silence_error_ms) {
              const tmp = statusPath + '.tmp';
              const updated: SupervisorStatus = {
                ...s,
                status: 'error',
                error: `No activity for ${Math.round(silenceMs / 1000)}s (threshold: ${thresholds.running_silence_error_ms / 1000}s)`,
              };
              writeFileSync(tmp, JSON.stringify(updated, null, 2), 'utf-8');
              renameSync(tmp, statusPath);
            }
          }
        } else if (s.status === 'waiting') {
          const lastEventAt = s.last_event_at_ms ?? s.started_at_ms;
          const silenceMs = now - lastEventAt;
          if (silenceMs > thresholds.waiting_stale_ms) {
            const eventsPath = join(this.resolvedJobsDir, entry, 'events.jsonl');
            const event = createStaleWarningEvent('waiting_stale', {
              silence_ms: silenceMs,
              threshold_ms: thresholds.waiting_stale_ms,
            });
            try { appendFileSync(eventsPath, JSON.stringify(event) + '\n'); } catch { /* best effort */ }
          }
        }
      } catch { /* ignore */ }
    }
  }

  /**
   * Run the specialist under supervision. Writes job state to disk.
   * Returns the job ID when complete (or throws on error).
   */
  async run(): Promise<string> {
    const { runner, runOptions } = this.opts;

    this.gc();
    this.crashRecovery();

    const id = crypto.randomUUID().slice(0, 6);
    const dir = this.jobDir(id);
    const startedAtMs = Date.now();

    mkdirSync(dir, { recursive: true });
    mkdirSync(this.readyDir(), { recursive: true });

    const nodeId = runOptions.variables?.node_id ?? runOptions.variables?.SPECIALISTS_NODE_ID;
    const variablesKeys = Object.keys(runOptions.variables ?? {});
    const activatedSkills = (runOptions.variables?.activated_skills ?? runOptions.variables?.skills_activated ?? '')
      .split(',')
      .map((skill) => skill.trim())
      .filter((skill) => skill.length > 0);
    const startupContext: NonNullable<SupervisorStatus['startup_context']> = {
      job_id: id,
      specialist_name: runOptions.name,
      ...(runOptions.inputBeadId ? { bead_id: runOptions.inputBeadId } : {}),
      ...(runOptions.reusedFromJobId ? { reused_from_job_id: runOptions.reusedFromJobId } : {}),
      ...(runOptions.worktreeOwnerJobId ? { worktree_owner_job_id: runOptions.worktreeOwnerJobId } : {}),
      ...((runOptions.worktreeOwnerJobId || runOptions.workingDirectory)
        ? {
            chain_id: runOptions.worktreeOwnerJobId ?? id,
            chain_root_job_id: runOptions.worktreeOwnerJobId ?? id,
          }
        : {}),
      ...(runOptions.variables?.chain_root_bead_id ? { chain_root_bead_id: runOptions.variables.chain_root_bead_id } : {}),
      ...(runOptions.workingDirectory ? { worktree_path: runOptions.workingDirectory } : {}),
      ...(runOptions.baseShaPinned ? { base_sha_pinned: runOptions.baseShaPinned } : {}),
      ...(runOptions.baseShaPinnedAtMs ? { base_sha_pinned_at_ms: runOptions.baseShaPinnedAtMs } : {}),
      ...(runOptions.workingDirectory
        ? { branch: resolveCurrentBranch(runOptions.workingDirectory) }
        : { branch: resolveCurrentBranch() }),
      variables_keys: variablesKeys,
      reviewed_job_id_present: variablesKeys.includes('reviewed_job_id'),
      reused_worktree_awareness_present: variablesKeys.includes('reused_worktree_awareness'),
      bead_context_present: variablesKeys.includes('bead_context'),
      ...(activatedSkills.length > 0
        ? {
            skills: {
              count: activatedSkills.length,
              activated: activatedSkills,
            },
          }
        : {}),
    };

    // Spec §13.4 precedence: explicit parent_job_id > ambient/propagated origin > unknown.
    // F2: when spawning a child job, look up the parent's stored root_runtime_origin
    // so the whole chain shares one root pane binding. Missing parent is tolerated —
    // the child's root_runtime_origin stays undefined; NEVER fabricated.
    let inheritedRootRuntimeOrigin: RuntimeOriginV1 | undefined;
    if (runOptions.explicitParentJobId) {
      try {
        const parentStatus = this.sqliteClient?.readStatus(runOptions.explicitParentJobId);
        inheritedRootRuntimeOrigin = parentStatus?.root_runtime_origin;
        console.warn(
          `[specialists] component=launch event=inherit parent_job_id=${runOptions.explicitParentJobId} outcome=${inheritedRootRuntimeOrigin ? 'ok' : 'parent-missing'}`,
        );
      } catch (err) {
        console.warn(
          `[specialists] component=launch event=inherit parent_job_id=${runOptions.explicitParentJobId} outcome=lookup-failed reason=${(err as Error).message?.slice(0, 60) ?? 'unknown'}`,
        );
      }
    }
    const originBinding = resolveSpawnOrigin({
      explicitParentJobId: runOptions.explicitParentJobId,
      ambientRuntimeOrigin: runOptions.ambientRuntimeOrigin,
      inheritedRootRuntimeOrigin,
    });

    const initialStatus: SupervisorStatus = {
      id,
      specialist: runOptions.name,
      status: 'starting',
      started_at_ms: startedAtMs,
      pid: process.pid,
      ...(runOptions.inputBeadId ? { bead_id: runOptions.inputBeadId } : {}),
      ...(nodeId ? { node_id: nodeId } : {}),
      ...(process.env.SPECIALISTS_TMUX_SESSION ? { tmux_session: process.env.SPECIALISTS_TMUX_SESSION } : {}),
      ...(runOptions.workingDirectory ? { worktree_path: runOptions.workingDirectory } : {}),
      ...(runOptions.reusedFromJobId ? { reused_from_job_id: runOptions.reusedFromJobId } : {}),
      ...(runOptions.worktreeOwnerJobId ? { worktree_owner_job_id: runOptions.worktreeOwnerJobId } : {}),
      ...(runOptions.baseShaPinned ? { base_sha_pinned: runOptions.baseShaPinned } : {}),
      ...(runOptions.baseShaPinnedAtMs ? { base_sha_pinned_at_ms: runOptions.baseShaPinnedAtMs } : {}),
      ...((runOptions.worktreeOwnerJobId || runOptions.workingDirectory)
        ? {
            chain_kind: 'chain' as const,
            chain_id: runOptions.worktreeOwnerJobId ?? id,
            chain_root_job_id: runOptions.worktreeOwnerJobId ?? id,
          }
        : { chain_kind: 'prep' as const }),
      ...(runOptions.epicId ? { epic_id: runOptions.epicId } : {}),
      ...(runOptions.workingDirectory
        ? { branch: resolveCurrentBranch(runOptions.workingDirectory) }
        : { branch: resolveCurrentBranch() }),
      startup_context: {
        ...startupContext,
        spawn_origin_kind: originBinding.spawn_origin.kind,
        ...(originBinding.parent_job_id ? { parent_job_id: originBinding.parent_job_id } : {}),
        ...(originBinding.root_runtime_origin
          ? {
              root_pane_id: originBinding.root_runtime_origin.tmux_pane_id,
              ...(originBinding.root_runtime_origin.agent_instance_id
                ? { root_agent_instance_id: originBinding.root_runtime_origin.agent_instance_id }
                : {}),
            }
          : {}),
      },
      spawn_origin: originBinding.spawn_origin,
      ...(originBinding.parent_job_id ? { parent_job_id: originBinding.parent_job_id } : {}),
      ...(originBinding.root_runtime_origin ? { root_runtime_origin: originBinding.root_runtime_origin } : {}),
    };
    this.writeStatusFile(id, initialStatus);
    const statusWatchdogPid = startDetachedStatusWatchdog(this.observabilityDbPath(), this.statusPath(id), id, process.pid);
    // Persist latest marker only when legacy file output enabled.
    if (this.isJobFileOutputEnabled) {
      writeFileSync(join(this.resolvedJobsDir, 'latest'), `${id}\n`, 'utf-8');
    }
    this.opts.onJobStarted?.({ id });

    let statusSnapshot: SupervisorStatus = initialStatus;
    let runStartClaimed = false;
    const shouldClaimRunStart = runOptions.permissionRequired !== 'READ_ONLY'
      && runOptions.permissionRequired !== undefined
      && !runOptions.forceJob
      && !!initialStatus.bead_id;
    const setStatus = (updates: Partial<SupervisorStatus>): void => {
      statusSnapshot = { ...statusSnapshot, ...updates };
      this.writeStatusFile(id, statusSnapshot);
    };

    const mergeRunMetrics = (incoming: SessionRunMetrics | undefined): void => {
      if (!incoming) return;
      runMetrics = {
        ...runMetrics,
        ...incoming,
        ...(incoming.token_usage ? { token_usage: { ...runMetrics.token_usage, ...incoming.token_usage } } : {}),
        ...(incoming.tool_call_names ? { tool_call_names: [...incoming.tool_call_names] } : {}),
      };
      setStatus({ metrics: runMetrics });
    };

    // Keep events.jsonl fd open for legacy file output mode only.
    const eventsFd = this.isJobFileOutputEnabled ? openSync(this.eventsPath(id), 'a') : undefined;
    let nextTimelineSeq = 1;
    const assignTimelineSeq = (event: TimelineEvent): TimelineEvent => {
      if (typeof event.seq === 'number' && Number.isFinite(event.seq) && event.seq > 0) {
        nextTimelineSeq = Math.max(nextTimelineSeq, event.seq + 1);
        return event;
      }
      return { ...event, seq: nextTimelineSeq++ };
    };

    const appendTimelineEvent = (event: TimelineEvent): void => {
      const sequencedEvent = assignTimelineSeq(event);
      if (eventsFd !== undefined) {
        writeSync(eventsFd, JSON.stringify(sequencedEvent) + '\n');
      }

      const persisted = this.withSqliteOperation('appendEvent', (client) => {
        client.appendEvent(id, runOptions.name, statusSnapshot.bead_id, sequencedEvent);
        return true;
      });
      if (persisted === undefined) {
        throw new Error('[supervisor] SQLite appendEvent failed: database client unavailable');
      }
    };

    const appendTimelineEventFileOnly = (event: TimelineEvent): TimelineEvent => {
      const sequencedEvent = assignTimelineSeq(event);
      if (eventsFd !== undefined) {
        writeSync(eventsFd, JSON.stringify(sequencedEvent) + '\n');
      }
      return sequencedEvent;
    };

    const setWaitingStatus = (updates?: Partial<SupervisorStatus>): void => {
      const previousStatus = statusSnapshot.status;
      const waitingAt = Date.now();
      setStatus({
        status: 'waiting',
        current_event: 'waiting',
        elapsed_s: Math.round((waitingAt - startedAtMs) / 1000),
        last_event_at_ms: waitingAt,
        ...updates,
      });
      if (previousStatus !== 'waiting') {
        appendTimelineEvent(createStatusChangeEvent('waiting', previousStatus));
      }
    };

    // Emit run_start event
    const runStartEvent = appendTimelineEventFileOnly(createRunStartEvent(
      runOptions.name,
      runOptions.inputBeadId,
      statusSnapshot.startup_context,
    ));
    if (shouldClaimRunStart && this.sqliteClient) {
      const claimResult = this.withSqliteOperation('claimJobStart', (client) => client.claimJobStart(statusSnapshot, runStartEvent));
      if (!claimResult) {
        throw new Error('[supervisor] SQLite claimJobStart failed: database client unavailable');
      }
      if (!claimResult.ok && claimResult.existingJobId !== id) {
        throw new Error(
          `Refusing job start for bead '${statusSnapshot.bead_id ?? 'unknown'}' specialist '${statusSnapshot.specialist}': ` +
          `existing ${claimResult.existingStatus} job '${claimResult.existingJobId}' already active. ` +
          `Wait for it to finish or rerun with --force-job.`,
        );
      }
      runStartClaimed = true;
    }
    if (!runStartClaimed) {
      const runStartPersisted = this.withSqliteOperation('upsertStatusWithEvent:run_start', (client) => {
        client.upsertStatusWithEvent(statusSnapshot, runStartEvent);
        return true;
      });
      if (runStartPersisted === undefined) {
        throw new Error('[supervisor] SQLite upsertStatusWithEvent failed during run start: database client unavailable');
      }
    }

    // Create a named FIFO for cross-process steering (e.g. `specialists steer <id> "msg"`)
    // Available for all jobs — steering is independent of keep-alive
    const fifoPath = join(dir, 'steer.pipe');
    try {
      execFileSync('mkfifo', [fifoPath]);
      setStatus({ fifo_path: fifoPath });
    } catch {
      // mkfifo unavailable or failed — steer is a best-effort feature, continue without it
    }

    let runMetrics: SessionRunMetrics = {
      turns: 0,
      tool_calls: 0,
      auto_compactions: 0,
      auto_retries: 0,
    };
    const gitnexusAccumulator = {
      files_touched: new Set<string>(),
      symbols_analyzed: new Set<string>(),
      highest_risk: undefined as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | undefined,
      tool_invocations: 0,
    };
    let textCharCount = 0;
    let thinkingCharCount = 0;
    let turnTextAccumulator = '';
    let assistantMessageAccumulator = '';
    let lastPersistedAssistantMessage = '';
    let currentContextTokens = 0;
    const toolCallNames: string[] = [];
    type ActiveToolCallState = {
      tool: string;
      args?: Record<string, unknown>;
      isError?: boolean;
      resultContent?: string;
      resultRaw?: Record<string, unknown>;
    };

    // Map from toolCallId → tool state for parallel tool call tracking.
    const activeToolCalls = new Map<string, ActiveToolCallState>();
    let latestUncorrelatedToolState: ActiveToolCallState | undefined;
    let killFn: (() => void) | undefined;
    let steerFn: ((msg: string) => Promise<void>) | undefined;
    let resumeFn: ((msg: string) => Promise<string>) | undefined;
    let closeFn: (() => Promise<void>) | undefined;
    let fifoReadStream: ReturnType<typeof createReadStream> | undefined;
    let fifoReadline: ReturnType<typeof createInterface> | undefined;
    let fifoFd: number | undefined;
    let keepAliveSession = false;
    let latestOutput = '';
    let autoCommitPolicy: 'never' | 'checkpoint_on_waiting' | 'checkpoint_on_terminal' | undefined = 'never';
    let keepAliveExitResolved = false;
    let isReadOnlySpecialist = false;
    let resolveKeepAliveExit: ((exit: { kind: 'closed' } | { kind: 'fatal'; error: Error }) => void) | undefined;
    const keepAliveExitPromise = new Promise<{ kind: 'closed' } | { kind: 'fatal'; error: Error }>((resolve) => {
      resolveKeepAliveExit = resolve;
    });

    const finishKeepAlive = (exit: { kind: 'closed' } | { kind: 'fatal'; error: Error }): void => {
      if (keepAliveExitResolved) return;
      keepAliveExitResolved = true;
      resolveKeepAliveExit?.(exit);
    };

    const emitRunCompleteForTurn = (result: {
      model: string;
      backend: string;
      beadId?: string;
      output: string;
    }): void => {
      const gitnexusSummary = gitnexusAccumulator.tool_invocations > 0
        ? {
            files_touched: [...gitnexusAccumulator.files_touched],
            symbols_analyzed: [...gitnexusAccumulator.symbols_analyzed],
            highest_risk: gitnexusAccumulator.highest_risk,
            tool_invocations: gitnexusAccumulator.tool_invocations,
          }
        : undefined;

      appendTimelineEvent(createRunCompleteEvent('COMPLETE', Math.round((Date.now() - startedAtMs) / 1000), {
        final: false,
        model: result.model,
        backend: result.backend,
        bead_id: result.beadId,
        output: result.output,
        token_usage: runMetrics.token_usage,
        finish_reason: runMetrics.finish_reason,
        tool_calls: [...toolCallNames],
        exit_reason: runMetrics.exit_reason,
        metrics: runMetrics,
        evidence: latestEvidenceRefs,
        ...(gitnexusSummary ? { gitnexus_summary: gitnexusSummary } : {}),
      }));
    };

    const emitReviewVerdictTimelineEvent = (output: string, context: { chainId?: string; chainTemplate?: string; changedPathsCount?: number }): void => {
      const verdict = parseReviewVerdict(output);
      if (!verdict) return;
      const terminalState = verdict === 'pass' ? 'merge_ready' : 'reviewed';
      if (verdict === 'pass' && context.chainId) {
        appendTimelineEvent(createChainEvent('chain_ready_for_review', {
          chain_id: context.chainId,
          chain_template: context.chainTemplate,
          changed_paths_count: context.changedPathsCount,
          terminal_state: terminalState,
          result: verdict,
        }) as unknown as TimelineEvent);
      }
      appendTimelineEvent(createReviewVerdictEvent(verdict, {
        chain_id: context.chainId,
        chain_template: context.chainTemplate,
        changed_paths_count: context.changedPathsCount,
        terminal_state: terminalState,
        result: verdict,
      }) as unknown as TimelineEvent);
    };
    const shouldAutoCloseReadOnlyKeepAlive = (output: string): boolean => (
      isReadOnlySpecialist && TERMINAL_COMPLIANCE_VERDICT_REGEX.test(output)
    );
    const shouldAutoFinalizeKeepAlive = (output: string): boolean => PASS_COMPLIANCE_VERDICT_REGEX.test(output);

    const shouldWriteExternalBeadNotes = runOptions.beadsWriteNotes ?? true;
    const notesMode = runOptions.notesMode ?? 'full-trail';
    const outputFile = runOptions.output_file;
    let lastTurnSummaryTextContent = '';
    let lastTurnSummaryIndex = 0;
    let skipFinalKeepAliveInputBeadAppend = false;
    let latestEvidenceRefs: Array<{ evidence_kind: 'diff' | 'commit' | 'pr'; evidence_ref?: string; evidence_url?: string; evidence_state?: string; base_ref?: string; base_sha?: string; head_sha?: string; pr_id?: string | number; pr_url?: string; pr_state?: string; trace_id?: string; span_id?: string; parent_span_id?: string; diff?: { changed_files: Array<{ path: string; added_lines: number; removed_lines: number }>; hunks?: string; hunks_artifact_ref?: string; hunks_inline?: boolean; hunks_truncated?: boolean; } }> | undefined;
    const getObservedPrEvidenceRef = (worktreePath: string): { pr_id?: number; pr_url?: string; pr_state?: string } | undefined => {
      const result = spawnSync('gh', ['pr', 'view', '--json', 'number,url,state'], { cwd: worktreePath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (result.status !== 0) return undefined;
      try {
        const parsed = JSON.parse((result.stdout ?? '').trim()) as { number?: number; url?: string; state?: string };
        if (!parsed?.url) return undefined;
        return { pr_id: parsed.number, pr_url: parsed.url, pr_state: parsed.state };
      } catch {
        return undefined;
      }
    };
    /** SHA of the most recent commit for which gitnexus analyze was triggered.
     *  Used to dedupe checkpoint-time vs terminal-time analyze fires when both
     *  paths see the same final commit. */
    let lastGitnexusAnalyzedSha: string | undefined;
    const triggerGitnexusAnalyzeIfNeeded = (sha: string | undefined, source: 'checkpoint' | 'terminal'): void => {
      if (!isGitnexusAnalyzeRequired(runOptions.permissionRequired)) return;
      if (sha && lastGitnexusAnalyzedSha === sha) return;
      // Use appendTimelineEvent (dual-write to file + SQLite) so the event is
      // visible to `sp feed` / `sp result` even when SPECIALISTS_JOB_FILE_OUTPUT
      // is off (post-ppkdg gating). Pre-ppkdg the terminal-path call used
      // appendTimelineEventFileOnly which silently dropped events.
      try {
        startDetachedGitnexusAnalyze(runOptions.workingDirectory ?? process.cwd());
        appendTimelineEvent(createMetaEvent('gitnexus_analyze_started', source));
        if (sha) lastGitnexusAnalyzedSha = sha;
      } catch (err: any) {
        appendTimelineEvent(createMetaEvent('gitnexus_analyze_start_failed', `${source}: ${String(err?.message ?? err)}`));
      }
    };
    const writeUnifiedHandoff = (params: {
      output: string;
      model: string;
      backend: string;
      status: SupervisorJobStatus;
      final: boolean;
      turnIndex?: number;
      promptHash?: string;
      durationMs?: number;
      tokenUsage?: SessionTokenUsage;
    }): boolean => {
      if (!shouldPersistHandoffBlock({ output: params.output, notesMode, final: params.final })) return false;
      const rendered = formatHandoffBlock({
        output: params.output,
        promptHash: params.promptHash,
        durationMs: params.durationMs,
        model: params.model,
        backend: params.backend,
        specialist: runOptions.name,
        jobId: id,
        status: params.status,
        timestamp: new Date().toISOString(),
        tokenUsage: params.tokenUsage,
        turnIndex: params.turnIndex,
      }, { final: params.final });
      const inputBeadId = runOptions.inputBeadId;
      if (shouldWriteExternalBeadNotes && inputBeadId && this.opts.beadsClient) {
        const noteText = notesMode === 'final-only' && !params.final ? '' : rendered;
        if (noteText) {
          const appendResult = this.opts.beadsClient.updateBeadNotes(inputBeadId, noteText);
          if (!appendResult.ok) {
            const appendError = `[bead-append-failed] ${appendResult.error ?? 'Unknown error'}`;
            appendTimelineEvent(createMetaEvent('bead_append_failed', appendError));
            setStatus({ current_event: 'bead_append_failed', last_event_at_ms: Date.now() });
            if (this.isJobFileOutputEnabled) {
              try {
                appendFileSync(this.resultPath(id), `\n\n${appendError}\n`, 'utf-8');
              } catch {
                // ignore secondary artifact write failures
              }
            }
          }
        }
      }
      if (outputFile) {
        try {
          if (notesMode === 'final-only') {
            writeFileSync(outputFile, rendered, 'utf-8');
          } else {
            appendFileSync(outputFile, rendered, 'utf-8');
          }
        } catch {
          // ignore secondary artifact write failures
        }
      }
      return true;
    };

    const appendResultToInputBead = (params: {
      output: string;
      model: string;
      backend: string;
      status: SupervisorJobStatus;
      final: boolean;
      turnIndex?: number;
      promptHash?: string;
      durationMs?: number;
      tokenUsage?: SessionTokenUsage;
    }): boolean => writeUnifiedHandoff(params);

    const buildAutoCommitEvidenceRefs = (jobId: string, worktreePath: string, commitSha: string): NonNullable<typeof latestEvidenceRefs> => {
      const baseShaResult = spawnSync('git', ['rev-parse', commitSha + '^'], { cwd: worktreePath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      const baseSha = baseShaResult.status === 0 ? (baseShaResult.stdout ?? '').trim() : undefined;
      const baseRef = baseSha ? commitSha + '^' : undefined;
      const range = baseSha ? baseSha + '..' + commitSha : commitSha + '^..' + commitSha;
      const numstatResult = spawnSync('git', ['diff', '--numstat', '--no-renames', range], { cwd: worktreePath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      const hunksResult = spawnSync('git', ['diff', '--unified=0', '--no-ext-diff', '--no-renames', range], { cwd: worktreePath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      const hunksOutput = (hunksResult.stdout ?? '').trim();
      const artifactRef = hunksOutput && !willHunksBeInline(hunksOutput)
        ? writeGitDiffHunksArtifact(this.jobDir(jobId), 'git-diff-' + commitSha.slice(0, 12) + '.patch', hunksOutput)
        : undefined;
      const diff = buildGitDiffEvidence({
        base_ref: baseRef,
        base_sha: baseSha,
        head_sha: commitSha,
        numstat_output: (numstatResult.stdout ?? '').trim(),
        hunks_output: hunksOutput,
        artifact_ref: artifactRef,
      });
      const traceFields = {
        ...(statusSnapshot.trace_id ? { trace_id: statusSnapshot.trace_id } : {}),
        ...(statusSnapshot.span_id ? { span_id: statusSnapshot.span_id } : {}),
        ...(statusSnapshot.parent_span_id ? { parent_span_id: statusSnapshot.parent_span_id } : {}),
      };
      const evidenceRefs: NonNullable<typeof latestEvidenceRefs> = [
        {
          evidence_kind: 'diff',
          evidence_ref: 'git:' + commitSha.slice(0, 12),
          evidence_state: diff.hunks_inline ? 'inline' : 'artifact',
          base_ref: diff.base_ref,
          base_sha: diff.base_sha,
          head_sha: diff.head_sha,
          ...traceFields,
          diff,
        },
        { evidence_kind: 'commit', evidence_ref: commitSha, evidence_state: 'complete', ...traceFields },
      ];
      const prEvidence = getObservedPrEvidenceRef(worktreePath);
      if (prEvidence) {
        evidenceRefs.push({ evidence_kind: 'pr', evidence_ref: prEvidence.pr_id ? 'pr:' + prEvidence.pr_id : prEvidence.pr_url, evidence_url: prEvidence.pr_url, evidence_state: prEvidence.pr_state, pr_id: prEvidence.pr_id, pr_url: prEvidence.pr_url, pr_state: prEvidence.pr_state, ...traceFields });
      }
      return evidenceRefs;
    };

    const applyAutoCommitCheckpoint = (target: 'waiting' | 'terminal', autoCommitPolicy: 'never' | 'checkpoint_on_waiting' | 'checkpoint_on_terminal' | undefined): void => {
      const autoCommitResult = runAutoCommitCheckpoint({
        autoCommitPolicy,
        target,
        worktreePath: statusSnapshot.worktree_path,
        specialist: runOptions.name,
        beadId: statusSnapshot.bead_id,
        turnNumber: Math.max(1, runMetrics.turns ?? 1),
        emitCommandEvent: (status, commandEvent) => {
          appendTimelineEvent(createCommandEvent(status, commandEvent) as unknown as TimelineEvent);
        },
      });

      if (autoCommitResult.status === 'skipped') {
        appendTimelineEvent(createAutoCommitEvent('skipped', { reason: autoCommitResult.reason }));
        return;
      }

      if (autoCommitResult.status === 'failed') {
        appendTimelineEvent(createAutoCommitEvent('failed', { reason: autoCommitResult.reason }));
        console.warn(`[supervisor] Auto-commit failed for job ${id}: ${autoCommitResult.reason}`);
        return;
      }

      const nextAutoCommitCount = (statusSnapshot.auto_commit_count ?? 0) + 1;
      setStatus({
        auto_commit_count: nextAutoCommitCount,
        last_auto_commit_sha: autoCommitResult.sha,
        last_auto_commit_at_ms: autoCommitResult.committedAtMs,
      });
      latestEvidenceRefs = buildAutoCommitEvidenceRefs(id, statusSnapshot.worktree_path ?? process.cwd(), autoCommitResult.sha);
      appendTimelineEvent(createAutoCommitEvent('success', {
        commit_sha: autoCommitResult.sha,
        committed_files: autoCommitResult.files,
        evidence: latestEvidenceRefs,
      }));
      // Refresh GitNexus index immediately after the commit so reviewers/orchestrators
      // inspecting the keep-alive worktree mid-session see up-to-date graph data.
      // Dedupes against the terminal-path fire via lastGitnexusAnalyzedSha.
      triggerGitnexusAnalyzeIfNeeded(autoCommitResult.sha, 'checkpoint');
    };

    const handleResumeTurn = async (task: string): Promise<void> => {
      if (!resumeFn) return;
      const now = Date.now();
      lastActivityMs = now;
      const previousStatus = statusSnapshot.status;
      setStatus({ status: 'running', current_event: 'starting', last_event_at_ms: now });
      if (previousStatus !== 'running') {
        appendTimelineEvent(createStatusChangeEvent('running', previousStatus));
      }
      appendTimelineEvent(createControlSignalEvent('resume_consumed', {
        source: 'runtime',
        previous_status: previousStatus,
        next_status: 'running',
        task_preview: task.replace(/\s+/g, ' ').slice(0, 240),
      }));
      silenceWarnEmitted = false;

      try {
        const output = await resumeFn(task);
        latestOutput = output;
        if (this.isJobFileOutputEnabled) {
          mkdirSync(this.jobDir(id), { recursive: true });
          writeFileSync(this.resultPath(id), lastTurnSummaryTextContent || output, 'utf-8');
        }
        try {
          this.withSqliteOperation('upsertResult:resume_turn', (client) => client.upsertResult(id, lastTurnSummaryTextContent || output));
        } catch (error: unknown) {
          console.warn(`[supervisor] SQLite upsertResult failed during resume turn: ${String(error)}`);
        }

        emitRunCompleteForTurn({
          model: statusSnapshot.model ?? 'unknown',
          backend: statusSnapshot.backend ?? 'unknown',
          beadId: statusSnapshot.bead_id,
          output: lastTurnSummaryTextContent || output,
        });

        const passFinalize = shouldAutoFinalizeKeepAlive(output);
        const readOnlyClose = shouldAutoCloseReadOnlyKeepAlive(output);
        if (passFinalize || readOnlyClose || parseReviewVerdict(output)) {
          emitReviewVerdictTimelineEvent(output, {
            chainId: statusSnapshot.chain_id,
            chainTemplate: statusSnapshot.startup_context?.branch,
          });
        }
        const isWaitingTurn = !readOnlyClose && !passFinalize;
        applyAutoCommitCheckpoint(isWaitingTurn ? 'waiting' : 'terminal', autoCommitPolicy);
        writeUnifiedHandoff({
          output,
          model: statusSnapshot.model ?? 'unknown',
          backend: statusSnapshot.backend ?? 'unknown',
          status: isWaitingTurn ? 'waiting' : 'done',
          final: false,
          turnIndex: runMetrics.turns,
          tokenUsage: runMetrics.token_usage,
        });

        if (!isWaitingTurn) {
          void closeKeepAliveSession();
          return;
        }

        setWaitingStatus();
      } catch (err: any) {
        const error = err instanceof Error ? err : new Error(String(err));
        setStatus({ status: 'error', error: error.message });
        finishKeepAlive({ kind: 'fatal', error });
      }
    };

    let waitingAutoCloseInFlight = false;
    const closeKeepAliveSession = async (options?: {
      source?: 'cli' | 'supervisor' | 'watchdog' | 'runtime';
      reason?: string;
      gracefulTimeoutMs?: number;
      onGracefulClose?: () => void;
      onForcedTermination?: (error: Error) => void;
    }): Promise<void> => {
      if (!closeFn) {
        options?.onGracefulClose?.();
        finishKeepAlive({ kind: 'closed' });
        return;
      }
      try {
        if (options?.gracefulTimeoutMs && options.gracefulTimeoutMs > 0) {
          await Promise.race([
            closeFn(),
            new Promise<never>((_, reject) => {
              setTimeout(() => {
                reject(new Error(`waiting auto-close timed out after ${options.gracefulTimeoutMs}ms`));
              }, options.gracefulTimeoutMs).unref();
            }),
          ]);
        } else {
          await closeFn();
        }
        options?.onGracefulClose?.();
        finishKeepAlive({ kind: 'closed' });
      } catch (err: any) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (options?.gracefulTimeoutMs && killFn) {
          options.onForcedTermination?.(error);
          setStatus({ status: 'error', error: `${error.message}; forced termination requested` });
          killFn();
          finishKeepAlive({ kind: 'fatal', error: new Error(`${error.message}; forced termination requested`) });
          return;
        }
        setStatus({ status: 'error', error: error.message });
        finishKeepAlive({ kind: 'fatal', error });
      }
    };

    // Stuck detection: thresholds, local tracking state, and periodic checker
    const thresholds = {
      ...STALL_DETECTION_DEFAULTS,
      ...this.opts.stallDetection,
      waiting_auto_close_ms: this.opts.stallDetection?.waiting_auto_close_ms ?? STALL_DETECTION_DEFAULTS.waiting_auto_close_ms,
    };
    let lastActivityMs = startedAtMs;
    let silenceWarnEmitted = false;
    let toolStartMs: number | undefined;
    let toolDurationWarnEmitted = false;
    let stuckIntervalId: ReturnType<typeof setInterval> | undefined;

    stuckIntervalId = setInterval(() => {
      const now = Date.now();
      if (statusSnapshot.status === 'running') {
        const silenceMs = now - lastActivityMs;
        if (!silenceWarnEmitted && silenceMs > thresholds.running_silence_warn_ms) {
          silenceWarnEmitted = true;
          appendTimelineEvent(createStaleWarningEvent('running_silence', {
            silence_ms: silenceMs,
            threshold_ms: thresholds.running_silence_warn_ms,
          }));
        }
        if (silenceMs > thresholds.running_silence_error_ms) {
          appendTimelineEvent(createStaleWarningEvent('running_silence_error', {
            silence_ms: silenceMs,
            threshold_ms: thresholds.running_silence_error_ms,
          }));
          setStatus({
            status: 'error',
            error: `No activity for ${Math.round(silenceMs / 1000)}s (threshold: ${thresholds.running_silence_error_ms / 1000}s)`,
          });
          killFn?.();
          clearInterval(stuckIntervalId);
        }
      }
      const waitingAutoCloseThresholdMs = thresholds.waiting_auto_close_ms ?? 0;
      if (
        !waitingAutoCloseInFlight
        && waitingAutoCloseThresholdMs > 0
        && statusSnapshot.status === 'waiting'
      ) {
        const waitingSinceMs = statusSnapshot.last_event_at_ms ?? startedAtMs;
        const waitingSilenceMs = now - waitingSinceMs;
        if (waitingSilenceMs > waitingAutoCloseThresholdMs) {
          waitingAutoCloseInFlight = true;
          appendTimelineEvent(createControlSignalEvent('waiting_auto_close_requested', {
            source: 'watchdog',
            previous_status: statusSnapshot.status,
            reason: 'waiting threshold exceeded',
            metadata: {
              silence_ms: waitingSilenceMs,
              threshold_ms: waitingAutoCloseThresholdMs,
            },
          }));
          setStatus({ current_event: 'waiting_auto_close', last_event_at_ms: now });
          void closeKeepAliveSession({
            source: 'watchdog',
            reason: 'waiting auto-close threshold exceeded',
            gracefulTimeoutMs: WAITING_AUTO_CLOSE_GRACE_MS,
            onGracefulClose: () => {
              appendTimelineEvent(createControlSignalEvent('waiting_auto_close_completed', {
                source: 'watchdog',
                previous_status: 'waiting',
                next_status: 'done',
                reason: 'close_fn_resolved',
                metadata: {
                  silence_ms: waitingSilenceMs,
                  threshold_ms: waitingAutoCloseThresholdMs,
                },
              }));
            },
            onForcedTermination: (error) => {
              appendTimelineEvent(createControlSignalEvent('waiting_auto_close_force_requested', {
                source: 'watchdog',
                previous_status: 'waiting',
                next_status: 'error',
                signal: 'SIGTERM/SIGKILL',
                reason: error.message,
                metadata: {
                  silence_ms: waitingSilenceMs,
                  threshold_ms: waitingAutoCloseThresholdMs,
                  graceful_timeout_ms: WAITING_AUTO_CLOSE_GRACE_MS,
                },
              }));
            },
          });
        }
      }
      if (toolStartMs !== undefined && !toolDurationWarnEmitted) {
        const toolDurationMs = now - toolStartMs;
        if (toolDurationMs > thresholds.tool_duration_warn_ms) {
          toolDurationWarnEmitted = true;
          const activeToolName = activeToolCalls.values().next().value?.tool ?? latestUncorrelatedToolState?.tool ?? 'unknown';
          appendTimelineEvent(createStaleWarningEvent('tool_duration', {
            silence_ms: toolDurationMs,
            threshold_ms: thresholds.tool_duration_warn_ms,
            tool: activeToolName,
          }));
        }
      }
    }, 10_000);

    const sigtermHandler = () => {
      if (keepAliveSession) {
        const hasPendingKeepAliveOutput = Boolean(
          latestOutput
          && statusSnapshot.status === 'waiting'
          && !shouldAutoCloseReadOnlyKeepAlive(latestOutput),
        );
        if (hasPendingKeepAliveOutput) {
          const appendSucceeded = writeUnifiedHandoff({
            output: latestOutput,
            model: statusSnapshot.model ?? 'unknown',
            backend: statusSnapshot.backend ?? 'unknown',
            status: 'cancelled',
            final: false,
            turnIndex: runMetrics.turns,
            tokenUsage: runMetrics.token_usage,
          });
          if (appendSucceeded) {
            skipFinalKeepAliveInputBeadAppend = true;
          }
        }
        void closeKeepAliveSession();
        return;
      }
      killFn?.();
    };
    process.once('SIGTERM', sigtermHandler);

    const runOptionsWithBoundary = runOptions.workingDirectory
      ? { ...runOptions, worktreeBoundary: runOptions.workingDirectory, suppressRunnerFileOutput: true }
      : { ...runOptions, suppressRunnerFileOutput: true };

    try {
      const result = await runner.run(
        runOptionsWithBoundary,
        // onProgress — parse tool names, update status, and stream to caller
        (delta) => {
          const toolMatch = delta.match(/⚙ (.+?)…/);
          if (toolMatch) {
            setStatus({ current_tool: toolMatch[1] });
          }

          if (delta !== '✓\n' && !delta.startsWith('\n⚙ ') && !delta.startsWith('💭 ')) {
            turnTextAccumulator += delta;
          }

          // Stream to caller if callback provided
          this.opts.onProgress?.(delta);
        },
        // onEvent — map callback events to timeline events
        (eventType, details) => {
          const now = Date.now();
          // Reset silence timer on any activity
          lastActivityMs = now;
          silenceWarnEmitted = false;
          const keepAliveTurnCompleted = keepAliveSession && eventType === 'agent_end';
          if (keepAliveTurnCompleted) {
            setWaitingStatus();
          } else {
            setStatus({
              status: 'running',
              current_event: eventType,
              last_event_at_ms: now,
              elapsed_s: Math.round((now - startedAtMs) / 1000),
            });
          }

          // Map callback event to timeline event using the canonical model
          if (eventType === 'turn_start') {
            textCharCount = 0;
            thinkingCharCount = 0;
            turnTextAccumulator = '';
            assistantMessageAccumulator = '';
          }
          if (eventType === 'message_start_assistant') {
            turnTextAccumulator = '';
            assistantMessageAccumulator = '';
          }
          if (eventType === 'text') {
            textCharCount += details?.charCount ?? 0;
            if (typeof details?.content === 'string') {
              assistantMessageAccumulator += details.content;
            }
          }
          if (eventType === 'thinking') {
            thinkingCharCount += details?.charCount ?? 0;
          }

          const toolCallId = details?.toolCallId;
          const toolState = toolCallId
            ? activeToolCalls.get(toolCallId)
            : latestUncorrelatedToolState;

          const parsedMeta = (() => {
            if ((eventType !== 'memory_injection' && eventType !== 'meta' && eventType !== 'payload_breakdown') || !details?.summary) return undefined;
            try {
              return JSON.parse(details.summary) as {
                memory_injection?: {
                  static_tokens?: number;
                  memory_tokens?: number;
                  gitnexus_tokens?: number;
                  total_tokens?: number;
                };
                payload_breakdown?: {
                  components?: Array<{ kind: string; name: string; tokens: number; bytes: number }>;
                  totals?: { tokens: number; bytes: number };
                };
                kind?: 'meta';
                source?: string;
                backend?: string;
                data?: {
                  sets_loaded?: string[];
                  rules_count?: number;
                  inline_rules_count?: number;
                  globals_disabled?: boolean;
                  token_estimate?: number;
                  budget_limit?: number;
                  candidate_tokens?: number;
                  injected_tokens?: number;
                  injected_section_ids?: string[];
                  evicted_section_ids?: string[];
                  payload_digest?: string;
                  outcome?: 'full' | 'degraded' | 'impossible';
                };
              };
            } catch {
              return undefined;
            }
          })();
          const metaDetails = details as {
            source?: string;
            backend?: string;
            data?: {
              sets_loaded?: string[];
              rules_count?: number;
              inline_rules_count?: number;
              globals_disabled?: boolean;
              token_estimate?: number;
              budget_limit?: number;
              candidate_tokens?: number;
              injected_tokens?: number;
              injected_section_ids?: string[];
              evicted_section_ids?: string[];
              payload_digest?: string;
              outcome?: 'full' | 'degraded' | 'impossible';
            };
          } | undefined;

          const memoryInjection = parsedMeta?.memory_injection
            ? {
                static_tokens: parsedMeta.memory_injection.static_tokens ?? 0,
                memory_tokens: parsedMeta.memory_injection.memory_tokens ?? 0,
                gitnexus_tokens: parsedMeta.memory_injection.gitnexus_tokens ?? 0,
                total_tokens: parsedMeta.memory_injection.total_tokens ?? 0,
              }
            : undefined;

          const mandatoryRulesInjection = parsedMeta?.source === 'mandatory_rules_injection' && parsedMeta.data
            ? projectMandatoryRulesInjection(parsedMeta.data)
            : undefined;

          const payloadBreakdown = parsedMeta?.payload_breakdown?.components && parsedMeta.payload_breakdown.totals
            ? {
                components: parsedMeta.payload_breakdown.components,
                totals: parsedMeta.payload_breakdown.totals,
              }
            : undefined;

          if (payloadBreakdown) {
            setStatus({ startup_payload_json: JSON.stringify(payloadBreakdown) });
          }

          if (memoryInjection || mandatoryRulesInjection) {
            setStatus({
              startup_context: {
                ...(statusSnapshot.startup_context ?? {}),
                ...(memoryInjection ? { memory_injection: memoryInjection } : {}),
                ...(mandatoryRulesInjection ? { mandatory_rules_injection: mandatoryRulesInjection } : {}),
              },
            });
          }

          const timelineEvent = mapCallbackEventToTimelineEvent(eventType, {
            tool: toolState?.tool,
            toolCallId,
            args: toolState?.args,
            isError: toolState?.isError,
            resultContent: toolState?.resultContent,
            resultRaw: toolState?.resultRaw,
            charCount: eventType === 'text'
              ? textCharCount
              : eventType === 'thinking'
                ? thinkingCharCount
                : details?.charCount,
            compaction: {
              tokensBefore: details?.tokensBefore,
              summary: details?.summary,
              firstKeptEntryId: details?.firstKeptEntryId,
            },
            retry: {
              attempt: details?.attempt,
              maxAttempts: details?.maxAttempts,
              delayMs: details?.delayMs,
              errorMessage: details?.errorMessage,
            },
            modelChange: {
              action: details?.action ?? (eventType === 'set_model' || eventType === 'cycle_model' ? eventType : 'set_model'),
              model: details?.model,
              previousModel: details?.previousModel,
            },
            extensionError: {
              extension: details?.extension,
              errorMessage: details?.errorMessage,
            },
            payloadBreakdown,
            memoryInjection,
            metaPayload: eventType === 'meta' ? {
              model: details?.model,
              backend: metaDetails?.backend,
              source: metaDetails?.source,
              data: metaDetails?.data,
            } : undefined,
          });

          const assistantMessageContent = assistantMessageAccumulator || (typeof details?.content === 'string' ? details.content : '');
          if (
            (eventType === 'message_end_assistant' || eventType === 'agent_end')
            && assistantMessageContent.trim().length > 0
            && assistantMessageContent !== lastPersistedAssistantMessage
          ) {
            appendTimelineEvent({
              t: Date.now(),
              type: TIMELINE_EVENT_TYPES.TEXT,
              char_count: assistantMessageContent.length,
              content: assistantMessageContent,
            });
            lastPersistedAssistantMessage = assistantMessageContent;
            assistantMessageAccumulator = '';
          }

          if (timelineEvent) {
            appendTimelineEvent(timelineEvent);
            if (eventType === 'tool_execution_end') {
              if (toolCallId) {
                activeToolCalls.delete(toolCallId);
              } else {
                latestUncorrelatedToolState = undefined;
              }

              const nextActiveTool = activeToolCalls.values().next().value?.tool;
              setStatus({ current_tool: nextActiveTool });
            }
          }
        },
        // onMetric — additive RPC-derived observability
        (metricEvent: SessionMetricEvent) => {
          if (metricEvent.type === 'token_usage') {
            mergeRunMetrics({ token_usage: metricEvent.token_usage });
            currentContextTokens = metricEvent.token_usage.input_tokens ?? 0;
            appendTimelineEvent(createTokenUsageEvent(metricEvent.token_usage, metricEvent.source));
            return;
          }

          if (metricEvent.type === 'finish_reason') {
            mergeRunMetrics({ finish_reason: metricEvent.finish_reason });
            appendTimelineEvent(createFinishReasonEvent(metricEvent.finish_reason, metricEvent.source));
            return;
          }

          if (metricEvent.type === 'api_error') {
            mergeRunMetrics({ api_error: metricEvent.errorMessage });
            appendTimelineEvent({
              t: Date.now(),
              type: TIMELINE_EVENT_TYPES.ERROR,
              source: metricEvent.source,
              error_message: metricEvent.errorMessage,
            });
            return;
          }

          if (metricEvent.type === 'turn_summary') {
            mergeRunMetrics({
              turns: metricEvent.turn_index,
              ...(metricEvent.token_usage ? { token_usage: metricEvent.token_usage } : {}),
              ...(metricEvent.finish_reason ? { finish_reason: metricEvent.finish_reason } : {}),
            });
            const contextUtilization = calculateContextUtilization(currentContextTokens, statusSnapshot.model);
            setStatus({
              context_pct: contextUtilization?.context_pct,
              context_health: contextUtilization?.context_health,
            });
            lastTurnSummaryIndex = metricEvent.turn_index;
            lastTurnSummaryTextContent = turnTextAccumulator;
            appendTimelineEvent(createTurnSummaryEvent(
              metricEvent.turn_index,
              metricEvent.token_usage,
              metricEvent.finish_reason,
              turnTextAccumulator || undefined,
              contextUtilization?.context_pct,
              contextUtilization?.context_health,
            ));
            if (!keepAliveSession && !runOptions.keepAlive) {
              writeUnifiedHandoff({
                output: turnTextAccumulator,
                model: statusSnapshot.model ?? 'unknown',
                backend: statusSnapshot.backend ?? 'unknown',
                status: 'done',
                final: false,
                turnIndex: metricEvent.turn_index,
                tokenUsage: metricEvent.token_usage ?? runMetrics.token_usage,
              });
            }
            turnTextAccumulator = '';
            return;
          }

          if (metricEvent.type === 'compaction') {
            const compactions = (runMetrics.auto_compactions ?? 0) + (metricEvent.phase === 'end' ? 1 : 0);
            mergeRunMetrics({ auto_compactions: compactions });
            appendTimelineEvent(createCompactionEvent(metricEvent.phase, {
              tokensBefore: metricEvent.tokensBefore,
              summary: metricEvent.summary,
              firstKeptEntryId: metricEvent.firstKeptEntryId,
            }));
            return;
          }

          if (metricEvent.type === 'retry') {
            const retries = (runMetrics.auto_retries ?? 0) + (metricEvent.phase === 'end' ? 1 : 0);
            mergeRunMetrics({ auto_retries: retries });
            appendTimelineEvent(createRetryEvent(metricEvent.phase, {
              attempt: metricEvent.attempt,
              maxAttempts: metricEvent.maxAttempts,
              delayMs: metricEvent.delayMs,
              errorMessage: metricEvent.errorMessage,
            }));
            return;
          }

        },
        // onMeta — model/backend metadata
        (meta) => {
          setStatus({ model: meta.model, backend: meta.backend, ...(meta.sessionId ? { session_id: meta.sessionId } : {}) });
          appendTimelineEvent(createMetaEvent(meta.model, meta.backend));
          // Stream to caller if callback provided
          this.opts.onMeta?.(meta);
        },
        // onKillRegistered — capture so SIGTERM can kill the Pi session cleanly
        (fn) => { killFn = fn; },
        (session) => { this.setActiveSession(session); },
        // onBeadCreated
        (beadId) => {
          setStatus({ bead_id: beadId });
        },
        // onSteerRegistered — wire FIFO reader to forward steer messages into the session
        (fn) => {
          steerFn = fn;
          if (!existsSync(fifoPath)) return;
          // Start a background reader loop on the FIFO.
          // Opening with 'r+' (O_RDWR) prevents blocking on open when there's no writer yet.
          // Each line received is forwarded as a steer message to the Pi session.
          // Open the FIFO fd synchronously (O_RDWR = non-blocking on named pipes)
          // so the fd is guaranteed open before onResumeReady transitions to 'waiting'.
          // createReadStream without a path argument uses the pre-opened fd directly,
          // eliminating the race where a test writer (O_WRONLY) blocks waiting for a reader.
          fifoFd = openSync(fifoPath, 'r+');
          fifoReadStream = createReadStream('', { fd: fifoFd, autoClose: false });
          fifoReadline = createInterface({ input: fifoReadStream });
          fifoReadline.on('line', (line) => {
              try {
                const parsed = JSON.parse(line);
                if (parsed?.type === 'steer' && typeof parsed.message === 'string') {
                  appendTimelineEvent(createControlSignalEvent('steer_consumed', {
                    source: 'runtime',
                    previous_status: statusSnapshot.status,
                    message_preview: parsed.message.replace(/\s+/g, ' ').slice(0, 240),
                  }));
                  // steer is only valid while the session is running
                  steerFn?.(parsed.message).catch((error) => {
                    appendTimelineEvent(createControlSignalEvent('steer_failed', {
                      source: 'runtime',
                      previous_status: statusSnapshot.status,
                      error_message: error instanceof Error ? error.message : String(error),
                    }));
                  });
                } else if (parsed?.type === 'resume' && typeof parsed.task === 'string') {
                  // resume: send next-turn prompt to a waiting keep-alive session
                  // waiting state: retained, non-streaming pi session awaiting explicit next-turn
                  // action from orchestrator. Valid actions: resume, close. Invalid: steer.
                  void handleResumeTurn(parsed.task);
                } else if (parsed?.type === 'prompt' && typeof parsed.message === 'string') {
                  // DEPRECATED: {type:"prompt"} → use {type:"resume", task:"..."} instead
                  console.error('[specialists] DEPRECATED: FIFO message {type:"prompt"} is deprecated. Use {type:"resume", task:"..."} instead.');
                  void handleResumeTurn(parsed.message);
                } else if (parsed?.type === 'close') {
                  appendTimelineEvent(createControlSignalEvent('close_consumed', { source: 'runtime', previous_status: statusSnapshot.status }));
                  void closeKeepAliveSession();
                }
              } catch (error) {
                appendTimelineEvent(createControlSignalEvent('fifo_parse_error', {
                  source: 'runtime',
                  error_message: error instanceof Error ? error.message : String(error),
                }));
              }
            });
          fifoReadline.on('error', (error) => {
            console.error(`[supervisor] FIFO read error: ${String(error)}`);
          });
        },
        // onResumeReady — keep-alive: session stays alive after first agent_end
        (rFn, cFn) => {
          keepAliveSession = true;
          resumeFn = rFn;
          closeFn = cFn;
          setWaitingStatus();
        },
        // onToolStartCallback — capture tool name, args, and call ID for timeline event fidelity
        (tool, args, toolCallId) => {
          const toolState: ActiveToolCallState = {
            tool,
            args,
            isError: false,
            resultContent: undefined,
            resultRaw: undefined,
          };

          if (toolCallId) {
            activeToolCalls.set(toolCallId, toolState);
          } else {
            latestUncorrelatedToolState = toolState;
          }

          toolStartMs = Date.now();
          toolDurationWarnEmitted = false;
          toolCallNames.push(tool);
          mergeRunMetrics({
            tool_calls: toolCallNames.length,
            tool_call_names: toolCallNames,
          });
          setStatus({ current_tool: tool });
        },
        // onToolEndCallback — restore correct per-call context before onEvent('tool_execution_end') fires
        (tool, isError, toolCallId, resultContent, resultRaw) => {
          const resolvedToolState: ActiveToolCallState = toolCallId
            ? activeToolCalls.get(toolCallId) ?? { tool }
            : latestUncorrelatedToolState ?? { tool };

          const finalizedToolState: ActiveToolCallState = {
            ...resolvedToolState,
            tool: resolvedToolState.tool ?? tool,
            isError,
            resultContent,
            resultRaw,
          };

          if (toolCallId) {
            activeToolCalls.set(toolCallId, finalizedToolState);
          } else {
            latestUncorrelatedToolState = finalizedToolState;
          }

          toolStartMs = undefined;
          toolDurationWarnEmitted = false;

          const resolvedToolName = finalizedToolState.tool;
          const resolvedToolArgs = finalizedToolState.args;

          if (resolvedToolName === 'edit' || resolvedToolName === 'write') {
            const path = resultRaw?.path;
            if (typeof path === 'string' && path.trim().length > 0) {
              gitnexusAccumulator.files_touched.add(path);
            }
          }

          if (resolvedToolName.startsWith('gitnexus_')) {
            gitnexusAccumulator.tool_invocations += 1;

            for (const file of extractGitnexusFiles(resolvedToolName, resultRaw)) {
              gitnexusAccumulator.files_touched.add(file);
            }

            for (const symbol of extractGitnexusSymbols(resultRaw, resolvedToolArgs)) {
              gitnexusAccumulator.symbols_analyzed.add(symbol);
            }

            const risk = extractGitnexusRisk(resultRaw);
            if (risk) {
              const currentHighest = gitnexusAccumulator.highest_risk;
              if (!currentHighest || GITNEXUS_RISK_ORDER[risk] > GITNEXUS_RISK_ORDER[currentHighest]) {
                gitnexusAccumulator.highest_risk = risk;
              }
            }
          }

          setStatus({ current_tool: undefined });
        },
      );

      latestOutput = result.output;
      if (this.isJobFileOutputEnabled) {
        mkdirSync(this.jobDir(id), { recursive: true });
        writeFileSync(this.resultPath(id), lastTurnSummaryTextContent || latestOutput, 'utf-8');
      }

      const elapsed = Math.round((Date.now() - startedAtMs) / 1000);
      const finalResult = {
        ...result,
        output: latestOutput,
      };

      mergeRunMetrics(finalResult.metrics);
      mergeRunMetrics({
        tool_calls: toolCallNames.length,
        tool_call_names: toolCallNames,
        exit_reason: 'agent_end',
      });
      isReadOnlySpecialist = finalResult.permissionRequired === 'READ_ONLY';
      autoCommitPolicy = finalResult.autoCommit;

      // Reported output falls back to the last non-empty turn summary when the
      // final turn itself produced no text (e.g. a model ends on an empty
      // completion). Control-flow decisions below keep using finalResult.output
      // (the true final turn) — only the externally-visible result substitutes.
      const reportedOutput = lastTurnSummaryTextContent || finalResult.output;

      emitRunCompleteForTurn({
        model: finalResult.model,
        backend: finalResult.backend,
        beadId: finalResult.beadId,
        output: reportedOutput,
      });

      // Persist result row on every turn boundary so `sp result` and stopped-job
      // recovery can read the last completed output without depending on the
      // file-output gate or keep-alive lifecycle.
      try {
        this.withSqliteOperation('upsertResult:initial_turn', (client) => client.upsertResult(id, reportedOutput));
      } catch (error: unknown) {
        console.warn(`[supervisor] SQLite upsertResult failed during initial turn: ${String(error)}`);
      }

      const runCompletesAsWaiting = keepAliveSession && !shouldAutoCloseReadOnlyKeepAlive(finalResult.output);
      applyAutoCommitCheckpoint(runCompletesAsWaiting ? 'waiting' : 'terminal', autoCommitPolicy);

      if (keepAliveSession) {
        if (parseReviewVerdict(finalResult.output)) {
          emitReviewVerdictTimelineEvent(finalResult.output, {
            chainId: statusSnapshot.chain_id,
            chainTemplate: statusSnapshot.startup_context?.branch,
          });
        }
        if (shouldAutoCloseReadOnlyKeepAlive(finalResult.output)) {
          await closeKeepAliveSession();
        } else if (shouldAutoFinalizeKeepAlive(finalResult.output)) {
          // PASS turns waiting keep-alive chain into terminal job via same close path.
          await closeKeepAliveSession();
        } else {
          // Degenerate-turn guard: a completion with no output text and no tool
          // calls means the model ended the turn without doing any work. Nudge
          // it once before parking the session in waiting (xtrm-5kwk2) so a
          // keep-alive job does not silently stall with an empty result.
          if (!finalResult.output?.trim() && toolCallNames.length === 0 && resumeFn) {
            appendTimelineEvent(createMetaEvent('degenerate_empty_turn', 'supervisor'));
            try {
              const nudgeOutput = await resumeFn(
                'Your previous turn produced no output and no tool calls. Continue the task now: investigate the issue and fix it.',
              );
              if (nudgeOutput?.trim()) {
                latestOutput = nudgeOutput;
                try {
                  this.withSqliteOperation('upsertResult:degenerate_turn_nudge', (client) => client.upsertResult(id, nudgeOutput));
                } catch (error: unknown) {
                  console.warn(`[supervisor] SQLite upsertResult failed after degenerate-turn nudge: ${String(error)}`);
                }
              }
            } catch (error: unknown) {
              console.warn(`[supervisor] Degenerate-turn nudge failed: ${String(error)}`);
            }
          }
          // Inline bead-notes append on the waiting checkpoint so the input
          // bead reflects the turn's output immediately. Mirrors handleResumeTurn.
          writeUnifiedHandoff({
            output: latestOutput || finalResult.output,
            model: finalResult.model,
            backend: finalResult.backend,
            status: 'waiting',
            final: false,
            turnIndex: runMetrics.turns,
            promptHash: finalResult.promptHash,
            durationMs: finalResult.durationMs,
            tokenUsage: finalResult.metrics?.token_usage,
          });
          skipFinalKeepAliveInputBeadAppend = true;
          setWaitingStatus({
            model: result.model,
            backend: result.backend,
            bead_id: result.beadId,
          });
        }

        const keepAliveExit = await keepAliveExitPromise;
        if (keepAliveExit.kind === 'fatal') {
          throw keepAliveExit.error;
        }
      }

      const inputBeadId = runOptions.inputBeadId;
      const ownsBead = Boolean(finalResult.beadId && !inputBeadId);

      const appendedStatus: SupervisorJobStatus = keepAliveSession && !shouldAutoCloseReadOnlyKeepAlive(finalResult.output)
        ? 'waiting'
        : 'done';
      const shouldSkipFinalInputBeadAppend = keepAliveSession && skipFinalKeepAliveInputBeadAppend;
      if (!shouldSkipFinalInputBeadAppend) {
        writeUnifiedHandoff({
          output: lastTurnSummaryTextContent || finalResult.output,
          model: finalResult.model,
          backend: finalResult.backend,
          status: appendedStatus,
          final: true,
          turnIndex: lastTurnSummaryIndex || runMetrics.turns,
          promptHash: finalResult.promptHash,
          durationMs: finalResult.durationMs,
          tokenUsage: finalResult.metrics?.token_usage,
        });
      }

      if (ownsBead && finalResult.beadId) {
        this.opts.beadsClient?.updateBeadNotes(finalResult.beadId, formatHandoffBlock({
          output: lastTurnSummaryTextContent || finalResult.output,
          promptHash: finalResult.promptHash,
          durationMs: finalResult.durationMs,
          model: finalResult.model,
          backend: finalResult.backend,
          specialist: runOptions.name,
          jobId: id,
          status: 'done',
          timestamp: new Date().toISOString(),
          tokenUsage: finalResult.metrics?.token_usage,
          turnIndex: lastTurnSummaryIndex || runMetrics.turns,
        }, { final: true }));
      } else if (shouldWriteExternalBeadNotes && !inputBeadId && finalResult.beadId) {
        this.opts.beadsClient?.updateBeadNotes(finalResult.beadId, formatHandoffBlock({
          output: lastTurnSummaryTextContent || finalResult.output,
          promptHash: finalResult.promptHash,
          durationMs: finalResult.durationMs,
          model: finalResult.model,
          backend: finalResult.backend,
          specialist: runOptions.name,
          jobId: id,
          status: 'done',
          timestamp: new Date().toISOString(),
          tokenUsage: finalResult.metrics?.token_usage,
          turnIndex: lastTurnSummaryIndex || runMetrics.turns,
        }, { final: true }));
      }

      if (finalResult.beadId) {
        // Close owned beads with full COMPLETE/duration/model reason. Auto-close input beads
        // when still in_progress so terminal DONE status retires them (unitAI-9truh).
        const liveJobs = this.listLiveJobsForBead(finalResult.beadId).filter((liveJobId) => liveJobId !== id);
        if (liveJobs.length > 0) {
          appendTimelineEvent({
            t: Date.now(),
            type: TIMELINE_EVENT_TYPES.META,
            model: `bead_close_skipped: sibling-jobs-active [${liveJobs.join(', ')}]`,
            backend: 'supervisor',
          } as TimelineEvent);
        } else if (!inputBeadId) {
          this.opts.beadsClient?.closeBead(finalResult.beadId, 'COMPLETE', finalResult.durationMs, finalResult.model);
        } else {
          this.opts.beadsClient?.closeBeadIfInProgress(
            finalResult.beadId,
            `Specialist ${runOptions.name} completed (job ${id})`,
          );
        }
      }
      const completedAtMs = Date.now();
      const enrichedRunMetrics = finalResult.outputType
        ? { ...runMetrics, output_type: finalResult.outputType }
        : runMetrics;
      statusSnapshot = {
        ...statusSnapshot,
        status: 'done',
        elapsed_s: elapsed,
        last_event_at_ms: completedAtMs,
        model: finalResult.model,
        backend: finalResult.backend,
        bead_id: finalResult.beadId,
        startup_payload_json: finalResult.payloadBreakdown ? JSON.stringify(finalResult.payloadBreakdown) : statusSnapshot.startup_payload_json,
        metrics: enrichedRunMetrics,
        ...(finalResult.outputType ? { output_type: finalResult.outputType } : {}),
      };
      this.writeStatusFileOnly(id, statusSnapshot);

      const gitnexusSummary = gitnexusAccumulator.tool_invocations > 0
        ? {
            files_touched: [...gitnexusAccumulator.files_touched],
            symbols_analyzed: [...gitnexusAccumulator.symbols_analyzed],
            highest_risk: gitnexusAccumulator.highest_risk,
            tool_invocations: gitnexusAccumulator.tool_invocations,
          }
        : undefined;

      const completePersisted = this.withSqliteOperation('upsertStatusWithEventAndResult:complete', (client) => {
        client.upsertStatusWithEventAndResult(statusSnapshot, createRunCompleteEvent('COMPLETE', elapsed, {
          final: true,
          model: finalResult.model,
          backend: finalResult.backend,
          bead_id: finalResult.beadId,
          output: finalResult.output,
          token_usage: runMetrics.token_usage,
          finish_reason: runMetrics.finish_reason,
          tool_calls: [...toolCallNames],
          exit_reason: runMetrics.exit_reason,
          metrics: enrichedRunMetrics,
          ...(gitnexusSummary ? { gitnexus_summary: gitnexusSummary } : {}),
        }), reportedOutput);
        return true;
      });
      if (completePersisted === undefined) {
        throw new Error('[supervisor] SQLite upsertStatusWithEventAndResult failed: database client unavailable');
      }

      emitParentNotification(statusSnapshot, this.activeSiblingAssignee(statusSnapshot));
      this.aggregateJobMetricsBestEffort(id);

      // Terminal-path gitnexus analyze. Dedupes against checkpoint-time fires for
      // the same commit; if a checkpoint already analyzed the final sha we skip.
      triggerGitnexusAnalyzeIfNeeded(statusSnapshot.last_auto_commit_sha, 'terminal');

      return id;
    } catch (err: any) {
      const elapsed = Math.round((Date.now() - startedAtMs) / 1000);
      const errorMsg = err?.message ?? String(err);
      const failedAtMs = Date.now();
      statusSnapshot = {
        ...statusSnapshot,
        status: 'error',
        elapsed_s: elapsed,
        error: errorMsg,
        last_event_at_ms: failedAtMs,
      };
      this.writeStatusFileOnly(id, statusSnapshot);

      mergeRunMetrics({
        tool_calls: toolCallNames.length,
        tool_call_names: toolCallNames,
        exit_reason: err instanceof Error ? err.name : 'error',
      });

      const gitnexusSummary = gitnexusAccumulator.tool_invocations > 0
        ? {
            files_touched: [...gitnexusAccumulator.files_touched],
            symbols_analyzed: [...gitnexusAccumulator.symbols_analyzed],
            highest_risk: gitnexusAccumulator.highest_risk,
            tool_invocations: gitnexusAccumulator.tool_invocations,
          }
        : undefined;

      // Emit run_complete with ERROR status
      const runCompleteEvent = appendTimelineEventFileOnly(createRunCompleteEvent('ERROR', elapsed, {
        final: true,
        error: errorMsg,
        token_usage: runMetrics.token_usage,
        finish_reason: runMetrics.finish_reason,
        tool_calls: [...toolCallNames],
        exit_reason: runMetrics.exit_reason,
        metrics: runMetrics,
        ...(gitnexusSummary ? { gitnexus_summary: gitnexusSummary } : {}),
      }));
      const errorPersisted = this.withSqliteOperation('upsertStatusWithEvent:error', (client) => {
        client.upsertStatusWithEvent(statusSnapshot, runCompleteEvent);
        return true;
      });
      if (errorPersisted === undefined) {
        throw new Error('[supervisor] SQLite upsertStatusWithEvent failed during error completion: database client unavailable');
      }

      this.aggregateJobMetricsBestEffort(id);

      appendResultToInputBead({
        output: latestOutput || errorMsg,
        model: statusSnapshot.model ?? 'unknown',
        backend: statusSnapshot.backend ?? 'unknown',
        status: 'error',
        final: false,
        turnIndex: runMetrics.turns,
        tokenUsage: runMetrics.token_usage,
      });
      emitParentNotification(statusSnapshot, this.activeSiblingAssignee(statusSnapshot));

      throw err;
    } finally {
      if (stuckIntervalId !== undefined) clearInterval(stuckIntervalId);
      process.removeListener('SIGTERM', sigtermHandler);
      if (statusWatchdogPid !== undefined) {
        try { process.kill(statusWatchdogPid, 'SIGTERM'); } catch { /* ignore */ }
      }
      // Close the FIFO idempotently. Bun can emit EBADF if a stream observes an fd
      // after we have already closed it, so destroy the stream with a local EBADF
      // guard before the single explicit closeSync(). autoClose is false, but the
      // guard keeps cleanup safe across runtime edge cases and tests.
      const swallowBenignFifoError = (error: NodeJS.ErrnoException): void => {
        if (error.code === 'EBADF' && error.syscall === 'close') return;
        throw error;
      };
      try { fifoReadline?.close(); } catch { /* ignore */ }
      try { fifoReadStream?.once('error', swallowBenignFifoError); } catch { /* ignore */ }
      try { fifoReadStream?.destroy(); } catch { /* ignore */ }
      if (fifoFd !== undefined) { try { closeSync(fifoFd); } catch { /* ignore */ } fifoFd = undefined; }
      // Ensure events are flushed to disk before closing
      if (eventsFd !== undefined) {
        try { fsyncSync(eventsFd); } catch { /* ignore */ }
        closeSync(eventsFd);
      }
      // Remove the FIFO on job completion (best effort)
      try { if (existsSync(fifoPath)) rmSync(fifoPath); } catch { /* ignore */ }
      // Best-effort tmux cleanup for tmux-backed background runs
      if (statusSnapshot.tmux_session) {
        spawnSync('tmux', ['kill-session', '-t', statusSnapshot.tmux_session], { stdio: 'ignore' });
      }
      await this.dispose();
    }
  }
}
