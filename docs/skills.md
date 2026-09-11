---
title: Skills Catalog
scope: skills
category: overview
version: 2.0.1
updated: 2026-06-24
synced_at: bf6baf7a
description: Skills shipped in this repo and how they are distributed.
source_of_truth_for:
  - "config/skills/**/*.md"
domain:
  - skills
---

# Skills Catalog

> `sp` is a shorter alias for `specialists`.

Skills are prompt packages that add focused guidance to specialist runs and to local coding-agent sessions.

## Managed skill distribution

Skills are **Category B** filesystem-bound assets. External agent runtimes read them directly from disk, so xtrm-tools owns the canonical snapshot under `.xtrm/skills/default/` and exposes active links through `.claude/skills` and `.pi/skills`.

Check and refresh with xtrm-tools:

```bash
xt doctor --cwd <repo> --json
xt update --repo <repo> --apply
xt update --root <projects-root> --apply
```

User-authored skills belong in the user/active layer used by the local agent setup. Treat `.xtrm/skills/default/` as managed output, not a hand-edited source tree.

## Repo-shipped skills

The package ships the source copies under `config/skills/`. The active `.xtrm/skills/...` files in a project may be refreshed by xtrm-tools.

### `using-specialists`

Location: `config/skills/using-specialists/SKILL.md`

Canonical orchestration doctrine for substantial tracked work. It covers bead contracts, dependency graph shape, conflict-cluster mapping, advisory passes, reviewer rebuttal, debugger-restitch, E2E smoke phases, monitoring cadence, manual publication, and session-end handoff. Use this for multi-step implementation, debugging, reviews, docs sync planning, and specialist orchestration.

### `using-specialists-auto`

Location: `config/skills/using-specialists-auto/SKILL.md`

Autonomous/offline orchestration overlay. It delegates shared mechanics to `using-specialists` and adds auto-mode pacing, per-item loop shape, escalation triggers, and unattended-run discipline.

### `sync-docs`

Location: `config/skills/sync-docs/SKILL.md`

Single-document documentation synchronizer. One invocation must name exactly one doc in SCOPE. It uses drift scans plus bounded report/commit context and must not be treated as a whole-tree docs auditor.

### `releasing`

Location: `config/skills/releasing/SKILL.md`

Release workflow driver. Owns version bump, changelog promotion, build, commit, tag, push, and npm publish. It may dispatch `changelog-keeper` to fill `[Unreleased]` gaps, but `changelog-keeper` itself does not publish.

### `update-specialists`

Location: `config/skills/update-specialists/SKILL.md`

Reconciles specialists/xtrm drift. Current model:

- Category A runtime assets: verify with `sp doctor --check-drift`; prune stale `.specialists/default/` snapshots with `sp prune-stale-defaults`.
- Category B filesystem assets: verify with `xt doctor --cwd <repo> --json`; refresh with `xt update --repo <repo> --apply` or `xt update --root <root> --apply`.

### `specialists-creator`

Location: `config/skills/specialists-creator/SKILL.md`

Guides creation and repair of `.specialist.json` files. Use `sp edit`, presets, `sp view`, and validation instead of hand-written ad-hoc JSON. Always choose models from live `pi --list-models`; do not cargo-cult old examples.

### `setup-specialists`

Location: `config/skills/setup-specialists/SKILL.md`

First-run Specialists setup workflow. Bootstraps `~/.config/specialists/user.json`, checks local Pi models, applies cross-repo `sp edit --global` overrides, and now covers interactive keep-alive defaults plus waiting auto-close settings.

### Other package skills

Additional shipped skills include:

- `using-script-specialists` — synchronous `sp script` / `sp serve` integration guidance
- `using-kpi` — observability SQLite/KPI analysis
- `using-nodes` — NodeSupervisor/coordinator workflow
- service/persona authoring and maintenance skills used by local workflows

Use `find config/skills -maxdepth 2 -name SKILL.md` or `sp list` / specialist definitions to see which skills each specialist loads.

## Referencing a skill from a specialist

In specialist JSON:

```json
{
  "specialist": {
    "skills": {
      "paths": [".xtrm/skills/active/sync-docs/"]
    }
  }
}
```

Some package skills can also be referenced by canonical name when the runtime resolver supports that package-canonical lookup. Prefer existing package examples and validate with:

```bash
sp view <name>
sp config show <name> --resolved
sp validate
```

## See also

- [authoring.md](authoring.md)
- [specialists-catalog.md](specialists-catalog.md)
- [installation.md](installation.md)
- [hooks.md](hooks.md)
