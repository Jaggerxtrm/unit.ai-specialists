# unitAI-rrdnt.34 — Phase 14 asynchronous runtime events, live evidence

Bead: unitAI-rrdnt.34 (Phase 14 — Specialist to Claude asynchronous runtime events)
Branch: `xt/phase14-async`
Worktree: `.xtrm/worktrees/specialists-xt-claude-phase14-async`
Acceptance under test: **AY** — Claude receives a structured completion notification tied
to a validated `ActivationResult`, and AM/AI lineage holds on every pushed event.

## What was built

`src/activation/async-events.ts` — `RuntimeEventPusher`.

- `track(activationId, route)` records where an activation's events go. The coordinator
  address is a property of the dispatch, not of the runtime: `src/server.ts` builds one
  host for the process lifetime and learns a coordinator session only per call.
- `settle(result)` records the validated `ActivationResult`. This is the single object both
  readers return.
- `pushCompletion(activationId)` composes the canonical `InteractionMessage` through the
  newly exported `composeInteractionMessage` and pushes it with `PeerAdapter.push`.

Supporting changes:

- `src/activation/interaction.ts` — optional `piSessionId` on `InteractionMessage` and
  `SendInput`; the private `compose` extracted into an exported
  `composeInteractionMessage` so the push uses the canonical vocabulary rather than a
  second shape with similar field names.
- `src/tools/specialist/activation.tool.ts` — `specialist_dispatch` tracks the route and
  attaches settle-then-push to `handle.result`; `toActivationResultView` is the single
  projection of `ActivationResult`.
- `src/tools/specialist/specialist_status.tool.ts` — `activation_results[]`.
- `src/server.ts` — constructs the pusher once and passes it to both tools.
- `src/lib.ts` — exports `toActivationResultView` and the pusher, so
  `config/pi-extensions/specialist-subagents/index.mjs` can import the projection instead
  of restating it.

`native-host.ts` is unmodified.

## Live evidence

All probes ran against the real roster and the real transport, not test doubles.

### 1. A completion push reaches a live Claude session

A real completion was pushed to this session's own registration
(`06e28707-3a67-4d29-b5f1-0cd7d80b3065`) using `scanRoster()`'s live route. It arrived in
the session transcript as a `cross-session-message` whose body was the serialised
`ActivationResult` verbatim:

```
{"activationId":"act:liveprobe0001","participantId":"node::executor",
 "attemptId":"att:liveprobe0001:1","beadId":"unitAI-rrdnt.34","status":"completed",
 "output":{"summary":"LIVE PROBE unitAI-rrdnt.34 — async completion push over the real
 peer channel"},"validation":{"valid":true},"piSessionId":"pi:live-probe",
 "resolvedModel":"probe/none","modelOverride":false,"fallbackUsed":false,
 "completedAt":1788823299918}
```

Probe output:

```
refused-before-validation: ResultNotValidatedError
outcome:            no_receipt
route:              pid:3244576/session:06e28707-3a67-4d29-b5f1-0cd7d80b3065
delivery.state:     sent_unconfirmed
receiptMsgId:       (none)
pushed===polled:    true
lineage: {"from":"node::executor","to":"orch::phase14",
          "activationId":"act:liveprobe0001","attemptId":"att:liveprobe0001:1",
          "piSessionId":"pi:live-probe","kind":"completion"}
```

**The load-bearing observation.** The message ARRIVED and the record still reads
`sent_unconfirmed` with no receipt. `sent_unconfirmed` on this transport therefore means
"unconfirmable", not "probably lost". That is the settled Phase 14 boundary confirmed by
measurement rather than by assertion, and it is the reason no receipt mechanism was added.

### 2. The read half is reachable through the real MCP server

Constructing the actual `SpecialistsServer` and calling its own `specialist_status` tool:

```
registered tools: use_specialist, specialist_status, specialist_dispatch,
                  specialist_reply, specialist_stop_activation
status keys: loaded_count, activations, pending_asks, activation_results,
             pending_interactions, uncertain_workspaces, backends_health,
             specialists, background_jobs
activation_results present: true
```

This probe exists because five modules in this epic were complete, unit-tested and
reachable by nothing. The wiring is asserted against the constructed server, not read off
the source.

## VALIDATION, item by item

1. **Same `ActivationResult`, field by field.** The push body is
   `JSON.stringify(result)` of the recorded object, so `parseCompletionBody(pushed)` and
   `pusher.result(id)` are compared with `toEqual`, not by summary. Live probe:
   `pushed===polled: true`.
2. **Peer channel unavailable.** With an empty roster the push returns `no_route`, the
   durable record is written before any send is attempted, `delivery.state` is never
   `delivered` and `receiptMsgId` is undefined — and `specialist_status` still projects the
   full result.
3. **Lineage.** `participantId` (as `from`), `activationId`, `attemptId` and `piSessionId`
   are on every pushed message. Asserted in unit test and in the live probe above.
4. **Push before validation is refused.** `pushCompletion` throws
   `ResultNotValidatedError` when no result has been recorded, before the durable record
   exists. Live probe line 1.

## Tests

`tests/unit/specialist/activation-async-events.test.ts` — 8 tests, all green. One of them
dispatches through `createSpecialistDispatchTool` and asserts the push is reached without
any further call, so the wiring is covered and not only the module.

Full suite: 2354 passed. Two files failed only under concurrent load
(`tests/unit/cli/status.test.ts`, `tests/unit/specialist/status-load-dead-job.test.ts`) and
both pass in isolation; `status.test.ts` also fails at the unmodified `master` baseline
under the same load, so neither is caused by this change.

## What was deliberately not built

No `finding`/progress push. The only progress-event source is `onSessionEvent` inside
`native-host.ts`, which this lane does not own, and an API with no caller is the failure
mode this epic has hit five times. The wakeup lane (unitAI-rrdnt.45) confirmed its forensic
sink is a Pi-side progress source needing no host change; when a caller appears, that is
the seam.

## Coordination

- `specialists-xt-claude-wakeup` (unitAI-rrdnt.45) confirmed there is ONE vocabulary: its
  wake is an in-process operator notification carrying no message id, deliberately not an
  `InteractionMessage`, and it touches no shared type.
- It flagged a real divergence: `toResultView` in
  `config/pi-extensions/specialist-subagents/index.mjs` is a second projection of
  `ActivationResult`. `toActivationResultView` was aligned to be a superset of it
  (`configured_model`, `requested_model`, `output ?? null`) and exported from `lib.js`;
  the extension should import it and delete its own. That deletion is not in this branch.
