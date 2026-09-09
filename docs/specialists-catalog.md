---
title: Specialists Catalog
scope: specialists-catalog
category: overview
version: 2.1.0
updated: 2026-06-23
synced_at: bf6baf7a
description: Current package-canonical specialists and what each one is for.
source_of_truth_for:
  - "config/specialists/*.specialist.json"
  - ".specialists/default/*.specialist.json"
  - ".specialists/user/*.specialist.json"
domain:
  - specialists
---

# Specialists Catalog

Runtime resolution is layered and package-canonical by default:

1. `.specialists/user/` — repo custom specialists and overrides, highest precedence
2. `.specialists/default/` — optional pins / compatibility snapshots
3. package-canonical `config/specialists/` — installed package fallback
4. legacy paths — migration compatibility only

Fresh repositories normally do not need `.specialists/default/` populated. Use `sp doctor --check-drift` and `sp prune-stale-defaults` to remove stale default snapshots; use `.specialists/user/` for intentional customization.

## Current package specialists

Run `sp list` for the live merged registry, including user-local specialists. The table below reflects package-canonical `config/specialists/*.specialist.json` at the current release.

| Name | Version | Model | Permission | Keep-alive | Typical use |
|---|---:|---|---|---|---|
| `bare` | 1.0.0 | user-configured | READ_ONLY | user-configured | Minimal read-only specialist for trusted-mode RPC; no mandatory rules. |
| `changelog-drafter` | 1.0.0 | user-configured | READ_ONLY | user-configured | Read-only bundle synthesis for `xt release prepare`; no publishing or edits. |
| `changelog-keeper` | 3.0.0 | user-configured | MEDIUM | user-configured | Fill sparse `[Unreleased]` sections from xt reports and commits; edits `CHANGELOG.md` only. |
| `debugger` | 2.0.0 | user-configured | HIGH | user-configured | Root-cause symptoms, regressions, flaky tests, and unknown-cause bugs before executor. |
| `executor` | 1.0.0 | user-configured | HIGH | user-configured | Implement already-scoped code or docs changes in an isolated worktree. |
| `explorer` | 1.1.0 | user-configured | READ_ONLY | user-configured | Map architecture, call flows, dependencies, and implementation options without edits. |
| `node-coordinator` | 1.3.0 | user-configured | LOW | user-configured | Drive NodeSupervisor research-node runs through `sp node` commands. |
| `obligations-scanner` | 1.0.0 | user-configured | READ_ONLY | user-configured | Scan source for unmet obligations (TODO, FIXME, XXX, HACK) and emit actionable reports. |
| `overthinker` | 1.0.0 | user-configured | READ_ONLY | user-configured | Deep reasoning, tradeoff review, premortems, architecture critique. |
| `planner` | 1.1.0 | user-configured | HIGH | user-configured | Turn broad initiatives into phased bead boards with dependencies and tests. |
| `quant-methodologist` | 1.0.0 | user-configured | LOW | user-configured | Design quantitative research methodologies, backtesting frameworks, and statistical validation. |
| `quant-researcher` | 1.0.0 | user-configured | LOW | user-configured | Research quantitative models, market microstructure, and alpha signals. |
| `researcher` | 1.3.0 | user-configured | MEDIUM | user-configured | Current library/API docs, GitHub examples, and ecosystem evidence. |
| `reviewer` | 2.0.0 | user-configured | MEDIUM | user-configured | Compliance review of executor/debugger output via `--job`; emits PASS/PARTIAL/FAIL. |
| `seconder` | 1.0.0 | user-configured | READ_ONLY | user-configured | Smell pass after executor and before reviewer. |
| `security-auditor` | 1.0.0 | user-configured | LOW | user-configured | Threat modeling, secure-code review, dependency advisory triage; recommendations only. |
| `service-knowledge-sync` | 1.6.0 | user-configured | MEDIUM | user-configured | Sync service-oriented skill packages and drift detection across service boundaries. |
| `specialists-creator` | 1.4.1 | user-configured | HIGH | user-configured | Create/fix `.specialist.json` definitions and validate schema/model choices. |
| `sync-docs` | 3.1.0 | user-configured | MEDIUM | user-configured | Sync exactly one documentation file from scoped report/commit context. |
| `test-engineer` | 1.0.0 | user-configured | HIGH | user-configured | Write/update tests, fixtures, smoke/E2E harnesses, and telemetry assertions from actual implementation diff; no production fixes. |
| `test-runner` | 2.0.1 | user-configured | LOW | user-configured | Execute exact requested test commands first, fall back to manifest-detected suites only when needed, capture evidence, classify failures by owner; no fixes. |
| `transcriber` | 1.6.0 | user-configured | MEDIUM | user-configured | Transcribe audio/video content and generate searchable structured output. |
| `xt-merge` | 1.1.0 | user-configured | MEDIUM | user-configured | Drain xt worktree PR queues with CI/rebase/conflict handling. |

## Notable release highlights

- **Package specialists ship with `null` model and keep-alive.** v3.16+ (commit `60b33412`) removed hardcoded models and keep-alive from all package-canonical specialist definitions. Model selection and session persistence are now user-environment-specific via orchestrator config merge; see [KAN-90 upgrade notes](upgrade-notes/kan-90-global-user-config.md).
- **`reviewer` v2.0 is phase-2-only.** The former phase-1 reviewer responsibilities merged into `seconder` v1.0; reviewer now handles only final compliance sign-off.
- **`researcher` v1.3 adds web pipeline (Mode 4).** Includes DDGS + agent-browser for current web queries beyond static library docs.
- **New quantitative specialists** `quant-methodologist` and `quant-researcher` v1.0.0 added for financial/quantitative research workflows.
- **New supporting specialists:** `transcriber` v1.6.0 (media transcription), `service-knowledge-sync` v1.6.0 (cross-service drift detection), `obligations-scanner` v1.0.0 (TODO/FIXME tracking), and `bare` v1.0.0 (minimal trusted-mode RPC).
- **`sync-docs` v3.1 is single-doc only.** One bead scope must name exactly one doc. It is not a broad docs-tree auditor.
- **`test-engineer` v1 writes tests from actual diff evidence.** It is ambidextrous for `test-only` and `code-with-tests` chains, creates/updates test assets only, emits exact `test-runner` commands, and routes source bugs back to debugger/executor.
- **`test-runner` v2.0.1 is exact-command first.** It prefers orchestrator/test-engineer command lists, falls back to manifest-detected suites only when no exact command is provided, and reports owner-routed failures with evidence.
- **`test-runner` v2 is polyglot.** It detects `package.json`, Python, Rust, and Go manifests and runs the appropriate test command.
- **`changelog-keeper` v3 is file-scoped.** It fills `CHANGELOG.md` gaps only; version bump/build/tag/publish are owned by the release skill flow.
- **`seconder` and `security-auditor` are advisory passes.** They provide evidence and findings before final reviewer PASS.

## Discover current runtime catalog

```bash
sp list
sp list --compact
sp list --json
sp list-rules
```

## Tool resolution

The `Permission` column is the input tier to the manifest-driven tool resolver. Runtime tools are computed from the tier plus package/user catalogs and any per-specialist `permissions[<TIER>]` override.

Inspect a resolved specialist:

```bash
sp config show <name> --resolved
```

See [manifest.md](manifest.md) for resolution semantics and override policy.

## See also

- [manifest.md](manifest.md)
- [authoring.md](authoring.md)
- [workflow.md](workflow.md)
- [skills.md](skills.md)
