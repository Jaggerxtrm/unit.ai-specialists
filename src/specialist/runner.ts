// src/specialist/runner.ts
import { writeJobFileOutput } from './job-file-output.js';
import { createHash } from 'node:crypto';
import { buildBeadBoundaryInstruction, renderTaskPrompt } from './task-prompt.js';
import { MandatoryRulesBudgetError } from './mandatory-rules.js';
import {
  PiAgentSession,
  SessionKilledError,
  resolveExecutionExtensionSelection,
  resolveRuntimeToolContract,
  type PiSessionOptions,
  type SessionMetricEvent,
  type SessionRunMetrics,
} from '../pi/session.js';
import type { SpecialistLoader } from './loader.js';
import type { HookEmitter } from './hooks.js';
import { isAuthError, isRateLimitError, isTransientError, type CircuitBreaker } from '../utils/circuitBreaker.js';
import { stripJsonFences } from './json-output.js';
import { createObservabilitySqliteClient } from './observability-sqlite.js';
import type { TimelineEvent, TimelineEventRunComplete } from './timeline-events.js';
import { resolveModelChain } from './model-chain.js';
import type { RuntimeOriginV1 } from './runtime-origin.js';
import { formatResolvedToolContract, type ResolvedToolContract } from './resolved-tool-contract.js';
import { buildSystemPrompt, type ResponseFormat, type OutputType, type JsonSchema } from './system-prompt.js';

export interface RunOptions {
  name: string;
  prompt: string;
  variables?: Record<string, string>;
  backendOverride?: string;
  autonomyLevel?: string;
  specialistName?: string;
  specialistPermissions?: PiSessionOptions['specialistPermissions'];
  /** Working directory for local scripts and the pi session. */
  workingDirectory?: string;
  /** Absolute write-boundary for write-side tools inside pi session. */
  worktreeBoundary?: string;
  /** Existing bead whose content should be used as the task prompt. */
  inputBeadId?: string;
  output_file?: string;
  suppressRunnerFileOutput?: boolean;
  notesMode?: 'full-trail' | 'final-only';
  /** Owning epic id for wave-bound chains, when bead belongs to an epic. */
  epicId?: string;
  /** Lineage: set when --job <id> is used to reuse another job's worktree. */
  reusedFromJobId?: string;
  /** Bead dependency context depth (0 disables completed blocker injection). */
  contextDepth?: number;
  /** Lineage: root job id that originally created the reused worktree. */
  worktreeOwnerJobId?: string;
  baseShaPinned?: string;
  baseShaPinnedAtMs?: number;
  /** Path to an existing pi session file for continuation (Phase 2+) */
  sessionPath?: string;
  /**
   * Keep the Pi session alive after agent_end.
   * Enables multi-turn: callers receive resumeFn/closeFn via onResumeReady callback.
   */
  keepAlive?: boolean;
  /** Explicitly disable keepAlive even when specialist.execution.interactive=true. */
  noKeepAlive?: boolean;
  /** Additional retries after the initial attempt (default: 0). */
  maxRetries?: number;
  /** Whether external (input) bead notes should be written by Supervisor. */
  beadsWriteNotes?: boolean;
  /** Force re-dispatch even if active same-bead specialist job exists. */
  forceJob?: boolean;
  /** Permission level used to decide concurrency guard scope. */
  permissionRequired?: 'READ_ONLY' | 'LOW' | 'MEDIUM' | 'HIGH';
  /**
   * Ambient xtmux runtime origin captured at the sp run boundary
   * (spec docs/xtmux-gaps.md §13.1-§13.4). Supervisor uses this in the spawn-
   * origin precedence rule to build the initial SupervisorStatus.
   */
  ambientRuntimeOrigin?: RuntimeOriginV1;
  /**
   * Explicit parent job id, populated by internal launch paths (F1). When set,
   * the spawn origin resolves to specialist.job, superseding any ambient origin.
   */
  explicitParentJobId?: string;
}

export interface RunResult {
  output: string;
  backend: string;
  model: string;
  durationMs: number;
  specialistVersion: string;
  promptHash: string;
  beadId?: string;
  metrics?: SessionRunMetrics;
  permissionRequired?: 'READ_ONLY' | 'LOW' | 'MEDIUM' | 'HIGH';
  autoCommit?: 'never' | 'checkpoint_on_waiting' | 'checkpoint_on_terminal';
  outputType?: string;
  payloadBreakdown?: PayloadBreakdown;
}

type SessionLike = Pick<PiAgentSession, 'start' | 'prompt' | 'waitForDone' | 'getLastOutput' | 'getState' | 'close' | 'kill' | 'meta' | 'steer' | 'resume'>
  & { getMetrics?: () => SessionRunMetrics };

export type SessionFactory = (opts: PiSessionOptions) => Promise<SessionLike>;

import { BeadsClient, type BeadsClient as BeadsClientType, buildBeadContext, shouldCreateBead } from './beads.js';
import {
  measurePayloadComponent,
  summarizePayloadBreakdown,
  type PayloadBreakdown,
  type PayloadComponentMeasurement,
} from './payload-measure.js';

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { homedir } from 'node:os';

interface RunnerDeps {
  loader: SpecialistLoader;
  hooks: HookEmitter;
  circuitBreaker: CircuitBreaker;
  /** Overridable for testing; defaults to PiAgentSession.create */
  sessionFactory?: SessionFactory;
  /** Optional beads client for specialist run tracking */
  beadsClient?: BeadsClientType;
}

// ── Pre/post script helpers ───────────────────────────────────────────────────

interface ScriptResult {
  name: string;
  output: string;
  stderr: string;
  exitCode: number;
  signal?: string;
  spawnError?: string;
}

/** Bounds the name and strips control/XML-significant characters so a
 *  script-controlled command string cannot break the `<script name="...">`
 *  wrapper or terminal rendering (unitAI-x64ys). */
export function sanitizeScriptName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f-\u009f"\\<>]/g, '').slice(0, 128);
  return /^[A-Za-z0-9:][A-Za-z0-9._:-]{0,127}$/.test(cleaned) ? cleaned : 'unknown';
}

const SCRIPT_OUTPUT_LIMIT_BYTES = 1024 * 1024;

// Hard byte cap applied in-process: not every runtime honors spawnSync maxBuffer.
function capStream(value: string, limitBytes: number = SCRIPT_OUTPUT_LIMIT_BYTES): string {
  const buf = Buffer.from(value, 'utf8');
  if (buf.length <= limitBytes) return value;
  return buf.subarray(0, limitBytes).toString('utf8');
}

export function runScript(command: string | undefined, cwd: string): ScriptResult {
  const run = (command ?? '').trim();
  if (!run) {
    return { name: 'unknown', output: 'Missing script command (expected `run` or legacy `path`).', stderr: '', exitCode: 1 };
  }

  const scriptName = sanitizeScriptName(basename(run.split(' ')[0]));
  // shell: true keeps the previous execSync /bin/sh -c semantics: `run` is a
  // shell command string, never re-tokenized (unitAI-x64ys).
  // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true -- trusted opt-in script definitions require shell grammar.
  const result = spawnSync(run, {
    encoding: 'utf8',
    timeout: 30_000,
    cwd,
    shell: true,
    maxBuffer: SCRIPT_OUTPUT_LIMIT_BYTES,
  });
  const exitCode = typeof result.status === 'number' ? result.status : 1;
  const output = capStream(result.stdout ?? '');
  const stderr = capStream(result.stderr ?? '');
  if (exitCode === 0 && !result.error) {
    return { name: scriptName, output, stderr, exitCode: 0 };
  }
  const rawErrorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const spawnError = typeof rawErrorCode === 'string' && /^[A-Z0-9_]{1,32}$/.test(rawErrorCode)
    ? rawErrorCode
    : result.error ? 'SPAWN_ERROR' : undefined;
  const notes = [stderr.trim(), spawnError ? `spawn error: ${spawnError}` : ''].filter(Boolean).join('\n');
  return {
    name: scriptName,
    output,
    stderr: notes,
    exitCode,
    ...(result.signal ? { signal: result.signal } : {}),
    ...(spawnError ? { spawnError } : {}),
  };
}

export interface RequiredPreScriptFailure {
  name: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  signal?: string;
  spawnError?: string;
}

/** Shared required-preflight decision: the first `pre` script marked
 *  `required: true` whose result is nonzero aborts the run. Optional scripts
 *  (required omitted/false) never gate — legacy injection behavior is kept. */
export function findRequiredPreScriptFailure(
  scripts: ReadonlyArray<{ phase?: string; required?: boolean }>,
  results: ReadonlyArray<ScriptResult>,
): RequiredPreScriptFailure | null {
  for (let i = 0; i < scripts.length; i += 1) {
    const script = scripts[i];
    if (script.phase !== 'pre' || script.required !== true) continue;
    const result = results[i];
    if (result && result.exitCode !== 0) {
      return {
        name: result.name,
        exitCode: result.exitCode,
        stdout: result.output,
        stderr: result.stderr,
        ...(result.signal ? { signal: result.signal } : {}),
        ...(result.spawnError ? { spawnError: result.spawnError } : {}),
      };
    }
  }
  return null;
}

export class RequiredPreScriptError extends Error {
  readonly code = 'pre_script_failed';
  constructor(message: string) {
    super(message);
    this.name = 'RequiredPreScriptError';
  }
}

const PRE_SCRIPT_DIAGNOSTIC_LIMIT_BYTES = 4096;

function sanitizeDiagnostic(text: string, limitBytes: number): string {
  const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
  if (Buffer.byteLength(clean, 'utf8') <= limitBytes) return clean;
  let slice = clean.slice(0, limitBytes);
  while (Buffer.byteLength(slice, 'utf8') > limitBytes) slice = slice.slice(0, -1);
  return `${slice}\n... (truncated)`;
}

export function formatRequiredPreScriptFailure(failure: RequiredPreScriptFailure): string {
  const context = failure.signal
    ? ` (signal ${failure.signal})`
    : failure.spawnError ? ` (${failure.spawnError})` : '';
  return [
    `Required pre-script '${failure.name}' failed with exit code ${failure.exitCode}${context}.`,
    'The run was aborted before the model session started; no model fallback or retry is performed.',
    `--- stdout (bounded to ${PRE_SCRIPT_DIAGNOSTIC_LIMIT_BYTES} bytes) ---`,
    sanitizeDiagnostic(failure.stdout, PRE_SCRIPT_DIAGNOSTIC_LIMIT_BYTES),
    `--- stderr (bounded to ${PRE_SCRIPT_DIAGNOSTIC_LIMIT_BYTES} bytes) ---`,
    sanitizeDiagnostic(failure.stderr, PRE_SCRIPT_DIAGNOSTIC_LIMIT_BYTES),
  ].join('\n');
}

/**
 * Build a small `gitnexus_summary` block from the reviewed job's last
 * `run_complete` event, so the reviewer task template can render it inline
 * without having to grep `sp feed <reviewed_job_id>` itself.
 *
 * Returns empty string when:
 *   - reusedFromJobId is missing (caller did not pass --job <exec-job-id>)
 *   - observability DB unavailable on this host (rare)
 *   - no run_complete event for that job (executor errored before terminal)
 *   - gitnexus_summary field absent in event (executor never called gitnexus)
 *
 * Returning empty rather than throwing keeps the pre-inject path optional —
 * the reviewer prompt's Step 5 falls back to running `sp feed` itself when
 * `$gitnexus_summary` is not provided.
 */
function buildReviewedGitnexusSummary(opts: {
  reusedFromJobId?: string;
  cwd: string;
}): string {
  const jobId = opts.reusedFromJobId?.trim();
  if (!jobId) return '';
  try {
    const client = createObservabilitySqliteClient(opts.cwd);
    if (!client) return '';
    const events: TimelineEvent[] = client.readEvents(jobId);
    let runComplete: TimelineEventRunComplete | null = null;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i];
      if (ev?.type === 'run_complete') {
        runComplete = ev as TimelineEventRunComplete;
        break;
      }
    }
    if (!runComplete?.gitnexus_summary) return '';
    const gs = runComplete.gitnexus_summary;
    const files = (gs.files_touched ?? []).slice(0, 20).join(', ') || '(none)';
    const symbols = (gs.symbols_analyzed ?? []).slice(0, 20).join(', ') || '(none)';
    const risk = gs.highest_risk ?? 'UNKNOWN';
    const invocations = gs.tool_invocations ?? 0;
    return `<gitnexus_summary reviewed_job_id="${jobId}">
  files_touched: ${files}
  symbols_analyzed: ${symbols}
  highest_risk: ${risk}
  tool_invocations: ${invocations}
</gitnexus_summary>`;
  } catch {
    return '';
  }
}

export function formatScriptOutput(results: ScriptResult[]): string {
  const withOutput = results.filter(r => r.output.trim());
  if (withOutput.length === 0) return '';
  const blocks = withOutput
    .map(r => {
      const status = r.exitCode === 0 ? '' : ` exit_code="${r.exitCode}"`;
      return `<script name="${r.name}"${status}>\n${r.output.trim()}\n</script>`;
    })
    .join('\n');
  return `<pre_flight_context>\n${blocks}\n</pre_flight_context>`;
}

// ── Pre-run validator ─────────────────────────────────────────────────────────

function resolvePath(p: string): string {
  return p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : resolve(p);
}

function commandExists(cmd: string): boolean {
  const result = spawnSync('which', [cmd], { stdio: 'ignore' });
  return result.status === 0;
}

const SHELL_BUILTINS = new Set<string>([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done',
  'case', 'esac', 'select', 'in', 'function', 'return', 'break', 'continue',
  ':', '.', 'true', 'false', '[', '[[', '{', '(',
]);

function validateShebang(filePath: string, errors: string[]): void {
  try {
    const head = readFileSync(filePath, 'utf-8').slice(0, 120);
    if (!head.startsWith('#!')) return;
    const shebang = head.split('\n')[0].toLowerCase();
    const typos: [RegExp, string][] = [
      [/pytho[^n]|pyton|pyhon/, 'python'],
      [/nod[^e]b/, 'node'],
      [/bsh$|bas$/, 'bash'],
      [/rub[^y]/, 'ruby'],
    ];
    for (const [pattern, correct] of typos) {
      if (pattern.test(shebang)) {
        errors.push(`  ✗ ${filePath}: shebang looks wrong — did you mean '${correct}'? (got: ${shebang})`);
      }
    }
  } catch { /* unreadable — caught by exists check */ }
}

/** Pi tools known to be gated by permission level. Tools not in this map are assumed available at all levels. */
const PERMISSION_GATED_TOOLS: Record<string, string[]> = {
  bash:  ['LOW', 'MEDIUM', 'HIGH'],
  edit:  ['MEDIUM', 'HIGH'],
  write: ['HIGH'],
};

function isToolAvailable(tool: string, permissionLevel: string): boolean {
  const normalized = permissionLevel.toUpperCase();
  const gatedLevels = PERMISSION_GATED_TOOLS[tool.toLowerCase()];
  if (!gatedLevels) return true; // not gated — available at all levels (read, grep, find, ls, glob, notebook, etc.)
  return gatedLevels.includes(normalized);
}

export function validateBeforeRun(
  spec: { specialist: { skills?: { paths?: string[]; scripts?: Array<{ run?: string; path?: string; phase: string; inject_output: boolean }> }; capabilities?: { external_commands?: string[]; required_tools?: string[] } } },
  permissionLevel: string,
  resolvedToolContract?: ResolvedToolContract,
): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate skills.paths files exist.
  // HARD FAILURE, not a warning: pi silently ignores a nonexistent `--skill` path
  // (exit 0, no diagnostic), so a stale entry used to mean the specialist ran with
  // its skills quietly missing. That is exactly how every specialist kept pointing
  // at the retired `.xtrm/skills/active/**` root unnoticed after the global-skills
  // migration (unitAI-6639v.1). Fail before launch instead.
  for (const p of spec.specialist.skills?.paths ?? []) {
    const abs = resolvePath(p);
    if (!existsSync(abs)) {
      errors.push(
        `  ✗ skills.paths: skill not found: ${p}\n` +
        `    resolved to: ${abs}\n` +
        `    canonical global skills live in ~/.xtrm/skills/default/<skill>/`,
      );
    }
  }

  // Validate scripts/commands
  for (const script of spec.specialist.skills?.scripts ?? []) {
    const run = script.run ?? script.path;
    if (!run) continue;
    const isFilePath = run.startsWith('./') || run.startsWith('../') || run.startsWith('/') || run.startsWith('~/');
    if (isFilePath) {
      const abs = resolvePath(run);
      if (!existsSync(abs)) {
        errors.push(`  ✗ skills.scripts: script not found: ${run}`);
      } else {
        validateShebang(abs, errors);
      }
    } else {
      const binary = run.split(' ')[0];
      if (binary && !SHELL_BUILTINS.has(binary) && !commandExists(binary)) {
        errors.push(`  ✗ skills.scripts: command not found on PATH: ${binary}`);
      }
    }
  }

  // Validate external_commands exist on PATH
  for (const cmd of spec.specialist.capabilities?.external_commands ?? []) {
    if (!commandExists(cmd)) {
      errors.push(`  ✗ capabilities.external_commands: not found on PATH: ${cmd}`);
    }
  }

  // Validate required_tools are enabled by the selected permission level
  const exposingExtensions = (resolvedToolContract?.exposedExtensionSources.length ?? 0) > 0;
  for (const tool of spec.specialist.capabilities?.required_tools ?? []) {
    if (!isToolAvailable(tool, permissionLevel)) {
      errors.push(
        `  ✗ capabilities.required_tools: tool "${tool}" requires higher permission than "${permissionLevel}"`,
      );
      continue;
    }
    if (resolvedToolContract && !resolvedToolContract.toolsList.some((availableTool) => availableTool.toLowerCase() === tool.toLowerCase())) {
      if (exposingExtensions) {
        // Extension-registered tool names cannot be enumerated ahead of
        // launch; with an enabled extension source the deny-list gate exposes
        // them (unitAI-34pyf). Validation of native tools still applies.
        warnings.push(`capabilities.required_tools: tool "${tool}" is expected from an enabled extension source; it is not in the native contract (${resolvedToolContract.toolsFlag || '(none)'})`);
      } else {
        errors.push(
          `  ✗ capabilities.required_tools: tool "${tool}" missing from resolved runtime contract (${resolvedToolContract.toolsFlag || '(none)'})`,
        );
      }
    }
  }

  if (warnings.length > 0) {
    process.stderr.write(`[specialists] pre-run warnings:\n${warnings.join('\n')}\n`);
  }
  if (errors.length > 0) {
    throw new Error(`Specialist pre-run validation failed:\n${errors.join('\n')}`);
  }
}

const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_JITTER = 0.2;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getRetryDelayMs(attemptNumber: number): number {
  const baseDelay = RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attemptNumber - 1));
  const jitterMultiplier = 1 + ((Math.random() * 2 - 1) * RETRY_MAX_JITTER);
  return Math.max(0, Math.round(baseDelay * jitterMultiplier));
}

const BASE_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    status: { enum: ['success', 'partial', 'failed', 'waiting'] },
    issues_closed: { type: 'array', items: { type: 'string' } },
    issues_created: { type: 'array', items: { type: 'string' } },
    follow_ups: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    verification: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'status', 'issues_closed', 'issues_created', 'follow_ups', 'risks', 'verification'],
};

const IMPACT_REPORT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    files_touched: { type: 'array', items: { type: 'string' } },
    symbols_analyzed: { type: 'array', items: { type: 'string' } },
    highest_risk: { enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
    tool_invocations: { type: 'number' },
  },
};

const OUTPUT_TYPE_SCHEMA_EXTENSIONS: Record<Exclude<OutputType, 'custom'>, JsonSchema> = {
  codegen: {
    type: 'object',
    properties: {
      files_changed: { type: 'array', items: { type: 'string' } },
      symbols_modified: { type: 'array', items: { type: 'string' } },
      lint_pass: { type: 'boolean' },
      tests_pass: { type: 'boolean' },
      impact_report: IMPACT_REPORT_SCHEMA,
    },
  },
  analysis: {
    type: 'object',
    properties: {
      key_files: { type: 'array', items: { type: 'string' } },
      architecture_notes: { type: 'string' },
      recommendations: { type: 'array', items: { type: 'string' } },
      impact_report: IMPACT_REPORT_SCHEMA,
    },
  },
  review: {
    type: 'object',
    properties: {
      verdict: { enum: ['pass', 'partial', 'fail'] },
      findings: { type: 'array', items: { type: 'string' } },
      recommendation: { type: 'string' },
    },
  },
  synthesis: {
    type: 'object',
    properties: {
      decisions: { type: 'array', items: { type: 'string' } },
      rationale: { type: 'string' },
      next_steps: { type: 'array', items: { type: 'string' } },
    },
  },
  orchestration: {
    type: 'object',
    properties: {
      actions: {
        type: 'array',
        items: {
          oneOf: [
            {
              type: 'object',
              properties: {
                type: { enum: ['resume'] },
                memberId: { type: 'string' },
                task: { type: 'string' },
              },
              required: ['type', 'memberId', 'task'],
            },
            {
              type: 'object',
              properties: {
                type: { enum: ['steer'] },
                memberId: { type: 'string' },
                message: { type: 'string' },
              },
              required: ['type', 'memberId', 'message'],
            },
            {
              type: 'object',
              properties: {
                type: { enum: ['stop'] },
                memberId: { type: 'string' },
              },
              required: ['type', 'memberId'],
            },
          ],
        },
      },
      blocking_on: {
        type: 'object',
        properties: {
          kind: { enum: ['human_input', 'member_output', 'external_dependency'] },
          target: { type: 'string' },
          details: { type: 'string' },
        },
        required: ['kind'],
      },
      memory_patch: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            entry_type: { enum: ['fact', 'question', 'decision'] },
            entry_id: { type: 'string' },
            summary: { type: 'string' },
            source_member_id: { type: 'string' },
            confidence: { type: 'number' },
            provenance: { type: 'object' },
          },
          required: ['entry_type', 'summary'],
        },
      },
      coordination_state: {
        type: 'object',
        properties: {
          current_goal: { type: 'string' },
          active_members: { type: 'array', items: { type: 'string' } },
          waiting_on_members: { type: 'array', items: { type: 'string' } },
          pending_decisions: { type: 'array', items: { type: 'string' } },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      routing_rationale: { type: 'string' },
      next_trigger: {
        type: 'object',
        properties: {
          event: { enum: ['on_member_update', 'on_human_input', 'on_external_update', 'on_timeout', 'manual_resume'] },
          target: { type: 'string' },
          details: { type: 'string' },
        },
        required: ['event'],
      },
    },
  },
  workflow: {
    type: 'object',
    properties: {
      steps_completed: { type: 'array', items: { type: 'string' } },
      first_task: { type: 'string' },
      children: { type: 'array', items: { type: 'string' } },
      test_issues: { type: 'array', items: { type: 'string' } },
    },
  },
  research: {
    type: 'object',
    properties: {
      sources_checked: { type: 'array', items: { type: 'string' } },
      confidence: { enum: ['low', 'medium', 'high'] },
      recommendations: { type: 'array', items: { type: 'string' } },
    },
  },
};

function deepMergeSchemas(base: JsonSchema, override: JsonSchema): JsonSchema {
  const merged: JsonSchema = { ...base };
  for (const [key, overrideValue] of Object.entries(override)) {
    const baseValue = merged[key];
    if (isRecord(baseValue) && isRecord(overrideValue)) {
      merged[key] = deepMergeSchemas(baseValue, overrideValue);
      continue;
    }
    merged[key] = overrideValue;
  }
  return merged;
}

function resolveOutputContractSchema(
  responseFormat: ResponseFormat,
  outputType: OutputType,
  outputSchema: JsonSchema | undefined,
): JsonSchema | undefined {
  if (responseFormat === 'text') return undefined;
  if (responseFormat === 'markdown' && !outputSchema) return undefined;

  let mergedSchema: JsonSchema = { ...BASE_OUTPUT_SCHEMA };

  if (outputType !== 'custom') {
    mergedSchema = deepMergeSchemas(mergedSchema, OUTPUT_TYPE_SCHEMA_EXTENSIONS[outputType]);
  }

  if (outputSchema) {
    mergedSchema = deepMergeSchemas(mergedSchema, outputSchema);
  }

  return mergedSchema;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\''`)}'`;
}

interface ReviewerDiffContext {
  source: string;
  stat: string;
  files: string[];
  hunks: string;
}

interface PatchSource {
  source: string;
  stat: string;
  files: string[];
  diffForFile: (file: string) => string;
}

function readCommandOutput(cwd: string, command: string): string {
  try {
    return execSync(command, {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

function resolveDefaultBranch(cwd: string): string {
  const headRef = readCommandOutput(cwd, 'git symbolic-ref refs/remotes/origin/HEAD');
  if (headRef) {
    return headRef.split('/').pop() ?? 'main';
  }

  const remoteHead = readCommandOutput(cwd, 'git remote show origin');
  const match = remoteHead.match(/HEAD branch:\s*(.+)/);
  return match?.[1]?.trim() || 'main';
}

function readMergeBase(cwd: string): string {
  const baseBranch = resolveDefaultBranch(cwd);
  return readCommandOutput(cwd, `git merge-base ${shellQuote(baseBranch)} HEAD`);
}

function extractInjectedFileDiff(hunks: string, file: string): string {
  const marker = `### ${file}\n`;
  const start = hunks.indexOf(marker);
  if (start < 0) return '';
  const rest = hunks.slice(start + marker.length);
  const nextHeader = rest.indexOf('\n\n### ');
  return (nextHeader >= 0 ? rest.slice(0, nextHeader) : rest).trim();
}

function parseInjectedReviewerDiffContext(variables?: Record<string, string>): ReviewerDiffContext | null {
  const source = variables?.reviewer_diff_source?.trim();
  const stat = variables?.reviewer_diff_stat?.trim();
  const filesRaw = variables?.reviewer_diff_files?.trim();
  const hunks = variables?.reviewer_diff_hunks?.trim();

  if (!source || !filesRaw || !hunks) return null;

  const files = filesRaw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (files.length === 0) return null;

  return {
    source,
    stat: stat || '(no stat)',
    files,
    hunks,
  };
}

function getPatchSources(cwd: string, variables?: Record<string, string>): PatchSource[] {
  const mergeBase = readMergeBase(cwd);
  const injectedContext = parseInjectedReviewerDiffContext(variables);

  return [
    ...(injectedContext
      ? [{
          source: injectedContext.source,
          stat: injectedContext.stat,
          files: injectedContext.files,
          diffForFile: (file: string) => extractInjectedFileDiff(injectedContext.hunks, file),
        } satisfies PatchSource]
      : []),
    {
      source: 'unstaged diff',
      stat: readCommandOutput(cwd, 'git diff --stat'),
      files: readCommandOutput(cwd, 'git diff --name-only').split('\n').map((line) => line.trim()).filter(Boolean),
      diffForFile: (file: string) => readCommandOutput(cwd, `git diff -- ${shellQuote(file)}`),
    },
    {
      source: 'staged diff',
      stat: readCommandOutput(cwd, 'git diff --cached --stat'),
      files: readCommandOutput(cwd, 'git diff --cached --name-only').split('\n').map((line) => line.trim()).filter(Boolean),
      diffForFile: (file: string) => readCommandOutput(cwd, `git diff --cached -- ${shellQuote(file)}`),
    },
    {
      source: 'branch-vs-base diff',
      stat: mergeBase ? readCommandOutput(cwd, `git diff --stat ${shellQuote(mergeBase)}..HEAD`) : '',
      files: mergeBase ? readCommandOutput(cwd, `git diff --name-only ${shellQuote(mergeBase)}..HEAD`).split('\n').map((line) => line.trim()).filter(Boolean) : [],
      diffForFile: (file: string) => mergeBase ? readCommandOutput(cwd, `git diff ${shellQuote(mergeBase)}..HEAD -- ${shellQuote(file)}`) : '',
    },
  ];
}

function buildReviewerDiffContext(cwd: string, variables?: Record<string, string>, maxFiles = 20): ReviewerDiffContext {
  for (const source of getPatchSources(cwd, variables)) {
    const files = source.files.slice(0, maxFiles);
    if (files.length === 0) continue;

    const hunks = files.map((file) => {
      const diff = source.diffForFile(file);
      return diff ? `### ${file}\n${diff}` : `### ${file}\n(no hunks)`;
    }).join('\n\n');

    if (hunks.trim()) {
      return {
        source: source.source,
        stat: source.stat,
        files,
        hunks,
      };
    }
  }

  throw new Error('Reviewer startup blocked: no patch context found in injected diff, unstaged diff, staged diff, or branch-vs-base diff.');
}

function buildReviewerDiffInstruction(context: ReviewerDiffContext): string {
  return `\n\n---\n## Reviewer Diff Context\nReview only patch below. Ignore unrelated files, repo-wide exploration, and filesystem hunting.\nIf patch context is empty, stop and fail fast.\n\nPatch source:\n${context.source}\n\nDiff stat:\n${context.stat || '(no stat)'}\n\nChanged files:\n${context.files.map((file) => `- ${file}`).join('\n')}\n\nDiff hunks:\n${context.hunks}\n---\n`;
}

function tryParseJson(input: string): { value?: unknown; error?: string } {
  try {
    return { value: JSON.parse(input) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message };
  }
}

function extractJsonFromMachineReadableBlock(output: string): { value?: unknown; error?: string } {
  const blockRegex = /##\s*Machine-readable block[\s\S]*?```json\s*([\s\S]*?)```/i;
  const match = output.match(blockRegex);
  if (!match || !match[1]) {
    return { error: 'missing `## Machine-readable block` JSON fenced block' };
  }
  return tryParseJson(match[1].trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateValueAgainstSchema(value: unknown, schema: JsonSchema, path: string): string[] {
  const errors: string[] = [];
  const schemaType = schema.type;
  const schemaEnum = schema.enum;

  if (Array.isArray(schemaEnum) && schemaEnum.length > 0 && !schemaEnum.some(candidate => Object.is(candidate, value))) {
    errors.push(`${path}: expected one of [${schemaEnum.map(item => JSON.stringify(item)).join(', ')}], got ${JSON.stringify(value)}`);
  }

  const effectiveType = typeof schemaType === 'string'
    ? schemaType
    : isRecord(schema.properties) || Array.isArray(schema.required)
      ? 'object'
      : Array.isArray(schema.items)
        ? 'array'
        : undefined;

  if (!effectiveType) return errors;

  switch (effectiveType) {
    case 'object': {
      if (!isRecord(value)) {
        errors.push(`${path}: expected object, got ${Array.isArray(value) ? 'array' : typeof value}`);
        return errors;
      }
      const properties = isRecord(schema.properties) ? schema.properties : {};
      const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : [];

      for (const key of required) {
        if (!(key in value)) {
          errors.push(`${path}.${key}: missing required property`);
        }
      }

      for (const [key, propertySchemaRaw] of Object.entries(properties)) {
        if (!(key in value)) continue;
        if (!isRecord(propertySchemaRaw)) continue;
        errors.push(...validateValueAgainstSchema(value[key], propertySchemaRaw, `${path}.${key}`));
      }
      return errors;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array, got ${typeof value}`);
        return errors;
      }
      const itemSchema = isRecord(schema.items) ? schema.items : undefined;
      if (!itemSchema) return errors;
      for (let i = 0; i < value.length; i += 1) {
        errors.push(...validateValueAgainstSchema(value[i], itemSchema, `${path}[${i}]`));
      }
      return errors;
    }
    case 'string':
      if (typeof value !== 'string') errors.push(`${path}: expected string, got ${typeof value}`);
      return errors;
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) errors.push(`${path}: expected number, got ${typeof value}`);
      return errors;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) errors.push(`${path}: expected integer, got ${JSON.stringify(value)}`);
      return errors;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path}: expected boolean, got ${typeof value}`);
      return errors;
    default:
      return errors;
  }
}

function validateOutputContract(
  output: string,
  responseFormat: ResponseFormat,
  outputSchema: JsonSchema | undefined,
): string[] {
  const warnings: string[] = [];
  if (responseFormat === 'text') return warnings;

  if (!outputSchema) return warnings;

  let structuredPayload: unknown;

  if (responseFormat === 'json') {
    const parsed = tryParseJson(output.trim());
    if (parsed.error) {
      warnings.push(`Strong warning: response_format=json but output is not valid JSON (${parsed.error}).`);
      return warnings;
    }
    structuredPayload = parsed.value;
  }

  if (responseFormat === 'markdown') {
    const parsed = extractJsonFromMachineReadableBlock(output);
    if (parsed.error) {
      warnings.push(`Output contract warning: ${parsed.error}.`);
      return warnings;
    }
    structuredPayload = parsed.value;
  }

  const schemaErrors = validateValueAgainstSchema(structuredPayload, outputSchema, '$');
  if (schemaErrors.length > 0) {
    warnings.push(
      `Output contract warning: schema mismatch (${schemaErrors.length} issue${schemaErrors.length === 1 ? '' : 's'}).`,
      ...schemaErrors.map(issue => `  - ${issue}`),
    );
  }

  return warnings;
}

function selectAvailableModel(
  modelChain: readonly string[],
  circuitBreaker: CircuitBreaker,
): string {
  for (const model of modelChain) {
    if (circuitBreaker.isAvailable(model)) return model;
  }

  return modelChain.at(-1) ?? modelChain[0];
}

function classifyFallbackError(error: unknown): string {
  if (isAuthError(error)) return 'auth';
  if (isRateLimitError(error)) return 'rate_limit';

  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (/timeout|timed out|etimedout|deadline/.test(message)) return 'timeout';
  if (isTransientError(error)) return 'transient';
  return 'unknown';
}

function emitFallbackStep(
  onEvent: ((type: string, details?: { model?: string; data?: Record<string, unknown> }) => void) | undefined,
  specialist: string,
  attemptN: number,
  modelTried: string,
  errorClass: string,
  terminal: boolean,
): void {
  onEvent?.('fallback_step', {
    model: modelTried,
    data: {
      event: 'fallback_step',
      specialist,
      attempt_n: attemptN,
      model_tried: modelTried,
      error_class: errorClass,
      terminal,
    },
  });
}

export class SpecialistRunner {
  private sessionFactory: SessionFactory;

  constructor(private deps: RunnerDeps) {
    this.sessionFactory = deps.sessionFactory ?? PiAgentSession.create.bind(PiAgentSession);
  }

  private resolvePromptWithBeadContext(options: RunOptions, runCwd: string, beadsClient?: BeadsClientType): string {
    if (!options.inputBeadId) {
      return options.prompt;
    }

    const beadReader = beadsClient ?? new BeadsClient();
    const bead = beadReader.readBead(options.inputBeadId);
    if (!bead) {
      return options.prompt;
    }

    const contextDepth = Math.max(0, Math.trunc(options.contextDepth ?? 3));
    const blockers = contextDepth > 0
      ? beadReader.getCompletedBlockers(options.inputBeadId, contextDepth)
      : [];

    const baseContext = buildBeadContext(bead, blockers);
    return `${baseContext}\n\n${buildBeadBoundaryInstruction(runCwd, options.worktreeBoundary)}`.trim();
  }

  async run(
    options: RunOptions,
    onProgress?: (msg: string) => void,
    onEvent?: (
      type: string,
      details?: {
        charCount?: number;
        content?: string;
        toolCallId?: string;
        model?: string;
        previousModel?: string;
        action?: 'set_model' | 'cycle_model';
        extension?: string;
        errorMessage?: string;
        tokensBefore?: number;
        summary?: string;
        source?: string;
        data?: Record<string, unknown>;
        firstKeptEntryId?: string;
        attempt?: number;
        maxAttempts?: number;
        delayMs?: number;
      },
    ) => void,
    onMetric?: (event: SessionMetricEvent) => void,
    onMeta?: (meta: { backend: string; model: string; sessionId?: string }) => void,
    onKillRegistered?: (killFn: () => void) => void,
    onSessionRegistered?: (session: SessionLike) => void,
    onBeadCreated?: (beadId: string) => void,
    onSteerRegistered?: (steerFn: (msg: string) => Promise<void>) => void,
    onResumeReady?: (
      resumeFn: (msg: string) => Promise<string>,
      closeFn: () => Promise<void>,
    ) => void,
    onToolStartCallback?: (tool: string, args?: Record<string, unknown>, toolCallId?: string) => void,
    onToolEndCallback?: (tool: string, isError: boolean, toolCallId?: string, resultContent?: string, resultRaw?: Record<string, unknown>) => void,
  ): Promise<RunResult> {
    const { loader, hooks, circuitBreaker, beadsClient } = this.deps;
    const invocationId = crypto.randomUUID();
    const start = Date.now();

    const spec = await loader.get(options.name);
    const { metadata, execution, prompt, output_file } = spec.specialist;
    // loader.get() hard-fails on null execution.model via SpecialistMissingModelError
    // before reaching here, so the cast is sound at runtime. tsc cannot prove it.
    const executionModel = execution.model as string;

    const modelChain = options.backendOverride
      ? [options.backendOverride]
      : resolveModelChain({ ...execution, model: executionModel });
    const primaryModel = modelChain[0] ?? executionModel;
    const initialModel = selectAvailableModel(modelChain, circuitBreaker);
    const fallbackUsed = initialModel !== primaryModel;

    const permissionLevel = options.autonomyLevel ?? execution.permission_required;
    const specialistPermissions = options.specialistPermissions ?? spec.specialist.permissions;
    const effectiveKeepAlive = options.noKeepAlive
      ? false
      : (options.keepAlive ?? execution.interactive ?? false);
    const extensionSelection = resolveExecutionExtensionSelection(execution.extensions);
    const excludeExtensions = extensionSelection.excludeExtensions;
    const resolvedToolContract = resolveRuntimeToolContract({
      level: permissionLevel,
      specialistName: options.specialistName ?? metadata.name,
      specialistPermissions,
      excludeExtensions,
      extensionSources: extensionSelection.extensionSources,
      cwd: options.workingDirectory,
    });
    const resolvedToolContractBlock = resolvedToolContract ? formatResolvedToolContract(resolvedToolContract) : '';
    const promptVariables = {
      ...(options.variables ?? {}),
      ...(resolvedToolContractBlock ? { resolved_tool_contract: resolvedToolContractBlock } : {}),
    };

    await hooks.emit('pre_render', invocationId, metadata.name, metadata.version, {
      variables_keys: Object.keys(promptVariables),
      backend_resolved: initialModel,
      fallback_used: fallbackUsed,
      circuit_breaker_state: circuitBreaker.getState(initialModel),
      scope: 'project',
    });

    // Pre-run validation: check scripts exist, commands/tools are available, shebang typos
    validateBeforeRun(spec, permissionLevel, resolvedToolContract);

    // Pre-phase scripts/commands run locally before the pi session starts.
    // Their stdout is captured and injected into the task via $pre_script_output.
    const runCwd = resolve(options.workingDirectory ?? process.cwd());

    const preScripts = spec.specialist.skills?.scripts?.filter(s => s.phase === 'pre') ?? [];
    const preScriptResults = preScripts
      .map(s => runScript(s.run ?? (s as unknown as { path?: string }).path, runCwd));
    const requiredPreFailure = findRequiredPreScriptFailure(preScripts, preScriptResults);
    if (requiredPreFailure) {
      throw new RequiredPreScriptError(formatRequiredPreScriptFailure(requiredPreFailure));
    }
    const preScriptOutput = formatScriptOutput(preScriptResults.filter((_, i) => preScripts[i].inject_output));
    const payloadComponents: PayloadComponentMeasurement[] = [];

    const beadReader = beadsClient ?? new BeadsClient();
    const bead = options.inputBeadId ? beadReader.readBead(options.inputBeadId) : null;
    const completedBlockers = options.inputBeadId && Math.max(0, Math.trunc(options.contextDepth ?? 3)) > 0
      ? beadReader.getCompletedBlockers(options.inputBeadId, Math.max(0, Math.trunc(options.contextDepth ?? 3)))
      : [];

    // Pre-inject the executor's gitnexus_summary (files_touched / symbols_analyzed /
    // highest_risk / tool_invocations) so the reviewer task template can render it
    // directly. Falls back to empty string when the reviewed job had no run_complete
    // event or no gitnexus_summary — the reviewer prompt instructs to `sp feed
    // <reviewed_job_id>` for the timeline in that case (see Phase 1 unitAI-gufaf.1).
    const gitnexusSummary = buildReviewedGitnexusSummary({
      reusedFromJobId: options.reusedFromJobId,
      cwd: runCwd,
    });

    // Task-side assembly is shared verbatim with `sp render-task` (unitAI-6639v.4).
    // Reviewer diff context is execution-only, so it enters through the hook rather
    // than the pure seam — it must still land before the hash, as it always has.
    let rendered;
    try {
      rendered = renderTaskPrompt({
        specialist: spec.specialist,
        cwd: runCwd,
        beadId: options.inputBeadId,
        bead,
        completedBlockers,
        fallbackPrompt: () => this.resolvePromptWithBeadContext(options, runCwd, beadsClient),
        preScriptOutput,
        variables: promptVariables,
        reusedFromJobId: options.reusedFromJobId,
        worktreeOwnerJobId: options.worktreeOwnerJobId,
        gitnexusSummary: gitnexusSummary || undefined,
        worktreeBoundary: options.worktreeBoundary,
        appendExecutionContext: metadata.name === 'reviewer'
          ? (task, cwd, variables) => {
              try {
                return `${task}${buildReviewerDiffInstruction(buildReviewerDiffContext(cwd, variables))}`;
              } catch (error) {
                console.warn(`[specialist runner] Reviewer diff context unavailable: ${String(error)}`);
                return task;
              }
            }
          : undefined,
      });
    } catch (error) {
      if (error instanceof MandatoryRulesBudgetError) {
        const data = {
          budget_limit: error.budgetLimit,
          candidate_tokens: error.candidateTokens,
          injected_tokens: error.injectedTokens,
          injected_section_ids: error.injectedSectionIds,
          evicted_section_ids: error.evictedSectionIds,
          payload_digest: createHash('sha256').update('').digest('hex'),
          outcome: error.outcome,
        };
        onEvent?.('meta', {
          source: 'mandatory_rules_injection',
          data,
          summary: JSON.stringify({ kind: 'meta', source: 'mandatory_rules_injection', data }),
        });
      }
      throw error;
    }

    const {
      beadContextOwn,
      beadContextParent,
      beadContextBlockers,
      beadContextText,
      beadTemplateVariables,
      mandatoryRulesBlock,
    } = rendered;
    const mandatoryRulesInjection = rendered.mandatoryRules;
    const renderedTask = rendered.initial_prompt;
    const promptHash = rendered.prompt_hash;
    payloadComponents.push(rendered.taskTemplateComponent);

    await hooks.emit('post_render', invocationId, metadata.name, metadata.version, {
      prompt_hash: promptHash,
      prompt_length_chars: renderedTask.length,
      estimated_tokens: Math.ceil(renderedTask.length / 4),
      system_prompt_present: !!prompt.system,
    });

    const responseFormat = (execution.response_format ?? 'text') as ResponseFormat;
    const outputType = (execution.output_type ?? 'custom') as OutputType;
    const specialistOutputSchema = prompt.output_schema as JsonSchema | undefined;
    const outputContractSchema = resolveOutputContractSchema(responseFormat, outputType, specialistOutputSchema);

    const systemPromptResult = buildSystemPrompt({
      systemPromptTemplate: prompt.system ?? '',
      templateVariables: beadTemplateVariables,
      bare: execution.bare,
      runCwd,
      specialistName: metadata.name,
      inputBeadId: options.inputBeadId,
      reusedFromJobId: options.reusedFromJobId,
      responseFormat,
      outputType,
      outputContractSchema,
      beadContextText,
      readBeadForMemory: (id) => (beadsClient ?? new BeadsClient()).readBead(id),
    });
    const agentsMd = systemPromptResult.text;
    const { static: staticTokens, memory: memoryTokens, gitnexus: gitnexusTokens } = systemPromptResult.tokens;

    const totalMemoryInjectionTokens = staticTokens + memoryTokens + gitnexusTokens;
    onEvent?.('memory_injection', {
      summary: JSON.stringify({
        memory_injection: {
          static_tokens: staticTokens,
          memory_tokens: memoryTokens,
          gitnexus_tokens: gitnexusTokens,
          total_tokens: totalMemoryInjectionTokens,
        },
      }),
    });

    const mandatoryRulesMeta = mandatoryRulesInjection && mandatoryRulesBlock.trim()
      ? {
          source: 'mandatory_rules_injection',
          data: {
            sets_loaded: mandatoryRulesInjection.setsLoaded,
            rules_count: mandatoryRulesInjection.ruleCount,
            inline_rules_count: mandatoryRulesInjection.inlineRulesCount,
            globals_disabled: mandatoryRulesInjection.globalsDisabled,
            token_estimate: mandatoryRulesInjection.injectedTokens,
            budget_limit: mandatoryRulesInjection.budgetLimit,
            candidate_tokens: mandatoryRulesInjection.candidateTokens,
            injected_tokens: mandatoryRulesInjection.injectedTokens,
            injected_section_ids: mandatoryRulesInjection.injectedSectionIds,
            evicted_section_ids: mandatoryRulesInjection.evictedSectionIds,
            payload_digest: mandatoryRulesInjection.payloadDigest,
            outcome: mandatoryRulesInjection.outcome,
          },
        }
      : null;

    if (mandatoryRulesMeta) {
      onEvent?.('meta', {
        ...mandatoryRulesMeta,
        summary: JSON.stringify({
          kind: 'meta',
          ...mandatoryRulesMeta,
        }),
      });
    }

    const skillPaths: string[] = [];
    if (prompt.skill_inherit) skillPaths.push(prompt.skill_inherit);
    skillPaths.push(...(spec.specialist.skills?.paths ?? []));

    if (mandatoryRulesInjection) {
      for (const section of mandatoryRulesInjection.sections) {
        payloadComponents.push(measurePayloadComponent('mandatory_rule', section.setId, section.block));
      }
    }
    for (const skillPath of skillPaths) {
      payloadComponents.push(measurePayloadComponent('skill', skillPath, skillPath));
    }
    if (preScriptOutput) {
      payloadComponents.push(measurePayloadComponent('pre_script_output', 'pre_script_output', preScriptOutput));
    }
    if (beadContextOwn) payloadComponents.push(beadContextOwn);
    if (beadContextParent) payloadComponents.push(beadContextParent);
    for (const component of beadContextBlockers) payloadComponents.push(component);
    for (const component of systemPromptResult.components) payloadComponents.push(component);

    const payloadBreakdown = summarizePayloadBreakdown(payloadComponents);
    onEvent?.('payload_breakdown', {
      summary: JSON.stringify({ payload_breakdown: payloadBreakdown }),
    });

    // AUTO INJECTED banner — printed before session starts so the user can see what was loaded
    if (skillPaths.length > 0 || preScripts.length > 0) {
      const line = '━'.repeat(56);
      onProgress?.(`\n${line}\n◆ AUTO INJECTED\n`);
      if (skillPaths.length > 0) {
        onProgress?.(`  skills (--skill):\n${skillPaths.map(p => `    • ${p}`).join('\n')}\n`);
      }
      if (preScripts.length > 0) {
        onProgress?.(`  pre scripts/commands:\n${preScripts.map(s => `    • ${(s.run ?? (s as unknown as { path?: string }).path ?? '<missing>')}${s.inject_output ? ' → $pre_script_output' : ''}`).join('\n')}\n`);
      }
      onProgress?.(`${line}\n\n`);
    }

    // Beads: use provided input bead OR create a new tracking bead.
    // When inputBeadId is present the orchestrator owns the lifecycle — do NOT create a second bead.
    // Owned-bead creation is placed BEFORE pre_execute so onBeadCreated fires early and callers
    // (e.g. Supervisor) can write bead_id into status.json before the session starts.
    const beadsIntegration = spec.specialist.beads_integration ?? 'auto';
    let beadId: string | undefined;
    let ownsBead = false; // true only when runner created the bead (not inherited from orchestrator)
    if (options.inputBeadId) {
      beadId = options.inputBeadId;
    } else if (beadsClient && shouldCreateBead(beadsIntegration, execution.permission_required)) {
      beadId = beadsClient.createBead(metadata.name) ?? undefined;
      if (beadId) { ownsBead = true; onBeadCreated?.(beadId); }
    }

    let currentModel = initialModel;
    await hooks.emit('pre_execute', invocationId, metadata.name, metadata.version, {
      backend: currentModel,
      model: currentModel,
      timeout_ms: execution.timeout_ms,
      permission_level: permissionLevel,
    });

    let output: string | undefined;
    let sessionBackend: string = currentModel; // captured before kill() can destroy meta
    let runMetrics: SessionRunMetrics | undefined;
    let session: Awaited<ReturnType<SessionFactory>> | undefined;
    let keepAliveActive = false; // set true when keepAlive hands session ownership to caller
    let sessionClosed = false; // track if we closed cleanly (to avoid kill in finally)
    let currentFailureRecorded = false;
    const maxRetries = Math.max(0, Math.trunc(options.maxRetries ?? execution.max_retries ?? 0));
    const maxAttempts = maxRetries + 1;

    try {
      const envVars: Record<string, string> = {};
      const resolvedNodeId = options.variables?.SPECIALISTS_NODE_ID ?? options.variables?.node_id;
      if (resolvedNodeId) envVars.SPECIALISTS_NODE_ID = resolvedNodeId;
      if (options.variables?.SPECIALISTS_JOB_ID) envVars.SPECIALISTS_JOB_ID = options.variables.SPECIALISTS_JOB_ID;

      for (let modelIndex = 0; modelIndex < modelChain.length; modelIndex++) {
        currentModel = modelChain[modelIndex];
        currentFailureRecorded = false;
        const isTerminalModel = modelIndex === modelChain.length - 1;

        if (!circuitBreaker.isAvailable(currentModel) && !isTerminalModel) {
          emitFallbackStep(onEvent, metadata.name, modelIndex + 2, modelChain[modelIndex + 1], 'transient', false);
          continue;
        }

        sessionClosed = false;
        session = await this.sessionFactory({
          model: currentModel,
          systemPrompt: agentsMd || undefined,
          systemPromptMode: prompt.system_prompt_mode,
          skillPaths: skillPaths.length > 0 ? skillPaths : undefined,
          thinkingLevel: execution.thinking_level,
          permissionLevel,
          specialistName: options.specialistName ?? metadata.name,
          specialistPermissions,
          resolvedToolContract,
          stallTimeoutMs: execution.stall_timeout_ms,
          cwd: runCwd,
          worktreeBoundary: options.worktreeBoundary,
          ...(excludeExtensions.length > 0 ? { excludeExtensions } : {}),
          ...(extensionSelection.extensionSources.length > 0 ? { extensionSources: extensionSelection.extensionSources } : {}),
          ...(extensionSelection.offline === false ? { offline: false } : {}),
          ...(Object.keys(envVars).length > 0 ? { env: envVars } : {}),
          onToken:     (delta) => onProgress?.(delta),
          onThinking:  (delta) => onProgress?.(`💭 ${delta}`),
          onToolStart: (tool, args, toolCallId) => { onProgress?.(`\n⚙ ${tool}…`); onToolStartCallback?.(tool, args, toolCallId); },
          onToolEnd:   (tool, isError, toolCallId, resultContent, resultRaw) => { onProgress?.(`✓\n`); onToolEndCallback?.(tool, isError, toolCallId, resultContent, resultRaw); },
          onEvent:     (type, details)  => onEvent?.(type, details),
          onMetric:    (event) => onMetric?.(event),
          onMeta:      (meta)  => onMeta?.(meta),
        });
        await session.start();

        onKillRegistered?.(session.kill.bind(session));
        onSessionRegistered?.(session);
        onSteerRegistered?.((msg) => session!.steer(msg));

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            await session.prompt(renderedTask);
            await session.waitForDone(execution.timeout_ms);
            output = await session.getLastOutput();
            runMetrics = session.getMetrics?.();
            sessionBackend = session.meta.backend;
            break;
          } catch (err: any) {
            const isRateLimit = isRateLimitError(err);
            const isTransient = !(err instanceof SessionKilledError) && !isAuthError(err) && isTransientError(err);
            // Rate-limit / quota errors: the current model's window is exhausted — retrying
            // the same model is guaranteed-wasteful, so skip straight to the fallback chain.
            const shouldRetry = attempt < maxAttempts && isTransient && !isRateLimit;

            if (shouldRetry) {
              const delayMs = getRetryDelayMs(attempt);
              onEvent?.('auto_retry');
              onProgress?.(`\n↻ transient backend error on attempt ${attempt}/${maxAttempts}; retrying in ${delayMs}ms\n`);
              await sleep(delayMs);
              continue;
            }

            if (!isTransient) throw err;

            circuitBreaker.recordFailure(currentModel);
            currentFailureRecorded = true;
            if (isTerminalModel) {
              emitFallbackStep(onEvent, metadata.name, modelIndex + 1, currentModel, classifyFallbackError(err), true);
              throw err;
            }

            emitFallbackStep(onEvent, metadata.name, modelIndex + 2, modelChain[modelIndex + 1], classifyFallbackError(err), false);
            session.kill();
            session = undefined;
            break;
          }
        }

        if (output !== undefined) break;
      }

      if (output === undefined) {
        throw new Error('Specialist run finished without output');
      }

      if (responseFormat === 'json') {
        output = stripJsonFences(output);
      }

      if (effectiveKeepAlive && onResumeReady) {
        // Hand the session to the caller for multi-turn use.
        // Don't close here — caller owns the lifecycle via closeFn.
        keepAliveActive = true;
        const resumeFn = async (msg: string): Promise<string> => {
          await session!.resume(msg, execution.timeout_ms);
          return session!.getLastOutput();
        };
        const closeFn = async (): Promise<void> => {
          keepAliveActive = false;
          await session!.close();
        };
        onResumeReady(resumeFn, closeFn);
      } else {
        if (!session) throw new Error('Specialist run finished without session');
        await session.close();
        sessionClosed = true;
      }

      // Post-phase scripts/commands run locally after the pi session completes
      const postScripts = spec.specialist.skills?.scripts?.filter(s => s.phase === 'post') ?? [];
      for (const script of postScripts) runScript(script.run ?? (script as unknown as { path?: string }).path, runCwd);

      circuitBreaker.recordSuccess(currentModel);
    } catch (err: any) {
      const isCancelled = err instanceof SessionKilledError;
      const authError = isAuthError(err);
      if (!isCancelled && !authError && !currentFailureRecorded) {
        // Only record a circuit-breaker failure for real backend errors
        circuitBreaker.recordFailure(currentModel);
      }
      // Beads: close with CANCELLED for kill, ERROR for real failures; always audit.
      // Only close if runner owns the bead — input beads are closed by the orchestrator.
      const beadStatus = isCancelled ? 'CANCELLED' : 'ERROR';
      if (beadId) {
        if (ownsBead) beadsClient?.closeBead(beadId, beadStatus, Date.now() - start, currentModel);
        beadsClient?.auditBead(beadId, metadata.name, currentModel, 1);
      }
      await hooks.emit('post_execute', invocationId, metadata.name, metadata.version, {
        status: isCancelled ? 'CANCELLED' : 'ERROR',
        duration_ms: Date.now() - start,
        output_valid: false,
        error: { type: isCancelled ? 'cancelled' : 'backend_error', message: err.message },
      });
      throw err;
    } finally {
      // Only kill if we didn't close cleanly AND not in keepAlive mode
      if (!keepAliveActive && !sessionClosed) {
        session?.kill(); // idempotent safety net
      }
    }

    const durationMs = Date.now() - start;

    const outputContractWarnings = validateOutputContract(output, responseFormat, outputContractSchema);
    if (outputContractWarnings.length > 0) {
      process.stderr.write(`[specialists] output contract warnings:\n${outputContractWarnings.map(msg => `  ⚠ ${msg}`).join('\n')}\n`);
    }

    if (output_file && !options.suppressRunnerFileOutput) {
      await writeJobFileOutput(output_file, output, 'overwrite').catch(() => {});
    }

    await hooks.emit('post_execute', invocationId, metadata.name, metadata.version, {
      status: 'COMPLETE',
      duration_ms: durationMs,
      output_valid: true,
    });

    // Beads: emit audit record. Owned beads are closed by the Supervisor AFTER
    // updateBeadNotes — do NOT call closeBead here on the success path.
    // (Error/cancel paths close owned beads in the catch block above because
    // Supervisor never reaches post-processing on failure.)
    if (beadId) {
      beadsClient?.auditBead(beadId, metadata.name, currentModel, 0);
    }

    return {
      output,
      backend: sessionBackend,
      model: currentModel,
      durationMs,
      specialistVersion: metadata.version,
      promptHash,
      beadId,
      metrics: runMetrics,
      permissionRequired: execution.permission_required,
      autoCommit: execution.auto_commit,
      outputType,
      payloadBreakdown: summarizePayloadBreakdown(payloadComponents),
    };
  }

  /**
   * @deprecated Legacy in-memory async path.
   * Now uses Supervisor-backed jobs under .specialists/jobs.
   */
  async startAsync(options: RunOptions, registry: import('./jobRegistry.js').JobRegistry): Promise<string> {
    const jobId = crypto.randomUUID();
    // Pre-load spec to capture version before the async run begins
    let specialistVersion = '?';
    try {
      const spec = await this.deps.loader.get(options.name);
      specialistVersion = spec.specialist.metadata.version;
    } catch { /* will fail properly inside run() */ }
    registry.register(jobId, {
      backend: options.backendOverride ?? 'starting',
      model: '?',
      specialistVersion,
    });
    this.run(
      options,
      (text)      => registry.appendOutput(jobId, text),
      (eventType) => registry.setCurrentEvent(jobId, eventType),
      undefined,
      (meta)      => registry.setMeta(jobId, meta),
      (killFn)    => registry.setKillFn(jobId, killFn),
      (_session)  => {},
      (beadId)    => registry.setBeadId(jobId, beadId),
      (steerFn)   => registry.setSteerFn(jobId, steerFn),
      (resumeFn, closeFn) => registry.setResumeFn(jobId, resumeFn, closeFn),
    )
      .then(result => registry.complete(jobId, result))
      .catch(err   => registry.fail(jobId, err));
    return jobId;
  }
}
