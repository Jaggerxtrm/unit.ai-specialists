# Interactive xt pi TUI run — the operator's completion bar

Date: 2026-09-08. Driven by the coordinator session (dawid-0b) directly, not by a lane.

## Why this run exists

Every prior proof of the Pi extension ran in `pi --mode json` sessions. Those are real pi
processes, but they are not the interactive TUI, and the operator's stated bar is
"locally installed extension and tested in a live xt pi session". This closes that.

## Invocation, including the one that failed

FAILED first attempt:

    xt pi tui-ax-probe --model zai/glm-5.3-flash -e config/pi-extensions/specialist-subagents/index.mjs

The session started normally and the coordinator had NO `specialist_*` tools. It then
diagnosed the absence as "no MCP servers are connected (0 servers, 0 tools)" and offered
the `sp` CLI instead — a confident and wrong explanation, because the extension surface
is not MCP. `xt pi` forwards flags to pi only AFTER `--`; anything before it is
xt-owned or dropped. Silent failure plus a plausible misdiagnosis.

WORKING form:

    xt pi tui-ax2 --model zai/glm-5.3-flash -- -e config/pi-extensions/specialist-subagents/index.mjs

Confirmed loaded: the extension appears in pi's `[Extensions]` list, and the coordinator
enumerated all four tools — specialist_dispatch, specialist_status, specialist_reply,
specialist_stop_activation.

## What happened, in order

1. **The bead gate refused.** Probe bead `unitAI-exfgr` was written without a SCRUTINY level.
   The refusal rendered:

       note:
         bead declares no SCRUTINY level (expected one of LOW, MEDIUM, HIGH, CRITICAL)
       reason:
         bead_contract_incomplete
       missing:
         - SCRUTINY

   That `note:` line is unitAI-rrdnt.40. Before that fix the operator would have seen a
   bare `bead_contract_incomplete` against a bead whose seven sections all appear present.

2. **The Fleet agreed with the refusal.** `specialist_status` returned zero activations
   and zero pending asks, and the coordinator called the rejection terminal rather than
   polling for an activation that was never created. It also declined to promote the
   contract itself, having been told not to do the bead's work.

3. **Re-dispatch after adding SCRUTINY succeeded.** `act:36a8720f-f30`,
   `participant_id: specialist::explorer`, `attempt_id: att:36a8720f-f30:1`.

4. **Settled on the first poll**, `status: completed`, `validation: valid`,
   `fallbackUsed: false`, `model_override: true`, resolved model `zai/glm-5.3-flash`
   against the bead's configured `opencode-go/deepseek-v4-flash`. The child returned its
   structured report: three directories under `config/pi-extensions/`, no files changed,
   no follow-ups, no risks.

## Acceptances exercised

- **AV / AW** — a real Specialist obtained from an interactive Pi coordinator, no `sp`.
- **O** — a bead that is not a usable task contract is refused before a session exists.
- **C / E / AZ** — a per-activation model override honoured through the Pi frontend, with
  requested and resolved both recorded (unitAI-rrdnt.35).
- **Ruling (a) on fallback** — `fallbackUsed: false` on a completed activation.

## What this run does NOT prove

- **Forensics.** `specialist_forensic_events` has ZERO rows for this job_id, and the
  worktree has no `.specialists` directory, so the rows were never written rather than
  written elsewhere. The extension constructs `new NativeActivationHost()` with no sink
  while `src/server.ts` passes one. Filed as unitAI-rrdnt.37.1. Acceptance AJ does NOT
  hold for the primary surface.
- **The clarification loop.** Not exercised here; that is unitAI-rrdnt.43 and the
  extension lane's forced-ask probe.
- **"Installed".** `xt pi status` reports the global catalog as
  `npm:@jaggerxtrm/pi-extensions`, which does not contain `specialist-subagents`. So
  "locally installed" currently means "passed with `-e` from a checkout", not "available
  in any session". Unresolved packaging question.
