# unitAI-rrdnt.37 — live probe transcript (Pi extension coordinator surface)

Date: 2026-09-07. Lane: specialists-xt-pi-pi-extension (worktree
/home/dawid/dev/specialists/.xtrm/worktrees/specialists-xt-pi-pi-extension).
Extension: config/pi-extensions/specialist-subagents/index.mjs loaded via `pi -e`.

## Sessions and models

- Coordinator session (real pi process, `--mode json`): model `opencode-go/deepseek-v4-flash`.
  (Coordinator model `deepseek/deepseek-v4-flash` was also used; that path intermittently
  returns empty completions in `-p` mode and intermittently fails child turns with a
  provider `400 insufficient credits` — use opencode-go for probes.)
- Child Specialist session: in-process AgentSession, model `opencode-go/deepseek-v4-flash`,
  pi_session_id `01a07d2b-43dc-76f3-9f84-f6a96c6df2db`.

## VALIDATION 1 — live dispatch, Fleet, validated result

Full loop ran in one real pi session (642 events, /tmp/pi-settle-probe.jsonl):

1. `specialist_dispatch {specialist: explorer, bead_id: unitAI-xp10q, model_override:
   opencode-go/deepseek-v4-flash}` -> `status: dispatched`, activation `act:b1d80e38-33a`,
   `pi_session_id` set, `resolved_model: opencode-go/deepseek-v4-flash`, step_contract counts.
2. `specialist_status` -> Fleet shows the activation (`state: running`).
3. After ~30s the activation reached `state: settled` with a `result` field:
   `status: completed`, `validation: {valid: true}`, real child output
   (markdown layout of config/pi-extensions/), `resolved_model`, `completed_at`.
4. Result achieved without `sp run`: the child is an in-process AgentSession.

## VALIDATION 2 — no sp process

The coordinator session itself ran `pgrep -fc 'sp run' || echo 0` immediately before
dispatch (3) and again after dispatch (3). Count unchanged; the dispatch created no child
process. (The 3 pre-existing processes are unrelated legacy sp jobs on the machine.)

## VALIDATION 3 — contract:draft refused

`specialist_dispatch {bead_id: unitAI-f3j2y}` (marked `contract=draft`, all 7 sections
present) -> structured tool RESULT (not a thrown error):

```
{"status":"rejected",
 "reason":"SPECIALIST_DISPATCH_REJECTED ... note: bead contract is marked draft —
   promote it with `bd set-state <id> contract=ready` first ... reason: bead_contract_incomplete",
 "detail":{"specialist":"explorer","beadId":"unitAI-f3j2y",
   "note":"bead contract is marked draft — promote it with `bd set-state <id> contract=ready` first"}}
... AgentSession: not created
```

## Host-level evidence (verbose harness, /tmp/sp-probe-settle2.mjs)

Full lifecycle with timestamps: activation_admitted -> activation_started (real pi session)
-> agent_start -> agent_end(119.7s single turn) -> agent_settled -> output_validation_passed
-> activation_completed. Result: `status: completed, validation: {valid: true}`.
Also observed: a failed child turn (provider 400) is recorded as `activation_failed`,
never as completed.

## Gaps for the operator's final acceptance run

- VALIDATION 4 (child enumerates its own tools == resolved allowlist): not provable through
  the current public host surface — the extension has no session reference and the host
  exposes no active-tool accessor. Needs either a host method or an operator asking the
  child in the interactive attach view.
- VALIDATION 5 (Fleet survives a turn boundary): requires an interactive session across two
  user turns. The extension holds one process-lifetime host; proof belongs in the operator's
  real `xt pi` run.
- Clarification loop (child asks, coordinator replies): blocked by unitAI-rrdnt.43
  (`createAgentSession`'s `tools` array is a hard filter that also drops `customTools`,
  so ask_coordinator never reached a child). Probe bead unitAI-gvyb8 is prepared (a task
  whose required fact is held by the coordinator); run after .43 lands on master.

## Clarification loop — live runs (follow-up)

Probe 1 (post .43.1/.43.2): child asked (state needs_reply), specialist_reply correlated
by message_id (answered x4, in_reply_to set), child resumed in-session after each reply
(needs_reply -> escalated -> running -> settled), but the ask tools rendered empty output.
Root cause: ask-tool custom tools returned a bare string; pi normalises `result.content ??
[]` so the text was dropped. Diagnosed live from the child's own report ("(no tool output)").
Fixed on master as .43.3 (18538e6e): ask() and the refusal now return
`{ content: [{ type: 'text', text }], details: {} }`; verified present in dist/lib.js.
Probe 2 (post .43.3) re-runs the same bead unitAI-gvyb8; expected child words + pending
ask disappearing + the child using the answered path in its result.

## unitAI-rrdnt.37.1 — forensic wiring + the node/bun:sqlite boundary (measured)

Wired (af2feb9c): lib seam adds createActivationForensicSink,
createObservabilitySqliteClientAtPath, resolveObservabilityDbLocation; the
extension builds its host through createCoordinatorHost(), resolving the
git-root canonical location, opening the client there (creating the canonical
file when absent, as sp run does), null-safe to the host's no-op sink.

MEASURED boundary: pi runs node (`#!/usr/bin/env node`); observability-sqlite
loads bun:sqlite only. /tmp/sp-measure-forensics.mjs against the built lib:
- bun: client OPEN at <cwd>/.specialists/db/observability.db (created).
- node: client NULL (MODULE_NOT_FOUND for bun:sqlite).
So in-process pi (node) sessions cannot currently write rows regardless of
wiring; a node:sqlite fallback in observability-sqlite is host-side work
(outside .37 scope). Live status probe under pi (node) after wiring: loads,
serves the Fleet, no crash (null-sink fallback verified).

Operator VALIDATION 1 interactive leg closed by dawid-0b (act:36a8720f-f30,
zai/glm-5.3-flash, validation valid, model_override honoured; bead-gate refusal
with note + missing SCRUTINY handled correctly by the coordinator).

## unitAI-rrdnt.43 / acceptance AX — PROVEN END TO END (post .43.3, live pi session)

Transcript /tmp/pi-ask-probe3.jsonl. dispatch act:0b19fc88-8c3 (explorer, unitAI-gvyb8) ->
child asked (msg:8b61870c-4dc) -> specialist_reply answered by message_id ->
child SETTLED completed, validation valid, pending_asks empty, and used the answer:
  "summary": "TARGET_FILE: src/activation/registry.ts: 65 lines."
  "verification": ["Path obtained from coordinator via ask_coordinator; line count read from file."]
Earlier 11-min non-settling outlier did not reproduce.

## unitAI-rrdnt.48 — inline-contract dispatch (implemented, unit-tested 14/14)
bead_id XOR contract; SAME readiness gate runs BEFORE bead creation (refusal leaves
board unchanged); both-together = structured refusal; neither = refusal.
## unitAI-rrdnt.49 — specialist_list tool (.49)
Resolved registry (repo+user overrides) + native dispatchability via the SAME host
checks (seam exports) + access tier + 'sp help' pointer.
## unitAI-rrdnt.37.1.1 THIRD defect — node driver write path (fixed 1a7ffeeb, host-side to place)
Measurement: client opened but 0 rows; append threw 'Unknown named parameter 0'.
Cause: module calls db.run(sql, [array]) (bun array form); adapter spread -> node:sqlite
read the array as named-param map. Fix: normalize single-array form + undefined->null.
Measured after: node writes rows; bun reads same WAL file.

## unitAI-rrdnt.37.1.1 — LIVE ROWS UNDER NODE-PI (definitive)

Probe rows2 (real pi, node process; coordinator opencode-go/deepseek-v4-flash):
dispatch act:198ce538-0c7 -> 10 forensic rows in the CANONICAL observability.db
(/home/dawid/dev/specialists/.specialists/db/observability.db) written by the
in-process node driver: activation_requested, step_contract_compiled,
activation_admitted, activation_starting, activation_started, turn_started,
turn_completed, activation_settled, activation_disposed, activation_failed.
Pre-fix control (act:2031b28d-b69) still 0 rows. The failed/disposed tail is the
probe process ending and session_shutdown disposing the still-running child.
