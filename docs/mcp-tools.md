---
title: MCP Tools Reference
scope: mcp-tools
category: reference
version: 2.2.0
updated: 2026-09-09
synced_at: d6dbaf1f
description: MCP tool contract for the Specialists server.
source_of_truth_for:
  - "src/server.ts"
  - "src/tools/specialist/use_specialist.tool.ts"
  - "src/tools/specialist/activation.tool.ts"
  - "src/tools/specialist/specialist_status.tool.ts"
  - "src/tools/specialist/specialist_list.tool.ts"
  - "src/activation/rejection.ts"
domain:
  - mcp
  - tools
---

# MCP Tools Reference

This server exposes six MCP tools over stdio: one legacy synchronous path
(`use_specialist`) and five native-path tools over the in-process
`NativeActivationHost` (no `sp` child process is spawned).

## Active tool inventory

| Tool | Purpose |
|---|---|
| `use_specialist` | legacy synchronous specialist run, result returned directly in MCP response |
| `specialist_status` | system health + native Fleet: activations, pending asks, recorded results |
| `specialist_dispatch` | admit-and-start a Specialist on the native runtime (async; returns on admission) |
| `specialist_reply` | answer an outstanding ask by `message_id` |
| `specialist_stop_activation` | stop and dispose a native activation |
| `specialist_list` | resolved Specialist registry with per-row dispatchability |

Inventory verified against live stdio `tools/list` (6 tools registered).

## `use_specialist`

Legacy path: runs a Specialist through `SpecialistRunner` in foreground and
returns final output directly in the MCP result.

### Input schema

Source: `src/tools/specialist/use_specialist.tool.ts` (`useSpecialistSchema`).

```ts
z.object({
  name: z.string().describe('Specialist identifier (e.g. codebase-explorer)'),
  prompt: z.string().optional().describe('The task or question for the specialist'),
  bead_id: z.string().optional().describe('Use an existing bead as the specialist prompt'),
  variables: z.record(z.string()).optional().describe('Additional $variable substitutions'),
  backend_override: z.string().optional().describe('Force a specific backend (gemini, qwen, anthropic)'),
  autonomy_level: z.enum(['READ_ONLY', 'LOW', 'MEDIUM', 'HIGH']).optional().describe('Override permission level for this invocation'),
  context_depth: z.number().min(0).max(10).optional().describe('Depth of blocker context injection (0 = none, 1 = immediate blockers, etc.)'),
}).refine((input) => Boolean(input.prompt?.trim() || input.bead_id), {
  message: 'Either prompt or bead_id is required',
  path: ['prompt'],
})
```

### Behavior highlights

- `bead_id` links execution to an existing bead and uses it as task context.
- A `bead_id` that `specialist_dispatch` would REFUSE (draft, closed, or
  missing a contract section) still runs here, but the result carries a
  `readiness_warning` naming what is missing. That divergence is deprecated:
  prefer `specialist_dispatch` for contract-gated work.

## `specialist_status`

Read-only projection: backend circuit-breaker states, loaded specialists and
staleness, DB-backed background jobs, plus the native Fleet
(`activations`, `pending_asks`) and recorded completions
(`activation_results`). Legacy `sp run` jobs are reported here read-only;
they remain CLI-managed.

### Input schema

Source: `src/tools/specialist/specialist_status.tool.ts` (inline schema; the
tool takes no arguments).

```ts
z.object({})
```

### Behavior highlights

- `activations` projects the host's own snapshots (`toActivationView`), so an
  MCP-dispatched activation reads back identically to a CLI-dispatched one.
- `pending_asks` projects outstanding questions (`toPendingAskView`) — answer
  them with `specialist_reply`.
- `activation_results` projects the same validated `ActivationResult` the push
  channel serialises (`toActivationResultView`); see "Push as projection".

## `specialist_dispatch`

Dispatch a Specialist onto the in-process runtime. Provide EITHER `bead_id`
(an existing READY bead) OR `contract` (an inline contract: the same
readiness gate runs first, then a bead is created and dispatched). Never both.

### Input schema

Source: `src/tools/specialist/activation.tool.ts`
(`specialistDispatchSchema`).

```ts
z.object({
  specialist: z.string().describe('Specialist name, e.g. codebase-explorer'),
  bead_id: z.string().optional().describe(
    "The id of an EXISTING READY Bead — this activation's task contract, a COMPLETE " +
    '7-section contract (PROBLEM, SUCCESS, SCOPE, NON_GOALS, CONSTRAINTS, VALIDATION, ' +
    'OUTPUT) plus a SCRUTINY level, which must be exactly one of LOW, MEDIUM, HIGH or ' +
    'CRITICAL. That is EIGHT required parts, not seven; SCRUTINY is the one most often ' +
    'left out. Write each section as a heading: either the section name on its own line ' +
    'with its body beneath, or `PROBLEM: the body` on one line. Both forms are accepted. ' +
    'A draft or incomplete Bead is refused before any model turn. No free-form task ' +
    'text is accepted: a task that needs more definition belongs in the Bead (see the ' +
    'planning skill). Mutually exclusive with contract: provide exactly one of bead_id ' +
    'or contract, never both.',
  ),
  contract: z.string().optional().describe(
    'An INLINE task contract, used instead of bead_id: the SAME readiness gate ' +
    'runs first, then a Bead is created from it and dispatched. The contract ' +
    'must contain all seven sections — PROBLEM, SUCCESS, SCOPE, NON_GOALS, ' +
    'CONSTRAINTS, VALIDATION, OUTPUT — plus a SCRUTINY level, which must be exactly ' +
    'one of LOW, MEDIUM, HIGH or CRITICAL. Note that this is EIGHT required parts, ' +
    'not seven; SCRUTINY is the one most often left out. Write each section as a ' +
    'heading: either the section name on its own line with its body beneath, or ' +
    '`PROBLEM: the body` on one line. Both forms are accepted. ' +
    'A contract missing any section is refused and nothing is created.',
  ),
  title: z.string().optional().describe(
    'Optional title for the Bead created from `contract` (default: derived from PROBLEM). ' +
    'Ignored when bead_id is given.',
  ),
  epic_context_depth: z.number().optional().describe(
    'Walk bead.parent UP this many hops (1 = immediate parent epic, 2 = epic + ' +
    "grand-epic) and render each ancestor contract into the turn-1 prompt as an '" +
    "'## Epic lineage' section. Must be 1 or 2; anything else is refused. Omit for " +
    'single-bead dispatch with no lineage. Dropped for beads auto-created from an ' +
    'inline contract (a fresh bead has no parent).',
  ),
  model_override: z.string().optional().describe(
    'Override the configured model for THIS activation only. An unavailable model is refused before the session is created, never silently replaced.',
  ),
  thinking_override: z.enum(THINKING_LEVELS).optional().describe(
    'Override the definition thinking_level for THIS activation only. Absent means the definition level. An unknown value is refused before the session is created.',
  ),
  requested_by: z.string().optional().describe(
    'ParticipantId of the requesting coordinator. Defaults to the MCP gateway participant.',
  ),
  coordinator_session_id: z.string().optional().describe('MCP session id, for lineage.'),
})
```

`THINKING_LEVELS` (`src/activation/types.ts`) is
`['off', 'minimal', 'low', 'medium', 'high', 'xhigh']`.

### Behavior highlights

- Admit-not-block: returns once the activation is ADMITTED and started, NOT
  when it finishes — poll `specialist_status` for state and for any question
  it raises, and answer with `specialist_reply`.
- The bead is the prompt and MUST be a complete 7-section contract plus a
  SCRUTINY level; a draft or incomplete bead is refused before a model turn is
  spent. If the bead is not dispatchable, fix the bead (planning skill), not
  the dispatch.
- An inline `contract` that passes the gate creates a durable board record;
  the result carries `created_bead_id` plus a `created_bead_note` — track it,
  it is not cleaned up automatically.
- `epic_context_depth` must be 1 or 2; anything else is a structured refusal
  (bare `z.number()` deliberately, so range errors return the refusal envelope
  instead of an opaque zod throw).
- Write-capable Specialists (MEDIUM/HIGH tiers) activate only when they can
  acquire the workspace lease; otherwise dispatch is refused with a structured
  reason.

## `specialist_reply`

Answer an outstanding question or escalation by its `message_id` (read them
from `specialist_status.pending_asks`). The answer returns as that tool
call's result, so the Specialist continues with its context intact. An
unknown or already-answered `message_id` is reported, not silently accepted.

### Input schema

Source: `src/tools/specialist/activation.tool.ts`
(`specialistReplySchema`).

```ts
z.object({
  message_id: z.string().describe(
    'The message_id of the outstanding ask, from specialist_status.pending_asks. Correlation is by message id and nothing else — there is no "answer the latest ask", because with two asks outstanding that is a coin flip.',
  ),
  body: z.string().describe('The answer. Returned to the Specialist as its tool result.'),
})
```

## `specialist_stop_activation`

Stop and dispose a native activation. This is the only ordinary path to
disposal — a settled Specialist is waiting and resumable, not finished.

### Input schema

Source: `src/tools/specialist/activation.tool.ts`
(`specialistStopSchema`).

```ts
z.object({
  activation_id: z.string().describe('Activation to stop and dispose.'),
  reason: z.string().optional().describe('Recorded forensically with the disposal.'),
})
```

## `specialist_list`

List the resolved Specialist registry after repo and user layer overrides.
Compact one line per specialist by default; pass `name` for one full record
or `detail: "full"` for everything (large — prefer `name`). The loader is
authoritative; dispatchability reuses the shared admission checks, never a
second resolver.

### Input schema

Source: `src/tools/specialist/specialist_list.tool.ts`
(`specialistListSchema`).

```ts
z.object({
  name: z.string().optional().describe('Return the full record for this one specialist instead of the compact list.'),
  detail: z
    .enum(['compact', 'full'])
    .optional()
    .describe('"compact" (default) is one line each; "full" returns every field for every specialist.'),
})
```

### Behavior highlights

- Every row carries the native-only note: dispatch through
  `specialist_dispatch`; do not shell out to the specialists CLI.
- Write-capable tiers (MEDIUM/HIGH) still need the workspace lease at dispatch
  time.

## Refusal shape

Refusals are returned tool results, never thrown errors — throwing would reach
the coordinator as an opaque MCP error string. All gate refusals render
through the single shared renderer. Source: `src/activation/rejection.ts`.

```ts
export interface RejectionInput {
  reason: string;
  detail?: DispatchRejectedError['detail'];
  missing?: string[];
}

export function renderRejection(input: RejectionInput, build?: string) {
  return {
    status: 'rejected' as const,
    reason: input.reason,
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.missing?.length ? { missing: input.missing } : {}),
    ...(build ? { build } : {}),
  };
}
```

- `status` is always `'rejected'`; `reason` names the gate outcome.
- `missing` lists the absent contract sections at the top level when the gate
  reports them — and is never stripped from `detail` where the host put it.
- `build` carries the loaded-vs-on-disk build identity
  (`describeBuildIdentity`), so a stale-build refusal is distinguishable from
  a broken-contract refusal.
- Example — inline contract missing sections:
  `{"status":"rejected","reason":"bead is not a usable task contract: ...",
  "missing":["PROBLEM",...],"build":{...}}`.
- Example — draft bead:
  `{"status":"rejected","reason":"bead_contract_incomplete",
  "detail":{"specialist":"...","beadId":"...","note":"bead contract is marked
  draft — ..."},"build":{...}}`.

## Coordinator behavior notes

- Admit-not-block: `specialist_dispatch` returns on admission. The handle's
  `result` promise is observed server-side (settling records the validated
  result, then the notification is pushed); the dispatching call never blocks
  on it, because a coordinator blocked waiting on completion cannot answer the
  clarification that would unblock it.
- Poll-for-asks: until a push channel is confirmed live, learn about questions
  by reading — poll `specialist_status.pending_asks` and answer with
  `specialist_reply`. A reader that cannot see the ask leaves the Specialist
  stuck forever.
- Push-as-projection: a pushed completion serialises the SAME validated
  `ActivationResult` that `specialist_status.activation_results` projects. A
  coordinator that never received the push reads the identical object here; the
  notification is a projection, never the authority. Provider limits on this
  transport (preview status, platform availability, untrusted inbound, no-ack
  delivery) are stated in [claude-channel-constraints.md](claude-channel-constraints.md).

## See also

- [cli-reference.md](cli-reference.md)
- [workflow.md](workflow.md)
- [background-jobs.md](background-jobs.md)
- [claude-channel-constraints.md](claude-channel-constraints.md)
