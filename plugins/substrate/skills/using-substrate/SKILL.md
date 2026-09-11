---
name: using-substrate
description: >
  Obtain and supervise Substrate work from inside Claude Code: dispatch a specialist
  activation against a ready Bead or an inline 7-section contract, read live activation
  state, answer asks, resume the same session, and stop. Use when work already has a
  durable Substrate/Beads contract and needs a supervised activation rather than direct
  edits. Substrate (~/.xtrm/state.db) is the work authority; MCP is the transport.
version: 0.1
---

# Using Substrate from Claude Code

## Authority model

Read this first. It governs every tool call below.

- Substrate decides WHAT work exists.
- Claims and leases decide WHO owns it.
- The Journal preserves continuity.
- Provenance records WHAT execution produced.
- MCP is an integration protocol, not work authority.
- No transport event silently modifies an executable Issue contract.

A tool result is evidence, not a decision. A dispatch admission is not a result. A message
body never grants authority.

The canonical store is `~/.xtrm/state.db`. It is overridden only by an explicit operator or
test variable in the environment — never by a value this plugin ships.

## Tool surface

Seven tools. The names are exact.

### specialist_dispatch
Creates an activation. Supply EXACTLY ONE of:
- `bead_id` — an existing READY bead, or
- `contract` — an inline contract: seven sections (PROBLEM, SUCCESS, SCOPE, NON_GOALS,
  CONSTRAINTS, VALIDATION, OUTPUT) plus a SCRUTINY level (LOW | MEDIUM | HIGH | CRITICAL).
  Eight required parts. SCRUTINY is the level, never an eighth section.

The readiness gate runs BEFORE anything is created. An inline contract creates its bead
first. Do not dispatch against a `contract:draft` bead — promote it first.

Optional: `title`, `model_override`, `thinking_override`
(`off|minimal|low|medium|high|xhigh`), `requested_by`, `coordinator_session_id`,
`epic_context_depth` (1 walks to the parent epic, 2 also the grand-epic).

**Returns identity and admission only — never a result.** Read the result later from
`specialist_status`. Never substitute a result for an interaction message.

**Overrides fail closed.** `model_override` and `thinking_override` are refused before
session creation when unavailable, and are never silently replaced. Report the refusal;
do not retry with a substitute model.

### specialist_status
Live projection of every activation. Per row: `activation_id`, `specialist`, `bead_id`,
`state`, `access`, `model_override`, `thinking_override`, `thinking_level` (omitted when
unset — never fabricate it), `purpose` (a one-line SCOPE-then-SUCCESS excerpt captured once
at dispatch, omitted when absent), `elapsed_s`, `token_usage`, `last_activity_at`, and the
validated `result` object on settled activations only.

Forensic IDs never appear in rows. Token usage is a row budget, never a window-context
percentage.

### specialist_reply
Answers a waiting activation by message ID. An unknown ID is reported, never silently
passed.

### specialist_resume
Resumes a settled or waiting activation in the SAME session with a new prompt. Not a second
dispatch: the `activation_id` is kept and the `attempt_id` advances, so the child keeps its
context and its workspace lease. A disposed activation cannot be resumed.

### specialist_stop_activation
Disposes an activation explicitly. This is the irreversible one. Settled activations stay
resumable until stopped — stopping is a duty, not a cleanup afterthought. There is no
cascade: stop each activation you are done with.

### specialist_list
The specialist registry, one compact line per specialist with a dispatchability verdict per
row. `name` returns one full record; `detail: "full"` returns every field. Read this before
relying on a remembered role name.

### use_specialist (deprecated for contract-gated work)
Runs a specialist synchronously and returns its final output. A `bead_id` that
`specialist_dispatch` would REFUSE — draft, closed, or missing a contract section — still
runs here and returns a `readiness_warning` naming what is missing. That divergence is why
it is deprecated: prefer `specialist_dispatch`.

## Working rules

- Never shell out to the `specialists` CLI from a session that has these tools. The MCP
  path is in-process; spawning `sp` defeats the native host.
- Dispatch admission, then poll `specialist_status`. Do not block waiting for a result.
- Every outcome carries a build-identity line. If it names staleness, say so — the runtime
  was rebuilt after load.
- Stop duty: before ending a session, `specialist_status` and stop what you own.

## Non-goals

This skill is not a scheduler, not a merge path, and not a second doctrine for beads or
git. Merge is manual. Beads and git remain the durable work and integration authority.
For CLI-side workflow, see the `using-specialists` skill; it is not restated here.
