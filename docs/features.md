---
title: Feature Guides
scope: runtime-features
category: guide
version: 2.5.0
updated: 2026-06-23
synced_at: bf6baf7a
description: Practical guides for structured output, job observation, bead-linked runs, keep-alive resume, worktree isolation, stuck detection, waiting state observability, auto gitnexus sync, specialist authoring, config presets, JSON-first configuration, context denormalization, and job lineage tracking.
source_of_truth_for:
  - "src/cli/run.ts"
  - "src/cli/feed.ts"
  - "src/cli/result.ts"
  - "src/cli/resume.ts"
  - "src/specialist/supervisor.ts"
  - "src/specialist/schema.ts"
  - "src/specialist/job-root.ts"
  - "src/specialist/worktree.ts"
  - "src/specialist/worktree-gc.ts"
  - "src/cli/edit.ts"
  - "src/specialist/loader.ts"
  - "src/cli/ps.ts"
  - "src/cli/epic.ts"
  - "src/cli/end.ts"
  - "src/cli/merge.ts"
  - "src/specialist/epic-lifecycle.ts"
  - "src/specialist/chain-identity.ts"
---

# Feature Guides

> `sp` is an alias for `specialists`.

## 1) Structured run output modes (`human`, `--json`, `--raw`)

`specialists run` supports three foreground output modes.

### Human mode (default)

```bash
sp run executor --prompt "Investigate failing tests"
```

- Shows formatted timeline events (debounced to reduce noise)
- Prints final assistant output when `run_complete` arrives
- Prints job footer to stderr with `job`, optional `bead`, elapsed time, model/backend

### JSON mode (`--json`)

```bash
sp run executor --prompt "Investigate failing tests" --json
```

- Streams NDJSON, one event per line
- Each event envelope includes `jobId`, `specialist`, optional `beadId`, plus timeline event fields
- Model/backend banner still prints to stderr

### Raw mode (`--raw`)

```bash
sp run executor --prompt "Investigate failing tests" --raw
```

- Legacy stream of raw progress deltas (`onProgress`) to stdout
- Useful for backward compatibility with older parsers
- Does not tail `events.jsonl` formatting

### Mode selection rules

- Default is `human`
- `--json` switches to structured event stream
- `--raw` switches to legacy progress stream
- If both are passed, the last flag wins

---

## 2) Job observation: `feed`, `ps`, `result`

All observation reads DB-backed runtime state first. Legacy/operator mirrors under:

```text
Legacy fallback artifacts (`observability.db` is primary runtime store):
.specialists/jobs/<job-id>/
  status.json
  events.jsonl
  result.txt
```

### SQLite persistence (schema v4)

When SQLite is available, Supervisor uses it as the primary storage backend. File-based fallback is legacy/operator-only:

- **`specialist_jobs` table**: status, bead_id, node_id, worktree_path, branch, last_output, elapsed_ms
- **`specialist_events` table**: append-only timeline with event_json (JSON-first design)
- **Node tables** (schema v4): `node_runs`, `node_members`, `node_events`, `node_memory` for orchestrator tracking
- **Dual-write**: atomic transactions at job start/completion; mid-run writes are standalone for resilience
- **Backward compatible**: file-based storage remains available only for recovery/debug tooling when SQLite is unavailable

### `feed` (timeline-first)

```bash
sp feed <job-id>
sp feed <job-id> --follow
sp feed -f --forever
sp feed --json --since 5m --limit 200
```

- Best for timeline/event visibility
- Snapshot mode: replay matching events
- Follow mode (`-f`): polls and appends new events in chronological order
- JSON mode outputs NDJSON envelopes with job metadata + event payload
- **Waiting state**: when a keep-alive job enters `waiting` status, feed displays a magenta `WAIT` banner with resume instructions
- **Text preview**: `TURN+` lines show 80-char preview of accumulated text content
- **Context warnings**: feed displays context utilization warnings at WARN/CRITICAL thresholds
- **Startup context lines**: on `run_start` events with `startup_snapshot`, emits dimmed `↳ startup` summary (job, specialist, bead, worktree, branch, vars, skills); on `meta` events with `memory_injection`, emits `↳ memory` token accounting line (static, dynamic, gitnexus, total)

### `result` (final text)

```bash
sp result <job-id>
sp result <job-id> --wait --timeout 120
```

- Prints `result.txt`
- `--wait` polls until `done`/`error`
- `--timeout` applies only with `--wait`
- **Waiting state**: when status is `waiting`, result prints a footer with resume instructions
- **SQLite-backed**: reads from `specialist_jobs.last_output` column when available
- **Startup context block**: derives startup snapshot from `status.json.startup_context` merged with `run_start` event + `meta` memory_injection. Prepends `--- startup context ---` block in human mode; adds `startup_context` field in `--json` mode

Use `result` when you want final plain text; use `feed` when you want event history and incremental state.

### Current tool staleness fix (April 2026)

`sp ps` exposes `current_tool` to show which tool a job is executing. Prior to April 2026, this field was stale because:

1. `current_tool` was set on `tool_execution_start` but never cleared on `tool_execution_end`
2. `sp ps` read from `status.json` snapshot, not the live event stream

**Fix (unitAI-66xn, unitAI-yke7):**

- **Read side**: `sp ps` now derives `current_tool` from `specialist_events` table, querying the latest tool event (start/update/end) instead of trusting `status.json`
- **Write side**: Supervisor clears `current_tool: undefined` in `onToolEndCallback` on every `tool_execution_end`

This prevents false-positive "hung job" diagnoses where `sp ps` showed a stale tool (e.g., `gitnexus_context`) while the model was actively streaming text.

---

## 2a) Console TUI (`sp console`)

`sp console` provides an interactive TUI for monitoring and controlling jobs across multiple repos.

### ALL view (multi-repo overview)

The ALL view shows active jobs from all configured repos in a single scrollable list.

**Navigation:**
- `↑↓` or `j/k` — move cursor through selectable job rows (skips headers/spacers)
- `0` — reset cursor to top and switch to ALL view

**Actions (cursor on job row):**
- `↵` (Enter) — open feed for selected job
- `r` — open result for selected job
- `i` — inspect job details
- `b` — open bead view for the job's input bead
- `d` — open diff view for the job's worktree changes

**Repo selection:**
- `Tab` — cycle to next repo tab
- `1-9` — jump to repo by index

**Other keys:**
- `q` — quit console
- `g` — open global config view (from ps view)
- `R` — open repo config view (from ps view)
- `x` — stop selected job (from ps/all view)

The ALL view auto-scrolls to keep the cursor visible and auto-advances off non-selectable rows (headers/spacers) on first render.

---

Use an existing bead as the run input source:

```bash
sp run executor --bead unitAI-123
```

Behavior:

- Reads bead content via `bd show --json`
- Builds full run prompt from bead context (`buildBeadContext(...)`)
- Injects variables:
  - `$bead_context`
  - `$bead_id`
- Adds `bead_id` to status and timeline (`run_start`, status footer)
- **Schema v2**: `bead_id` persisted as dedicated column in `specialist_jobs` table (backfilled from status_json)

### Dependency context injection

By default, `--bead` injects completed blockers at depth 1.

```bash
sp run executor --bead unitAI-123 --context-depth 2
sp run executor --bead unitAI-123 --context-depth 0  # disable blocker injection
```

### Tracking control

```bash
sp run executor --bead unitAI-123 --no-beads
```

- `--no-beads` disables bead tracking/updates
- Bead reading still works (run input still comes from `--bead`)

### Prompt source exclusivity

`--prompt` and `--bead` are mutually exclusive.

---

## 4) Keep-alive + resume (`--keep-alive`, `--no-keep-alive`, `resume`)

Keep a session alive for multi-turn flows:

```bash
sp run executor --prompt "Analyze this bug" --keep-alive
```

Interactive specialists can enable this by default in YAML:

```yaml
specialist:
  execution:
    interactive: true
```

Default behavior and precedence:

1. `--no-keep-alive` / `no_keep_alive` forces one-shot mode
2. `--keep-alive` / `keep_alive` forces keep-alive
3. Otherwise, runner uses merged `execution.interactive` (package spec → `~/.config/specialists/user.json` → repo override)
4. If unset, default is one-shot (`false`)

Supervisor behavior in keep-alive mode:

- Creates FIFO: `.specialists/jobs/<job-id>/steer.pipe`
- On first turn completion, job status becomes `waiting`
- Emits `status_change` timeline event with `status: "waiting"` and `previous_status: "running"`
- Session stays alive with full conversation history retained

Resume with a next-turn task:

```bash
sp resume <job-id> "Now implement the fix and add tests"
```

Rules:

- `resume` is valid only when status is `waiting`
- If status is `running`, use `steer`/`steer_specialist` (mid-turn guidance)
- `resume` writes `{type:"resume", task:"..."}` to FIFO
- After resume turn finishes, status returns to `waiting` until closed

### Waiting state observability

When a keep-alive job enters the `waiting` state, the system provides multiple observation signals:

**Timeline event** (`events.jsonl`):
```json
{"t": 1743883200000, "type": "status_change", "status": "waiting", "previous_status": "running"}
```

**Feed output** (`sp feed <job-id>`):
```
WAIT executor (49adda) is waiting for input. Use: specialists resume 49adda "..."
```
- Displayed in **magenta** to distinguish from running/done states
- Shows specialist name, job ID, and exact resume command

**Status output** (`sp status --job <job-id>`):
```
  status       waiting
  action       specialists resume 49adda "..."
```
- Status field rendered in magenta
- `action` row shows the resume command to use

**Result footer** (`sp result <job-id>`):
```
--- Session is waiting for your input. Use: specialists resume 49adda "..." ---
```
- Appended to result output when status is `waiting`
- Printed to stderr in dimmed text

Use `--no-keep-alive` for a one-off run even when the specialist is interactive:

```bash
sp run executor --prompt "Quick check only" --no-keep-alive
```

Observation loop for keep-alive runs:

```bash
sp feed <job-id> --follow
```

---

## 5) --job concurrency guard

When `--job <id>` reuses an existing job's worktree, MEDIUM/HIGH permission specialists are blocked from entering while the target job is still `starting` or `running`. This prevents concurrent file corruption.

### Blocked statuses

| Status | Blocked for MEDIUM/HIGH | Allowed for READ_ONLY/LOW |
|--------|:-----------------------:|:------------------------:|
| `starting` | ✗ Blocked | ✓ Allowed |
| `running` | ✗ Blocked | ✓ Allowed |
| `waiting` | ✓ Allowed | ✓ Allowed |
| `done` | ✓ Allowed | ✓ Allowed |
| `error` | ✓ Allowed | ✓ Allowed |
| `cancelled` | ✓ Allowed | ✓ Allowed |
| Unknown | ✗ Blocked (conservative) | ✓ Allowed |

### Bypass with --force-job

```bash
sp run executor --job a1b2c3 --force-job --bead fix-123
```

Use `--force-job` when:
- The target job's status is stale/unknown but the worktree is known to be safe
- Emergency fix entry when the original job is stalled but not terminal
- Caller explicitly accepts concurrent write risk

READ_ONLY and LOW specialists bypass the guard entirely — they cannot corrupt files.

---

## 6) Liveness checks for `sp list --live`

The `--live` mode in `sp list` filters out dead jobs by default. A job is **dead** when:
- Its PID no longer exists (`ps -p <pid>` fails)
- Its tmux session is gone (`tmux has-session -t <name>` fails or times out)

`is_dead` is a **computed field**, never persisted to `status.json`. This avoids stale state where a dead job is marked alive or vice versa.

### `--show-dead` flag

```bash
sp list --live --show-dead
```

Shows dead jobs with a `dead` status indicator. Useful for debugging sessions that crashed or were killed externally.

---

## 7) Job status lifecycle

Supervisor tracks job status through a state machine:

```
starting → running → waiting → (resume) → running → ... → done/error/cancelled
         ↘ error
```

**Terminal statuses**:
- `done` — job completed normally with `run_complete` event
- `error` — job failed (exception, timeout, crash)
- `cancelled` — job stopped intentionally without completion evidence

**`cancelled` status**:

Introduced to distinguish intentional stops from failures:
- Set by `sp stop` when job has no `run_complete` event
- Preserved in SQLite + legacy/operator file mirror `status.json`
- Rendered in `sp ps` and `sp status` (gray color)

---

## 8) Stuck detection configuration

There are two complementary mechanisms.

### A) Session-level stall timeout (`execution.stall_timeout_ms`)

Defined in specialist YAML under `execution`.

```yaml
specialist:
  execution:
    stall_timeout_ms: 120000
```

- Passed to `PiAgentSession` as `stallTimeoutMs`
- If no RPC/protocol activity occurs within this window, the session is killed with `StallTimeoutError`
- Set `0`/unset to disable this watchdog

### B) Supervisor-level stale detection (`stall_detection`)

Defined at top-level specialist config:

```yaml
specialist:
  stall_detection:
    running_silence_warn_ms: 60000
    running_silence_error_ms: 300000
    waiting_stale_ms: 3600000
    waiting_auto_close_ms: 0
    tool_duration_warn_ms: 120000
```

Defaults (if omitted):

- `running_silence_warn_ms`: 60s
- `running_silence_error_ms`: 300s
- `waiting_stale_ms`: 1h (3600s) — waiting jobs past this threshold emit `stale_warning` events
- `waiting_auto_close_ms`: disabled by default (`0` or `null`) — when set to a positive number, stale waiting jobs attempt graceful close first, then forced termination fallback if graceful close times out
- `tool_duration_warn_ms`: 120s

Supervisor outcomes:

- Emits `stale_warning` timeline events
- Can promote long-running silence to `status=error`
- Dead waiting jobs with no `run_complete` evidence transition to `error` (non-node only)
- Dead waiting jobs with `run_complete` evidence reconcile to `done`

---

## 9) Test-aware stall detection

PiAgentSession extends the stall timeout window when a bash tool command matches a test runner pattern:

- `vitest` (including `bun --bun vitest`)
- `bun test`
- `npm/pnpm/yarn test`
- `jest`
- `pytest`

During detected test commands, the effective timeout is `max(base_timeout, test_timeout)` where `test_timeout` defaults to 300s. This prevents the stall watchdog from killing test runners during tinypool worker initialization, which can take longer than the standard 30-120s stall window.

### Extended window lifecycle

1. `tool_execution_start` detected → pattern match on command string
2. If test pattern matched → extend stall timeout for this tool call
3. `tool_execution_end` → restore base stall timeout
4. Stall watchdog still fires for actual hangs — no upper-bound removal

### Known limitations

- Pattern-based detection may miss custom test wrappers
- Process-group isolation not implemented (deeper refactor needed)

---

## 10) Specialist authoring example (executor-style)

Example with structured-friendly settings and stall controls (JSON format):

```json
{
  "specialist": {
    "metadata": {
      "name": "executor",
      "version": "1.0.0",
      "description": "General-purpose execution specialist",
      "category": "codegen"
    },
    "execution": {
      "model": "openai-codex/gpt-5.3-codex",
      "fallback_model": "google-gemini-cli/gemini-3.1-pro-preview",
      "timeout_ms": 0,
      "stall_timeout_ms": 120000,
      "response_format": "text",
      "permission_required": "HIGH",
      "thinking_level": "medium"
    },
    "prompt": {
      "system": "You are a production implementation specialist.",
      "task_template": "$prompt\n\nWorking directory: $cwd"
    },
    "stall_detection": {
      "running_silence_warn_ms": 60000,
      "running_silence_error_ms": 300000,
      "waiting_stale_ms": 3600000,
      "tool_duration_warn_ms": 120000
    }
  }
}
```

Authoring notes:

- **JSON-first**: Specialist configs use `.specialist.json` format (YAML deprecated but supported)
- `response_format` controls requested format (`text|json|markdown`) at specialist config level
- `stall_timeout_ms` handles session protocol silence
- `stall_detection` handles Supervisor state/timeline warnings and error promotion
- `permission_required` controls post-job GitNexus reindex (see below)
- For bead-driven specialists, rely on `$bead_context` / `$bead_id` in templates
- Bare specialists: see [bare-specialists.md](bare-specialists.md)
- Additional fields: `author`, `tags`, `created`, `output_type`, `max_retries`, `beads_write_notes`, `communication`


---

## 11) Configuration presets (`--preset`)

Presets provide one-shot configuration profiles for quick adaptation to different task types without editing specialist configs.

### Available presets

Presets are defined in `config/presets.json`:

| Preset | Model | Thinking | Stall Timeout | Use Case |
|--------|-------|----------|---------------|----------|
| `cheap` | see `sp edit --list-presets` | `off` | 60s | Exploration, simple tasks, quick lookups |
| `medium` | see `sp edit --list-presets` | `low` | 120s | Balanced cost/quality — default for most tasks |
| `power` | see `sp edit --list-presets` | `high` | 300s | Complex implementation, deep reasoning |

Preset model values are operational defaults and may change between releases; inspect the live package with `sp edit --list-presets` or `config/presets.json`.

### Usage

Apply a preset to a specialist config:

```bash
sp edit executor --preset cheap
sp edit executor --preset medium
sp edit executor --preset power
```

This mutates the specialist's JSON config in place, updating:
- `specialist.execution.model`
- `specialist.execution.thinking_level`
- `specialist.execution.stall_timeout_ms`

### When to use

- **cheap**: Quick exploration, documentation lookups, simple refactors
- **medium**: Standard implementation work, bug fixes, feature development
- **power**: Complex architecture changes, multi-file refactors, difficult debugging

---

## 12) Configuration format: JSON-first with YAML fallback

Specialist configurations migrated from YAML to JSON in v2.1.15+.

### File locations

Specialist configs and global overrides include:
- `config/specialists/<name>.specialist.json` (canonical)
- `.specialists/user/<name>.specialist.json` (repo user override fork, full spec)
- `~/.config/specialists/user.json` (global user override layer, sparse fields only, machine scope)

### Loading precedence (KAN-90)

Override merge is strict 3-layer policy:

1. **Package canonical** specialist from `config/specialists/<name>.specialist.json`
2. **Global user** sparse overrides from `~/.config/specialists/user.json`
3. **Repo user spec** from `.specialists/user/<name>.specialist.json`

Only allowed fields flow through global/repo override layers. Package canonical defines baseline behavior, then machine and repo layers may override safe fields (or append `skills.paths` values).

Blocked fields are still guarded:
- `execution.permission_required`
- `execution.auto_commit`
- `prompt.system`
- `prompt.output_schema`
- `skills.scripts`
- `mandatory_rules`
- `capabilities`

Allowed override fields include:
- `execution.model`, `execution.fallback_model`, `execution.timeout_ms`, `execution.stall_timeout_ms`, `execution.interactive`, `execution.thinking_level`, `execution.max_retries`, `execution.response_format`
- `execution.extensions` (`gitnexus: false` remains legacy opt-out; arbitrary trusted source-string keys are allowed; `execution.extensions.serena` remains allowlisted for legacy configs but is deprecated and ignored)
- `specialist.stall_detection.waiting_auto_close_ms`
- `specialist.prompt.system_prompt_mode`

Global-layer blocked attempts are stripped at merge time; repo-layer blocked attempts are surfaced in `sp doctor --specialists`.

The loader keeps JSON-first with YAML fallback at each leaf source:

1. Look for `<name>.specialist.json` — use if found
2. Fall back to `<name>.specialist.yaml` — use if JSON missing (deprecated)
3. Emit warning to stderr when YAML is used:
```
[specialists] DEPRECATED: YAML specialist config detected at <path>. Please migrate to .specialist.json
```

### Migration from YAML

YAML configs remain functional but are deprecated. To migrate:

```bash
# YAML (deprecated)
config/specialists/executor.specialist.yaml

# JSON (preferred)
config/specialists/executor.specialist.json
```

JSON supports all YAML fields plus additional metadata:
- `author`: Config author
- `tags`: Array of categorization tags
- `created`: Creation date
- `output_type`: Expected output format
- `max_retries`: Retry count for transient failures
- `beads_write_notes`: Whether to write bead notes
- `communication`: Communication preferences

### Schema validation

All configs are validated against `src/specialist/schema.ts` at load time. Invalid configs are skipped with an error message.

---
## 13) Auto GitNexus reindex after high-permission jobs

Supervisor automatically triggers a GitNexus reindex after jobs with elevated file access complete.
### Trigger conditions

```json
{
  "specialist": {
    "execution": {
      "permission_required": "MEDIUM"
    }
  }
}
```

When `permission_required` is `MEDIUM` or `HIGH`

When `permission_required` is `MEDIUM` or `HIGH`, the supervisor spawns a detached `npx gitnexus analyze` process after job completion.

### Behavior

- **Detached execution**: reindex runs in background, does not block job completion
- **Working directory**: analyze runs in the job's worktree (if applicable) or main checkout
- **Timeline event**: emits a `meta` event with `model: "gitnexus_analyze_started"` or `model: "gitnexus_analyze_start_failed"`
- **Failure handling**: if spawn fails, error is logged to timeline but job still completes

### Example timeline events

```json
{"t": 1743883200000, "type": "meta", "model": "gitnexus_analyze_started", "backend": "supervisor"}
```

### Rationale

High-permission specialists (`MEDIUM`/`HIGH`) typically modify source code. Auto-reindex ensures the GitNexus knowledge graph stays current without requiring manual intervention or separate CI steps.

### Disabling

To disable auto-reindex for a high-permission specialist, set `permission_required` to `LOW` or omit it (defaults to `LOW`).

---

## 14) Debugger v2.0 — Keep-alive iterative debugging

The `debugger` specialist was upgraded to v2.0 with enhanced capabilities for iterative debug-fix-verify cycles.

### Configuration

```json
{
  "specialist": {
    "metadata": {
      "name": "debugger",
      "version": "2.0.0",
      "description": "Autonomous debugger: given any symptom, error, or stack trace, systematically traces call chains with GitNexus, identifies root cause at file:line precision, applies targeted fixes, and verifies the fix works. Keep-alive for iterative debug-fix-verify cycles."
    },
    "execution": {
      "permission_required": "HIGH",
      "interactive": true
    }
  }
}
```

### Key changes in v2.0

| Feature | v1.0 | v2.0 |
|---------|------|------|
| Permission level | MEDIUM | **HIGH** |
| Keep-alive | No | **Yes** (`interactive: true`) |
| Workflow | Single-pass | **Iterative cycles** |

### Iterative workflow

1. **Initial run**: `sp run debugger --bead bd-123`
   - Investigates root cause using GitNexus
   - Applies targeted fix
   - Verifies fix works
   - Enters `waiting` state

2. **Resume if needed**: `sp resume <job-id> "Fix didn't work, error is now..."`
   - Re-diagnoses with new evidence
   - Applies corrected fix
   - Re-verifies
   - Returns to `waiting`

3. **Repeat** until issue is resolved

### When to use

- Complex bugs requiring multiple fix attempts
- Issues where the initial hypothesis may be wrong
- Debugging sessions that need human verification between attempts

### Observation

Use standard observation commands:

```bash
sp feed <job-id> --follow   # Watch investigation progress
sp status --job <job-id>    # Check waiting state
sp result <job-id>          # Read bug report + resume footer
```

---

## 15) Worktree isolation (`--worktree`, `--job`)

Each edit-permission specialist runs in an isolated git worktree (branch). This prevents concurrent file corruption when multiple executors modify overlapping paths, and produces a clean per-task branch that the orchestrator merges in dependency order.

### CLI flags

```bash
specialists run <name> [--worktree] [--job <id>]
```

| Flag | Semantics | Creates worktree? |
|------|-----------|:-:|
| `--worktree` | Explicitly provision a new isolated workspace; requires `--bead` | Yes |
| `--job <id>` | Reuse the workspace of an existing job | No |

`--worktree` and `--job` are **mutually exclusive**.

### Worktree guard (MEDIUM/HIGH permission specialists)

Specialists with `permission_required = MEDIUM` or `HIGH` and `requires_worktree: true` auto-provision an isolated worktree when `--bead` is provided and `--job` is not used. If no bead is supplied, the command exits with:

```
Error: specialist '<name>' has permission_required=<MEDIUM|HIGH> and requires worktree isolation.
Provide --bead <id> for automatic worktree provisioning, or use --job <id> to reuse an existing worktree.
```

### `requires_worktree` config flag

Specialists can opt out of the worktree guard by setting:

```json
{
  "specialist": {
    "execution": {
      "requires_worktree": false
    }
  }
}
```

When `requires_worktree: false`:
- Worktree guard is bypassed even for MEDIUM/HIGH permission
- Specialist can write directly to the main checkout
- Use for workflow specialists that manage shared state directly in the main checkout

**Default**: `requires_worktree: true` — all edit-capable specialists are gated.

`READ_ONLY` specialists are never gated.

### `--worktree` (new isolated workspace)

Requires `--bead <id>` — the bead id drives the deterministic branch name.

```bash
sp run executor --worktree --bead hgpu.3
# stderr: [worktree created: /repo/.worktrees/hgpu.3/hgpu.3-executor  branch: feature/hgpu.3-executor]
```

If a worktree for that branch already exists (e.g. from a prior interrupted run) it is reused:

```bash
# stderr: [worktree reused: /repo/.worktrees/hgpu.3/hgpu.3-executor  branch: feature/hgpu.3-executor]
```

### `--job <id>` (reuse existing workspace)

Reads `worktree_path` from the target job's `status.json` and uses that directory as `cwd`. The **caller's** `--bead` remains authoritative — only the workspace is borrowed.

```bash
sp run reviewer --job 49adda --bead hgpu.3-review
# stderr: [workspace reused from job 49adda: /repo/.worktrees/hgpu.3/hgpu.3-executor]
```

Hard fail conditions:
- `status.json` missing or unreadable for the given job id
- `worktree_path` absent — the target job was not started with `--worktree`

### Worktree GC

Clean up terminal job worktrees:

```bash
sp clean            # prunes job dirs AND terminal worktrees
sp clean --dry-run  # preview removals without deleting
```

GC candidates must satisfy all conditions:
1. Job status is `done` or `error` (terminal)
2. `worktree_path` is recorded in `status.json`
3. The directory still exists on disk
4. Job status is **not** `starting`, `running`, or `waiting`

For full technical details, see [worktrees.md](worktrees.md).

---
## 16) Context denormalization in `status.json`

Context utilization fields are denormalized directly into `status.json` on every `turn_summary` event, so any consumer reading `status.json` gets the latest context percentage without having to scan `events.jsonl`.

### Fields

```typescript
interface SupervisorStatus {
  // ... existing fields ...
  context_pct?: number;        // context window utilization (0-100)
  context_health?: 'OK' | 'MONITOR' | 'WARN' | 'CRITICAL';
}
```

### Health classification thresholds

| Range | Health |
|-------|--------|
| < 40% | `OK` |
| 40–65% | `MONITOR` |
| 65–80% | `WARN` |
| > 80% | `CRITICAL` |

### Model context windows

| Model pattern | Window |
|---------------|--------|
| `gemini-3.1-pro` | 1M tokens |
| `qwen3.5` / `glm-5` | 128K tokens |
| `claude` | 200K tokens |

### Where context is surfaced

- `sp status` / `sp status --job <id>` — renders `context_pct` and `context_health`
- `sp ps` — shows `ctx%` column on every job row (from `status.json` directly)
- `sp feed` — prints WARN/CRITICAL banners when thresholds are crossed
- `sp ps --json` — includes `context_pct` and `context_health` in `flat[]` array

---

## 17) Job lineage tracking (`reused_from_job_id`, `worktree_owner_job_id`)

When `--job <id>` is used, the new job records two lineage fields in its `status.json`. These enable `sp ps` to reconstruct worktree trees reliably without guessing from directory paths.

### Fields

```typescript
interface SupervisorStatus {
  reused_from_job_id?: string;       // the job whose workspace was borrowed via --job
  worktree_owner_job_id?: string;    // the root job that owns the worktree
}
```

### Semantics

| Field | Set when | Value |
|-------|----------|-------|
| `reused_from_job_id` | `--job <id>` is used | The explicit `--job` argument |
| `worktree_owner_job_id` | `--job <id>` is used | The transitive root owner of the worktree: resolves `worktree_owner_job_id` from the target status, falling back to the target job's `id` |

### Example

```bash
# Executor provisions the worktree (owner)
sp run executor --worktree --bead unitAI-55d
# → job a1b2c3, worktree_owner_job_id=a1b2c3

# Reviewer reuses the executor's workspace
sp run reviewer --job a1b2c3 --bead unitAI-55d-review
# → new job d4e5f6, reused_from_job_id=a1b2c3, worktree_owner_job_id=a1b2c3

# Second reviewer reuses the first reviewer's job (chained reuse)
sp run validator --job d4e5f6 --bead unitAI-55d-validate
# → new job g7h8i9, reused_from_job_id=d4e5f6, worktree_owner_job_id=a1b2c3 (resolved transitively)
```

### Tree reconstruction in `sp ps`

`sp ps` groups all jobs sharing the same `worktree_owner_job_id` into one worktree tree. Jobs are further arranged as a reuse forest: parent → child edges follow `reused_from_job_id` pointers.

---

## 18) `sp merge`: per-chain publication

`sp merge` publishes a single chain. The original "refuse if epic unresolved" inverted gate was removed in the chain-lifecycle redesign — per-chain merge is now allowed for any PASS chain regardless of sibling-epic state. Use `sp epic merge` only when batching all epic chains together.

### When `sp merge` accepts a chain

- Chain has reviewer PASS verdict in its terminal state.
- All chain jobs are terminal (executor closed via auto-finalize-on-streaming-PASS or `sp finalize <any-chain-job-id>` cascade).
- Epic membership is allowed; the chain merges incrementally regardless of sibling state.
- Epic has not been explicitly `merged` or `abandoned` (those two are the only blocking terminal states).

### Scope

**What it does**:
- Merge a single chain-root branch (one bead → one branch)
- Run TypeScript gate after merge
- Optional rebuild (`--rebuild`) after merge
- Optional PR mode (`--pr`)

**What it does NOT include**:
- Atomic batch publish across multiple chains (use `sp epic merge`)
- Topological dependency ordering across chains (use `sp epic merge`)
- Worktree cleanup after merge
- Conflict auto-resolution

### Vocabulary

| Term | Definition |
|------|------------|
| **Epic** | Top merge-gated identity with state machine. Use `sp epic merge` for publication. |
| **Chain** | Worktree lineage (`chain_kind: 'chain'`), seeded by edit-capable specialist. |
| **Prep** | Standalone job without worktree lineage (`chain_kind: 'prep'`). |
| **Wave** | Stage/batch label — speech only, no code meaning. |
| **Job** | Atomic execution unit. Jobs belong to chains or are prep. |

### Command

```bash
sp merge <chain-root-bead-id> [--rebuild]
```

- `<chain-root-bead-id>`: A **chain-root bead**. **Must NOT belong to an unresolved epic.**
- `--rebuild`: run `bun run build` after merge

### Safety

- Non-terminal jobs block merge (`starting`, `running` statuses)
- Epic guard blocks if chain belongs to unresolved epic
- **Merge-preview worthiness guard** — blocks empty-delta and noise-only-delta branches (see [cli-reference.md#merge-preview-worthiness-guard](cli-reference.md#merge-preview-worthiness-guard))
- TypeScript gate after merge
- Uses `--no-ff` to preserve branch history

### File listing

Merge output uses `git diff HEAD^1 HEAD` for accurate changed-file reporting (not `git diff-tree`).

### Example

```bash
# Standalone chain merge (epic guard must pass)
sp merge unitAI-55d
# → merges branch feature/unitAI-55d-executor

# PR mode
sp merge unitAI-55d --pr
# → creates PR instead of direct merge
```

### Implementation

Source: `src/cli/merge.ts`

Key functions:
- `resolveMergeTargets()` — resolve bead to chain
- `resolveChainEpicMembership()` — epic guard check
- `mergeBranch()` — git merge with conflict detection
- `runTypecheckGate()` — tsc validation

---

## 19) `sp epic merge`: canonical publication for wave-bound chains

`sp epic merge` is the canonical publication path for wave-bound chain groups.

### Synopsis

```bash
sp epic merge <epic-id> [--pr] [--rebuild] [--json]
```

### Behavior

1. Reads epic record from observability SQLite (refuses only on `merged` / `abandoned`)
2. Computes readiness live from chain state (no operator-driven `resolving → merge_ready` transition needed)
3. Verifies all chains are terminal (executor finalized via auto-finalize-on-streaming-PASS or `sp finalize` cascade)
4. Verifies latest reviewer verdict is PASS for each chain (matches plain or markdown-bold format)
5. Topologically sorts chains by bead dependencies
6. For each chain: `git merge <branch> --no-ff --no-edit`
7. Runs `bunx tsc --noEmit` after each merge
8. Creates PRs if `--pr` is set
9. Persists `merged` on success; on transient failure (rebase conflict, dirty worktree) writes a soft `failed` marker that the next attempt clears automatically

### Epic lifecycle (derived model)

```
chains in flight ──── derive ──── blocked / failed / merge_ready
                            │
                            ├── merged (persisted, terminal)
                            └── abandoned (persisted, terminal)
```

Only `merged` and `abandoned` are persisted as terminal markers. `blocked`, `failed`, and `merge_ready` are recomputed live from chain readiness on every read. A persisted soft `failed` marker (from a transient publish failure) is recoverable — the next `sp epic merge` retries fresh.

See `docs/cli-reference.md` and `docs/ARCHITECTURE.md` §10 for the full derived-readiness rules.

### Examples

```bash
# Check readiness first
sp epic status unitAI-3f7b

# Publish all chains
sp epic merge unitAI-3f7b

# PR mode
sp epic merge unitAI-3f7b --pr

# Rebuild after merge
sp epic merge unitAI-3f7b --rebuild
```

---

## 20) `sp end`: epic-aware session close

`sp end` integrates with epic lifecycle for publication.

### Synopsis

```bash
sp end [--bead <id>|--epic <id>] [--pr] [--rebuild]
```

### Behavior

1. **Epic redirect**: If `--epic <id>` provided, delegates to `sp epic merge <id>`
2. **Epic guard**: If current chain belongs to unresolved epic, auto-redirects to `sp epic merge`
3. **Chain merge**: For standalone chains, publishes the branch

### Example

```bash
# Epic publication
sp end --epic unitAI-3f7b --pr
# → delegates to: sp epic merge unitAI-3f7b --pr

# Chain in unresolved epic (auto-detect)
sp end
# Chain unitAI-impl belongs to unresolved epic unitAI-3f7b (resolving).
# Redirecting to: sp epic merge unitAI-3f7b
```

---

## 21) Chain identity: chain vs prep jobs

Jobs are classified as `chain` or `prep` based on worktree lineage.

### Kinds

| Kind | Definition | Has worktree? |
|------|------------|:-------------:|
| `chain` | Worktree lineage seeded by edit-capable specialist | Yes |
| `prep` | Standalone job without worktree lineage | No |

### Derivation

```typescript
// Automatic classification from status fields
const isChainJob = Boolean(
  status.worktree_path || status.worktree_owner_job_id || status.chain_id
);
```

### Fields in status.json

- `chain_kind` — 'chain' or 'prep'
- `chain_id` — unique identifier
- `chain_root_job_id` — root worktree owner
- `chain_root_bead_id` — seeding bead

---

## 22) Crash recovery for zombie jobs

`crashRecovery()` runs at Supervisor startup and reconciles orphaned job states:

**Dead running/starting jobs**:
- Dead PID + non-node → status becomes `error` ("Process crashed or was killed")
- Dead PID + node member → status becomes `waiting` ("recovery_pending") — preserved for NodeSupervisor

**Dead waiting jobs**:
- Emits `stale_warning` event if idle past `waiting_stale_ms` threshold
- If `waiting_auto_close_ms` is set, stale waiting jobs request graceful close first, then forced termination fallback if close hangs
- Default remains recoverable waiting sessions when `waiting_auto_close_ms` is unset/0
- Node members preserved for NodeSupervisor recovery

**`hasRunCompleteEvent()`**:

Used by `sp stop` to resolve terminal status:
```typescript
// SQLite-first, then events.jsonl fallback
export function hasRunCompleteEvent(jobId: string): boolean;
```

---

## 23) Epic chain membership auto-sync

Supervisor automatically syncs epic chain membership on job completion:

**Trigger**: Both success (`done`) and error paths

**Actions**:
1. `upsertEpicChainMembership()` — persist chain→epic linkage
2. `loadEpicReadinessSummary()` — recompute readiness state
3. `syncEpicStateFromReadiness()` — update epic state machine

This ensures epic readiness is always current without manual sync steps.

---

## 24) Worktree write-boundary enforcement

When a specialist runs with `--worktree`, the pi session enforces a **write-boundary** on tool calls. This prevents accidental modifications to files outside the isolated worktree.

### Intercepted tools

| Tool | Intercepted? | Behavior on out-of-bounds absolute path |
|------|:-------------:|------------------------------------------|
| `edit` | ✓ Yes | Blocked with reason — tool call rejected |
| `write` | ✓ Yes | Blocked with reason |
| `multiEdit` | ✓ Yes | Blocked with reason |
| `notebookEdit` | ✓ Yes | Blocked with reason |
| `read` | ✗ No | Allowed (read-only, no corruption risk) |
| `bash` | ✗ No | Allowed (command execution, not file write) |

### Boundary semantics

- **Worktree root**: from `SPECIALISTS_WORKTREE_BOUNDARY` env var (set by the runner from `worktree_path` recorded in `status.json`)
- **In-bounds path**: any path that resolves to a location under worktree root
- **Out-of-bounds path**: any absolute path resolving outside worktree root
- **Relative paths**: not intercepted — they resolve against the specialist's cwd, which is the worktree root

### Block behavior

When a write tool is called with an out-of-bounds absolute path:
1. The tool call is **blocked** before reaching the file system.
2. The specialist receives a structured rejection: `{ block: true, reason: "Path '<X>' is outside worktree boundary ('<root>'). Use a relative path or a path within the worktree." }`.
3. No file is created, no tmp-fs redirect, no silent success.
4. The specialist sees the reason and is expected to retry with a worktree-relative path.

This design prevents:
- Specialists accidentally modifying main checkout files
- Parallel specialists racing on shared files
- Escape via absolute paths (LLMs commonly generate these from context memory)

### Why this matters

Without write-boundary enforcement, specialists in worktrees could:
1. Generate absolute paths from session context (e.g. `/home/user/project/src/file.ts`)
2. Modify files in the main repo, bypassing worktree isolation
3. Create race conditions with other specialists or the operator

This was observed in production (2026-04-09): sync-docs specialist in worktree `.worktrees/8we6/8we6-sync-docs/` emitted edit calls with absolute paths pointing to main repo. All 6 doc edits landed in main repo instead of the worktree — isolation was completely bypassed.

### Implementation

Enforcement lives in pi session layer (not specialists code):
- Commit: `da9ac9e3` (elhl/a2u7 Phase 1)
- Applied at tool invocation boundary
- Path resolution checks against declared `worktree_path`

### Limitations

- `Bash` commands are not intercepted — a `bash` tool call invoking `cp`, `mv`, or shell redirection can still write outside the worktree.
- Relative paths are not checked — they resolve against the specialist's cwd. Escape via `..` traversal is possible if the specialist explicitly does so; in practice the worktree boundary catches the absolute-path failure mode that motivated this enforcement.
- Only `path` and `file_path` input fields are inspected; tools with non-standard input keys are not covered.

---

## 25) Per-bead context injection at specialist spawn (retired)

The runner injects no stored per-bead context (removed S1 unitAI-cnca3 through S4 unitAI-j45ai: spawn injection, management CLI, sync hook, init wiring, SQLite persistence, curator specialist, audit skill). Doctrinal context comes from the xtrm-loader Pi extension, which injects ONLY the doctrine file — the user-owned memory file is never injected.

### Extension opt-out

Specialists can disable the GitNexus npm extension:

```json
{
  "execution": {
    "extensions": {
      "gitnexus": false
    }
  }
}
```

The legacy `execution.extensions.serena` key stays parseable but is ignored — Serena extension injection was retired with the K4 Serena retirement (unitAI-e67up.8).

### `memory_injection` timeline event

Every spawn emits a `meta` event with `model: "memory_injection"` recording token accounting:

```json
{
  "memory_injection": {
    "static_tokens": 60,
    "memory_tokens": 400,
    "gitnexus_tokens": 150,
    "total_tokens": 610
  }
}
```

### Non-fatal behavior

All injection sources are non-fatal:
- `.gitnexus/meta.json` missing → no GitNexus mandate or pre-query
- GitNexus CLI unavailable → pre-query skipped silently

---

## 26) Edit gate bead-claim KV pattern

The edit gate hooks check two KV keys before allowing file edits:

### Primary: session-scoped claim

```bash
bd kv set "claimed:<session-id>" "<bead-id>"
```

Set by Claude Code hooks when an agent claims a bead. Session-bound, cleared on session end.

### Fallback: bead-claim

```bash
bd kv set "bead-claim:<bead-id>" "active"
```

Set by Runner **before spawning a specialist** when `--bead <id>` is provided. Enables worktree specialists to edit without requiring a session-scoped claim.

### Lifecycle

```typescript
// Before specialist spawn (run.ts)
if (args.beadId && workingDirectory) {
  execSync(`bd kv set "bead-claim:${args.beadId}" "active"`);
}

// After specialist completes (success or error)
if (args.beadId && workingDirectory) {
  execSync(`bd kv clear "bead-claim:${args.beadId}"`);
}
```

**Why this matters**: Worktree specialists run in subprocesses without session context. The bead-claim pattern provides an edit gate entry that:
1. Is independent of session IDs
2. Is scoped to the specific bead being worked on
3. Is automatically cleaned up when the run completes

---

## 27) Auto-append bead notes for ALL specialists

Supervisor now auto-appends full specialist output to the **input bead** on every `run_complete` event. This applies to **all specialists**, not just READ_ONLY.

### Behavior

For specialists with `--bead <id>`:
- **First turn**: output appended with `[WAITING]` header if keep-alive and non-terminal
- **Subsequent turns**: output appended after each resume turn completes
- **Terminal completion**: output appended with `[DONE]` header

### Format

```markdown
### Specialist Output — executor (job 49adda) [WAITING]

<full assistant output>

---
timestamp=2026-04-13T10:30:00Z
status=waiting
prompt_hash=abc123
git_sha=def456
elapsed_ms=45678
model=gpt-5.3-codex
backend=openai-codex
```

Status labels:
- `WAITING — more output may follow` — keep-alive session awaiting resume
- `DONE` — terminal completion
- `ERROR` — failed completion

### Implementation

Commit: `428cd7f7`
- `formatBeadNotes()` — enriched with specialist name, job ID, status label, timestamp
- `appendResultToInputBead()` — called on every `run_complete` (not just terminal)
- `BeadsClient.updateBeadNotes()` — returns `{ ok, error }` instead of void

---

## 28) Auto-commit worktree changes (checkpoint policy)

Specialists with `auto_commit: checkpoint_on_waiting` or `checkpoint_on_terminal` automatically commit substantive worktree changes at designated lifecycle points.

### Policy options

| Policy | Trigger | Use case |
|--------|---------|----------|
| `never` | Never | Default — no auto-commit |
| `checkpoint_on_waiting` | Each keep-alive turn entering `waiting` | Executors, debuggers — preserve partial work before review |
| `checkpoint_on_terminal` | Terminal completion (`done`/`error`) | One-shot specialists — commit only at end |

### Configuration

```json
{
  "specialist": {
    "execution": {
      "auto_commit": "checkpoint_on_waiting"
    }
  }
}
```

Built-in defaults:
- **executor**: `checkpoint_on_waiting`
- **debugger**: `checkpoint_on_waiting`

### Noise filtering

Auto-commit ignores paths matching:
- `.xtrm/`
- `.wolf/`
- `.specialists/jobs/`
- `.beads/`

Only **substantive files** (source, config, docs) are committed.

### Commit message format

```
checkpoint(executor): unitAI-55d turn 1
```

### Timeline events

```json
{"type": "auto_commit_success", "commit_sha": "abc123", "committed_files": ["src/cli/run.ts"]}
{"type": "auto_commit_skipped", "reason": "no_substantive_changes"}
{"type": "auto_commit_failed", "reason": "git commit failed"}
```

### Status fields

```typescript
interface SupervisorStatus {
  auto_commit_count?: number;        // cumulative checkpoints this run
  last_auto_commit_sha?: string;    // SHA of most recent checkpoint
  last_auto_commit_at_ms?: number;  // timestamp of most recent checkpoint
}
```

### Implementation

Commit: `11e9b016`
- `runAutoCommitCheckpoint()` — substantive file detection, git add + commit, SHA capture
- `applyAutoCommitCheckpoint()` — called after `run_complete` on waiting/terminal transitions
- Timeline: `auto_commit_success/skipped/failed` events
- Schema: `execution.auto_commit` field

---

## 29) Stale-base guard — rebase at merge + block at dispatch

Two-layer protection against parallel-chain divergence:

### Layer 1: Dispatch-time guard

When `--worktree` provisions a new worktree, the stale-base guard checks for sibling chains with unmerged substantive commits:

```
Error: Epic 'unitAI-3f7b' has sibling chains with unmerged changes.
  - impl-a: 2 substantive commits on 'feature/unitAI-impl-a-executor'
  - impl-b: 3 substantive commits on 'feature/unitAI-impl-b-executor'
Merge sibling chains first via 'sp epic merge unitAI-3f7b', or use --force-stale-base to bypass.
```

**Bypass**: `--force-stale-base` flag forces provisioning at caller's risk.

### Layer 2: Merge-time rebase

Before merging each chain (via `sp merge` or `sp epic merge`), the branch is rebased onto master inside the worktree:

```bash
git rebase master  # runs in worktree cwd
```

If rebase fails with conflicts:

```
Error: Rebase failed for 'feature/unitAI-impl-a-executor' onto 'master'.
Conflicting files:
  - src/cli/run.ts
  - src/specialist/supervisor.ts
Resolve conflicts manually in that worktree, then re-run merge.
```

Abort is automatic (`git rebase --abort`) — no partial rebase state remains.

### Why this matters

Parallel chains branched from the same base diverge:

1. Wave A branches from master at commit X
2. Wave B branches from master at commit X (same base)
3. Wave A merges → master now has Wave A changes
4. Wave B merges → its diff shows **reversions** of Wave A (branched before merge)

Rebase at merge-time resolves this by incorporating earlier waves' changes before publication.

### Implementation

Commit: `4c3eeb36`
- `assertNoStaleBaseSiblings()` — dispatch-time guard in run.ts
- `rebaseBranchOntoMaster()` — merge-time rebase in merge.ts
- `listEpicChainsWithLatestJob()` — SQLite query for sibling chain state
- Schema: `ChainMergeTarget.worktreePath` field

---

## 30) Manifest-driven tool resolver

Each specialist's `--tools` argument is computed at session start by `resolvePermissionTools` from a JSON tool catalog plus an optional per-specialist override block. There are no hardcoded tier→tool arrays in source: the catalog is the only source of truth.

### Inputs

1. The specialist's tier from `execution.permission_required` (`READ_ONLY`/`LOW`/`MEDIUM`/`HIGH`)
2. The project catalog override at `.specialists/catalog/index.json`, when present; otherwise the package-canonical `config/catalog/index.json` (with `native.json` / `gitnexus.json` siblings). A discovered invalid project override fails closed instead of falling back.
3. Live extension health probe of `pi-gitnexus` in the global npm modules directory
4. Optional `permissions[<TIER>]` override block on the specialist JSON

### Resolution layers (in order)

| Layer | Effect |
|-------|--------|
| `catalog` | Tier defaults from each catalog (native + gitnexus) |
| `specialist_override` | The specialist's `permissions[<TIER>]` block strips natives via `denied_natives_when_extension` |
| `runtime_health` | Tools belonging to unhealthy extensions are dropped; if a hard-deny had stripped natives whose replacement extension is now unhealthy, those natives are restored automatically |

### Deny modes

- `soft` (default): native tool stays in `--tools`; resolver emits a `preference signals` line as a hint
- `hard`: native tool is removed when the replacement extension is healthy; restored when it isn't

### Override example: explorer

`config/specialists/explorer.specialist.json` is the only specialist with an override today:

```json
"permissions": {
  "READ_ONLY": {
    "denied_natives_when_extension": ["grep", "find", "ls"],
    "denied_natives_mode": "hard"
  }
}
```

Result at runtime when the GitNexus extension is healthy: explorer's `--tools` excludes native `grep`/`find`/`ls`, includes `gitnexus_query` and the other graph tools. If `pi-gitnexus` becomes unhealthy mid-run, the natives are restored.

### Inspection

```bash
sp config show <name> --resolved
```

Prints layer attribution, extension health, denied natives, deny mode, downgrade reasons, and the final `--tools` string. See [manifest.md](manifest.md) for the full reference and [cli-reference.md](cli-reference.md#specialists-config) for the CLI surface.

---

## Quick reference flows

### CLI async observation flow

```bash
sp run executor --prompt "Task" --json
# capture job id from stderr
sp feed <job-id> --follow
sp result <job-id> --wait --timeout 120
```

### Process dashboard flow

```bash
# Live view of all active jobs
sp ps --follow

# Snapshot with context% and bead titles
sp ps

# Include completed jobs
sp ps --all

# Machine-readable for scripting
sp ps --json | jq '.flat[] | select(.status == "waiting")'
```

### Worktree isolation flow

```bash
# 1. Executor provisions worktree, runs implementation
sp run executor --worktree --bead hgpu.3
# → job id: 49adda

# 2. Reviewer reuses same workspace (read-only)
sp run reviewer --job 49adda --bead hgpu.3-review

# 3. Clean up terminal worktrees after review complete
sp clean --dry-run   # preview
sp clean             # execute
```

### MCP single-run flow

1. `use_specialist` with `name` + `prompt`/`bead_id`
2. Read final output directly from MCP response

