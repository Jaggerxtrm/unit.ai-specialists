---
title: Specialist Authoring
scope: authoring
category: guide
version: 1.9.2
updated: 2026-06-24
synced_at: bf6baf7a
description: How to write, validate, place, and maintain specialist definition files.
source_of_truth_for:
  - ".xtrm/skills/active/pi/specialists-creator/SKILL.md"
  - "src/specialist/schema.ts"
  - "src/specialist/runner.ts"
  - "src/pi/session.ts"
domain:
  - authoring
---

# Specialist Authoring

This guide is the user-facing reference for authoring `.specialist.json` files. It mirrors the canonical `specialists-creator` skill and keeps examples aligned with runtime behavior.

> **Format:** All specialists use `.specialist.json`. YAML (`.specialist.yaml`) is deprecated — still loaded but prints a deprecation warning. Migrate existing YAML files to JSON.

## JSON Format Notes

- All string enum values must be quoted: `"READ_ONLY"`, `"auto"`, `"markdown"`
- Version must be a quoted string: `"1.0.0"` not `1.0.0`
- Multi-line strings use `\n` for newlines in `task_template`
- Comments are **not** supported in JSON — document intent in a companion `.md` file
- Use a JSON linter/formatter to catch syntax errors before running `specialists validate`

## Minimal skeleton

```json
{
  "specialist": {
    "metadata": {
      "name": "my-specialist",
      "version": "1.0.0",
      "description": "One sentence.",
      "category": "workflow"
    },
    "execution": {
      "model": "openai-codex/gpt-5.4-mini",
      "permission_required": "READ_ONLY"
    },
    "prompt": {
      "task_template": "$prompt\n\nWorking directory: $cwd"
    }
  }
}
```

---

## `specialist.metadata` (required)

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | kebab-case: `[a-z][a-z0-9-]*` |
| `version` | string | yes | semver (`"1.0.0"`) — must be a quoted string in JSON |
| `description` | string | yes | one-sentence summary |
| `category` | string | yes | free text (`"workflow"`, `"analysis"`, `"codegen"`, …) |
| `author` | string | no | optional |
| `created` | string | no | optional date |
| `updated` | string | no | optional date |
| `tags` | string[] | no | optional labels |

## `specialist.execution` (required)

| Field | Type | Default | Notes |
|---|---|---|---|
| `model` | string | — | required — ping before using |
| `fallback_model` | string | — | recommended from a different provider |
| `mode` | `"tool" \| "skill" \| "auto"` | `"auto"` | run mode |
| `timeout_ms` | number | `120000` | run timeout (ms) |
| `stall_timeout_ms` | number | unset | kill if no event for N ms |
| `max_retries` | number | `0` | retry count on failure |
| `interactive` | boolean | `false` | keep-alive by default for multi-turn specialists; override layers may also set it |
| `stdout_limit_bytes` | number | `33554432` | per-run stdout cap for script-class runtime; env `SPECIALISTS_SCRIPT_STDOUT_LIMIT_BYTES` overrides default, spec value overrides env |
| `response_format` | `"text" \| "json" \| "markdown"` | `"text"` | output contract hint |
| `expected_output_keys` | `string[]` | unset | script-surface required JSON keys, independent of `response_format`; `sp script`/`runScriptSpecialist` fail closed with `error_type: "invalid_json"` on miss; inert on `sp run` |
| `output_type` | enum | `"custom"` | semantic archetype: `"codegen"`, `"analysis"`, `"review"`, `"synthesis"`, `"orchestration"`, `"workflow"`, `"research"`, `"custom"` |
| `permission_required` | `"READ_ONLY" \| "LOW" \| "MEDIUM" \| "HIGH"` | `"READ_ONLY"` | tool-access tier |
| `thinking_level` | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh"` | unset | forwarded to thinking-capable models |
| `requires_worktree` | boolean | `true` | set `false` for workflow/script-class specialists that should not run in an isolated git worktree; a worktree is not a security sandbox |
| `auto_commit` | `"never" \| "checkpoint_on_waiting" \| "checkpoint_on_terminal"` | `"never"` | when to auto-commit specialist edits to the worktree |
| `extensions.serena` | boolean | — | DEPRECATED, ignored (Serena retired, unitAI-e67up.8); legacy specs keep validating |
| `extensions.gitnexus` | boolean | `true` | `false` disables GitNexus extension injection for this specialist |

### Permission tiers

The tier coarse-grains the native pi tools your specialist gets. The full resolved tool list also includes GitNexus tools. Specialists uses the project override at `.specialists/catalog/index.json` when present; otherwise it uses the package-canonical `config/catalog/index.json`. A discovered malformed or unreadable project override fails closed instead of falling back. See [manifest.md](manifest.md) for the complete picture.

| Level | Native tools added (cumulative) |
|---|---|
| `"READ_ONLY"` | `read, grep, find, ls` |
| `"LOW"` | `+ bash` |
| `"MEDIUM"` | `+ edit` |
| `"HIGH"` | `+ write` |

Each tier also brings tier-appropriate GitNexus tools from the catalog. Catalog `default_overrides` may also remove native tools at runtime when extensions are healthy. To see exactly what your specialist will receive:

```bash
sp config show <name> --resolved
```

> `READ_WRITE` is **not** a valid permission value.

### Per-specialist permissions override (optional)

For most specialists the tier defaults are correct and you should not declare an override. When a specialist's policy genuinely diverges from its tier — currently only `explorer` does — add a top-level `permissions` block (sibling to `execution`):

```jsonc
{
  "specialist": {
    "execution": { "permission_required": "READ_ONLY", "...": "..." },
    "permissions": {
      "READ_ONLY": {
        "denied_natives_when_extension": ["grep", "find", "ls"],
        "denied_natives_mode": "hard"
      }
    }
  }
}
```

| Field | Type | Default | Effect |
|-------|------|---------|--------|
| `denied_natives_when_extension` | `string[]` | `[]` | Native tools to deny only when the replacement extension (gitnexus) is healthy. |
| `denied_natives_mode` | `"soft"` \| `"hard"` | `"soft"` | `soft` keeps the tool but emits a preference hint; `hard` removes it (with health-gated restore). |

The example above is explorer's actual block: when `pi-gitnexus` is loaded, native `grep`/`find`/`ls` are stripped to force the model toward `gitnexus_query` and the other GitNexus graph tools. If the extension degrades, the natives are restored automatically.

See [manifest.md](manifest.md) for full semantics, the canonical example, and when to *not* add an override.

For bare-mode authoring and npm-package starter flow, see [bare-specialists.md](bare-specialists.md).


### Referencing canonical assets

Custom specialists can reference package-canonical rules and skills by name instead of copying files into the repo. The runtime resolves canonical assets from the installed package when no project-local copy exists.

```jsonc
{
  "specialist": {
    "mandatory_rules": {
      "template_sets": ["git-workflow-safe"]
    },
    "skills": {
      "paths": ["releasing"]
    }
  }
}
```

Use this for stable shared guidance. Create a project-local file only when the repo intentionally changes the canonical behavior. Project/user layers still win over package canonical, so custom overlays remain explicit. See [installation.md](installation.md) for the Category A / Category B distribution split.

### Interactive precedence

Effective keep-alive order is:
1. explicit disable (`--no-keep-alive` / `no_keep_alive`)
2. explicit enable (`--keep-alive` / `keep_alive`)
3. JSON `execution.interactive`
4. default one-shot (`false`)

### Extension sources and opt-out

Use `execution.extensions` only for trusted executable extension config.
- `gitnexus: false` skips default GitNexus injection for that specialist.
- any other source-string key with value `true` adds repeated `-e <source>` pairs in insertion order.
- remote `npm:`, `git:`, and `http(s):` sources disable `--offline`; local paths keep it.
- legacy `serena` key still parses and is ignored.

## `specialist.prompt` (required)

| Field | Type | Required | Notes |
|---|---|---|---|
| `task_template` | string | yes | rendered with `$variables` |
| `system` | string | no | system prompt content |
| `skill_inherit` | string | no | single skill folder/file injected via `--skill` |
| `output_schema` | object | no | JSON schema for structured output — runner-injected, warn-only validation |
| `examples` | array | no | few-shot examples |

### Output contract precedence

**Order:** `response_format` → `output_type` → `output_schema`

**`response_format` behavior:**
- `"text"`: no report template injected (raw behavior)
- `"json"`: specialist must return one parseable JSON object
- `"markdown"`: specialist must use canonical report sections:
  - `## Summary`, `## Status`, `## Changes`, `## Verification`, `## Risks`, `## Follow-ups`, `## Beads`
  - Optional: `## Architecture`, `## Acceptance Criteria`, `## Machine-readable block`

**`output_type` (semantic archetype):**
- `"codegen"`: implementation/change manifests
- `"analysis"`: architecture/exploration reports
- `"review"`: compliance/review verdicts
- `"synthesis"`: decision summaries across multiple findings
- `"orchestration"`: coordinator actions/state handoffs
- `"workflow"`: procedural/operational run outputs
- `"research"`: source-backed findings with confidence
- `"custom"`: no built-in extension

**`output_schema` guidance:** Add when output must be machine-readable. Schema is injected into system prompt; post-run validation is warn-only.

**Mandatory markdown+schema rule:** If `response_format: "markdown"` and `output_schema` present, output must include `## Machine-readable block` with exactly one JSON object in a ` ```json ` fenced block matching the schema.

**Standard schemas by specialist type:**

```json
// executor — change manifest
{
  "prompt": {
    "output_schema": {
      "type": "object",
      "properties": {
        "status": { "enum": ["success", "partial", "failed"] },
        "files_changed": { "type": "array", "items": { "type": "string" } },
        "symbols_modified": { "type": "array", "items": { "type": "string" } },
        "lint_pass": { "type": "boolean" },
        "tests_pass": { "type": "boolean" },
        "issues_closed": { "type": "array", "items": { "type": "string" } },
        "follow_ups": { "type": "array", "items": { "type": "string" } }
      }
    }
  }
}

// explorer — analysis report
{
  "prompt": {
    "output_schema": {
      "type": "object",
      "properties": {
        "summary": { "type": "string" },
        "key_files": { "type": "array", "items": { "type": "string" } },
        "architecture_notes": { "type": "string" },
        "recommendations": { "type": "array", "items": { "type": "string" } }
      }
    }
  }
}

// planner — epic result
{
  "prompt": {
    "output_schema": {
      "type": "object",
      "properties": {
        "epic_id": { "type": "string" },
        "children": { "type": "array", "items": { "type": "string" } },
        "test_issues": { "type": "array", "items": { "type": "string" } },
        "first_task": { "type": "string" }
      }
    }
  }
}
```

---

## `specialist.skills` (optional)

```json
{
  "skills": {
    "paths": [
      "skills/my-skill/",
      "~/.agents/skills/domain/",
      "skills/notes.md"
    ],
    "scripts": [
      {
        "run": "./scripts/pre-check.sh",
        "phase": "pre",
        "inject_output": true,
        "required": true
      },
      {
        "run": "bd ready",
        "phase": "pre",
        "inject_output": true
      },
      {
        "run": "./scripts/cleanup.sh",
        "phase": "post"
      }
    ]
  }
}
```

### `skills.paths`
- Each item is passed via `pi --skill`.
- Folders resolve to their `SKILL.md`.
- Direct file paths are accepted.
- Missing files are skipped silently.

### `skills.scripts`
- `run` accepts either:
  - a file path (`./scripts/foo.sh`, `~/scripts/foo.sh`), or
  - a shell command (`bd ready`, `git status`).
- `phase` can be `"pre"` or `"post"`.
- `inject_output: true` makes script stdout available as `$pre_script_output`.
- `required: true` on a `pre` script makes a nonzero exit abort the run before the model session starts (no fallback/retry). Default `false`: failure is injected/ignored as before.

### Pre/post script execution details
- Scripts run **locally**, outside the specialist model session.
- `pre` scripts run before session start.
- `post` scripts run after completion.
- Timeout is 30 seconds per script.
- Exit code is captured, but script failure does **not** abort the run unless the script is `pre` with `required: true`.
- Pre-run validation checks:
  - file paths exist,
  - command binaries exist on `PATH`,
  - obvious shebang typos are reported before launch.

---

## `specialist.capabilities` (optional)

Declarative capabilities help validation and tooling (`specialists doctor`, pre-run checks).

```json
{
  "capabilities": {
    "required_tools": ["bash", "read", "grep", "glob"],
    "external_commands": ["bd", "git", "gh"]
  }
}
```

| Field | Type | Behavior |
|---|---|---|
| `required_tools` | string[] | Declares required pi tools |
| `external_commands` | string[] | Commands validated on `PATH` before run |

If any `external_commands` binary is missing, startup hard-fails and the session does not begin.

---

## `specialist.output_file` (optional, top-level)

```json
{
  "output_file": ".specialists/my-specialist-result.md"
}
```

When set, the specialist writes its **handoff block** to this file on every substantive turn — foreground and `--background`. The content is identical to what is appended to the input bead notes and shown by `sp result`: a markdown heading, the verbatim specialist output, and an italic metadata footer.

- **No env flag required.** `output_file` is honored whenever it is set (since unitAI-f58ma). It does NOT require `SPECIALISTS_JOB_FILE_OUTPUT` — that flag now only gates the debug file-mirrors (events.jsonl / status.json / result.txt).
- **Single writer.** In a supervised run (`sp run`) the supervisor owns the file and the runner's own write is suppressed, so the file is never double-written. (In script/serve runs there is no supervisor; the runner writes the raw output instead of the enveloped block.)
- **Format is the rendered handoff block, not bare output.** A downstream specialist that consumes this file as input will see the header/footer envelope around the body.
- **Append vs overwrite is controlled by `notes_mode`** (see below): `full-trail` appends each turn; `final-only` overwrites with just the final `[FINAL · DONE]` block.
- **Gitignore the path** if you don't want it committed — specs with `output_file` always write, so add the path (e.g. `.specialists/*-result.md`) to `.gitignore`.

Relative paths resolve from the working directory.

---

## `specialist.notes_mode`

Controls how per-turn handoff output is persisted to BOTH the input bead notes and `output_file`.

| Value | Behavior |
|---|---|
| `"full-trail"` (default) | Append every substantive turn. Bead notes / `output_file` accumulate `### … [turn N · WAITING]` blocks, ending with a final `## … [FINAL · DONE]` block. Best for keep-alive specialists where the operator wants the full trail. |
| `"final-only"` | Persist only the single canonical `## … [FINAL · DONE]` block; intermediate turns are skipped and `output_file` is OVERWRITTEN (not appended). Best for non-coding / chained pipelines where the next specialist reads the previous specialist's bead note or `output_file` as its input and only wants the final result. |

Empty turns are never persisted. The handoff block is markdown-native (heading + verbatim body + one italic metadata footer); the model string is normalized (provider prefix stripped, e.g. `nano-gpt/moonshotai/kimi-k2.5` renders as `kimi-k2.5`).

```json
{ "notes_mode": "final-only" }
```

## `specialist.validation` (optional)

Used by staleness reporting in `specialists status` and `specialists list`.

| Field | Type | Notes |
|---|---|---|
| `files_to_watch` | string[] | If any watched file mtime is newer than `metadata.updated`, status becomes `STALE` |
| `stale_threshold_days` | number | Days before `STALE` escalates to `AGED` |
| `references` | array | accepted, currently unused |

### Staleness states

| State | Condition |
|---|---|
| `OK` | No watched file changed, or no watch/updated metadata configured |
| `STALE` | Watched file mtime > `metadata.updated` |
| `AGED` | `STALE` and days since `updated` > `stale_threshold_days` |

Example:

```json
{
  "specialist": {
    "metadata": {
      "updated": "2026-03-01"
    },
    "validation": {
      "files_to_watch": [
        "src/specialist/schema.ts",
        "src/specialist/runner.ts"
      ],
      "stale_threshold_days": 30
    }
  }
}
```

---

## `specialist.stall_detection` (optional)

Controls stall detection warnings during specialist execution.

| Field | Type | Default | Notes |
|---|---|---|---|
| `running_silence_warn_ms` | number | `60000` | Warn if no events for N ms while running |
| `running_silence_error_ms` | number | `300000` | Mark stale if no events for N ms while running |
| `waiting_stale_ms` | number | `3600000` | Warn if waiting state lasts N ms |
| `waiting_auto_close_ms` | `number \| null` | unset | ms in waiting state before attempting graceful auto-close; `null` clears inherited value |
| `tool_duration_warn_ms` | number | `120000` | Warn if single tool runs longer than N ms |

```json
{
  "stall_detection": {
    "running_silence_warn_ms": 60000,
    "running_silence_error_ms": 300000,
    "waiting_stale_ms": 3600000,
    "waiting_auto_close_ms": null,
    "tool_duration_warn_ms": 120000
  }
}
```

---

## `specialist.beads_integration` (optional)

| Value | Behavior |
|---|---|
| `"auto"` (default) | Create tracking bead when `permission_required` is `LOW` or higher |
| `"always"` | Always create a tracking bead |
| `"never"` | Never create a tracking bead |

`beads_write_notes` (boolean, default `true`) — when `true`, the specialist appends its handoff block to the associated bead's notes on every substantive turn. The appended block is the rendered handoff format described under `notes_mode`: a markdown heading (`### <specialist> · <model> · [turn N · WAITING]` for trail turns, `## … [FINAL · DONE]` for the final turn), the verbatim specialist output, and an italic footer with timing / token / git metadata. Set to `false` to suppress bead-note writes entirely. The same content also feeds `output_file` and `sp result` (one shared content source).

---

## Built-in template variables

Always available in `prompt.task_template`:

| Variable | Value |
|---|---|
| `$prompt` | user prompt passed to the specialist |
| `$cwd` | current working directory (`process.cwd()`) |
| `$pre_script_output` | combined stdout from `pre` scripts with `inject_output: true` (empty string if none) |

When invoked with bead context (`--bead` / `bead_id`):

| Variable | Value |
|---|---|
| `$bead_context` | full bead content (used in place of plain prompt context) |
| `$bead_id` | bead identifier |

Custom variables can be passed at invocation with `--variables key=value` and referenced as `$key`.

---

## Skills injection mechanics

Files from `skills.paths` are read and appended to the system prompt at runtime.

Append format:

```text
---
# Skill: <path>

<file content>
```

`prompt.skill_inherit` behaves similarly but is intended as single-file Agent Forge compatibility input and is appended under `# Service Knowledge`.

---

## File placement scopes (3-tier discovery)

Specialists are discovered in priority order:

1. User (repo authoring layer): `<project-root>/.specialists/user/*.specialist.json`
2. Default (repo-managed mirror): `<project-root>/.specialists/default/*.specialist.json`
3. Package (upstream fallback): `<project-root>/config/specialists/*.specialist.json`

Legacy paths (loaded but deprecated):
- `<project-root>/specialists/`
- `<project-root>/.claude/specialists/`
- `<project-root>/.agent-forge/specialists/`
- Nested paths like `.specialists/user/specialists/`

> **User-scope CLI flag deprecated:** The `--user-dir` flag is now `--project-dir` (alias retained). User-scope discovery is project-local only; `~/.agents/specialists` is not scanned.

Name files as `<metadata.name>.specialist.json`.

> **Deprecated:** `.specialist.yaml` files are still loaded but print a deprecation warning. Migrate to `.specialist.json`.

---

## Validation workflow

1. Author/update the `.specialist.json` file.
2. Run schema validation:

```bash
# Option A: CLI command (preferred)
specialists validate specialists/my-specialist.specialist.json

# Option B: direct schema validator
bun src/specialist/validate.ts specialists/my-specialist.specialist.json
```

3. Confirm discovery:

```bash
specialists list
```

4. Smoke test run:

```bash
specialists run my-specialist --prompt "ping" --no-beads
```

The validator prints `OK <file>` on success and field-level errors on failure.

---

## Common errors and fixes

| Error (typical) | Cause | Fix |
|---|---|---|
| `Must be kebab-case` | `metadata.name` has spaces/uppercase | use `"my-specialist"` |
| `Must be semver` | version like `"v1.0"` or unquoted `1.0.0` | use `"version": "1.0.0"` |
| `Invalid enum value ... 'READ_WRITE'` | invalid permission tier | use `"READ_ONLY"`, `"LOW"`, `"MEDIUM"`, or `"HIGH"` |
| `Invalid enum value ... 'auto'` on `permission_required` | wrong enum on wrong field | use `"auto"` only for `beads_integration` |
| `Required` on `task_template` | missing prompt template | add `prompt.task_template` |
| `Required` on `model` | missing execution model | add `execution.model` |
| `Required` on `description` | missing metadata description | add `metadata.description` |
| `Required` on `category` | missing metadata category | add `metadata.category` |
| JSON parse error | Missing comma, trailing comma, unquoted key | Run through a JSON linter; all keys and string values must be quoted |
| Valid JSON but poor results | `task_template` never uses `$prompt` | include `$prompt` in template |
| `defaults` key unrecognized | unsupported top-level key | remove `defaults`; pass runtime values via `--variables` |

---

## Context Window & Lifecycle Design

Specialists run as long-lived Pi sessions. Context management is not optional — ignoring it causes silent quality degradation before any hard limit is hit.

### Context rot starts before the window fills

Quality degrades as the context grows — compressed early context causes inconsistency, missed facts, and instruction drift. Design for bounded, coherent runs rather than arbitrarily long ones.

### Model context windows

| Model family | Context window |
|--------------|----------------|
| Gemini 3.1 Pro | 1,000,000 tokens |
| Qwen3.5 / GLM-5 | 128,000 tokens |
| Claude (all) | 200,000 tokens |

### Context health thresholds

| Utilization | Health | Action |
|-------------|--------|--------|
| < 40% | OK | Normal operation |
| 40–65% | MONITOR | Watch for degradation |
| 65–80% | WARN | Consider wrap-up |
| > 80% | CRITICAL | High risk of quality loss |

### Design patterns

1. **Phase-bounded runs**: Split large tasks into discrete phases with explicit completion points
2. **Summarization gates**: Emit structured summaries at phase boundaries for downstream context injection

---

## Script-class authoring

For specialists run through `specialists-service` (HTTP `/v1/generate` or `sp serve`).

Script-class specs are a **subset** of the full schema — same loader, same `parseSpecialist()`, but with runtime constraints enforced by the service's `compatGuard` (`src/specialist/script-runner.ts`). The schema is unchanged; what differs is which combinations the service will accept at request time.

Use this section when authoring specs for `specialists-service`. Use the rest of this guide for full agent-class specs run via `sp run`.

### Required fields (script class)

Same as for any specialist:

- `metadata.name`, `metadata.version`, `metadata.description`, `metadata.category`
- `execution.model` (must be resolvable from the host's `~/.pi/agent/auth.json`)
- `prompt.task_template`

### Constraint-marked fields (the script-class boundary)

The service rejects any spec that doesn't match these at request time with `error_type: "specialist_load_error"`:

| Field | Required value | Reason |
|---|---|---|
| `execution.interactive` | `false` | HTTP request cannot host a multi-turn keep-alive session |
| `execution.requires_worktree` | `false` | The service is stateless; no git branching |
| `execution.permission_required` | `"READ_ONLY"` | Service requests resolve the READ_ONLY catalog and must pass an explicit allowlist before Pi starts |
| `execution.max_retries` | `0` (recommended) | Script-class ignores `max_retries` entirely — value has no effect. Caller (HTTP client / cron) owns retries. Set `0` so the spec's intent matches behavior. |
| `skills.scripts` | omitted or `[]` | Local shell hooks are a host-side capability not available in service mode |

### Optional supported fields

These run unchanged:

- `execution.timeout_ms`, `execution.fallback_model`, `execution.thinking_level`, `execution.response_format` (`"text"` | `"json"` | `"markdown"`)
- `prompt.system`, `prompt.output_schema`
- `metadata.tags`, `metadata.updated`

### Trust flags (script-class security)

By default, `compatGuard` rejects opt-in fields that add host-provided prompt inputs or shell hooks:

| Field | Default | Rejection reason |
|-------|---------|------------------|
| `skills.paths` | rejected | would inject host files into prompt |
| `prompt.skill_inherit` | rejected | same trust concern |
| `skills.scripts` | always rejected by `sp serve` | local shell hooks are unavailable in service mode |

To permit skill inputs, launch `sp serve` with trust flags:

```bash
sp serve --allow-skills --allow-skills-roots /safe/path:/another/safe/path
# Unsupported: sp serve --allow-local-scripts
```

| Flag | Effect |
|------|--------|
| `--allow-skills` | Permits `skills.paths` and `prompt.skill_inherit` |
| `--allow-skills-roots <p1>:<p2>:...` | Restricts permitted skill paths to entries under listed roots (requires `--allow-skills`); **not** a filesystem read boundary |
| `--allow-local-scripts` | Unsupported; `skills.scripts` are always rejected in service/script mode |

When `--allow-skills` is active, each skill path is resolved and hashed after all trusted pre-scripts, immediately before Pi launch. The `status_json.skill_sources` field contains `{path, sha256, source, attestation: "observation_time_only"}` entries. Pi reopens the mutable path when it loads the skill, so this hash is observation-time audit evidence, not proof of the bytes Pi consumed. The exported audit computation represents unreadable files with `sha256: "unreadable"`; the direct/script runtime rejects any such final observation before Pi starts.

Without enabled extension sources, script and service execution resolves the requested permission-tier catalog and passes an explicit tool allowlist. With enabled extension sources, it uses `--no-builtin-tools` and the bundled extension policy to activate only granted native and extension tools. Missing, malformed, unreadable, or empty runtime catalog contracts abort before Pi or model startup (fail-closed). Required pre-script failures return `pre_script_failed` without model fallback or retry, and both raw and rendered preflight output are bounded before inclusion. Trusted direct `sp script` callers can separately opt into local scripts or write-capable tiers; `sp serve` remains READ_ONLY and rejects local scripts. Service-knowledge skill sources use a pinned exact npm spec (e.g. `npm:@jaggerxtrm/pi-service-knowledge@1.10.0`); floating or range specs are rejected.

> **No host-read isolation:** These controls do not create a filesystem read boundary. Specialists 3.21.6 permits only trusted single-tenant use under its bounded waiver; untrusted, public, cross-tenant, and multi-tenant deployment is excluded. The waiver does not authorize publication and expires at 3.21.7.

### Output validation

`prompt.output_schema.required` is checked against `parsed_json` when `response_format: "json"`. Missing keys produce `error_type: "invalid_json"` with a message naming the field. Nested schema is currently warn-only; tracked in `unitAI-xutg2` (passthrough) and the deferred-strict-mode discussion in `docs/design/specialists-service-evaluation.md` §29.

#### `execution.expected_output_keys` — script-surface JSON contract

Script-class specs can ship a JSON contract inline in their script template while using any `response_format`. Without an explicit required-keys check, hallucinated key sets (e.g. `{command, tables}` instead of the contracted `{summary, tags}`) can pass through as `success: true` and the consumer can save corrupt rows.

`execution.expected_output_keys: string[]` triggers a required-keys check independent of `response_format` only on surfaces that call `runScriptSpecialist`, including `sp script` and `sp serve`. `SpecialistRunner.run` (`sp run`) does not read this field. Set it to the keys your script-surface prompt requests:

```json
{
  "specialist": {
    "execution": {
      "response_format": "text",
      "expected_output_keys": ["summary", "tags"]
    },
    "prompt": {
      "task_template": "Output JSON: {summary: string, tags: string[]}\n\nInput: $content"
    }
  }
}
```

Script-surface behavior:

- `runScriptSpecialist` extracts a JSON payload with `extractJsonPayload`, parses it, then verifies every listed key is present.
- On miss, it fails closed with `error_type: "invalid_json"` and a message naming the missing key — the same error consumers already handle for `response_format: "json"` specs.
- If `response_format === "json"` is also set, the keys are unioned with `prompt.output_schema.required`.
- This is intentionally **not** auto-derived from `output_schema`: the cost of mistakenly validating the wrong key set is silent corruption, so authors declare expectations explicitly.
- `sp run` is unchanged and does not enforce or warn on `expected_output_keys`; use `prompt.output_schema` for its advisory output-contract validation.

### Reference example

[`docs/examples/smoke-echo.specialist.json`](examples/smoke-echo.specialist.json) is a minimal working script-class spec. Copy it into a project's `.specialists/user/` to verify a fresh `sp serve` deployment end-to-end.

[`docs/examples/smoke-echo-text-expected-keys.specialist.json`](examples/smoke-echo-text-expected-keys.specialist.json) demonstrates the text-format-with-`expected_output_keys` pattern: ships a JSON contract inline in `task_template`, runs as `response_format: "text"`, and declares `expected_output_keys: ["summary", "tags"]` so hallucinated key sets fail with `error_type: "invalid_json"` instead of being saved.

### Same loader, same edit path

`sp edit <name> specialist.execution.model <new-model>` works identically for script-class specs — the JSON file is round-tripped, no special handling needed.

---

## See also

- [specialists-catalog.md](specialists-catalog.md)
- [workflow.md](workflow.md)
- [specialists-service.md](specialists-service.md) — the HTTP service contract that consumes script-class specs
- [mcp-tools.md](mcp-tools.md)
