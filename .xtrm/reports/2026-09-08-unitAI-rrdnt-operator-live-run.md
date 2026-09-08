# Operator live run over the merged tree — unitAI-rrdnt

**Date** 2026-09-08 · **Tree** master @ 2406c1f3 (all five lanes merged, pushed to
`feature/unitAI-rrdnt-native-specialist-activation`) · **Runner** coordinator session `dawid-0b`

## What this run is

The epic's completion bar asks for the extension loaded in a live `xt pi` session and
driven as an operator would drive it. Every prior live proof came from a lane exercising
its own change. This one runs the *merged* tree, end to end, from outside.

## Launch

```
xt pi operator-live --model opencode-go/muse-spark-1.3-contributor --no-attach \
  -- -e /home/dawid/dev/specialists/config/pi-extensions/specialist-subagents/index.mjs
```

The `-e` path is the main repo's merged tree; the session itself ran in its own worktree.
Nothing auto-discovers the extension, so `-e` after a bare `--` is the only load path
today. That is filed as **unitAI-rrdnt.53** and is a cross-repo change to `xtrm-tools`.

## Measured, in order

| # | Surface | Bead | Result |
|---|---|---|---|
| 1 | Extension loads over merged tree | — | `specialist_*` tools registered |
| 2 | `specialist_list` | .51 | 25 specialists, 23 natively dispatchable; `bare` and `changelog-keeper` correctly excluded |
| 3 | Wake announcement at first dispatch | .45 | "Specialist wake is on: a blocked child will start a turn here on its own. Disable with `--no-specialist-wake`." |
| 4 | Unknown specialist refused | .48 | `unknown_specialist`, `AgentSession: not created` |
| 5 | Readiness gate refused | .48 | `bead_contract_incomplete`, `missing: - SCRUTINY` — named the section |
| 6 | Dispatch after the bead was fixed | .48 | `act:e2722afb-e91`, `att:e2722afb-e91:1` |
| 7 | Fleet widget, unprompted | .46 | `Specialists — 1 activation(s), 0 pending ask(s)` / `settled explorer unitAI-ovdmh [read] act:e2722afb-e91` |
| 8 | `/` menu | .46 | `/fleet`, `/fleet:reply`, `/fleet:stop` all listed with descriptions |
| 9 | Argument completion | .46 | `/fleet:stop act:` offered `act:e2722afb-e91  explorer · settled` from live host state |
| 10 | `/fleet:stop` executed | .46 | `Stopped act:e2722afb-e91.`, panel cleared |
| 11 | Forensic rows under node-pi | .37.1.1 | 11 rows |
| 12 | Result projection | .34 / kv8ac | full result view rendered in the Pi coordinator |

## Forensic evidence, read from the database and not from the coordinator

`specialist_forensic_events`, `job_id = act:e2722afb-e91`, 11 rows:

```
activation_requested -> step_contract_compiled -> activation_admitted -> activation_starting
-> activation_started -> turn_started -> turn_completed -> activation_settled
-> output_validation_started -> output_validation_passed -> activation_completed
```

`activation_admitted` body:

```json
{
  "tier": "READ_ONLY", "access": "read",
  "configured_model": "opencode-go/deepseek-v4-flash",
  "requested_model":  "opencode-go/deepseek-v4-flash",
  "resolved_model":   "opencode-go/deepseek-v4-flash",
  "model_override": false,
  "tools": "read,grep,find,ls",
  "custom_tools": "ask_coordinator,escalate_to_coordinator"
}
```

Three things that row settles independently of any test:

1. **The allowlist did not widen.** `read,grep,find,ls` and nothing else — no `bash`,
   `edit`, `write` or `powershell` for a read-only Specialist. That is .43's VALIDATION 2,
   observed in production rather than asserted in a unit test.
2. **The ask tools are in the contract.** `custom_tools` carries both. That is .43's
   VALIDATION 1, same way.
3. **`deployment_environment: local`.** The NODE_ENV bake-in fix is holding in a real
   build, not just in a byte-comparison of two bundles.

## The child did real work and got it right

Result view as the coordinator received it:

```json
{ "status": "completed", "validation": { "valid": true },
  "pi_session_id": "01a0808f-5515-73cd-bfd6-84657bbb3f6c",
  "configured_model": "opencode-go/deepseek-v4-flash",
  "resolved_model":   "opencode-go/deepseek-v4-flash",
  "model_override": false, "fallback_used": false }
```

The probe bead asked for the export count of `src/lib.ts`. The child answered **25**,
which matches `grep -c '^export' src/lib.ts` run independently, and listed the exact line
numbers it counted. It also flagged the ambiguity in my own bead text — 25 export
*statements* versus 75 exported *names* — and said which reading it took and why. The
contract was imperfect and the child said so rather than guessing.

That result view is `toActivationResultView`, the shared projection that replaced the
extension's duplicate `toResultView` earlier the same day (unitAI-kv8ac). This is the
first live run in which the Pi coordinator and the MCP coordinator project a settled
activation through the same function.

## What this run does NOT prove

**No ask, and therefore no wake.** The probe bead was self-contained, so the child never
called `ask_coordinator` and the wake never fired. Item 3 above is the *announcement*, not
the wake itself. The wake is proven — four live TUI transcripts on
`.xtrm/reports/2026-09-08-unitAI-rrdnt.45-wake-evidence.md`, including a degraded run under
`--no-specialist-wake` re-recorded after the delivery fix — but it is proven by that lane
and not by this run.

**`/fleet:reply` was never executed.** With no pending ask there was nothing to reply to.
Its completion was exercised by the ui-fleet lane against a stub host; its execution
against a genuine ask is proven only in the .45 transcripts.

**Provider instability.** The session took repeated `429 rate_limit_exceeded` from
`opencode-go`. Every one was retried and recovered. No result above depends on a retried
turn producing a different answer, but the run is not a clean latency measurement.

## Two defects this run found in my own work, not in the product

1. The probe bead I wrote omitted `SCRUTINY`. The gate refused and named the missing
   section. Correct behaviour, and the same refusal shape the earlier interactive run
   produced — the second time this gate has caught a contract written by the coordinator
   who built it.
2. I first waited on `select ... from forensic_events`, a table that does not exist. The
   wait loop exited and I briefly read that exit as evidence the activation had settled. It
   was evidence of nothing. The real table is `specialist_forensic_events` and the
   activation id is stored in `job_id`, not `activation_id`. A polling loop whose predicate
   throws is indistinguishable from one whose predicate is false — which is the same shape
   as the five fixture-not-system defects this epic already ate, produced by the person
   cataloguing them.
