import { spawnSync } from 'node:child_process';
import type { EpicState, EpicRunRecord, EpicChainRecord, EpicReadinessResult } from '../specialist/epic-lifecycle.js';
import {
  isEpicUnresolvedState,
  transitionEpicState,
  evaluateEpicMergeReadiness
} from '../specialist/epic-lifecycle.js';
import { abandonEpic, syncEpicState, withEpicAdvisoryLock } from '../specialist/epic-reconciler.js';
import { createForensicEvent, deploymentEnvironment } from '../specialist/forensic-events.js';
import { createObservabilitySqliteClient } from '../specialist/observability-sqlite.js';
import type { ObservabilitySqliteClient } from '../specialist/observability-sqlite.js';
import {
  resolveMergeTargetsForBeadIds,
  parseChildBeadIds,
  executePublicationPlan,
  type ChainMergeTarget,
  type MergeStepResult,
} from './merge.js';

const RUNNING_STATUSES = new Set(['starting', 'running', 'waiting', 'degraded']);

interface EpicMergeCliOptions {
  epicId: string;
  rebuild: boolean;
  json: boolean;
  pr: boolean;
  targetBranch?: string;
}

interface EpicListOptions {
  unresolvedOnly: boolean;
  json: boolean;
}

interface EpicStatusOptions {
  epicId: string;
  json: boolean;
}

interface EpicSyncOptions {
  epicId: string;
  apply: boolean;
  json: boolean;
}

interface EpicAbandonOptions {
  epicId: string;
  reason: string;
  force: boolean;
  json: boolean;
}

interface EpicListEntry {
  epic_id: string;
  state: EpicState;
  chain_count: number;
  readiness: EpicReadinessResult;
  updated_at_ms: number;
}

interface EpicMergeContext {
  epicId: string;
  epicRecord: EpicRunRecord | null;
  chainRecords: EpicChainRecord[];
  chainTargets: ChainMergeTarget[];
  chainJobStatuses: Map<string, { hasRunningJob: boolean; jobIds: string[] }>;
}

interface EpicMergeResult {
  epicId: string;
  success: boolean;
  fromState: EpicState;
  toState: EpicState;
  mergedChains: Array<{ beadId: string; branch: string; changedFiles: string[] }>;
  blockedChains: string[];
  error?: string;
  pullRequestUrl?: string;
}

function runCommand(command: string, args: readonly string[], cwd = process.cwd()) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function parseEpicId(args: readonly string[]): string {
  let epicId = '';
  for (const argument of args) {
    if (argument.startsWith('-')) continue;
    if (epicId) {
      throw new Error('Only one epic ID is supported');
    }
    epicId = argument;
  }

  if (!epicId) {
    throw new Error('Missing epic ID');
  }

  return epicId;
}

function parseMergeOptions(argv: readonly string[]): EpicMergeCliOptions {
  const epicId = parseEpicId(argv);
  let rebuild = false;
  let json = false;
  let pr = false;
  let targetBranch = '';

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--rebuild') {
      rebuild = true;
      continue;
    }
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--pr') {
      pr = true;
      continue;
    }
    if (argument === '--target-branch') {
      const branchName = argv[index + 1];
      if (!branchName || branchName.startsWith('-')) {
        throw new Error('Missing value for --target-branch');
      }
      if (targetBranch) {
        throw new Error('Only one target branch is supported');
      }
      targetBranch = branchName;
      index += 1;
      continue;
    }
    if (argument.startsWith('-') && argument !== '--rebuild' && argument !== '--json' && argument !== '--pr') {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  return { epicId, rebuild, json, pr, targetBranch: targetBranch || undefined };
}

function parseListOptions(argv: readonly string[]): EpicListOptions {
  let unresolvedOnly = false;
  let json = false;

  for (const argument of argv) {
    if (argument === '--unresolved') {
      unresolvedOnly = true;
      continue;
    }
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  return { unresolvedOnly, json };
}

function parseStatusOptions(argv: readonly string[]): EpicStatusOptions {
  const epicId = parseEpicId(argv);
  let json = false;

  for (const argument of argv) {
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument.startsWith('-') && argument !== '--json') {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  return { epicId, json };
}

function parseSyncOptions(argv: readonly string[]): EpicSyncOptions {
  const epicId = parseEpicId(argv);
  let apply = false;
  let json = false;

  for (const argument of argv) {
    if (argument === '--apply') {
      apply = true;
      continue;
    }
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument.startsWith('-') && argument !== '--apply' && argument !== '--json') {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  return { epicId, apply, json };
}

function parseAbandonOptions(argv: readonly string[]): EpicAbandonOptions {
  let epicId = '';
  let reason = '';
  let force = false;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--force') {
      force = true;
      continue;
    }
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--reason') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) {
        throw new Error('Missing value for --reason');
      }
      reason = value.trim();
      index += 1;
      continue;
    }
    if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    }
    if (epicId.length > 0) {
      throw new Error('Only one epic ID is supported');
    }
    epicId = argument;
  }

  if (!epicId) {
    throw new Error('Missing epic ID');
  }

  if (reason.length === 0) {
    throw new Error('Missing required --reason <text>');
  }

  return { epicId, reason, force, json };
}

function readEpicChildrenFromBeads(epicId: string): string[] {
  const result = runCommand('bd', ['children', epicId]);
  if (result.status !== 0) {
    throw new Error(`Unable to load children for epic '${epicId}'`);
  }
  const ids = parseChildBeadIds(result.stdout);
  if (ids.length === 0) {
    throw new Error(`No children found for epic '${epicId}'`);
  }
  return ids;
}

function buildChainJobStatuses(
  sqlite: ObservabilitySqliteClient,
  chainRecords: EpicChainRecord[],
): Map<string, { hasRunningJob: boolean; jobIds: string[] }> {
  const statuses = new Map<string, { hasRunningJob: boolean; jobIds: string[] }>();

  for (const chain of chainRecords) {
    const jobIds = sqlite.listChainJobIds(chain.chain_id);
    const hasRunningJob = jobIds.some((jobId) => {
      const status = sqlite.readStatus(jobId);
      return status && RUNNING_STATUSES.has(status.status);
    });
    statuses.set(chain.chain_id, { hasRunningJob, jobIds });
  }

  return statuses;
}

function evaluateReadiness(epicId: string, state: EpicState, chainRecords: EpicChainRecord[], sqlite: ObservabilitySqliteClient): EpicReadinessResult {
  const chainStatuses = chainRecords.map((chain) => {
    const jobIds = sqlite.listChainJobIds(chain.chain_id);
    const hasRunningJob = jobIds.some((jobId) => {
      const status = sqlite.readStatus(jobId);
      return status && RUNNING_STATUSES.has(status.status);
    });
    return { chainId: chain.chain_id, hasRunningJob };
  });

  return evaluateEpicMergeReadiness({
    epicId,
    epicStatus: state,
    chainStatuses,
  });
}

function gatherEpicList(sqlite: ObservabilitySqliteClient, unresolvedOnly: boolean): EpicListEntry[] {
  const epicRuns = sqlite.listEpicRuns();
  return epicRuns
    .filter((run) => !unresolvedOnly || isEpicUnresolvedState(run.status))
    .map((run) => {
      const chainRecords = sqlite.listEpicChains(run.epic_id);
      const readiness = evaluateReadiness(run.epic_id, run.status, chainRecords, sqlite);
      return {
        epic_id: run.epic_id,
        state: run.status,
        chain_count: chainRecords.length,
        readiness,
        updated_at_ms: run.updated_at_ms,
      };
    });
}

function gatherEpicContext(options: EpicMergeCliOptions): EpicMergeContext {
  const sqlite = createObservabilitySqliteClient();
  if (!sqlite) {
    throw new Error('Observability SQLite database not available. Run `sp db setup` first.');
  }

  try {
    const epicRecord = sqlite.readEpicRun(options.epicId);
    const chainRecords = sqlite.listEpicChains(options.epicId);

    const childBeadIds = chainRecords.length > 0
      ? chainRecords
        .map((chain) => chain.chain_root_bead_id)
        .filter((id): id is string => Boolean(id))
      : readEpicChildrenFromBeads(options.epicId);

    if (childBeadIds.length === 0) {
      throw new Error(`No chain-root bead IDs found for epic '${options.epicId}'`);
    }

    const chainTargets = resolveMergeTargetsForBeadIds(childBeadIds);
    const chainRecordsForStatus = chainRecords.length > 0
      ? chainRecords
      : chainTargets.map((chainTarget) => ({
        chain_id: chainTarget.jobId,
        epic_id: options.epicId,
        chain_root_bead_id: chainTarget.beadId,
        chain_root_job_id: chainTarget.jobId,
        updated_at_ms: chainTarget.startedAtMs,
      }));

    return {
      epicId: options.epicId,
      epicRecord,
      chainRecords,
      chainTargets,
      chainJobStatuses: buildChainJobStatuses(sqlite, chainRecordsForStatus),
    };
  } finally {
    sqlite.close();
  }
}

function validateEpicMergeReadiness(context: EpicMergeContext): EpicState {
  const epicState: EpicState = context.epicRecord?.status ?? 'open';

  // Per derived-readiness redesign: only 'merged' and 'abandoned' are truly
  // terminal. A persisted 'failed' marker (from a transient merge failure
  // such as rebase conflict) must be recoverable — readiness is recomputed
  // live from chain state, so the next merge attempt should be allowed if
  // the chains are still PASS.
  if (epicState === 'merged' || epicState === 'abandoned') {
    throw new Error(`Epic ${context.epicId} is already in terminal state '${epicState}'. No further merges allowed.`);
  }

    const chainStatuses = [...context.chainJobStatuses.entries()].map(([chainId, status]) => ({
    chainId,
    hasRunningJob: status.hasRunningJob,
  }));
  const readiness = evaluateEpicMergeReadiness({
    epicId: context.epicId,
    epicStatus: epicState,
    chainStatuses,
  });

  if (readiness.blockingChains.length > 0) {
    throw new Error(
      `Epic ${context.epicId} has running chains: ${readiness.blockingChains.join(', ')}.\n` +
      'All chain jobs must be terminal before publication.',
    );
  }

  return epicState;
}

function updateEpicState(epicId: string, fromState: EpicState, toState: EpicState): void {
  const sqlite = createObservabilitySqliteClient();
  if (!sqlite) {
    throw new Error('Observability SQLite database not available. Cannot persist epic state transition.');
  }

  try {
    const now = Date.now();
    sqlite.upsertEpicRun({
      epic_id: epicId,
      status: toState,
      status_json: JSON.stringify({
        epic_id: epicId,
        status: toState,
        previous_status: fromState,
        transitioned_at_ms: now,
      }),
      updated_at_ms: now,
    });
  } finally {
    sqlite.close();
  }
}

function mergeEpicChains(context: EpicMergeContext, rebuild: boolean, pr: boolean, targetBranch?: string): { steps: MergeStepResult[]; pullRequestUrl?: string } {
  return executePublicationPlan(context.chainTargets, {
    rebuild,
    mode: pr ? 'pr' : 'direct',
    publicationLabel: `epic-${context.epicId}`,
    targetBranch,
  });
}


function emitEpicForensicEvent(epicId: string, eventFamily: 'chain' | 'worktree', eventName: string, body: Record<string, unknown>, correlation: Record<string, unknown>): void {
  const sqlite = createObservabilitySqliteClient();
  if (!sqlite) return;

  try {
    sqlite.appendForensicEvent(epicId, 'specialist', undefined, createForensicEvent({
      event_family: eventFamily,
      event_name: eventName,
      resource: {
        service_namespace: 'xtrm',
        service_name: 'specialists',
        service_component: 'epic',
        deployment_environment: deploymentEnvironment(),
        repo: 'specialists',
        participant_kind: 'specialist',
        participant_role: 'epic',
      },
      correlation: { epic_id: epicId, ...correlation },
      body,
    }));
  } finally {
    sqlite.close();
  }
}

function printEpicMergeSummary(result: EpicMergeResult, rebuild: boolean, pr: boolean): void {
  console.log('');
  console.log(`Epic ${result.epicId}: ${result.fromState} → ${result.toState}`);

  if (result.success) {
    console.log('');
    console.log('Publication successful.');
    console.log('');
    console.log('Merged chains (dependency order):');
    for (const chain of result.mergedChains) {
      console.log(`  ${chain.branch} (${chain.beadId})`);
      if (chain.changedFiles.length === 0) {
        console.log('    files: (none)');
      } else {
        console.log(`    files: ${chain.changedFiles.join(', ')}`);
      }
    }

    console.log('');
    console.log('TypeScript gate: passed after each merge');
    if (rebuild) {
      console.log('Rebuild: bun run build (passed)');
    }
    if (pr) {
      console.log(`Publication mode: PR${result.pullRequestUrl ? ` (${result.pullRequestUrl})` : ''}`);
    } else {
      console.log('Publication mode: direct merge');
    }
  } else {
    console.log('');
    console.log('Publication failed.');
    if (result.error) {
      console.log(`Error: ${result.error}`);
    }
    if (result.blockedChains.length > 0) {
      console.log(`Blocked chains: ${result.blockedChains.join(', ')}`);
    }
  }

  console.log('');
}

export async function handleEpicListCommand(argv: readonly string[]): Promise<void> {
  let options: EpicListOptions;
  try {
    options = parseListOptions(argv);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    console.error('Usage: specialists epic list [--unresolved] [--json]');
    process.exit(1);
  }

  const sqlite = createObservabilitySqliteClient();
  if (!sqlite) {
    const message = 'Observability SQLite database not available. Run `sp db setup` first.';
    if (options.json) {
      console.log(JSON.stringify({ error: message }, null, 2));
    } else {
      console.error(message);
    }
    process.exit(1);
  }

  try {
    const entries = gatherEpicList(sqlite, options.unresolvedOnly);

    if (options.json) {
      console.log(JSON.stringify({ epics: entries }, null, 2));
      return;
    }

    console.log('');
    if (entries.length === 0) {
      console.log('No epics found.');
      console.log('');
      return;
    }

    for (const epic of entries) {
      const readiness = epic.readiness.isReady ? 'ready' : 'blocked';
      console.log(`${epic.epic_id}  ${epic.state}  chains:${epic.chain_count}  ${readiness}`);
      console.log(`  ${epic.readiness.summary}`);
      console.log(`  updated: ${new Date(epic.updated_at_ms).toISOString()}`);
    }
    console.log('');
  } finally {
    sqlite.close();
  }
}

export async function handleEpicMergeCommand(argv: readonly string[]): Promise<void> {
  let options: EpicMergeCliOptions;
  try {
    options = parseMergeOptions(argv);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    console.error('');
    console.error('Usage: specialists epic merge <epic-id> [--rebuild] [--pr] [--json] [--target-branch <name>]  [broken]');
    process.exit(1);
  }

  let context: EpicMergeContext;
  try {
    context = gatherEpicContext(options);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      console.log(JSON.stringify({ epic_id: options.epicId, error: `Failed to gather epic context: ${message}` }, null, 2));
    } else {
      console.error(`Failed to gather epic context: ${message}`);
    }
    process.exit(1);
  }

  let currentState: EpicState;
  try {
    currentState = validateEpicMergeReadiness(context);
    for (const chain of context.chainTargets) {
      emitEpicForensicEvent(context.epicId, 'chain', 'chain.ready_for_review', {
        chain_template: `epic-${context.epicId}`,
        terminal_state: 'merge_ready',
        result: 'pass',
      }, {
        job_id: chain.jobId,
        bead_id: chain.beadId,
        chain_root_job_id: chain.jobId,
      });
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      console.log(JSON.stringify({ epic_id: options.epicId, error: `Merge blocked: ${message}` }, null, 2));
    } else {
      console.error(`Merge blocked: ${message}`);
    }
    process.exit(1);
  }

  const fromState = currentState;
  let mergedChains: MergeStepResult[] = [];
  let mergeError: string | undefined;
  let toState: EpicState = currentState;
  let pullRequestUrl: string | undefined;

  try {
    const publicationResult = mergeEpicChains(context, options.rebuild, options.pr, options.targetBranch);
    mergedChains = publicationResult.steps;
    pullRequestUrl = publicationResult.pullRequestUrl;
    toState = options.pr ? currentState : transitionEpicState(currentState, 'merged');
    updateEpicState(context.epicId, currentState, toState);
    for (const [index, chain] of mergedChains.entries()) {
      const chainTarget = context.chainTargets[index];
      emitEpicForensicEvent(context.epicId, 'worktree', 'worktree.merged', {
        changed_paths_count: chain.changedFiles.length,
        merge_ref: chain.branch,
        source_ref: chain.branch,
        target_ref: options.targetBranch ?? 'main',
        result: 'success',
      }, {
        job_id: chainTarget?.jobId ?? context.epicId,
        bead_id: chain.beadId,
      });
    }
  } catch (error: unknown) {
    mergeError = error instanceof Error ? error.message : String(error);
    toState = transitionEpicState(currentState, 'failed');
    updateEpicState(context.epicId, currentState, toState);
  }

  const result: EpicMergeResult = {
    epicId: context.epicId,
    success: !mergeError,
    fromState,
    toState,
    mergedChains,
    blockedChains: [],
    error: mergeError,
    pullRequestUrl,
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printEpicMergeSummary(result, options.rebuild, options.pr);
  }

  if (!result.success) {
    process.exit(1);
  }
}

export async function handleEpicSyncCommand(argv: readonly string[]): Promise<void> {
  let options: EpicSyncOptions;
  try {
    options = parseSyncOptions(argv);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    console.error('Usage: specialists epic sync <epic-id> [--apply] [--json]');
    process.exit(1);
  }

  const sqlite = createObservabilitySqliteClient();
  if (!sqlite) {
    const message = 'Observability SQLite database not available. Run `sp db setup` first.';
    if (options.json) {
      console.log(JSON.stringify({ error: message }, null, 2));
    } else {
      console.error(message);
    }
    process.exit(1);
  }

  try {
    const result = withEpicAdvisoryLock(options.epicId, () => syncEpicState(sqlite, options.epicId, options.apply));

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log('');
    console.log(`Epic ${result.epic_id} sync (${result.apply ? 'apply' : 'dry-run'})`);
    console.log(`  stale_chain_refs: ${result.drift.stale_chain_refs.length}`);
    console.log(`  dead_jobs_blocking_readiness: ${result.drift.dead_jobs_blocking_readiness.length}`);
    console.log(`  integrity_flags: ${result.drift.integrity_flags.length}`);
    console.log(`  stale_redirect_markers: ${result.drift.stale_redirect_markers.length}`);
    if (result.apply) {
      console.log(`  repaired_dead_jobs: ${result.repairs.dead_jobs_marked_error.length}`);
      console.log(`  stale_chain_refs_pruned: ${result.repairs.stale_chain_refs_pruned.length}`);
      console.log(`  readiness_resynced: ${result.repairs.readiness_resynced}`);
      console.log(`  redirect_markers_cleared: ${result.repairs.redirect_markers_cleared}`);
    }
    console.log(`  readiness_before: ${result.readiness_before.readiness_state}`);
    console.log(`  readiness_after: ${result.readiness_after.readiness_state}`);
    console.log('');
  } finally {
    sqlite.close();
  }
}

export async function handleEpicAbandonCommand(argv: readonly string[]): Promise<void> {
  let options: EpicAbandonOptions;
  try {
    options = parseAbandonOptions(argv);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    console.error('Usage: specialists epic abandon <epic-id> --reason <text> [--force] [--json]');
    process.exit(1);
  }

  const sqlite = createObservabilitySqliteClient();
  if (!sqlite) {
    const message = 'Observability SQLite database not available. Run `sp db setup` first.';
    if (options.json) {
      console.log(JSON.stringify({ error: message }, null, 2));
    } else {
      console.error(message);
    }
    process.exit(1);
  }

  try {
    const result = withEpicAdvisoryLock(options.epicId, () => abandonEpic(sqlite, options.epicId, options.reason, options.force));
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`Epic ${result.epic_id}: ${result.from_state} -> ${result.to_state}`);
    console.log(`Reason: ${result.reason}`);
    if (result.forced) {
      console.log('Mode: forced');
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      console.log(JSON.stringify({ epic_id: options.epicId, error: message }, null, 2));
    } else {
      console.error(message);
    }
    process.exit(1);
  } finally {
    sqlite.close();
  }
}

export async function handleEpicStatusCommand(argv: readonly string[]): Promise<void> {
  let options: EpicStatusOptions;
  try {
    options = parseStatusOptions(argv);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    console.error('Usage: specialists epic status <epic-id> [--json]');
    process.exit(1);
  }

  const sqlite = createObservabilitySqliteClient();
  if (!sqlite) {
    const message = 'Observability SQLite database not available. Run `sp db setup` first.';
    if (options.json) {
      console.log(JSON.stringify({ error: message }, null, 2));
    } else {
      console.error(message);
    }
    process.exit(1);
  }

  try {
    const epicRecord = sqlite.readEpicRun(options.epicId);
    const chainRecords = sqlite.listEpicChains(options.epicId);
    const state: EpicState = epicRecord?.status ?? 'open';
    const readiness = evaluateReadiness(options.epicId, state, chainRecords, sqlite);

    const chainDetails = chainRecords.map((chain) => {
      const jobIds = sqlite.listChainJobIds(chain.chain_id);
      const runningJobs = jobIds.filter((jobId) => {
        const status = sqlite.readStatus(jobId);
        return status && RUNNING_STATUSES.has(status.status);
      });

      return {
        chain_id: chain.chain_id,
        chain_root_bead_id: chain.chain_root_bead_id,
        running_jobs: runningJobs,
        terminal: runningJobs.length === 0,
      };
    });

    if (options.json) {
      console.log(JSON.stringify({
        epic_id: options.epicId,
        state,
        updated_at_ms: epicRecord?.updated_at_ms ?? null,
        readiness,
        chains: chainDetails,
      }, null, 2));
      return;
    }

    console.log('');
    console.log(`Epic: ${options.epicId}`);
    console.log(`State: ${epicRecord?.status ?? '(derived)'}`);
    console.log(`Readiness: ${readiness.isReady ? 'ready' : 'blocked'}`);
    console.log(`Summary: ${readiness.summary}`);

    console.log('');
    console.log('Chains:');
    if (chainDetails.length === 0) {
      console.log('  (none tracked)');
    } else {
      for (const chain of chainDetails) {
        const statusIndicator = chain.terminal ? '○ terminal' : '◉ running';
        console.log(`  ${chain.chain_id}: ${statusIndicator}`);
        if (chain.chain_root_bead_id) {
          console.log(`    bead: ${chain.chain_root_bead_id}`);
        }
        if (chain.running_jobs.length > 0) {
          console.log(`    running jobs: ${chain.running_jobs.join(', ')}`);
        }
      }
    }

    console.log('');
  } finally {
    sqlite.close();
  }
}

export async function handleEpicCommand(argv: readonly string[]): Promise<void> {
  const subcommand = argv[0];

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log([
      '',
      'Usage: specialists epic <list|status|sync|abandon|merge> [options]',
      '',
      'Commands:',
      '  list [--unresolved] [--json]                    List epics with readiness summary',
      '  status <epic-id> [--json]                       Show derived readiness and chain status',
      '  sync <epic-id> [--apply] [--json]               Reconcile epic drift (dry-run by default)',
      '  abandon <epic-id> --reason <text> [--force] [--json]  Transition epic to abandoned',
      '  merge [broken]                                  Do not use; follow the manual git workflow',
      '',
      'Epic readiness:',
      '  status reflects derived readiness from live chain state',
      '  persisted epic state is compatibility metadata only',
      '',
      'Examples:',
      '  specialists epic list',
      '  specialists epic list --unresolved --json',
      '  specialists epic status unitAI-3f7b --json',
      '  specialists epic sync unitAI-3f7b',
      '  specialists epic sync unitAI-3f7b --apply',
      '  specialists epic abandon unitAI-3f7b --reason "scope changed"',
      '',
    ].join('\n'));
    return;
  }

  const usage: Record<string, string> = {
    list: 'specialists epic list [--unresolved] [--json]',
    status: 'specialists epic status <epic-id> [--json]',
    sync: 'specialists epic sync <epic-id> [--apply] [--json]',
    abandon: 'specialists epic abandon <epic-id> --reason <text> [--force] [--json]',
    merge: 'specialists epic merge <epic-id> [--rebuild] [--pr] [--json] [--target-branch <name>]  [broken]',
  };
  if (argv.slice(1).some((arg) => arg === '--help' || arg === '-h') && usage[subcommand]) {
    console.log(`\nUsage: ${usage[subcommand]}\n`);
    return;
  }

  if (subcommand === 'list') {
    await handleEpicListCommand(argv.slice(1));
    return;
  }

  if (subcommand === 'sync') {
    await handleEpicSyncCommand(argv.slice(1));
    return;
  }

  if (subcommand === 'abandon') {
    await handleEpicAbandonCommand(argv.slice(1));
    return;
  }

  if (subcommand === 'merge') {
    await handleEpicMergeCommand(argv.slice(1));
    return;
  }

  if (subcommand === 'status') {
    await handleEpicStatusCommand(argv.slice(1));
    return;
  }

  console.error(`Unknown epic subcommand: ${subcommand}`);
  console.error('Usage: specialists epic <list|status|sync|abandon|merge>');
  process.exit(1);
}
