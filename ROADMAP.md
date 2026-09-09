# Specialists Roadmap

> Tracked in [beads](https://github.com/steveyegge/beads) — epic `unitAI-8ou`
> QA source: `docs/qa-v3.0.2.md`

---

## Bugs (from QA v3.0.2)

| ID | Priority | Description |
|----|----------|-------------|
| `unitAI-0ef` | P1 🔴 | **SIGTERM doesn't update job status** — `stop` kills pi but `status.json` stays `running` forever (EPIPE crash, no watcher) |
| `unitAI-hgo` | P2 🟡 | **`specialists install` is silent** — zero output; can't verify what was installed |
| `unitAI-kwb` | P2 🟡 | **Active Jobs absent when queue is empty** — section hidden when there are no jobs |
| `unitAI-7s6` | P2 🟡 | **`specialists init` missing dirs** — `.specialists/jobs/` and `ready/` not created upfront |
| `unitAI-tv3` | P3 🟢 | **`specialists status --job <id>` not implemented** — shows full table instead of single-job detail |
| `unitAI-mk5` | P4 ⚪ | **`ready/` markers accumulate between messages** — low impact, cosmetic |

---

## Features

### P1 — Bead integration depth (dependency chain)

These must be done in order. `unitAI-fgy` unblocks everything below it.

```
unitAI-fgy  bead_id in status.json at creation
    └── unitAI-iuj  pin specialist output to bead
            ├── unitAI-6op  Dolt-backed run summaries (replace flat dirs)
            ├── unitAI-c64  memory curator specialist
            └── unitAI-hos  commit/PR provenance hook
```

| ID | Feature |
|----|---------|
| `unitAI-750` | **Dependency-aware context injection** — blocker outputs auto-injected into prompt at configurable depth; dep graph becomes workflow graph; no manual context threading |
| `unitAI-55d` | **`specialists run --bead <id>`** — bead IS the prompt; orchestrator writes once, not twice; input bead vs tracking bead distinction; deps linked automatically |
| `unitAI-fgy` | **Write `bead_id` into `status.json` at job creation** — prerequisite for all below; currently only written at completion |
| `unitAI-iuj` | **Pin specialist output to bead on completion** — `bd update <bead_id> --notes '<output>'` + prompt hash + git SHA; bead becomes a knowledge artifact, not just a timestamp receipt |
| `unitAI-6op` | **Dolt-backed run summaries** — flush completed runs into Dolt; keep flat files only for hot-path streaming; enables cross-session SQL queries, `dolt push/pull` for sharing run history |
| `unitAI-c64` | **Memory curator specialist** — READ_ONLY; queries closed specialist beads, diffs against `bd memories`, emits targeted `bd remember` calls, flags contradictions |
| `unitAI-hos` | **Commit/PR provenance hook** — PostToolUse:Bash auto-wires `--external-ref gh-<n>` to active bead on `git commit` / `gh pr create` |

### P1 — Infrastructure & quality

| ID | Feature |
|----|---------|
| `unitAI-f3t` | **SessionStart hook** — injects active jobs + available specialists into every new session (like `bd prime`) |
| `unitAI-2v1` | **Skills installation** — `specialists install` installs `specialists-usage` skill |
| `unitAI-7d0` | **`specialists setup`** — writes workflow block into AGENTS.md/CLAUDE.md (`--project` / `--global`) |
| `unitAI-pjx` | **Force memory judgment on `bd close`** — blocking gate requiring agent to evaluate memory worth; auto-extract bypasses judgment |
| `unitAI-9re` | **`specialists feed -f` global live feed** — all jobs simultaneously, color per job, bead status inline, auto-discovers new jobs |
| `unitAI-xr1` | **Hook audit** — verify all 6 hooks: schema compliance, exit codes, output format, timeouts, graceful degradation |
| `unitAI-msh` | **Comprehensive docs** — every component in README.md with diagrams (schema, CLI, session lifecycle, supervisor, MCP, hooks, beads, skills) |

### P2 — CLI & polish

| ID | Feature |
|----|---------|
| `unitAI-9xa` | **`specialists clean`** — purge old job dirs; `--all`, `--keep <n>`, `--dry-run`; short-term fix while Dolt migration proceeds |
| `unitAI-3n1` | **Reduce hook verbosity** — ≤2 lines passing case, no repeated protocol text, <100ms per hook |
| `unitAI-1vt` | **Project-local hook installation** — `specialists init` / `specialist_init` MCP write to `.claude/settings.json` in project root |
| `unitAI-ln6` | **Per-command `--help`** — usage, flags, examples for every subcommand |
| `unitAI-qls` | **`specialists quickstart`** — rich getting-started guide |
| `unitAI-55j` | **YAML schema docs** — full `.specialist.yaml` field reference |
| `unitAI-npo` | **CLI polish** — `--json` flag, command categories, `--verbose`, consistent exit codes |
| `unitAI-z0n` | **`specialists doctor`** — health check + auto-fix hints |

---

## Architecture notes

### Background job lifecycle (v3)

```
specialists run <name> --background
  → Supervisor.run()
    → writes status.json  { status: starting, pid, bead_id (once created) }
    → runner.run() → creates bead → onBeadCreated → updateStatus({bead_id})
    → pi runs, streams events.jsonl
    → on done: writes result.txt, updateStatus(done), touches ready/<id>
    → [TODO unitAI-iuj] bd update <bead_id> --notes '<output>'
  → prints "Job started: <id>", exits

UserPromptSubmit hook (specialists-complete.mjs)
  → injects "[Specialist '<name>' completed …]" banner, deletes marker
```

### Known SIGTERM gap (unitAI-0ef)

When `specialists stop` sends SIGTERM to pi:
1. pi tries to flush final event → EPIPE (parent pipe closed)
2. pi crashes; no parent watcher → `status.json` stays `"running"` forever

**Fix:** keep supervisor alive as thin watcher until pi exits, trap `close` event, write final status.

### Bead as knowledge artifact (unitAI-fgy → unitAI-iuj)

Current bead record after a completed run:
```
COMPLETE  19373ms  anthropic/claude-haiku-4-5
```

Target bead record:
```
COMPLETE  19373ms  anthropic/claude-haiku-4-5
notes:    <full specialist output>
metadata: prompt_hash=a3f2dd14  commit=894bca4  pr=31
```

### Full provenance chain (unitAI-hos)

```
user prompt
  → specialists run → bead created (unitAI-fgy)
  → output pinned to bead (unitAI-iuj)
  → git commit → hook auto-adds commit SHA to bead
  → gh pr create → hook auto-adds PR number to bead
  → merged → bead record is permanent Dolt history

Query: "all specialist runs that led to merged PRs this week"
  → bd list --label specialist --status closed
  → filter by external-ref matching gh-* merged PRs
  → read output from notes field
```

### Memory curator loop (unitAI-c64)

```
specialists run memory-curator --prompt "Review runs since <date>"
  → bd list --label specialist --status closed
  → read notes field from each bead
  → diff against bd memories
  → bd remember "<stable insight>"     (new knowledge)
  → bd update <mem_id> --notes "..."   (update existing)
  → flag contradictions for human review
```

### Hook inventory (v3.0.2)

| Hook | Event | Purpose |
|------|-------|---------|
| `specialists-main-guard.mjs` | PreToolUse | Block direct edits to master; enforce PR workflow |
| `beads-edit-gate.mjs` | PreToolUse | Require in_progress bead before file edits |
| `beads-commit-gate.mjs` | PreToolUse | Require issues closed before `git commit` |
| `beads-stop-gate.mjs` | Stop | Require issues closed before session end |
| `beads-close-memory-prompt.mjs` (planned, never shipped — roadmap-only mention, no file) | PostToolUse(Bash) | Planned nudge for knowledge capture after `bd close` (→ blocking gate: unitAI-pjx); never implemented |
| `specialists-complete.mjs` | UserPromptSubmit | Inject completion banners for background jobs |

**Missing:** SessionStart (`unitAI-f3t`). Project-local install (`unitAI-1vt`). Provenance hook (`unitAI-hos`).
