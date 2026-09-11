---
title: Specialists Runtime Architecture
scope: architecture
category: reference
version: 3.4.2
updated: 2026-06-23
synced_at: bf6baf7a
description: Event pipeline, Pi RPC adapter boundaries, Supervisor lifecycle ownership, schema v1→v4 migration chain, JSON-first dual-write persistence, node runtime tables, context window tracking, job lineage fields, context denormalization, sp ps CLI surface, worktree/bead ownership semantics, and worktree write-boundary enforcement via generated Pi extensions.
source_of_truth_for:
  - "src/specialist/job-root.ts"
  - "src/specialist/worktree.ts"
  - "src/specialist/timeline-events.ts"
  - "src/pi/session.ts"
  - "src/specialist/supervisor.ts"
  - "src/cli/ps.ts"
  - "src/cli/merge.ts"
  - "src/cli/epic.ts"
  - "src/cli/end.ts"
  - "src/specialist/epic-lifecycle.ts"
  - "src/specialist/chain-identity.ts"
  - "src/specialist/epic-readiness.ts"
  - "pi/rpc/"
domain:
  - architecture
  - rpc
  - supervisor
  - timeline
  - worktrees
  - jobs
---

# Specialists Runtime Architecture

This document defines the runtime boundary between:

- **Pi RPC protocol** (`pi/rpc/`) — canonical transport and event contract
- **RPC adapter** (`src/pi/session.ts`) — process bridge + request/response correlation
- **Lifecycle owner** (`src/specialist/supervisor.ts`) — durable state, persistence, completion semantics, GitNexus tracking
- **Timeline model** (`src/specialist/timeline-events.ts`) — persisted event vocabulary for feed v2
- **Worktree isolation** (`src/specialist/worktree.ts`) — isolated git workspaces per executor
- **Job registry anchor** (`src/specialist/job-root.ts`) — git-common-root-anchored job state

## 0) Runner context injection at spawn

`src/specialist/runner.ts` injects context into the specialist's first-turn prompt before spawning the Pi session. Per-bead stored-context injection is retired (S1 unitAI-cnca3 through S4 unitAI-j45ai): the runner injects no stored per-bead context.

### Injection pipeline (in order)

| # | Source | Tokens | Condition | Purpose |
|---|--------|--------|-----------|--------|
| 0 | Caveman-micro output directive | ~80 | Always | Terse agent-to-agent output style (+26pp accuracy, ~65% token reduction) |
| 1 | GitNexus workflow mandate | ~200 | `.gitnexus/meta.json` exists | Mandatory code intelligence usage rules |
| — | Memory doctrine | — | Injected by xtrm-loader Pi extension ONLY, not runner | User-owned memory file is never injected |
| 4 | GitNexus pre-query snapshot | ~0-200 | `.gitnexus/meta.json` exists + symbol-like tokens in bead title | Pre-resolved caller/callee/process summaries for top 2 CamelCase symbols |

### Retired: per-bead context retrieval

Removed across S1–S4: unitAI-cnca3 (spawn injection), unitAI-7n3fs (management CLI, sync hook, init wiring), unitAI-3qfjr (SQLite persistence → stubs), unitAI-j45ai (curator specialist, audit skill). The former module retains neutered stubs plus pure helpers for caller compatibility.

### Extension opt-out

Specialists can tune injected extensions via `execution.extensions`.
`gitnexus: false` still maps to `excludeExtensions: ['pi-gitnexus']`.
Any other trusted source-string key with value `true` becomes `-e <source>` in insertion order.
Remote `npm:`, `git:`, and `http(s):` sources omit `--offline`; local-only sources keep it.
Legacy `execution.extensions.serena` remains parseable but ignored after K4 Serena retirement (unitAI-e67up.8).

### Retired: serena-pool pre-spawn hook

Before the K4 Serena retirement (unitAI-e67up.8), `session.ts` pre-spawned a shared Serena daemon via the globally installed `serena-pool` extension and injected `SERENA_MCP_PORT` into the Pi environment. That hook is gone: Specialists never probes for `pi-serena-tools`, never spawns or reuses a Serena daemon, and never sets `SERENA_MCP_PORT`. Passive process-health detection (`sp ps --health`, orphan reaping) still reports or reaps already-running foreign Serena processes, but nothing in the runtime activates Serena.

### `memory_injection` timeline event

Supervisor records token accounting for each specialist spawn:

```json
{
  "type": "meta",
  "model": "memory_injection",
  "backend": "injected",
  "memory_injection": {
    "static_tokens": 60,
    "memory_tokens": 400,
    "gitnexus_tokens": 150,
    "total_tokens": 610
  }
}
```

This enables post-hoc analysis of context budget allocation across runs.

### Non-fatal behavior

All injection sources are optional and non-blocking:
- `.gitnexus/meta.json` missing → no GitNexus mandate or pre-query
- GitNexus CLI unavailable → pre-query skipped silently
- Extension opt-out → extension simply not loaded (no error)

This ensures specialist runs work in minimal environments (fresh clones, CI) while benefiting from full context in mature setups.

---

## 1) Canonical protocol boundary: `pi/rpc/`

`pi/rpc/` is the protocol source of truth for:

- JSONL framing (`jsonl.ts`)
- command/response/event types (`rpc-types.ts`)
- runtime behavior (`rpc-mode.ts`)
- typed client semantics (`rpc-client.ts`)

Specialists does **not** redefine protocol semantics. It consumes Pi events and commands through an adapter layer.

## 2) `src/pi/session.ts` = RPC adapter (not lifecycle owner)

`PiAgentSession` is an in-memory adapter over `pi --mode rpc`.

### Responsibilities

- Spawns Pi in RPC mode and parses stdout as NDJSON lines
- Sends commands over stdin with unique request IDs
- Correlates `response` events back to pending promises via `_pendingRequests`
- Emits normalized callbacks for Supervisor/Runner (`onEvent`, `onToolStart`, `onToolEnd`, `onMeta`)
- Enforces liveness timeout (`stallTimeoutMs`) at session level
- Pins absolute cwd at spawn time to prevent TMUX path drift in worktrees
- Resolves npm package extensions (gitnexus) from global node_modules
- Supports per-specialist extension opt-out via `excludeExtensions` option
- Injects caveman extension for terse agent-to-agent output
- Sets `CAVEMAN_LEVEL=full` environment variable

### ID-mapped dispatch + ack checks

- `sendCommand()` assigns incrementing IDs (`_nextRequestId`) and stores resolver/rejecter in `_pendingRequests`
- `_handleEvent()` matches `type === "response"` with `event.id` and resolves the matching pending request
- timeouts reject outstanding calls with `RPC timeout...` (default timeout: 30s)
- command methods enforce explicit ack success:
  - `prompt()` throws if `response.success === false`
  - `steer()` throws if `response.success === false`

### Extension resolution

npm package extensions (gitnexus) are resolved from global node_modules:
- gitnexus: `~/.nvm/versions/node/<version>/lib/node_modules/pi-gitnexus`

Serena extension resolution was retired with the K4 Serena retirement (unitAI-e67up.8).

Extension opt-out: `excludeExtensions` string array filters packages before `-e` assembly.

Caveman extension: loaded from `~/.pi/agent/extensions/caveman` if present. Sets `CAVEMAN_LEVEL=full` env.

This is the key adapter contract: **transport-level correctness and command acknowledgement**, not durable job semantics.

## 3) Job registry anchored to git common root (`job-root.ts`)

`src/specialist/job-root.ts` ensures all worktrees converge on the same job registry.

### `resolveJobsDir()` — common-root anchoring

```typescript
export function resolveCommonGitRoot(cwd: string): string | undefined {
  const result = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf-8' });
  // Returns the main repo root from any worktree
  return dirname(resolve(cwd, result.stdout.trim()));
}

export function resolveJobsDir(cwd = process.cwd()): string {
  const commonRoot = resolveCommonGitRoot(cwd) ?? cwd;
  return join(commonRoot, '.specialists', 'jobs');
}
```

**Note:** `resolveCommonGitRoot` is exported for reuse (e.g., worktree.ts deduplication).

**Why this matters:** In a worktree, `git rev-parse --git-common-dir` returns the shared `.git/` directory in the main checkout. Taking `dirname` gives us the common project root, so all worktrees read/write `.specialists/jobs/` at the same absolute path.

### `resolveCurrentBranch()` — branch detection

Returns the current branch name, or `undefined` when HEAD is detached. Used by Supervisor to persist `branch` in `status.json`.

## Specialist configuration merge contract (KAN-90)

Specialist resolution is implemented in `src/specialist/loader.ts` through a deterministic 3-layer merge used by all runtime consumers.

### Layer order

1. **Package canonical** (`config/specialists/<name>.specialist.json`)
   - Upstream default for every specialist.
2. **Global user** (`~/.config/specialists/user.json`)
   - Sparse override surface initialized by `sp init --global`.
   - Merge path supports allowlisted execution/prompt/metadata fields and `skills.paths` append semantics.
3. **Repo user** (`.specialists/user/<name>.specialist.json`)
   - Full override file in repository scope.
   - Same allowlisted merge semantics as global for safe fields.

### Field governance

- **Allowed override fields (global/repo):** execution allowlist leaves (`model`, `fallback_model`, `fallback_models`, `timeout_ms`, `stall_timeout_ms`, `interactive`, `thinking_level`, `max_retries`, `prompt_limit_bytes`, `stdout_limit_bytes`), execution extension leaves, `prompt.system_prompt_mode`, `stall_detection.waiting_auto_close_ms`, `beads_write_notes`, `notes_mode`, `output_file`, and `skills.paths`.
- **Blocked fields:** `execution.permission_required`, `execution.auto_commit`, `prompt.system`, `prompt.output_schema`, `skills.scripts`, `mandatory_rules`, `capabilities`.
- **Severity model:**
  - Global blocked attempt: stripped (`severity: strip`) and surfaced only in diagnostic metadata.
  - Repo/user blocked attempt: retained in warning stream (`severity: warn`) and surfaced by `sp doctor --specialists`.

### Health checks and failure path

- `sp init --global` creates and seeds global override files from shipped catalog.
- `sp edit --global` mutates the shared layer.
- `sp doctor --specialists` evaluates global-model coverage, blocked fields, and model completeness.
- `SpecialistLoader.get()` throws `SpecialistMissingModelError` when a fully merged specialist still has no model after all layers.

### Why this contract exists

This contract centralizes user intent (`~/.config/specialists/user.json`) without forking canonical package assets, while preserving safety on policy-sensitive fields. It also keeps repo-local overrides composable with one machine-wide baseline and one per-repo layer.

## 4) Worktree isolation (`worktree.ts`)

`src/specialist/worktree.ts` provisions isolated git workspaces for edit-permission specialists.

### Key constraints

- Shells out to `bd worktree create` exclusively — no silent git fallback
- Fails loud: throws on bd error instead of degrading silently
- No Pi bootstrap logic (extensions are global via `~/.pi/`)

### Branch and path derivation

```typescript
// Convention: feature/<beadId>-<specialist-slug>
export function deriveBranchName(beadId: string, specialistName: string): string {
  return `feature/${beadId}-${slugify(specialistName)}`;
}

// Convention: <beadId>-<specialist-slug>
export function deriveWorktreeName(beadId: string, specialistName: string): string {
  return `${beadId}-${slugify(specialistName)}`;
}
```

### `provisionWorktree()` — creation and reuse

1. Derives canonical branch name and worktree path
2. Checks `git worktree list --porcelain` for existing worktree on that branch
3. If exists: returns `reused: true`
4. If not: calls `bd worktree create <path> --branch <branch>` (hard — throws on failure)

### `listWorktrees()` / `findExistingWorktree()` — discovery

Parses `git worktree list --porcelain` output into a `Map<branch, absolute-path>`. Detached-HEAD worktrees are omitted.

## 5) Supervisor is the sole durable lifecycle source

`src/specialist/supervisor.ts` owns persisted lifecycle and job state.

### Durable artifacts (authoritative)

For each run (`.specialists/jobs/<id>/` legacy/operator mirror):

- `status.json` — mutable current state (`starting/running/waiting/done/error`, pid, last event timestamps, model/backend, worktree_path, branch, **`node_id`**)
- `events.jsonl` — append-only canonical timeline stream (JSON-first source of truth)
- `result.txt` — final assistant output text

### JSON-first storage + atomic dual-write

Persistence is **JSON-first**:

- SQLite is the canonical runtime store for listing/querying and node-level analytics.
- Files under `.specialists/jobs/<id>/` are legacy/operator mirrors for recovery and debugging.

Dual-write behavior is intentionally split by durability role:

1. Write canonical file artifact (`status.json`, `events.jsonl`, `result.txt`).
2. Best-effort mirror into SQLite.

For coupled SQLite rows, writes are atomic inside a DB transaction:

- `upsertStatusWithEvent(...)` → status + event in one transaction
- `upsertStatusWithEventAndResult(...)` → status + event + result in one transaction

This yields: canonical durability from files, atomic relational consistency inside SQLite, and resilient operation when SQLite is unavailable.

### SQLite integration

Supervisor optionally uses `ObservabilitySqliteClient` for:

- Status mirror (`upsertStatus`) — indexed reads by status/bead/node
- Event mirror (`appendEvent`) — ordered timeline queries from `event_json`
- Result mirror (`upsertResult`) — quick result retrieval without reading `result.txt`
- Transactional compound updates (`upsertStatusWithEvent*`) — single-commit relational state changes

File-based storage remains authoritative and always available.

### Observability schema evolution (`schema_version` v1 → v4)

`src/specialist/observability-sqlite.ts` initializes and migrates schema idempotently through:

- **v1**: base observability tables (`schema_version`, `specialist_jobs`, `specialist_events`, `specialist_results`) + v1 rebuild of `specialist_jobs` to normalized columns (`worktree_column`, `last_output`).
- **v2**: bead-aware indexing (`bead_id` in jobs + `idx_jobs_bead`).
- **v3**: explicit job lifecycle indexing (`status`, `node_id`, `idx_jobs_status_updated`) and status denormalization for faster list/filter operations.
- **v4**: node-runtime observability tables:
  - `node_runs`
  - `node_members`
  - `node_events`
  - `node_memory`

Migrations are safe to rerun: each step checks `schema_version`, applies forward-only DDL, and recreates required indexes with `IF NOT EXISTS`.

### Node runtime tables (v4)

v4 adds first-class storage for multi-member node orchestration state:

- `node_runs` — coordinator-level run status (`node_name`, `status`, `coordinator_job_id`, `waiting_on`, `memory_namespace`, `status_json`)
- `node_members` — per-member participation (`member_id`, linked `job_id`, `specialist`, `model`, `role`, `status`, `enabled`)
- `node_events` — node-scoped timeline stream (`type`, `event_json`, ordered by `t,id`)
- `node_memory` — node memory/materialization (`namespace`, `entry_type`, `entry_id`, `summary`, `source_member_id`, `confidence`, `provenance_json`)

### Lifecycle ownership rules

Supervisor determines and persists:

- job creation and initial `starting` state
- transitions to `running`, `waiting`, `done`, `error`
- run completion and terminal event emission
- crash recovery and stale-state reconciliation

**Design rule:** completion and state are read from Supervisor files, not inferred directly from raw Pi adapter callbacks.

### GitNexus tracking accumulator

Supervisor accumulates GitNexus usage across a run:

```typescript
const gitnexusAccumulator = {
  files_touched: new Set<string>(),
  symbols_analyzed: new Set<string>(),
  highest_risk: undefined as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | undefined,
  tool_invocations: 0,
};
```

- `edit`/`write` tool results: extract `path` → add to `files_touched`
- `gitnexus_*` tool results: extract `files`, `symbols_analyzed`, `risk_level`
- Emits `gitnexus_summary` in `run_complete` event

### FIFO-based steering

Supervisor creates a named FIFO (`steer.pipe`) for cross-process steering:

```typescript
const fifoPath = join(dir, 'steer.pipe');
execFileSync('mkfifo', [fifoPath]);
```

**Synchronous fd closing:** The FIFO fd is opened with `'r+'` (O_RDWR) to prevent blocking, and closed synchronously in the `finally` block before destroying the read stream. This prevents event loop hangs in batch test suites.

Message types:
- `{ type: 'steer', message: '...' }` — steer running session
- `{ type: 'resume', task: '...' }` — resume waiting keep-alive session
- `{ type: 'close' }` — close keep-alive session
- `{ type: 'prompt', message: '...' }` — DEPRECATED, use `resume`

### Keep-alive session support

Supervisor supports non-streaming keep-alive sessions via `onResumeReady` callback:

1. Session completes first turn → transitions to `waiting` status
2. Session stays alive (not killed) awaiting explicit `resume` or `close`
3. Orchestrator sends `{ type: 'resume', task: '...' }` via FIFO
4. Session processes next turn → returns to `waiting` or `done`

**State machine:**
- `running` → actively processing
- `waiting` → alive, awaiting next-turn action (valid: `resume`, `close`)
- `done` → terminal, session closed
- `error` → terminal, session closed with error

### Worktree write-boundary enforcement

Supervisor propagates `worktreeBoundary` to the Runner when a job has an active worktree:

```typescript
const runOptionsWithBoundary = runOptions.workingDirectory
  ? { ...runOptions, worktreeBoundary: runOptions.workingDirectory }
  : runOptions;
```

The resolver walks the target job's `status.json`: if it already carries a `worktree_owner_job_id`, that value is inherited; otherwise the target job's own `id` becomes the owner. This keeps ownership consistent across arbitrarily deep reuse chains.

These fields are the primary inputs for `sp ps` tree construction — they replace fragile `worktree_path` inference.

### Context denormalization in `status.json`

On every `turn_summary` metric event, Supervisor writes `context_pct` and `context_health` directly into `status.json` via `setStatus()`:

```typescript
setStatus({
  context_pct: contextUtilization?.context_pct,
  context_health: contextUtilization?.context_health,
});
```

This avoids event-log scanning for any consumer that only needs the latest value (e.g. `sp ps` reads `status.json` and displays a `ctx%` column without touching `events.jsonl`).

### Current tool staleness fix (April 2026)

Prior to April 2026, `current_tool` in `status.json` was stale because it was set on `tool_execution_start` but never cleared on `tool_execution_end`. `sp ps` read from `status_json` snapshot and showed stale values.

**Fix (unitAI-66xn, unitAI-yke7):**

1. **Supervisor clears on tool end**: `onToolEndCallback` sets `current_tool: undefined` via `setStatus()` on every `tool_execution_end` event.

```typescript
onToolEndCallback: (toolCallId, toolName, result, resultRaw, isError) => {
  setStatus({ current_tool: undefined });  // Clear stale tool
  // ... rest of callback
}
```

2. **ps.ts derives from event stream**: Instead of reading `status_json.current_tool`, `sp ps` queries `specialist_events` for the latest tool phase:

```typescript
// readLatestToolEvent() in observability-sqlite.ts
const latestTool = db.query(`
  SELECT json_extract(event_json, '$.phase') as phase
  FROM specialist_events
  WHERE job_id = ? AND type = 'tool'
  ORDER BY t DESC, id DESC LIMIT 1
`).get(jobId);
// If phase === 'end', current_tool is null; if 'start'/'update', it's active
```

This prevents false-positive "hung job" diagnoses where `sp ps` showed a stale tool (e.g., `gitnexus_context`) while the model was actively streaming text.

### Context window tracking

Supervisor tracks context utilization for long-running sessions:

```typescript
type ContextHealth = 'OK' | 'MONITOR' | 'WARN' | 'CRITICAL';

const MODEL_CONTEXT_WINDOWS: Array<{ matcher: (model: string) => boolean; windowTokens: number }> = [
  { matcher: (model) => model.includes('gemini-3.1-pro'), windowTokens: 1_000_000 },
  { matcher: (model) => model.includes('qwen3.5') || model.includes('glm-5'), windowTokens: 128_000 },
  { matcher: (model) => model.includes('claude'), windowTokens: 200_000 },
];

function getContextHealth(contextPct: number): ContextHealth {
  if (contextPct < 40) return 'OK';
  if (contextPct <= 65) return 'MONITOR';
  if (contextPct <= 80) return 'WARN';
  return 'CRITICAL';
}
```

Context utilization (`context_pct`) is captured on every `turn_summary` event, rounded/validated into status snapshots, and surfaced by CLI/status views for long-run monitoring and compaction risk detection.

**Per-turn text accumulation**:
- `turnTextAccumulator` collects streamed `text` deltas per assistant message
- Emits as `text_content` on `turn_summary` events (survives crashes via JSON persistence in `event_json`)
- Feed displays 80-char preview on `TURN+` lines
- Context health warnings shown at WARN (80%) and CRITICAL (95%) thresholds

### Stuck detection model

Stall/staleness is enforced at two layers:

#### Session-level liveness (`session.ts`)

- `_markActivity()` resets a timer on each parsed event
- if no activity for `stallTimeoutMs`, session throws `StallTimeoutError` and kills Pi

**Test-aware stall detection:** PiAgentSession extends the stall timeout window when bash tool commands match test runner patterns:

```typescript
const TEST_COMMAND_PATTERNS = [
  /(?:^|\s)(?:bun\s+--bun\s+)?vitest(?:\s|$)/i,
  /(?:^|\s)bun\s+test(?:\s|$)/i,
  /(?:^|\s)npm\s+test(?:\s|$)/i,
  // ... npm/pnpm/yarn test, jest, pytest
];
const TEST_COMMAND_STALL_TIMEOUT_MS = 300_000;  // 5 minutes
```

When a test command is detected:
- Effective timeout = `max(base_timeout, test_timeout)`
- Stall watchdog still fires for actual hangs
- Window restored after `tool_execution_end`

This prevents false-positive kills during vitest's tinypool worker initialization, which can exceed the standard 30-120s stall window.

#### Supervisor-level staleness (`supervisor.ts`)

Defaults (`STALL_DETECTION_DEFAULTS`):

| Threshold | Default | Action |
|-----------|---------|--------|
| `running_silence_warn_ms` | 60s | Emit `stale_warning` event |
| `running_silence_error_ms` | 300s | Transition to `error`, kill session |
| `waiting_stale_ms` | 1h | Emit `stale_warning` event |
| `waiting_auto_close_ms` | disabled | Graceful close first; forced termination fallback only if close hangs |
| `tool_duration_warn_ms` | 120s | Emit `stale_warning` with tool name |

Periodic checker (10s interval) monitors silence duration and tool execution time.

### Crash recovery

On `run()`, Supervisor scans job dirs for:

- `running`/`starting` jobs with dead PID → mark as `error`
- `running` jobs with prolonged silence → mark as `error`
- `waiting` jobs with prolonged silence → emit `stale_warning` event (preserve state)

### Liveness checks (`isJobDead`)

`Supervisor.isJobDead()` cross-checks PID + tmux session to determine if a job is dead:

```typescript
function isJobDead(status: SupervisorStatus): boolean {
  if (!status.pid) return true;  // no pid recorded = dead
  if (!isProcessAlive(status.pid)) return true;
  if (status.tmux_session && !isTmuxSessionAlive(status.tmux_session)) return true;
  return false;
}
```

`is_dead` is **computed at read time**, never persisted. This prevents stale state where:
- A dead job is marked alive because its `status.json` wasn't updated
- An alive job is marked dead because `is_dead` was persisted before the process recovered

**`isTmuxSessionAlive()`** (in `src/cli/tmux-utils.ts`) uses a 2000ms timeout and returns false on timeout or non-zero exit. This prevents hangs on tmux socket issues.

### Async dispose + pending-ops tracker

Supervisor's `dispose()` is now async to prevent "Cannot use a closed database" errors:

```typescript
async dispose(): Promise<void> {
  this._disposed = true;
  await this._pendingOpsTracker.flush();  // wait for in-flight SQLite ops
  await this.closeActiveSession();        // close active pi session
  this.sqliteClient?.close();
}
```

Root cause: async operations (stall detection interval, FIFO callbacks, Promise microtasks) fired **after** `dispose()` closed the SQLite connection. The retry loop in observability-sqlite.ts never helped because "Cannot use a closed database" wasn't retryable.

Solution: a pending-operations tracker that:
1. Wraps every SQLite operation in `_pendingOpsTracker.run(op)`
2. `dispose()` awaits the tracker's flush before closing the active session and SQLite client
3. CLI entry points (`run`, `status`, `resume`, `steer`, `stop`) await `supervisor.dispose()` before exit

**Active session lifecycle**: Supervisor tracks the active Pi session via `setActiveSession()`. During `dispose()`, `closeActiveSession()` attempts graceful `session.close()` first; on failure, it falls back to `session.kill()` to ensure the pi process and its MCP children are reaped before process exit.

### Job reuse concurrency guard

When `--job <id>` is passed, `resolveWorkingDirectory()` enforces a concurrency guard for MEDIUM/HIGH specialists:

```typescript
const BLOCKED_JOB_REUSE_STATUSES = new Set(['starting', 'running']);

if (editCapable && !args.forceJob && BLOCKED_JOB_REUSE_STATUSES.has(targetJobStatus)) {
  // Block: cannot enter an active worktree
  process.exit(1);
}
```

- `starting`/`running`: blocked for MEDIUM/HIGH (can corrupt files)
- `waiting`/`done`/`error`/`cancelled`: allowed for all
- Unknown status: blocked conservatively (unless `--force-job`)
- `--force-job`: bypass guard at caller's risk

READ_ONLY and LOW specialists bypass the guard entirely — they cannot corrupt files.

### Job lineage fields

When `--job <id>` is passed at run time, Supervisor persists two lineage fields in `status.json` (and mirrors them to SQLite):

```typescript
interface SupervisorStatus {
  reused_from_job_id?: string;      // the job whose workspace was borrowed via --job
  worktree_owner_job_id?: string;   // the transitive root owner of the worktree
}
```

### Stale-base guard (dispatch-time + merge-time)

Commit: `4c3eeb36`

Two-layer protection against parallel-chain divergence:

**Layer 1: Dispatch-time guard** (run.ts)

When `--worktree` provisions a new worktree for a bead belonging to an epic, the stale-base guard checks for sibling chains with unmerged substantive commits:

```typescript
function assertNoStaleBaseSiblings(beadId: string, forceStaleBase: boolean): void {
  const sqliteClient = createObservabilitySqliteClient();
  if (!sqliteClient) return;

  const epicId = resolveEpicIdForBead(sqliteClient, beadId);
  if (!epicId) return;

  const siblingChains = sqliteClient
    .listEpicChainsWithLatestJob(epicId)
    .filter((chain) => chain.chain_root_bead_id !== beadId && Boolean(chain.branch));

  // Check each sibling branch for substantive commits vs master
  const staleSiblings = detectSubstantiveCommits(siblingChains, baseBranch);

  if (staleSiblings.length > 0 && !forceStaleBase) {
    console.error(`Error: Epic '${epicId}' has sibling chains with unmerged changes.`);
    process.exit(1);
  }
}
```

Bypass with `--force-stale-base`.

**Layer 2: Merge-time rebase** (merge.ts)

Before merging each chain (via `sp merge` or `sp epic merge`), the branch is rebased onto master:

```typescript
export function rebaseBranchOntoMaster(branch: string, worktreePath: string): void {
  const baseBranch = resolveDefaultBranchName(worktreePath);
  const rebase = runCommand('git', ['rebase', baseBranch], worktreePath);
  if (rebase.status === 0) return;

  // On failure: abort rebase and report conflicting files
  tryAbortRebase(worktreePath);
  const conflicts = getConflictFiles(worktreePath);
  throw new Error(`Rebase failed for '${branch}' onto '${baseBranch}'...`);
}
```

Called in `runMergePlan()` before `mergeBranch()` for each chain.

**Why this matters**: Parallel chains branched from the same base diverge. Wave A's merge would appear as reversions in Wave B's diff. Rebase incorporates earlier waves' changes before publication.

### Bead ownership and lifecycle semantics

Ownership comes from Runner + Supervisor behavior:

- If `inputBeadId` is provided, that bead is orchestrator-owned (inherited)
- If no input bead and creation policy permits, Runner creates an owned bead

Supervisor post-run policy:

- always persists bead ID in status when available
- **Auto-append**: on every `run_complete` event, full specialist output is appended to the **input bead** (all specialists, not just READ_ONLY)
- **Auto-commit**: if `auto_commit` policy is set, substantive worktree changes are checkpointed at waiting/terminal transitions
- **Owned beads**: closed with full reason (COMPLETE/duration/model) on terminal status
- **Input beads**: auto-closed via `closeBeadIfInProgress()` on terminal status (DONE) — closes only if still `open` or `in_progress`, preserving existing reasons if already closed

Commit: `83b5986a` (unitAI-9truh)

This eliminates stale `in_progress` drift without overwriting closed beads' reasons.

### Auto-append bead notes

Commit: `428cd7f7`

`appendResultToInputBead()` is called on every `run_complete` event (per-turn for keep-alive, once for one-shot):

```typescript
const notes = formatBeadNotes({
  output: params.output,
  promptHash: params.promptHash,
  durationMs: params.durationMs,
  model: params.model,
  backend: params.backend,
  specialist: runOptions.name,
  jobId: id,
  status: params.status,  // 'waiting' | 'done' | 'error'
  timestamp: new Date().toISOString(),
});
```

Status-aware headers:
- `[WAITING — more output may follow]` — keep-alive awaiting resume
- `[DONE]` — terminal completion

`BeadsClient.updateBeadNotes()` now returns `{ ok: boolean; error?: string }` for error handling.

### Auto-commit checkpoint policy

Commit: `11e9b016`

Specialists with `execution.auto_commit` policy automatically checkpoint worktree changes:

| Policy | Trigger |
|--------|---------|
| `checkpoint_on_waiting` | Every turn entering `waiting` |
| `checkpoint_on_terminal` | Terminal completion (`done`/`error`) |

Implementation:

```typescript
function runAutoCommitCheckpoint(options: {
  autoCommitPolicy: 'never' | 'checkpoint_on_waiting' | 'checkpoint_on_terminal';
  target: 'waiting' | 'terminal';
  worktreePath: string | undefined;
  specialist: string;
  beadId: string | undefined;
  turnNumber: number;
}): { status: 'skipped' | 'success' | 'failed'; ... }
```

Noise filtering: `.xtrm/`, `.wolf/`, `.specialists/jobs/`, `.beads/` are ignored. `.specialists/jobs/` is legacy/operator-only.

Timeline events: `auto_commit_success`, `auto_commit_skipped`, `auto_commit_failed`.

Status fields: `auto_commit_count`, `last_auto_commit_sha`, `last_auto_commit_at_ms`.n
## 6) Timeline event model (`timeline-events.ts`)

`src/specialist/timeline-events.ts` defines the canonical feed v2 event vocabulary.

### Event layers

1. **Message construction layer** (nested under `message_update`):
   - `text_start`, `text_delta`, `text_end`
   - `thinking_start`, `thinking_delta`, `thinking_end`
   - `toolcall_start`, `toolcall_delta`, `toolcall_end`
   - `done` (message-level completion)
   - `error` (message-level failure)

2. **Tool execution layer** (top-level):
   - `tool_execution_start`
   - `tool_execution_update` (optional, streaming)
   - `tool_execution_end`

3. **Tool result layer** (message role: `toolResult`):
   - `message_start` (role: `toolResult`)
   - `message_end`

4. **Turn boundary layer**:
   - `turn_start`
   - `turn_end` (includes assistant message + `toolResults[]`)

5. **Run boundary layer**:
   - `agent_start`
   - `agent_end` (run completion, contains all `messages[]`)

### Canonical timeline events (persisted to `events.jsonl`)

| Event | When emitted | Key fields |
|-------|-------------|------------|
| `run_start` | Job begins | `specialist`, `bead_id`, **`startup_snapshot`** |

**`startup_snapshot` fields** (on `run_start`):

| Field | Source |
|-------|--------|
| `job_id` | Supervisor run ID |
| `specialist_name` | `runOptions.name` |
| `bead_id` | `runOptions.inputBeadId` |
| `reused_from_job_id` | `runOptions.reusedFromJobId` |
| `worktree_owner_job_id` | `runOptions.worktreeOwnerJobId` |
| `chain_id` / `chain_root_job_id` | Derived from worktree owner or self |
| `chain_root_bead_id` | `variables.chain_root_bead_id` |
| `worktree_path` | `runOptions.workingDirectory` |
| `branch` | `resolveCurrentBranch()` |
| `variables_keys` | `Object.keys(runOptions.variables)` |
| `reviewed_job_id_present` | Bool — `reviewed_job_id` in variables |
| `reused_worktree_awareness_present` | Bool — `reused_worktree_awareness` in variables |
| `bead_context_present` | Bool — `bead_context` in variables |
| `memory_injection` | Token counts from `meta` event (backfilled post-emission) |
| `skills` | `{ count, activated[] }` from `activated_skills` variable |

This snapshot is persisted both in `status.json.startup_context` and in the `run_start` timeline event. `sp result` merges both sources + `meta.memory_injection` into a unified startup context block.
| `meta` | Model/backend known | `model`, `backend`, `memory_injection` |
| `thinking` | Reasoning detected | `char_count` |
| `tool` (start/update/end) | Tool execution | `tool`, `phase`, `tool_call_id`, `args`, `result_summary`, `result_raw`, `is_error` |
| `text` | Text output detected | `char_count` |
| `message` (start/end) | Message boundary | `phase`, `role` |
| `turn` (start/end) | Turn boundary | `phase` |
| `token_usage` | Token metrics from RPC | `token_usage`, `source` |
| `finish_reason` | Finish reason from RPC | `finish_reason`, `source` |
| `turn_summary` | Turn completion | `turn_index`, `token_usage`, `finish_reason`, **`context_pct`**, **`text_content`** |
| `compaction` (start/end) | Context compaction | `phase` |
| `retry` | Auto-retry event | `phase` |
| `stale_warning` | Stuck detection | `reason`, `silence_ms`, `threshold_ms`, `tool` |
| `run_complete` | **THE canonical completion** | `status`, `elapsed_s`, `model`, `backend`, `bead_id`, `error`, `output`, `output_type`, `metrics`, `gitnexus_summary` |

### Completion semantic

> ⚠️ **BREAKING CHANGE:** `run_complete` is now emitted **per turn** for keep-alive sessions, not once per job lifecycle. Consumers that previously treated the first `run_complete` as terminal must now gate completion on terminal job status (`done`/`error`/`cancelled`) for keep-alive flows.

For feed v2, `run_complete` is the canonical per-turn completion event. In single-turn runs this is emitted once; in keep-alive runs it is emitted after each completed turn.
This resolves the historical ambiguity between:

- callback-level `done` (synthetic, from `agent_end`)
- persisted `agent_end` (added after runner returns)

Each `run_complete` event contains:
- final status (`COMPLETE` | `ERROR` | `CANCELLED`)
- elapsed time
- model/backend
- output type (from specialist execution config: codegen/analysis/review/synthesis/orchestration/workflow/research/custom)
- error message if applicable
- aggregated metrics (`token_usage`, `finish_reason`, `tool_calls`, `exit_reason`)
- GitNexus summary if any `gitnexus_*` tools were invoked

Legacy completion events (`done`, `agent_end`) are parse-compatible for old history but ignored on the write path.

### Bun SQLite loading model

`ObservabilitySqliteClient` is Bun-aware and lazy-loaded:

- `bun:sqlite` is required dynamically (`require('bun:sqlite')`) only on first probe.
- Under Node/vitest (where `bun:sqlite` is unavailable), the probe returns `null` and runtime continues file-only.
- If SQLite exists, schema init (`initSchema`) runs first, then a persistent client is opened with WAL + busy timeout.

This keeps tests/tooling portable while enabling SQLite acceleration in Bun environments.

### `mapCallbackEventToTimelineEvent()` — mapping table

| Callback event | Timeline event | Notes |
|---------------|----------------|-------|
| `thinking` | `thinking` | — |
| `tool_execution_start` | `tool` (start) | Includes `args`, `started_at` |
| `tool_execution_update` | `tool` (update) | — |
| `tool_execution_end` | `tool` (end) | Includes `result_summary`, `result_raw`, `is_error` |
| `text` | `text` | Presence only, not deltas |
| `message_start_assistant` | `message` (start, assistant) | — |
| `message_end_assistant` | `message` (end, assistant) | — |
| `message_start_tool_result` | `message` (start, toolResult) | — |
| `message_end_tool_result` | `message` (end, toolResult) | — |
| `turn_start` | `turn` (start) | — |
| `turn_end` | `turn` (end) | — |
| `auto_compaction_start` | `compaction` (start) | — |
| `auto_compaction_end` | `compaction` (end) | — |
| `auto_retry` | `retry` (end) | — |
| `memory_injection` | `meta` (model=`memory_injection`) | Token accounting for context budget analysis |
| `agent_end`, `done`, `message_done` | **IGNORED** | Supervisor emits `run_complete` instead |

## 7) Pi session extensions for tool interception

`PiAgentSession` can generate and inject Pi extensions at spawn time for policy enforcement. The primary use is **worktree write-boundary enforcement** — preventing specialists in isolated worktrees from writing outside their boundary.

### Extension generation pattern

When `worktreeBoundary` is provided in session options:

1. `getWorktreeBoundaryExtensionPath(boundary)` generates a temporary extension file
2. Extension lives in `$TMPDIR/specialists-pi-extensions/worktree-boundary-<hash>.mjs`
3. Hash is derived from SHA256 of the resolved boundary path (first 16 chars)
4. Extension is passed to Pi via `-e <path>` argument

### Extension behavior

The generated extension hooks `tool_call` events for write-side tools (`edit`, `write`, `multiEdit`, `notebookEdit`):

```javascript
export default function(pi) {
  pi.on('tool_call', (event) => {
    if (!WRITE_TOOLS.has(event.toolName)) return undefined;

    const rawPath = extractPathFromInput(event.input);
    if (!rawPath || !isAbsolute(rawPath)) return undefined;

    if (isPathWithinBoundary(rawPath, worktreeBoundary)) return undefined;

    return { block: true, reason: `Path '${rawPath}' is outside worktree boundary...` };  
  });
}
```

- **Relative paths**: always allowed (resolve within worktree cwd)
- **Absolute paths inside boundary**: allowed
- **Absolute paths outside boundary**: blocked with error message

### Tmp-fs fallback behavior

If the extension directory (`$TMPDIR/specialists-pi-extensions/`) cannot be created or the extension file cannot be written:

1. Logs warning to stderr: `[session] Failed to write worktree boundary extension: <error>`
2. Returns `null` from `getWorktreeBoundaryExtensionPath()`
3. Session proceeds **without** the boundary extension (unprotected mode)
4. Specialist can still write anywhere — relies on orchestrator vigilance

This fail-soft behavior ensures sessions don't crash on tmpdir issues (e.g. read-only filesystem, permissions) but surfaces the degradation clearly via stderr.

### Boundary propagation flow

```
Supervisor.run()
  ↓ detects workingDirectory (worktree path)
  ↓ adds worktreeBoundary: workingDirectory to runOptions
Runner.startSession()
  ↓ passes worktreeBoundary to PiSessionOptions
PiAgentSession.start()
  ↓ generates extension via getWorktreeBoundaryExtensionPath()
  ↓ passes -e <ext-path> to Pi spawn args
  ↓ sets WORKTREE_BOUNDARY env var for extension to read
Pi extension (inside pi process)
  ↓ hooks tool_call events
  ↓ blocks write tools with out-of-bounds paths
```

## 8) How Session, Timeline, and Supervisor connect

End-to-end flow:

1. Supervisor allocates job ID and writes initial `status.json`
2. Supervisor starts Runner; Runner starts `PiAgentSession`
3. Session parses Pi RPC stream and emits normalized callbacks
4. Supervisor maps callbacks through `mapCallbackEventToTimelineEvent(...)`
5. Supervisor appends normalized timeline records to `events.jsonl` (and SQLite when available)
6. Supervisor updates `status.json` on every lifecycle change
7. On each completed turn, Supervisor writes `result.txt` and emits `run_complete`

Result: **Pi provides protocol events; Session adapts transport; Supervisor persists lifecycle truth.**

## 9) Edit gate bead-claim KV pattern

The beads edit gate hooks (`beads-edit-gate`) check two KV keys before allowing file edits.

### Primary path: session-scoped claim

```bash
bd kv set "claimed:<session-id>" "<bead-id>"
```

Set by Claude Code hooks when an agent claims a bead via `bd update <id> --claim`. Session-bound, cleared on session end.

### Fallback path: bead-claim

```bash
bd kv set "bead-claim:<bead-id>" "active"
```

Set by Runner **before spawning a specialist** when `--bead <id>` is provided in `src/cli/run.ts`:

```typescript
// Before specialist spawn
if (args.beadId && workingDirectory) {
  execSync(`bd kv set "bead-claim:${args.beadId}" "active"`, { cwd: workingDirectory });
}

// After run completes (success or error)
if (args.beadId && workingDirectory) {
  execSync(`bd kv clear "bead-claim:${args.beadId}"`, { cwd: workingDirectory });
}
```

### Why this matters

Worktree specialists run in subprocesses without session context. The bead-claim pattern provides an edit gate entry that:
1. Is independent of Claude Code session IDs
2. Is scoped to the specific bead being worked on
3. Is automatically cleaned up when the run completes
4. Enables MEDIUM/HIGH specialists to edit files in worktrees without blocking

### Edit gate check order

```bash
# Hook checks in order:
1. claimed:<session-id>  → session claim (Claude Code)
2. bead-claim:<bead-id>  → bead-scoped claim (specialist runner)
```

If neither key exists, the edit is blocked.

---

## 10) Epic lifecycle model (`epic-lifecycle.ts`, `epic-readiness.ts`)

Epic lifecycle is **derived live** from chain readiness, not driven by an operator-managed state machine. Only two states are persisted as terminal markers; everything else is recomputed each read.

### Derived state model

```
                           ┌── merged (persisted, terminal)
                           │
chains in flight ──── derive ──── blocked / failed / merge_ready
                           │
                           └── abandoned (persisted, terminal)
```

| State | Persisted? | Meaning | Per-chain merge | Batch merge |
|-------|:----------:|---------|:----------:|:----------:|
| `blocked` | No (derived) | Some chain pending or has no reviewer verdict | — | ✗ |
| `failed` | Soft marker only | A chain reviewer returned PARTIAL/FAIL with no fix-loop, OR a previous publish attempt failed transiently | per-chain on PASS chains | ✗ until cleared |
| `merge_ready` | No (derived) | All chains pass and no active jobs | ✓ | ✓ |
| `merged` | Yes (terminal) | Publication complete | — | — |
| `abandoned` | Yes (terminal) | Operator-cancelled via `sp epic abandon` | — | — |

### Recovery rule

`validateEpicMergeReadiness` (`src/cli/epic.ts`) refuses merge **only** for the two truly-terminal states:

```typescript
if (epicState === 'merged' || epicState === 'abandoned') throw 'No further merges allowed';
```

A persisted `failed` row from a prior transient publication failure (e.g. rebase conflict, dirty worktree) is treated as legacy/non-terminal — readiness is recomputed live, so the next `sp epic merge` retries fresh once the operator clears the conflict source.

### SQLite persistence

`epic_runs` table:
- `epic_id` — bead epic ID
- `status` — `merged` | `abandoned` for terminal records; soft `failed` markers may exist from prior transient failures and are recoverable
- `status_json` — audit trail (transitions, reasons)
- `updated_at_ms` — last write timestamp

### Per-chain merge

`sp merge <chain-root>` is allowed for any PASS chain regardless of sibling-epic state. The original "refuse if epic unresolved" inverted gate was removed in the chain-lifecycle redesign — chains publish individually whenever their reviewer returns PASS and their executor is finalized. Use `sp epic merge` only when batching all epic chains together (atomic, topological order, tsc gate per merge).

## 11) Chain identity model (`chain-identity.ts`)

Chain identity distinguishes worktree lineages from standalone prep jobs.

### Chain kinds

```typescript
export const CHAIN_KINDS = ['chain', 'prep'] as const;
export type ChainKind = (typeof CHAIN_KINDS)[number];
```

| Kind | Definition | Has worktree? |
|------|------------|:-------------:|
| `chain` | Worktree lineage seeded by edit-capable specialist | Yes |
| `prep` | Standalone job without worktree lineage | No |

### Identity derivation

`derivePersistedChainIdentity()` computes `chain_kind` from SupervisorStatus:

```typescript
// Deterministic fallback:
// - missing chain markers + no worktree lineage => prep
// - any lineage marker/worktree => chain rooted at owner/id
const isChainJob = Boolean(
  status.worktree_path || status.worktree_owner_job_id || status.chain_id || status.chain_root_job_id
);
```

Chain identity fields:
- `chain_kind` — 'chain' or 'prep'
- `chain_id` — unique identifier (job ID for prep, owner job ID for chain)
- `chain_root_job_id` — root job that owns the worktree
- `chain_root_bead_id` — bead that seeded the chain

### Chain membership tracking

`epic_chain_membership` table links chains to epics:
- `chain_id` — unique chain identifier
- `epic_id` — parent epic ID
- `chain_root_bead_id` — optional explicit bead linkage
- `chain_root_job_id` — optional job linkage

## 12) Epic readiness evaluation (`epic-readiness.ts`)

Epic readiness determines merge eligibility from chain/prep job states.

### Readiness states

| State | Condition |
|-------|----------|
| `unresolved` | Open epic with active work |
| `resolving` | Resolving epic with active work or blockers |
| `merge_ready` | Prep terminal + all chains PASS |
| `blocked` | Non-terminal, missing reviewer/fix-loop closure |
| `failed` | Prep error or chain review failure |
| `merged` / `abandoned` | Terminal passthrough |

### Chain readiness per chain

| State | Condition |
|-------|----------|
| `pending` | Active jobs (`starting|running|waiting`) |
| `blocked` | No reviewer verdict or fix-loop incomplete |
| `failed` | Latest reviewer verdict is PARTIAL/FAIL |
| `pass` | Latest reviewer verdict is PASS |

### Prep semantics

Prep jobs (`chain_kind !== 'chain'`) affect readiness:
- Running prep → blocks merge
- Errored prep → fails epic
- Done prep → satisfies prep completion

### Auto-transition logic

`syncEpicStateFromReadiness()` persists state transitions automatically:
- `open → resolving` when unresolved work exists
- `resolving → merge_ready` when all conditions met
- `merge_ready → resolving` if blockers reappear
- `resolving|merge_ready → failed` on fatal failure

See `docs/epic-readiness.md` for full evaluator specification.

## 13) `sp end` — Epic-aware session close (`end.ts`)

`sp end` integrates with epic lifecycle for publication:

### Synopsis

```bash
specialists end [--bead <id>|--epic <id>] [--pr] [--rebuild]
```

### Flags

- `--epic <id>`: Redirect to `sp epic merge <id>` (canonical publication path)
- `--pr`: Create pull request instead of direct merge
- `--rebuild`: Run build after merge

### Behavior

1. **Epic detection**: If current chain belongs to unresolved epic, redirects to `sp epic merge`
2. **Chain guard**: `checkEpicUnresolvedGuard()` checks epic membership
3. **Auto-redirect**: Prints redirect message, delegates to epic merge handler

Example:
```bash
sp end --epic unitAI-3f7b --pr
# → redirects to: sp epic merge unitAI-3f7b --pr
```

### Workspace inference

If no `--bead` or `--epic` provided, `detectCurrentBeadIdFromWorkspace()`:
1. Queries SQLite for job with matching `worktree_path` and `chain_root_bead_id`
2. Falls back to branch name parsing (`feature/unitAI-xxx-...`)

## 14) Canonical references

| Component | Path | Responsibility |
|-----------|------|----------------|
| Protocol | `pi/rpc/` | JSONL framing, RPC types, client semantics |
| Protocol boundary docs | `docs/pi-rpc-boundary.md` | Ownership boundary between pi RPC protocol and Specialists adaptation |
| RPC adapter | `src/pi/session.ts` | Spawns Pi, parses NDJSON, correlates requests |
| Job registry | `src/specialist/job-root.ts` | Git-common-root-anchored jobs dir |
| Worktree isolation | `src/specialist/worktree.ts` | Provisioning, branch naming, reuse detection |
| Durable lifecycle | `src/specialist/supervisor.ts` | Status, events, results, GitNexus tracking, FIFO steering, lineage fields, context denorm |
| Timeline schema | `src/specialist/timeline-events.ts` | Feed v2 event vocabulary, mapping, constructors |
| Process snapshot CLI | `src/cli/ps.ts` | Job tree view, context%, bead titles, urgency sort, JSON output |
| Worktree docs | `docs/worktrees.md` | Operator-facing worktree isolation reference |
