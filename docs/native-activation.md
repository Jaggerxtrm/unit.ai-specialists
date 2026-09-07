---
title: Native Activation Runtime
scope: native-activation
category: guide
version: 0.1.0
updated: 2026-09-07
synced_at: 5bdff6b5
description: What the native Specialist activation runtime does today, what it refuses, and which of its guarantees are not yet in force.
source_of_truth_for:
  - "src/activation/native-host.ts"
  - "src/activation/bead-gate.ts"
  - "src/activation/workspace-lease.ts"
  - "src/activation/interaction.ts"
  - "src/activation/ask-tool.ts"
domain:
  - activation
  - specialists
---

<!-- INDEX -->
| Section | Summary |
|---|---|
| [Status](#status-read-this-first) | What ships, what does not, and how to invoke it today |
| [What it is](#what-it-is) | The runtime seam, and how it differs from `sp run` |
| [Admission](#admission-what-gets-refused-before-a-model-turn) | The four gates a dispatch passes, in order |
| [Workspaces and worktrees](#workspaces-and-worktrees) | Why a native Specialist does not get its own worktree |
| [The writer lease](#the-writer-lease) | Specified, tested, and not yet in force |
| [Results are not messages](#results-are-not-messages) | The distinction the runtime exists to preserve |
| [Asking without restarting](#asking-without-restarting) | Clarification versus restart |
| [Forensics](#forensics) | One store, one query, and the vocabulary gap |
| [Known holes](#known-holes) | Every unclosed gap, with its bead |

# Native Activation Runtime

## Status — read this first

The native activation runtime is **not operator-invocable today**. There is no CLI
command, no MCP tool, and no export from `src/lib.ts` or `src/index.ts` that starts a
native activation. `NativeActivationHost` has no production consumer: every reference to
it outside its own module is a test.

The only way to run one is the gated live smoke, which is a test harness and not an
operator surface:

```bash
SPECIALISTS_LIVE_SMOKE=1 \
SPECIALISTS_LIVE_SMOKE_MODEL=<provider/model> \
SPECIALISTS_LIVE_SMOKE_MODEL_ALT=<a different provider/model> \
  bun --bun vitest run tests/integration/activation/native-activation.live.test.ts
```

It skips cleanly rather than failing when the environment variables or provider
credentials are absent.

The operator surface is MCP tools being built under **`unitAI-rrdnt.33`** (Phase 13). Until
that lands, treat this document as the developer reference for the runtime, not as an
operator runbook. The operator section will be written against the shipped tool contract
rather than against its design, because this epic has already produced three claims that
passed inspection and were then falsified by a live probe.

Nothing below describes a planned behaviour. Where a behaviour is specified but not yet in
force, the text says so and names the bead that closes it.

## What it is

`NativeActivationHost` runs a Specialist on an in-process Pi `AgentSession` instead of
spawning `pi` as a subprocess. The class is the shared seam: a Pi extension, the Claude
Code MCP server, and a future Chain scheduler are all meant to be frontends over it, and
none of them invokes the legacy `sp run` CLI.

Three differences from `sp run` matter to anyone using it.

**The session outlives the turn.** Reaching `agent_settled` makes a Specialist *waiting and
resumable*, not finished. Disposal is an explicit act — `stop()`. The legacy path disposes
a child at the end of its turn, which is why a legacy Specialist cannot be asked a
follow-up question.

**`--bead` is the whole prompt.** `ActivationRequest` has no free-form task field. That is
deliberate: supplementing an incomplete Bead with delegation prose is how durable work
loses its scope silently.

**Identity has three layers.** A participant is the role across activations; an activation
is one dispatch; an attempt is one try within it. A resume advances the attempt counter and
never mints a new activation id, so lineage can answer "did this Specialist retry, or did
two Specialists run?". The physical Pi session id is correlation metadata only and is never
durable Specialist identity.

The legacy `sp run` path is unchanged by any of this and is not being removed.

## Admission — what gets refused before a model turn

Four checks run before an `AgentSession` exists. Each refusal is a `DispatchRejectedError`,
which renders a block ending in `AgentSession: not created`, and each refusal is written to
`observability.db` as forensic evidence. A refusal is cheap; a child that already spent a
model turn guessing at missing scope is not.

**1. Writers are refused outright.** The Specialist's resolved permission tier decides
mutation authority — `MEDIUM` and `HIGH` mean `write`, `READ_ONLY` and `LOW` mean `read`.
Authority is derived from the resolved capability grant and never from the Specialist's
name: a custom Specialist with edit tools is a writer whatever it is called, and one named
`executor` with a read-only grant is not. A `write` activation is currently rejected with
`writer_not_supported_in_phase_1`. Writers are enabled by **`unitAI-rrdnt.36`** (Phase 10),
and not before the writer lease is wired — see [Known holes](#known-holes).

**2. The Bead must be a usable task contract.** The gate requires seven non-empty sections
— `PROBLEM`, `SUCCESS`, `SCOPE`, `NON_GOALS`, `CONSTRAINTS`, `VALIDATION`, `OUTPUT` — plus
a declared `SCRUTINY` level of `LOW`, `MEDIUM`, `HIGH` or `CRITICAL`. Closed and deferred
Beads are refused as non-dispatchable. A Bead explicitly marked `contract=draft` is refused
with the promotion command in the message; an *absent* marker is not treated as draft,
because most Beads predate the marker.

Check the marker before dispatching:

```bash
bd state <id> contract
```

That is the only surface carrying it — `bd show --json` does not include it.

The gate proves each section exists and is non-empty. It does not judge whether the
sections are any good; no parser makes that judgement, and pretending otherwise would trade
a useful gate for a bureaucratic one.

**3. An explicitly requested model must exist and be authenticated.** Both halves are
required and neither is sufficient alone. A known provider with an unknown model id
resolves to a *fabricated* model with no error, so only the `no-match` diagnostic catches
it; a real model under a provider with no configured auth resolves cleanly, so only the
auth check catches it. Provider *reachability* is not checked, because neither API touches
the network — a model that looks reachable and fails at request time is a runtime failure,
not a dispatch rejection, and is reported as one.

**4. A `StepContract` is compiled.** It bounds one activation, is derived in-memory from the
Bead plus the Specialist definition, and is deliberately not persisted. It is not a second
work item: giving these ids and dependencies would rebuild the graph Beads already owns, in
a place nothing else can see.

## Workspaces and worktrees

**A native Specialist does not get its own worktree.** It runs in the coordinator's current
worktree unless a `workspaceHint` says otherwise, and a write-capable child does not get a
new one either.

This is a deliberate divergence from the legacy path, and it is the deepest behavioural
change in the project. On the `sp run` path, `execution.requires_worktree` defaults to true,
so dispatching an edit-capable Specialist automatically provisions a git worktree on branch
`feature/<beadId>-<specialist-slug>`. On the native path that provisioning does not happen.
Isolation changes from *spatial* — one worktree per writer — to *temporal* — one writer at a
time in a shared worktree. Full analysis: `docs/design/native-activation-reconciliation.md`
§5.4.

The consequence is the reason the lease matters. Under the legacy path, two writers could
not collide because they were in different directories. Under the native path they are in
the same directory, and the only thing that separates them is the lease. That is why the
lease is a hard prerequisite for enabling writers rather than an enhancement to add later.

The mutation domain is the **worktree path**, not the repository. Two linked git worktrees
sharing one common repo are distinct mutable workspaces even though they share history and
one `observability.db`. Keying exclusion by repository would serialise unrelated work;
keying it by branch would miss two activations on one branch in one worktree.

## The writer lease

> **Not in force.** `src/activation/workspace-lease.ts` is implemented and unit-tested, and
> nothing acquires it. `NativeActivationHost` contains no call to `acquire`, `release` or
> `admitToolCall`. Wiring it into the admission and tool-call paths is **`unitAI-rrdnt.36`**
> (Phase 10), the same bead that enables writers. Until .36 lands, no native activation
> holds a lease, and the lease protects nothing — which costs nothing today only because
> writers are refused at admission anyway.

This section documents the lease as specified, so that the specification is not re-derived
when .36 wires it. Everything below describes the module's behaviour when called; none of
it describes the runtime's behaviour today.

### Contention

Acquisition is keyed on the resolved worktree path — `realpath`, so two spellings of one
worktree cannot both hold it. When another activation holds the lease, `acquire` throws
`workspace_held_by_another_writer`, naming the holder, the workspace and the activation.

Acquisition is atomic against another process. The record is staged to a temporary file and
published with `link()`, which either publishes a complete file or fails with `EEXIST`; the
loser never observes a half-written holder record and cannot overwrite the winner. On
`EEXIST` the lease is re-read so the refusal names whoever actually won the race.

A resume is not contention. An activation that already holds a workspace reacquires its own
lease for a new attempt, comparing on `activationId` — a retry is a new attempt under one
activation, not a new participant.

The lease fences the **coordinator** too. It is not a Specialist-only concept: a
coordinator editing the worktree while a write-capable child holds it is the same two-writer
problem, and the design says "exactly one writer per mutable workspace, coordinator
included" for that reason.

Records live under `<git-common-dir>/.specialists/leases/`, so every worktree of one
repository keeps its leases in one discoverable place while the key still separates them.
This is runtime state, not a second forensic database; `observability.db` remains the single
forensic store and nothing in the lease path writes to it.

### Uncertainty

`uncertain` is a third state, not a degraded `free`. Acquisition and release are both
refused while a lease is uncertain.

Liveness is process existence plus a start-time guard — raw field 22 of `/proc/<pid>/stat`,
recorded at acquisition. It is never a self-reported status field and never the presence of
a file. That is not caution for its own sake: on this host, 10 of 20 peer registrations
advertised `status: "idle"` while naming PIDs with no `/proc` entry, and 128 socket files
existed for those 20 registrations. A lease trusting either signal would free itself under a
live holder.

Four reasons produce `uncertain`:

| Reason | Meaning |
|---|---|
| `holder_process_gone` | The holder's PID is not running. It may have died mid-write. |
| `holder_start_mismatch` | The PID is running but started at a different time — PID reuse, not the holder. |
| `liveness_unverifiable` | This host cannot see processes at all (no `/proc`). Nothing is ever freed. |
| `unreadable_record` | The record did not parse. Evidence that something wrote it badly, not that nobody holds the workspace. |

A crashed holder therefore yields `uncertain`, never a blind free. Releasing a lease whose
holder's liveness is unknown is exactly how two writers end up in one worktree, and two
writers in one worktree is data loss rather than a race to tolerate. `release` **throws** on
an uncertain lease; that must surface rather than being swallowed in a `finally`. Releasing
an already-free workspace is a no-op, so a duplicated teardown path is safe.

Resolving an uncertain lease is Phase 9 (`unitAI-rrdnt.31`) and is deliberately not part of
this module. The
module's job is to produce the state honestly, not to resolve it.

### The known bypass

The lease guard is a per-tool-call block inside `beforeToolCall`. `tool_call` is a genuine
choke point for every LLM-initiated tool path on Pi 0.85.1 — built-in edit and write,
bash-as-tool, `pi.registerTool` and `customTools` are wrapped into one registry and the hook
is tool-agnostic. Four paths bypass it:

| | Path | Closed by |
|---|---|---|
| H1 | `AgentSession.executeBash()` called directly by any in-process holder of the session, our own host included — no tool call is emitted | Our own discipline: the host never calls it |
| H2 | The operator `user_bash` path — interactive `!bash` and RPC `bash` emit `user_bash`, not `tool_call` | Our own discipline: the MCP server must route shell work through prompt-induced tool calls, never RPC `bash` |
| H3 | `pi.exec(command, args, options)` inside an extension handler | **Not closable on Pi 0.85.1** |
| H4 | Direct `node:fs`, `child_process` or `fetch` inside extension code, which runs in-process | **Not closable on Pi 0.85.1** |

H3 and H4 have no interposition layer to hook, so a trusted extension can mutate a leased
workspace without the agent loop ever seeing it. That is a trusted-extension threat, not a
delegated-agent threat: the lease still covers every mutation an LLM can initiate, which is
the entire threat model for a delegated Specialist. It is stated here rather than implied
away, because a lease claiming total enforcement is more dangerous than one that documents
its boundary.

The guard must be a per-call block and **not** `setActiveToolsByName`. Within a turn the
agent loop executes against a snapshot taken at turn start, and in parallel mode every call
is prepared before any executes, so revoking active tools cannot cancel an already-planned
call. Every `tool_call` handler in a batch fires before any execution, so a mid-batch block
is enforceable where a tool-set change is not. Building it the other way round produces a
lease that silently leaks for the remainder of every turn in which it is acquired.

Mutation admission uses an **allowlist** of non-mutating tools, so an unrecognised tool is
treated as mutating. A denylist would silently admit every tool added after it was written.

Three admission outcomes are worth stating plainly, because each is deliberate rather than
incidental:

- A read is admitted with no lease at all. Reading is not a mutation.
- A read-only activation is refused every mutating call. It holds no lease and is not
  entitled to one; that is the capability grant being enforced at the only choke point that
  can enforce it, not an error state.
- While a lease is uncertain, mutation is refused **including for the original holder**.
  Uncertainty is about the record, not about who is asking.

## Results are not messages

An `ActivationResult` and an `InteractionMessage` are different objects, and conflating them
is the failure this runtime was built to prevent.

A model that stopped has not necessarily produced a result. Completion runs output
validation and post-execution logic and carries a `validation` record with `valid`, the
schema and any errors, alongside `status` of `completed`, `failed` or `uncertain`, the
resolved model, and whether an override or a fallback was used. A progress message performs
no state transition at all. A completion *notification* is a projection of an
`ActivationResult` — never a substitute for one.

Practically: a message saying the Specialist is done is not evidence the work validated. Ask
for the result object, or query `observability.db`.

The same rule holds one level down, in delivery. A successful send is transport acceptance,
not delivery; only a receipt means delivered. A message that cannot be delivered becomes
readable `pending` state rather than disappearing, and the Specialist stays in `needs_reply`
rather than failing or silently proceeding.

## Asking without restarting

A running Specialist reaches its coordinator through two tools it sees in its contract:
`ask_coordinator` and `escalate_to_coordinator`. Both expect an answer and both leave the
child alive; they differ in who is expected to resolve them, which is why they are one kind
each rather than one kind with a severity flag. Asking moves the activation to `needs_reply`
or `escalated`.

The shape is the point. **The tool call blocks until the answer arrives and returns it as
the tool result.** The model is sitting inside a tool call, so when it returns, the turn
continues with the answer in context and the child's whole history intact.

The alternative — end the turn, store the question, start a new session with the answer
prepended — looks equivalent on a whiteboard and is not. It discards the child's context and
turns a clarification into a restart. That is the failure mode this design prevents, and it
is the one that looks like success from outside.

Blocking the child does not block the host: the session stays alive and `agent_settled`
never fires while a tool call is outstanding. There is deliberately **no timeout**. An
unanswered question is a state an operator resolves, not an error the runtime invents on
their behalf.

Correlation is by message id and never by ordering. Two asks can be outstanding at once, and
a transport matching replies positionally would silently cross them. A reply carries
`inReplyTo`; that is the only correlation mechanism.

These tools are supplied as SDK-defined custom tools alongside the resolved allowlist, so a
read-only Specialist gains the ability to ask without gaining any mutation capability.
Asking is not a workspace operation, and widening the allowlist to grant it would hand every
reader an edit tool.

Resuming a settled or waiting activation with a new prompt is `resume()`, which advances the
attempt and reuses the activation id. Resumable states are `settled`, `waiting`,
`needs_reply` and `escalated`; `starting`, `running` and disposed activations are not
resumable.

## Forensics

Native activations write the **same** `observability.db` as legacy `sp run` activations.
There is deliberately no native-subagent telemetry database: two stores would give
"which Specialists touched this Bead?" two different answers depending on which runtime
served the request.

The documented query for "what did this activation do?":

```sql
SELECT event_name FROM specialist_forensic_events
WHERE job_id = ? AND event_family = 'activation'
ORDER BY seq ASC
```

Event names the runtime emits today:

```
activation_requested   activation_rejected     activation_admitted
activation_starting    activation_started      activation_settled
activation_completed   activation_failed       activation_resumed
activation_disposed    step_contract_compiled  turn_started
turn_completed         retry_started           retry_completed
output_validation_started  output_validation_passed
compaction_started     compaction_completed
```

Two caveats apply to anything built on this.

`attempt_id` and `pi_session_id` have no dedicated columns in the current schema. They are
carried in the event body and in `correlation` where a field exists, so attempt-level
lineage is present in the data but is not efficiently queryable.

The sink classifies six event names by severity that the host never emits:
`output_validation_failed`, `retry_failed`, `tool_blocked` and `lease_denied` as errors,
`activation_uncertain` and `lease_uncertain` as warnings. They are forward declarations for
Phase 10 and later, not evidence that those events occur. Do not write a dashboard that
treats their absence as a healthy signal.

## Known holes

Every entry is unclosed as of `5bdff6b5`. Where a bead exists it is named; where one does
not, that is stated rather than implied.

| Hole | Consequence | Bead |
|---|---|---|
| No operator surface. `NativeActivationHost` has no production consumer; the only live path is the gated smoke test. | The runtime cannot be invoked by an operator at all. | `unitAI-rrdnt.33` (Phase 13, in progress) |
| The writer lease is implemented but not wired. No activation acquires, releases, or admits tool calls against it. | Temporal exclusion does not exist yet. Currently harmless only because writers are refused at admission. | `unitAI-rrdnt.36` (Phase 10) |
| Writers are refused at admission (`writer_not_supported_in_phase_1`). | Only `READ_ONLY` and `LOW` Specialists activate natively. | `unitAI-rrdnt.36` (Phase 10) |
| Lease bypasses H3 (`pi.exec`) and H4 (direct `node:fs` / `child_process` in extension code) cannot be closed on Pi 0.85.1. | A trusted extension can mutate a leased workspace unobserved. Not a delegated-agent threat. | No bead; requires a Pi interposition layer that does not exist |
| Uncertain-lease recovery is unimplemented. `release` throws and acquisition is refused; nothing resolves the state. | An uncertain lease requires a human. | `unitAI-rrdnt.31` (Phase 9, in progress) |
| `attempt_id` and `pi_session_id` are not indexed columns. | Attempt-level lineage is present but not efficiently queryable. | Tracked separately per `src/activation/forensic-sink.ts` |
| Six forensic event names are classified by the sink but never emitted. | Their absence is not a health signal. | Follows Phase 10 |

One hole named in the Phase 0 reconciliation is **closed**, and is recorded here because
that document still describes it as open: `docs/design/native-activation-reconciliation.md`
§5.5 reports the console rendering `worktree_owner_job_id` under the label `lease` with a
hardcoded `leases: 1, leaseCapacity: 4`. Verified against `5bdff6b5`: no such rendering
exists. It was removed by `0b76f3f6` — "fix(console): remove fabricated lease indicators
(unitAI-rrdnt.4)". Do not carry that item forward.

`worktree_owner_job_id` itself remains chain-provenance metadata for `--job` reuse and is
still not an exclusion primitive. Do not build on it.

## See also

- `docs/design/native-activation-reconciliation.md` — the Phase 0 measurement pass, including
  the Pi 0.85.1 baseline, the feature parity matrix, and every PRD statement falsified by
  measurement.
- `docs/mcp-tools.md` — the current MCP tool contract. It documents `use_specialist`, which
  is the legacy `sp run` path, not native activation.
- `/using-specialists` — the operator skill for the supervised `sp` job lifecycle.
