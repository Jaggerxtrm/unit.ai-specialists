---
title: Native Activation Runtime
scope: native-activation
category: guide
version: 0.3.1
updated: 2026-09-07
synced_at: e78d120d
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
| [Status](#status-read-this-first) | What ships, what does not, and what is unproven |
| [What it is](#what-it-is) | The runtime seam, and how it differs from `sp run` |
| [Admission](#admission-what-gets-refused-before-a-model-turn) | The four gates a dispatch passes, in order |
| [Workspaces and worktrees](#workspaces-and-worktrees) | Why a native Specialist does not get its own worktree |
| [The writer lease](#the-writer-lease) | Acquired at admission; the per-call guard has no caller |
| [Results are not messages](#results-are-not-messages) | The distinction the runtime exists to preserve |
| [Asking without restarting](#asking-without-restarting) | Clarification versus restart |
| [Forensics](#forensics) | One store, one query, and the vocabulary gap |
| [Running one](#running-one--the-mcp-surface) | The four MCP tools, merged and callable |
| [Known holes](#known-holes) | Every unclosed gap, with its bead |

# Native Activation Runtime

## Status — read this first

The native activation runtime **is operator-invocable**. Four MCP tools —
`specialist_dispatch`, `specialist_reply`, `specialist_stop_activation` and an extended
`specialist_status` — are registered in `src/server.ts` and merged (`unitAI-rrdnt.33`,
closed). See [Running one](#running-one--the-mcp-surface).

Write-capable Specialists are admitted and take the workspace writer lease
(`unitAI-rrdnt.36` work merged as `67be44b1`, though the bead is still open). Read the
[lease section](#the-writer-lease) before dispatching one: admission-time exclusion is live,
the per-call mutation guard is not yet reachable.

There is still no CLI command. A gated live smoke exercises the host directly:

```bash
SPECIALISTS_LIVE_SMOKE=1 \
SPECIALISTS_LIVE_SMOKE_MODEL=<provider/model> \
SPECIALISTS_LIVE_SMOKE_MODEL_ALT=<a different provider/model> \
  bun --bun vitest run tests/integration/activation/native-activation.live.test.ts
```

It skips cleanly rather than failing when the environment variables or provider credentials
are absent.

A second frontend — a Pi extension over the same host — is in progress as
`unitAI-rrdnt.37` and is not merged. It is not documented here.

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

**1. Mutation authority is resolved, and a writer takes the lease.** The Specialist's
resolved permission tier decides it — `MEDIUM` and `HIGH` mean `write`, `READ_ONLY` and
`LOW` mean `read`. Authority is derived from the resolved capability grant and never from
the Specialist's name: a custom Specialist with edit tools is a writer whatever it is
called, and one named `executor` with a read-only grant is not.

A `write` activation acquires the workspace writer lease **before a session exists**, so
contention is refused without spending a model turn and a refused writer never reaches the
point where it could mutate anything. The refusal names the holder. An uncertain lease is
never stolen. A `read` activation acquires nothing — it is not entitled to the lease.

Writers were refused outright with `writer_not_supported_in_phase_1` until `67be44b1`.

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

**The gate belongs to the native admission path, not to Beads.** The legacy `use_specialist`
tool also accepts a `bead_id`, reads it with `buildBeadContext`, and applies no readiness
check at all — it also accepts a free-form `prompt` with no Bead. So a Bead that
`specialist_dispatch` refuses can still be run through `use_specialist`. That is
pre-existing and by design: the gate lives where admission lives. It is stated here because
a reader who learns "a draft Bead is refused" from this document would otherwise be
surprised.

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

> **Partly in force.** Acquisition and release are wired: a write-capable activation takes
> the lease at admission (`native-host.ts:316`) and releases it on teardown, and both paths
> emit forensics. The **per-call mutation guard is not reachable**:
> `NativeActivationHost.admitToolCall` is a public method with no caller anywhere in `src/`
> or `tests/`, and the host registers no blocking `tool_call` handler — `session.subscribe`
> is observation only. No frontend should be the one to call it either — an enforcement
> point invoked by a frontend is optional enforcement, because the next frontend forgets and
> nothing goes red. Tracked as `unitAI-rrdnt.36.2`.
>
> What that means concretely: two activations cannot both hold one worktree, because
> admission refuses the second. What is *not* enforced is the per-call block — a writer
> whose lease turns uncertain mid-turn is not stopped, and a reader is not refused mutating
> calls by the lease. A reader is still constrained, but by its fail-closed tool allowlist
> rather than by the lease.

Everything below describes the module's behaviour. Acquisition, contention, uncertainty and
release are live on the admission path; the admission-verdict subsection is the part with no
caller.

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

Resolving an uncertain lease is deliberately not this module's job — it produces the state
honestly and refuses to guess. The way out is `src/activation/workspace-reconcile.ts`
(`unitAI-rrdnt.31`, closed), described next.

### Getting out of uncertain

Refusing to resolve `uncertain` is the correct safety property and, alone, a liveness bug: a
writer killed mid-mutation leaves a workspace that is neither silently free nor ever usable
again. Reconciliation is the only way out, and it is shaped so that the way out is a
**recorded decision rather than an inference**.

It is not `reconcile(workspace)` — "look at the world and free it if that seems safe" is the
blind free under another name. Absence of a process is not evidence a mutation completed,
and not evidence it did not. Instead the caller proposes an outcome, and the module
validates and records it: it re-inspects the live lease at decision time, refuses any outcome
the current `uncertainReason` does not permit, and appends the attempt — accepted **or**
refused — to a durable log beside the lease.

A proposal carries the outcome, `decidedBy` (never defaulted — "the runtime decided" with no
author is how an inference gets laundered into a decision), and a non-empty `basis` of the
durable evidence consulted. An empty basis is insufficient for every outcome, including
`manual_attention_required`: a refusal still has to say what was looked at.

Proposable outcomes are `safe_free`, `superseded` (requires naming the successor activation)
and `manual_attention_required`. `recovered_holder` is computed, never requested — it is what
re-inspection returns when the workspace turns out to be held after all. A refusal is a
result rather than an error to discard: it leaves the workspace uncertain and readable,
because a workspace nobody can resolve is exactly what an operator needs to see.

The four uncertain reasons license different outcomes, which is why they were kept distinct
rather than collapsed. `unreadable_record` refuses `safe_free` outright — with no holder
identity, nothing can be attributed as safely finished, though an operator who has inspected
the worktree may still name a successor, which asserts ownership instead of completion.
`liveness_unverifiable` means no evidence available to this runtime can show the holder
stopped.

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

**Nothing calls this yet.** `NativeActivationHost.admitToolCall(activationId, toolName)`
exists, emits `tool_blocked` on a refusal, and fails closed on an unknown activation — and
`grep -rn admitToolCall src/ tests/` finds no caller of it outside the module and its own
unit tests. The three outcomes below therefore describe the verdict the function returns, not a block
any Specialist has experienced. Tracked as `unitAI-rrdnt.36.2`, which requires the host to
invoke it rather than a frontend.

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

> **Two defects, one file, both invisible to the same class of test. The end-to-end path is
> still unproven.**
>
> First, the tools reached no Specialist at all. `createAgentSession`'s `tools` array is a
> hard filter on pi 0.85.1 and it applies to `customTools` too: a session given
> `customTools: [ask_coordinator]` and `tools: ['read']` reports `getAllTools() === ['read']`
> — the custom tool is dropped silently, with no error and no diagnostic. PRD Phase 6 was
> unreachable from the day it was written. Fixed by naming both tools in the allowlist
> (`unitAI-rrdnt.43.1`) — not by omitting the filter, which admits 50+ builtins including
> bash, edit and write, and is fail-open.
>
> Second, fixing that only made the next defect reachable. pi calls a custom tool's
> `execute` with five arguments and the parameters object is the **second**; `ask-tool.ts`
> declared `(args)`, so `args` bound to the tool-call id string, `args.question` was
> `undefined`, and the tool refused every call as empty. In a live probe the child's own
> reasoning reads "The tool returned no output. That's odd." — it starts debugging the
> harness instead of doing its task. Fixed in `75cdce74` (`unitAI-rrdnt.43.2`).
>
> Neither defect was catchable by the tests that existed, and that is the transferable
> lesson: the unit test called `tool.execute({ question })` directly, asserting the contract
> it wished the SDK had rather than the one the SDK has. Green tests, against a tool no live
> model could use. `ask-tool.ts` and `interaction.ts` were complete and unit-tested against
> doubles the whole time.
>
> **Whether a live model calls the tool is `unitAI-rrdnt.43` and is still open.** Everything
> below describes the protocol as built. Treat the end-to-end path as unproven.

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
lease_acquired         lease_denied            lease_uncertain
tool_blocked
```

Two caveats apply to anything built on this.

`attempt_id` and `pi_session_id` have no dedicated columns in the current schema. They are
carried in the event body and in `correlation` where a field exists, so attempt-level
lineage is present in the data but is not efficiently queryable.

The sink classifies three event names by severity that the host never emits:
`output_validation_failed` and `retry_failed` as errors, `activation_uncertain` as a
warning. They are forward declarations, not evidence that those events occur. All three are
the negative half of a pair whose positive half *is* emitted, so a failure filter over them
returns nothing whether or not failures happened. Tracked as `unitAI-rrdnt.38`, narrowed from six:
`lease_denied`, `lease_uncertain` and `tool_blocked` gained producers when the lease was
wired in `67be44b1`.

## Known holes

Every entry is unclosed as of `e78d120d`. Where a bead exists it is named; where one does
not, that is stated rather than implied.

| Hole | Consequence | Bead |
|---|---|---|
| The per-call mutation guard has no caller. `admitToolCall` is a public method; nothing in `src/` invokes it and the host registers no blocking `tool_call` handler. | Admission-time exclusion works. The block *during* a turn is absent: a writer whose lease turns uncertain mid-turn is not stopped, and a reader is constrained by its fail-closed tool allowlist rather than by the lease. | `unitAI-rrdnt.36.2` |
| A live model has never been observed calling `ask_coordinator`. The tools reached no Specialist at all until `866d4a35`. | The clarification path is built and unit-tested but unproven end to end. | `unitAI-rrdnt.43` |
| The 7-section contract gate applies only to native admission. `use_specialist` takes a `bead_id` with no readiness check, and a free-form `prompt` with no Bead at all. | A Bead refused by `specialist_dispatch` still runs through `use_specialist`. Pre-existing and by design; surprising if the gate is read as a property of Beads. | None; stated so the boundary is not mistaken |
| Lease bypasses H3 (`pi.exec`) and H4 (direct `node:fs` / `child_process` in extension code) cannot be closed on Pi 0.85.1. `executeBash()` and `pi.exec()` fire the `tool_call` handler zero times. | A trusted extension can mutate a leased workspace unobserved. Not a delegated-agent threat. | No bead; requires a Pi interposition layer that does not exist |
| Reconciling an uncertain workspace requires a named decider and durable basis; nothing resolves one automatically. | By design, not a gap — but an uncertain workspace stays unusable until a person decides. | `unitAI-rrdnt.31`, closed |
| `attempt_id` and `pi_session_id` are not indexed columns. | Attempt-level lineage is present but not efficiently queryable. | Tracked separately per `src/activation/forensic-sink.ts` |
| Three forensic event names are classified by the sink with no producer: `output_validation_failed`, `retry_failed`, `activation_uncertain`. | Their absence is not a health signal; each is the negative half of a pair whose positive half is emitted. | `unitAI-rrdnt.38` |

Four items previously listed here are **closed** and are recorded rather than deleted, so
nobody reinstates them from an older document.

**There was no operator surface.** `NativeActivationHost` had no production consumer and the
only live path was a gated smoke test. Closed by `unitAI-rrdnt.33`: four MCP tools, merged.

**Writers were refused, and the lease was wired to nothing.** These were two rows and one
defect. The lease was complete, mutation-tested, closed on the board, and imported by
nothing in `src/`; writers were refused outright, so nothing was fenced because nothing
wrote. Three lanes found it independently on the same day. Closed by `67be44b1`, which
enabled writers and acquired the lease in one change — flipping admission without the
acquire call would have shipped write-capable Specialists guarded by a lease that was
present, tested, closed on the board, and never called.

**The refusal renderer dropped its explanation.** `reject()` was called with
`{ detail: <explanation> }` at four sites while `DispatchRejectedError`'s only free-text
field is `note`, so a Bead marked `contract=draft` refused with `reason:
bead_contract_incomplete`, no missing sections and no mention of "draft" — for a Bead whose
seven sections were all correct. Fixed by `fdfc7c61` (`unitAI-rrdnt.40`), with two
regression tests that assert on the **rendered** message rather than on the object passed
in. That distinction is the whole point: a test over the object would have passed for as
long as the defect existed, because the object was always correct and it was the rendering
that discarded it. The underlying reason nothing went red across four call sites is that
`reject()` takes `Record<string, unknown>`, so any key the error does not render compiles
cleanly and vanishes. That type was deliberately not tightened — it has its own blast radius
and its own bead.

One hole named in the Phase 0 reconciliation is also closed, and is recorded here because
that document still describes it as open: `docs/design/native-activation-reconciliation.md`
§5.5 reports the console rendering `worktree_owner_job_id` under the label `lease` with a
hardcoded `leases: 1, leaseCapacity: 4`. Verified against `5bdff6b5`: no such rendering
exists. It was removed by `0b76f3f6` — "fix(console): remove fabricated lease indicators
(unitAI-rrdnt.4)". Do not carry that item forward.

`worktree_owner_job_id` itself remains chain-provenance metadata for `--job` reuse and is
still not an exclusion primitive. Do not build on it.

## Running one — the MCP surface

`unitAI-rrdnt.33` is merged; these tools are registered in `src/server.ts` and callable.
Field names and shapes below were read from `src/tools/specialist/activation.tool.ts`.

Four tools, three new and one extended. They call `NativeActivationHost` in-process and
construct no child process — a subprocess running `sp` would satisfy the letter of
"expose the runtime over MCP" and defeat its purpose.

`use_specialist` **stays, unchanged, alongside them.** It is the legacy `SpecialistRunner`
path: synchronous, returns the final output, not backed by the native runtime. These are two
surfaces, not one migrating into the other.

### Dispatching

`specialist_dispatch` takes `specialist` and `bead_id` (both required), plus optional
`model_override`, `requested_by` (defaults to `adapter::specialists-mcp`) and
`coordinator_session_id`.

There is **no task or prompt field**. The Bead is the prompt. There is also **no workspace
hint**: the activation runs in the server's working directory, and a writer would not get a
new worktree anyway.

Pass `model_override` for any Specialist whose `execution.model` is null — `explorer` is
one. Without it the dispatch is refused with `no_model_configured`, which is a poor first
experience for someone following these docs literally.

On success it returns the activation's **identity and state**, not a result:

```json
{ "status": "dispatched",
  "activation_id": "...", "participant_id": "...", "attempt_id": "...",
  "specialist": "...", "bead_id": "...",
  "state": "...", "access": "read",
  "worktree_path": "...", "branch": "...", "pi_session_id": "...",
  "resolved_model": "...", "model_override": false,
  "step_contract": { "root_work_ref": "...", "inputs": 0, "outputs": 1 } }
```

`inputs` and `outputs` are **counts**, not the compiled objects.

**`status: "dispatched"` means admitted and started. It does not mean succeeded.** An
activation can be dispatched and then fail; read `state` from `specialist_status` for the
outcome.

The call returns at admission rather than at completion, and that is what keeps
[results and messages](#results-are-not-messages) from being conflated on this surface. A
tool that blocked until a validated `ActivationResult` existed would deadlock on the first
clarification, because the coordinator cannot answer a question it is blocked waiting on. So
the session outlives the call, **no `ActivationResult` is ever delivered through this tool**,
and there is no place in the surface where a result and a message could be mistaken for each
other. That is AU held by construction rather than by discipline.

### Refusals are results, not errors

A `DispatchRejectedError` does not propagate as an MCP error. It comes back as:

```json
{ "status": "rejected",
  "reason": "<the full rendered block, ending \"AgentSession:\\n  not created\">",
  "detail": { "specialist": "...", "beadId": "...", "missing": ["NON_GOALS"] } }
```

`detail` carries the machine-readable fields — `specialist`, `beadId`, and where present
`missing[]`, `requestedModel`, `workspace`, `holder`, `note`. Throwing would have reached the
caller as an opaque string and lost `missing`, which is the part an operator acts on. A
genuine fault still throws.

`note` carries the human-readable explanation — the missing-section reason, the model-gate
reason, the loader error. It was silently dropped by the renderer until `fdfc7c61`
(`unitAI-rrdnt.40`); see [Known holes](#known-holes) for what that looked like and why
nothing went red. If you are reading a refusal from a build older than that commit, expect
`reason` alone with no explanation.

### Answering a question

`specialist_reply` takes `message_id` and `body`. It resumes a child sitting in the blocking
`ask_coordinator` or `escalate_to_coordinator` call: the answer returns as that tool call's
result and the same `AgentSession` continues with its context intact. It is not a restart
with the answer pasted into a new prompt.

**`message_id` is the only correlation key**, read from
`specialist_status.pending_asks[].message_id`. There is deliberately no "answer the latest
ask" convenience — with two asks outstanding that is a coin flip. An unknown or
already-answered id returns `{ "status": "error", ... }` naming the id, never a silent
accept.

`specialist_stop_activation` takes `activation_id` and an optional `reason`, recorded
forensically with the disposal.

### Reading state

`specialist_status` takes no arguments and gained two additive keys, each an empty list
rather than absent when there is nothing:

- `activations[]` — the same projection `specialist_dispatch` returns.
- `pending_asks[]` — `message_id`, `kind` (`question` or `escalation`), `activation_id`,
  `attempt_id`, `from`, `to`, `body`, `delivery`, `asked_at`.

`delivery` is `pending`, `delivered` or `refused`, where `delivered` means a receipt was
seen and not merely that no error was thrown.

Until the asynchronous push channel exists (Phase 14), a coordinator learns about a question
by **reading**. A reader that cannot see the ask leaves the Specialist stuck forever, which
is why pending asks are projected here rather than waited for.

### What a dispatch actually spawns

No `sp` or `specialists` process is created — that is acceptance AV, asserted against
`/proc` rather than against intent.

The dispatch is **not subprocess-free in general**, and the loose claim is falsifiable with
one `ps`. The Bead gate shells out to `bd state <id> contract` via `spawnSync`, so a dispatch
forks `sh` and `bd`. Those are the contract gate reading the board, not the Specialist
runtime. A live run on a working provider observed exactly two descendants of the MCP server
pid: `sh` and `bd`.

The MCP surface does not decide mutation authority and never filtered writers out itself,
which is why enabling writers in `67be44b1` needed no change here: it flipped one admission
decision inside the host and there was no second dispatch path to teach. A dispatch of a
write-capable Specialist now acquires the lease, and a contended or uncertain workspace
comes back as a `status: "rejected"` result naming the holder, exactly like any other
refusal.

What this path still cannot do is call the per-call mutation guard — MCP has no agent-loop
hook. See [Known holes](#known-holes).

## See also

- `docs/design/native-activation-reconciliation.md` — the Phase 0 measurement pass, including
  the Pi 0.85.1 baseline, the feature parity matrix, and every PRD statement falsified by
  measurement.
- `docs/mcp-tools.md` — the current MCP tool contract. It documents `use_specialist`, which
  is the legacy `sp run` path, not native activation.
- `/using-specialists` — the operator skill for the supervised `sp` job lifecycle.
