---
name: using-specialists
description: >
  Use Specialists as a governed XTRM execution backend for tracked implementation,
  debugging, review, testing, security, documentation, research, and other role-shaped
  work. Use when work already has a durable XTRM contract and benefits from a distinct
  specialist role, supervised job lifecycle, review/fix loop, retained evidence, or an
  advanced Specialists surface such as node/script execution, KPI analysis, or specialist
  definition authoring. Read live `specialists list --full` and `sp help` before relying
  on remembered roles or flags.
version: 4.2
---

# Using Specialists

Specialists is one execution backend inside XTRM. XTRM owns the work contract,
continuity, and system-level coordination. Specialists owns specialist selection,
job execution, retained results, role boundaries, and specialist-specific review loops.

Do not use this skill as a substitute for `/using-xtrm`, `/planning`, or
`/multiplexing`.

## Start from live truth

Before a substantial dispatch:

```bash
specialists list --full
sp help
```

Use subcommand help before exact invocation when a flag matters. The installed CLI and
registry are authoritative. Static examples in this skill are shapes, not a promise that
an old flag still exists.

The current released product supports supervised specialist jobs plus advanced node/script
surfaces. The programme is moving toward the XTRM
`ChainSource -> ChainDefinition -> ResolvedChain -> ChainRun` architecture, but that
generic native chain runtime is not yet a released contract. Do not pretend it is.

## Contract precondition

A specialist receives a durable XTRM work item. The bead must already be a usable
contract before dispatch.

- Read it with `bd show <id>`.
- If it is a draft, incomplete, stale, or contradicted by current code, repair it through
  the XTRM planning/contract workflow before dispatch.
- Do not use an ad-hoc prompt to smuggle missing requirements around the bead.
- The same contract-quality rule applies to every XTRM worker, not only Specialists.

The detailed contract-writing doctrine belongs to `/planning`; Specialists consumes it.

## Choose a specialist when the role adds value

Use a specialist when the task benefits from a bounded role, independent context,
explicit permissions, retained execution evidence, or a review/test/security gate.
Typical roles include explorer, debugger, executor, reviewer, seconder, test roles,
security-auditor, researcher, and documentation/release roles. Resolve the actual list
from the live registry.

Do small, obvious work in the current XTRM agent when delegation would create more
coordination than value. XTRM is multi-agent by design; that does not mean every edit
requires a child agent.

## Basic job lifecycle

```text
contract ready
  -> select live specialist
  -> dispatch against the bead
  -> observe job state/evidence
  -> consume the persisted result
  -> verify findings against current tree/state
  -> run required review/test/security follow-up
  -> publish or hand back through the owning XTRM workflow
```

For exact commands and specialized surfaces, load only the relevant reference:

- `references/chain-recipes.md` — role selection and production-diff review shapes.
- `references/monitoring.md` — waiting, feed/result semantics, keep-alive and failure handling.
- `references/merge-and-integration.md` — current integration/publish behavior.
- `references/registry-and-locations.md` — live registry and source locations.
- `references/dispatch-preconditions.md` — git/worktree prerequisites for dependent work.
- `references/kpi.md` — runtime cost, token/payload, waiting/stall and role/model analysis.
- `references/nodes.md` — NodeSupervisor coordination when `sp node` is intentionally selected.
- `references/script-class.md` — bounded read-only `sp script` / `sp serve` execution.
- `references/specialist-definitions.md` — author/validate Specialist definitions; deterministic
  helpers are under `scripts/specialist-definitions/`.

## Evidence rules

A specialist result is a claim, not live truth.

- Prefer persisted job/result evidence over terminal scraping.
- Verify important claims against the current tree, tests, runtime state, or external
  system before acting on them.
- A terminal state tells you the job stopped; it does not tell you the result is correct.
- Reviewer/seconder findings require a fix loop when valid. Do not reinterpret a failing
  gate as advisory because the implementation looks plausible.
- Classify test failures as in-scope regression, pre-existing failure, or infrastructure
  failure before changing unrelated code.

## Production changes

For a production diff, preserve the project-required review and validation gates. The
current role registry and XTRM chain doctrine decide the exact set; do not reconstruct a
frozen pipeline from memory.

At minimum, make sure the work has implementation/debug evidence, appropriate tests or
explicit test evidence, independent review when required, security review when warranted,
and no unresolved findings hidden by the final summary.

## Dependent waves

Before dispatching work that depends on earlier work, re-derive the base:

```text
working tree clean enough for the next lane
prior required commits/results present
correct branch/worktree selected
no stale job or ownership assumption
```

Stale-base dispatch is a coordination defect. Fix the state before adding another worker.

## Monitoring and continuation

Do not busy-poll. Use the runtime's supported wait/feed/result mechanisms and XTRM
continuation facilities. If the parent session is near its context ceiling, persist the
state and hand off rather than keeping a half-understood specialist swarm alive inside a
failing context window.

General inter-agent messaging and wake/reply semantics belong to `/multiplexing`, not
this skill.

## Native activation is not yet dispatchable

Everything above describes the supervised `sp` job lifecycle. A second runtime — native
activation — hosts a Specialist on an in-process Pi `AgentSession` rather than spawning
`pi` as a subprocess, which lets a child ask a clarifying question and resume instead of
restarting.

**Do not dispatch through it. There is nothing to dispatch through.** It has no CLI
command and no MCP tool; its only live path is a credential-gated integration test. The
operator surface is being built under `unitAI-rrdnt.33`.

Two of its properties change how you write a bead even before it is invocable, because
they are stricter than the `sp` path:

- Admission refuses a bead that is not a complete 7-section contract with a declared
  `SCRUTINY` level, before any model turn is spent. Check `bd state <id> contract` — a
  bead marked `draft` is refused outright.
- A write-capable Specialist gets **no** worktree of its own; it shares the
  coordinator's. Writers are refused entirely today (`unitAI-rrdnt.36` enables them),
  and the exclusion that will make them safe is a writer lease that is implemented but
  not yet wired to anything.

Full reference, including which guarantees are specified but not in force:
`docs/native-activation.md`.

## Advanced surfaces are references, not separate skills

KPI analysis, NodeSupervisor, script-class execution and Specialist definition authoring
are specialized parts of one Specialists execution backend. They remain discoverable
through this root and retain deterministic helper assets, but they do not need four more
active skill triggers. This keeps the default/optional catalog small without deleting the
capabilities.

## What this skill deliberately does not own

- Generic bead/contract authoring -> `/planning` and `/using-xtrm`.
- Session cold-start, context-pressure handoff, resume -> `/starting-and-resuming-work`.
- Native peer/subagent communication -> `/multiplexing`.
- Generic code exploration strategy -> `/gitnexus`.
- Future ChainRun semantics that are not released yet -> current XTRM runtime canon.

The boundary is intentional: one system doctrine, one contract doctrine, and one
Specialists-specific execution doctrine.