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
