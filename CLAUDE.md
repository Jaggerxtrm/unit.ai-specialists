<!-- BEGIN INJECTED BLOCK -->
## Communication Style

Use controlled, precise, and direct language throughout the work session, including plans, progress updates, analysis, reviews, implementation notes, documentation, handoffs, and final reports. Prefer explicit subjects, active voice, consistent terminology, concrete statements, and logically ordered sentences. Keep the writing natural and concise. Avoid conversational filler, ornamental language, vague qualifiers, unnecessary jargon, and exaggerated certainty.

Adapt the level of rigor to the context. Use clear technical prose for analysis, architecture, debugging, design discussion, and collaboration. Use a stricter ASD-STE100-oriented style for procedures, commands, migrations, deployments, security requirements, destructive operations, rollback instructions, acceptance criteria, and operator handoffs. In these cases, state conditions before actions, identify the responsible actor, express one principal action per sentence, preserve the required sequence, and describe expected results and failure conditions explicitly.

Clearly distinguish verified facts, observations, assumptions, inferences, recommendations, and unresolved questions. Do not report an action as successful without evidence. Preserve exact names for repositories, services, contracts, routes, identifiers, configuration fields, and work items. Do not omit material ownership, dependencies, risks, preconditions, rollback requirements, or verification criteria for the sake of brevity.

## Task Tracking (two-tier)

Two task systems coexist in this repo. Use both; do not substitute one for the other.

- **Beads (`bd`)** — top-level durable tracking. Authoritative for ownership, dependencies, cross-session memory, and closure. Read the rest of this file and run `bd prime` for beads context before starting work. File, claim, and close work here.
- **Native integrated task system** (`TaskCreate` / `TaskList` / `TaskGet` / `TaskUpdate` / `TaskExecute`) — this-session execution tracking. Use it to mirror the active bead and break it into smaller intermediate steps. Ephemeral; does not replace beads.

Rule: when you pick up a bead, create native tasks that track it — reference the bead ID in each task title (e.g. `N.N summary — status (worker %NNNN)`) — and add any smaller intermediate steps as native sub-tasks. Beads own the durable record; native tasks own the in-flight breakdown.

Example native task list mirroring beads:
- ◼ N.N smoke container global surface — BLOCKS RELEASE (worker %NNNN)
- ◼ N.N status test flake under load (worker %NNNN)
- ◻ Pre-release smoke run against current main branches
- ◻ Dispatch N.N stale doc metrics + N.N Claude inbox surface
- ◻ Dispatch N.N, N.N, N.N remaining small beads
<!-- END INJECTED BLOCK -->

<!-- xtrm:start -->
# XTRM Agent Workflow

> Full reference: [XTRM-GUIDE.md](XTRM-GUIDE.md) | Session manual: `/using-xtrm` skill
> Run `bd prime` at session start (or after `/compact`) for live beads workflow context.

## Session Start

1. `bd prime` — load workflow context and active claims
2. `bd memories <keyword>` — retrieve memories relevant to today's task
3. `bd recall <key>` — retrieve a specific memory by key if needed
4. `bv --robot-triage` — graph-aware triage: ranked picks, unblock targets, project health
5. `bd update <id> --claim` — claim before any file edit

## Execution Interaction Policy

- Proceed by default on standard implementation tasks once scope is clear.
- Do **not** ask repetitive “Proceed? Yes/No” confirmations.
- Ask for confirmation only when actions are destructive, irreversible, or high-risk (e.g. `rm`, history rewrite, mass deletes, credential rotation, prod-impacting ops).
- Prefer concise clarifying questions only when requirements are genuinely ambiguous.

## Active Gates (hooks enforce these — not optional)

| Gate | Trigger | Required action |
|------|---------|-----------------|
| **Edit** | Write/Edit without active claim | `bd update <id> --claim` |
| **Commit** | `git commit` while claim is open | `bd close <id>` first, then commit |
| **Stop** | Session end with unclosed claim | `bd close <id>` |
| **Memory** | `bd close <id>` without issue ack | First run `bd remember "<insight>"` (or decide nothing novel), then `bd kv set "memory-acked:<id>" "saved:<key>"` or `"nothing novel:<reason>"`, then retry `bd close <id> --reason="..."` (Stop hook remains fallback reminder) |
| **Dispatch** *(bridge — discipline only, not yet hook-enforced)* | Specialist run against a `contract:draft` bead | Promote first: explore + rewrite full 7-section contract + `bd set-state <id> contract=ready --reason "..."`. Check with `bd state <id> contract` before dispatch. |

## bd Command Reference

```bash
# Work discovery
bd ready                               # Unblocked open issues
bd show <id>                           # Full detail + deps + blockers
bd list --status=in_progress           # Your active claims
bd query "status=in_progress AND assignee=me"  # Complex filter
bd search <text>                       # Full-text search across issues

# Claiming & updating
bd update <id> --claim                 # Claim (sets you as owner, status→in_progress)
bd update <id> --append-notes "..."     # Append to existing notes
bd update <id> --notes "..."           # Replace notes (use --append-notes to append)
bd update <id> --status=blocked        # Mark blocked
bd update                              # Update last-touched issue (no ID needed)

# Creating
bd create --title="..." --description="..." --type=task --priority=2
# --parent <bead-id>                    nest as <id>.1, .2, … (recursive: .1.1) — default whenever this bead
#                                        services another bead's work, not only epics
# --labels contract:draft               capture-for-later: real PROBLEM + rough SCOPE, rest TBD — never dispatchable
#                                        until promoted (`bd set-state <id> contract=ready`); see using-specialists
# --deps "discovered-from:<parent-id>"  link follow-ups to source
# priority: 0=critical  1=high  2=medium  3=low  4=backlog
# types: task | bug | feature | epic | chore | decision

# Closing
# Memory gate: ack per issue before close
#   bd kv set "memory-acked:<id>" "saved:<key>"  OR  "nothing novel:<reason>"
bd close <id>                          # Close issue (blocked until memory-acked:<id> exists)
bd close <id> --reason="Done: ..."     # Close with context
bd close <id1> <id2> <id3>            # Batch close (each id needs its own memory ack)

# Dependencies
bd dep add <issue> <depends-on>        # issue depends on depends-on (depends-on blocks issue)
bd dep <blocker> --blocks <blocked>    # shorthand: blocker blocks blocked
bd dep relate <a> <b>                  # non-blocking "relates to" link
bd dep tree <id>                       # visualise dependency tree
bd blocked                             # show all currently blocked issues

# Persistent memory
bd remember "<insight>"                # Store across sessions (project-scoped)
bd memories <keyword>                  # Search stored memories
bd recall <key>                        # Retrieve full memory by key
bd forget <key>                        # Remove a memory

# Health & pre-flight
bd stats                               # Open/closed/blocked counts
bd preflight --check                   # Pre-PR readiness (lint, tests, beads)
bd doctor                              # Diagnose installation issues
```

## Git Workflow (strict: one branch per issue)

```bash
git checkout -b feature/<issue-id>-<slug>   # or fix/... chore/...
bd update <id> --claim                       # claim before any edit
# ... write code ...
bd close <id> --reason="..."                 # closes issue
xt end                                       # push, PR, merge, worktree cleanup
```

**Never** continue new work on a previously used branch.

## bv — Graph-Aware Triage

bv is a graph-aware triage engine for the beads issue board. Use it instead of `bd ready` when you need ranked picks, dependency-aware scheduling, or project health signals.

> **CRITICAL: Use ONLY `--robot-*` flags. Bare `bv` launches an interactive TUI that blocks your session.**

```bash
bv --robot-triage             # THE entry point — ranked picks, quick wins, blockers, health
bv --robot-next               # Single top pick + claim command (minimal output)
bv --robot-triage --format toon  # Token-optimized output for lower context usage
```

**Scope boundary:** bv = *what to work on*. `bd` = creating, claiming, closing issues.

| Command | Returns |
|---------|---------|
| `--robot-plan` | Parallel execution tracks with unblocks lists |
| `--robot-insights` | PageRank, betweenness, HITS, cycles, critical path |
| `--robot-forecast <id\|all>` | ETA predictions with dependency-aware scheduling |
| `--robot-alerts` | Stale issues, blocking cascades, priority mismatches |
| `--robot-diff --diff-since <ref>` | Changes since ref: new/closed/modified |

```bash
bv --recipe actionable --robot-plan    # Pre-filter: ready to work
bv --robot-triage --robot-triage-by-track  # Group by parallel work streams
bv --robot-triage | jq '.quick_ref'   # At-a-glance summary
bv --robot-insights | jq '.Cycles'    # Circular deps — must fix
```

## Code Intelligence (mandatory before edits)

Use **GitNexus** MCP tools before touching any symbol:
- `gitnexus_impact({target: "symbolName", direction: "upstream"})` — blast radius
- `gitnexus_context({name: "symbolName"})` — callers, callees, execution flows
- `gitnexus_detect_changes()` — verify scope before every commit
- `gitnexus_query({query: "concept"})` — explore unfamiliar areas

Stop and warn the user if impact returns HIGH or CRITICAL risk.

## Quality Gates (automatic)

Run on every file edit via PostToolUse hooks:
- **TypeScript/JS**: ESLint + tsc
- **Python**: ruff + mypy

Gate output appears as hook context. Fix failures before proceeding — do not commit with lint errors.

## Worktree Sessions

- `xt claude` — launch Claude Code in a sandboxed worktree
- `xt end` — close session: commit / push / PR / cleanup
<!-- xtrm:end -->

# Project: specialists

> Skills are loaded on demand — don't duplicate skill content here.
> If a section grows past 30 lines, it probably belongs in a skill.

## Session start

```bash
bd prime                        # workflow context + active claims
bv --robot-triage --format toon # ranked work + project health
bd update <id> --claim          # claim before any file edit
```

`bv` ONLY with `--robot-*` flags — bare `bv` opens a TUI and blocks the session.

## Active gates (hooks enforce — not optional)

| Gate | Trigger | Required action |
|------|---------|-----------------|
| Edit | Write/Edit without active claim | `bd update <id> --claim` |
| Commit | `git commit` while claim is open | `bd close <id>` first |
| Memory | `bd close <id>` without ack | `bd remember "..."` then `bd kv set "memory-acked:<id>" "saved:<key>"` (or `"nothing novel:<reason>"`) then close |
| Stop | Session end with unclosed claim | `bd close <id>` |

## Execution policy

- Proceed by default once scope is clear. No repetitive "Proceed? Yes/No" prompts.
- Confirm only for destructive/irreversible/high-risk actions (rm, history rewrite, mass deletes, credential rotation, prod ops).
- Ask only when requirements are genuinely ambiguous.

## Branching

```bash
git checkout -b feature/<issue-id>-<slug>   # fix/... chore/... etc.
# work, close bead, commit
xt end                                      # push + PR + merge + worktree cleanup
```

Never continue new work on a previously used branch.

## Code intelligence (mandatory before edits)

Before modifying any function/class/method:
- `gitnexus_impact({target: "X", direction: "upstream"})` — blast radius
- `gitnexus_context({name: "X"})` — callers/callees/flows
- `gitnexus_detect_changes()` before commit

Use GitNexus for graph-aware navigation and impact analysis. Use the runtime's native read and edit tools for file operations. Stop and warn if impact returns HIGH/CRITICAL.

## Quality gates (automatic on edit)

| Language | Tools |
|---|---|
| TS/JS | ESLint + tsc |
| Python | ruff + mypy |

Hook output appears as context. Fix failures before committing.

## Skills (load on demand)

| When | Skill |
|---|---|
| Specialist orchestration (run/review/merge) | `/using-specialists` |
| Specialist authoring (`.specialist.json`) | `/specialists-creator` |
| Worktree session lifecycle | `/using-xtrm`, `/xt-end`, `/xt-merge` |
| Code exploration / impact / debugging / refactoring | `/gitnexus-exploring`, `/gitnexus-impact-analysis`, `/gitnexus-debugging`, `/gitnexus-refactoring` |
| GitNexus CLI (analyze/index/wiki) | `/gitnexus-cli` |
| Pre-PR review / security review | `/review`, `/security-review` |
| Release | `/releasing` |
| Session close | `/session-close-report` |
| Plan a feature/epic from scratch | `/planning` |
| Premortem a plan | `/premortem` |

Run `bd memories <keyword>` or `bd recall <key>` for prior insights before substantial work.

## Specialist orchestration in one paragraph

`--bead` is the prompt — don't run a specialist until the bead is a usable task contract (PROBLEM / SUCCESS / SCRUTINY / SCOPE / NON_GOALS / CONSTRAINTS / VALIDATION / OUTPUT). Edit-capable specialists auto-provision a worktree from `--bead`. Reviewer reuses the executor workspace via `--job <exec-job>` — `--worktree` and `--job` are mutually exclusive. Keep executor/debugger jobs alive with `--keep-alive` so they're resumable. Default `--context-depth` is 3. **Merge via manual git workflow (Cherry-Pick Playbook or `git merge --no-ff`)** — `sp merge` and `sp epic merge` are prohibited (known broken, awaiting separate rework epic). Per-turn output auto-appends to bead notes; `bd show <id>` is the canonical way to read a handoff. Full reference: `/using-specialists`.

## Common gotchas (project-specific)

- **Merge is manual.** `sp merge` and `sp epic merge` are prohibited (rule #9 in `/using-specialists`). Use `git merge --no-ff feature/<bead>` for per-chain merges, or `git update-ref` for FF-equivalent when checkout is blocked by transient `.beads/issues.jsonl` churn. Cherry-Pick Playbook is the canonical multi-chain path.
- **Closing keep-alive specialists.** No `sp finalize` cascade — close each waiting job explicitly with `sp stop <job-id>` after reviewer PASS. Verify with `sp ps` first.
- **`--worktree` and `--job` are mutually exclusive.** First executor: `--worktree`. Reviewer/fix: `--job <exec-job>`.
- **Canonical QA+Iron pipeline is mandatory on production diffs.** Shape (canon `docs/design/chain-templates.md` §2.1): writer → **seconder** (fused dual-verdict scope+quality gate; emits `scope_verdict`/`quality_verdict`/`overall_verdict`) → **test-engineer** (authors tests from the diff) → **test-runner** (runs exact commands + classifies failures by owner) → security-auditor (if sensitive surface) → **obligations-scanner** (TODO/FIXME/HACK scan) → reviewer (phase-2 adversarial + Release Checklist). Skip seconder/obligations only for test-only or new-file-only diffs. Reviewer auto-escalates SCRUTINY on sensitive surfaces (auth, config/specialists, lockfiles, migrations, permissions/hooks).
- **Git State Precondition before any dependent chain dispatch.** `git status` clean + HEAD contains prior chain commits + no orphaned worktrees. Stale-base dispatch → guaranteed debugger-restitch loop. The dispatcher fetch-and-pins the base and refuses with a `stale_base` envelope; override via `sp run ... --accept-stale-base --reason "<text>"` (or pin explicitly with `--base-sha <sha>` / `--base-ref <branch>`). `--force-stale-base` is deprecated.
- **PR/job attention surfaces.** `specialists doctor --pr-drift` refreshes PR classifications (`clean | needs-rebase | conflicted | blocked | stale | unknown`) via `gh pr view` when `pr_drift_checked_at_ms` is stale (> 5 min) or null; `sp ps --needs-attention` (or `--json` → `attention_reasons[]`) filters to non-clean jobs. After container/host restarts, `specialists doctor --reap-dead-jobs [--dry-run] [--json]` cancels orphan rows (`container-restart-orphan`) and emits `xtrm.forensic.v1 lifecycle.dead_declared`.
- **GitNexus index goes stale on commit.** PostToolUse hook normally re-indexes after `git commit`/`git merge`; if not, `npx gitnexus analyze` (add `--embeddings` only if `.gitnexus/meta.json` shows `stats.embeddings > 0`).
- **`bd close` itself does not block.** Stop hook blocks only after a successful `bd close` in same session, and only when hook can resolve issue id from `claimed:<sessionId>`, `closed-this-session:<sessionId>`, or branch name. If `bd show` fails, gate fails open. Each id in batch needs its own ack before session stop.
- **bd auto-export keeps re-staging `.beads/issues.jsonl`** after every bd op. `.git/info/exclude` blocks `git add` but the already-tracked staged change can still be committed. Stale `.git/index.lock` from bd hooks is safe to `rm -f` when no real git process is running.
- **Specialists are JSON** (`config/specialists/<name>.specialist.json`) — YAML is a deprecated legacy fallback (`loader.ts:101 deprecatedYaml`).
- **Package-tier specialists need direct JSON edit** (not `sp edit` — that's user-tier only). Use `jq -e` to validate after edit. `specialists list --full` to confirm registry sees the change.
- **Edit-capable specialists that CREATE files need permission HIGH, not MEDIUM.** Runtime: `write` (create new files) → HIGH only; `edit` (modify existing) → MEDIUM (`src/specialist/runner.ts:236-237`, `schema.ts:32-33`). A file-authoring specialist (e.g. test-engineer) set to MEDIUM fails pre-run validation at 0s (`tool "write" requires higher permission`). **`sp validate` does NOT catch this — only a live dispatch does.** Enforce a "no production-source edits" boundary via `prompt` + `inline_rules`, never by lowering the tier.

## Commit messages ARE the changelog

`CHANGELOG.md` is generated from commits by git-cliff (`changelog/cliff.toml`). Write the
commit once; never hand-write a changelog entry for the same change.

| Prefix | Lands in |
|---|---|
| `feat:` | **Added** |
| `fix:` | **Fixed** |
| `perf:` | **Performance** |
| `revert:` | **Reverted** |
| `docs: chore: build: ci: test: refactor: style:` | **Project maintenance** |
| `checkpoint:` `merge:` `release:` `bump:` | *skipped — never in the changelog* |
| anything else | **Other changes** ← means "you used a prefix with no parser". Fix the message or add a parser. |

**The commit BODY is rendered into the changelog verbatim** (indented under the bullet), so
put the real rationale there — what broke, why, bead id, PR. That body is the changelog entry.
Keep the subject one line, imperative, no trailing period.

Release regenerates with `git-cliff --config changelog/cliff.toml --prepend CHANGELOG.md --unreleased`.
**Never** run git-cliff with `-o` / plain generate on this repo — it rebuilds from the git log and
drops every hand-written line (measured: 362 lines would be lost).

## Project-specific

- gzrx manifest system: see `docs/design/gzrx-tool-catalog.md` (canonical), `docs/design/gzrx-completion-critique.md` (gap analysis), bead `unitAI-qujxo` (completion epic).
- Specialists project guide / runtime architecture / key files: `docs/ARCHITECTURE.md`, `docs/cli-reference.md`, `docs/features.md`.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **specialists** (16684 symbols, 39758 relationships, 813 execution flows).

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact before editing.** Use `impact({target: "symbolName", direction: "upstream"})` or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .`; report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check — a zero means unseen, not unaffected; re-run it. For regression review: `detect_changes({scope: "compare", base_ref: "master"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "master" --repo .`.
- MUST warn on HIGH/CRITICAL `risk` pre-edit; never use `riskSharedAxes` to waive a HIGH/CRITICAL `risk` warning. Compare File/symbol: MCP File omits axes; Graph-RAG expands File.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- **MUST use `query({search_query: "concept"})` for concepts/flows, `context({name: "symbolName"})` for a named symbol, or `impact` for blast radius, on read-only callers, dependencies, imports, or execution flow.** Graph first; text search only for empty/`UNKNOWN`/literals.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read `UNKNOWN` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/specialists/context` | Codebase overview, check index freshness |
| `gitnexus://repo/specialists/clusters` | All functional areas |
| `gitnexus://repo/specialists/processes` | All execution flows |
| `gitnexus://repo/specialists/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
