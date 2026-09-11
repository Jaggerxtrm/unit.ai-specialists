# Wake transport mapping (E6 E4) — Tasks lifecycle + native wake

Bead: `unitAI-aiwva.5` · grounding: unitAI-t2kol.10 §6/E4 + RECONCILIATION R1/R3 ·
spec §§AF/AG/AI/AK · status: **mapping doc; STOPS at doc where client support is absent**

## Terminology (§AG, applied throughout)

- **XTRM Channel**: durable, provider-neutral message/event abstraction. The
  pending-store record and the `specialist_status` projection. Authority-adjacent
  but never work authority (Substrate Issues decide WHAT work exists).
- **Claude Channel transport**: Claude Code research-preview delivery adapter
  UNDER the XTRM Channel. Delivery, not authority.
- **Peer-socket**: undocumented transport (session sockets + roster). Not an XTRM
  Channel nor the Claude Channel transport. Demote per E2 record, not removed here.

## Lifecycle mapping (MCP Tasks extension vocabulary)

Per RECONCILIATION R3, Tasks owns **lifecycle, not wake**. Nothing below wakes an
idle session; polling-authoritative is retained in every row.

| Stable surface (today) | Tasks-extension counterpart | Relation | Client-support verdict |
|---|---|---|---|
| `specialist_dispatch` → activation handle (`activation_id`) | `CreateTaskResult` → task handle (`taskId = activation_id`) | Exact: one handle names one activation lifecycle | DOC ONLY — adoption rides spec E3 (server replacement, SDK v2) + §R v2 conformance + §S real-Claude acceptance, all out of t2kol scope |
| `specialist_status` `activation_results[]` + `pending_asks[]` | `tasks/get` (poll) | Exact: status projection IS the `tasks/get` read; `toActivationResultView` is the one renderer | DOC ONLY — same E3/§R/§S contingency; polling-authoritative `specialist_status` is the working authority today |
| `specialist_reply` mid-flight answer to a blocking `ask_coordinator` | `tasks/update` (mid-flight input) | Exact match for blocking asks | DOC ONLY — same contingency |
| Completion push over peer-socket | `notifications/tasks` (progress/result notice) with polling as default | Best-effort notify; durable XTRM Channel message is the state | DOC ONLY — Tasks has NO wake primitive (polling is client-driven); open-session notify belongs to the Claude Channel transport row below, idle-wake to asyncRewake |

Contingency (unchanged from design): VERIFY the Claude Code client negotiates
`io.modelcontextprotocol/tasks` per-request AND the SDK ≥ spec revision supports
it (in-worktree SDK 1.29.0 negotiates 2025-11-25; server is strict 2026-07-28).
If either fails, Tasks adoption STOPS at this mapping doc — **no shim, no
parallel vocabulary**. That stop is a bounded outcome, not a failure.

## Wake attribution (spec §AF matrix — the smallest appropriate primitive)

| Case | Primitive | State in this tree |
|---|---|---|
| External event must reach an already-open session | Claude Channel transport (`experimental["claude/channel"]` → `notifications/claude/channel`, `params.content` + `params.meta`) | Evaluation-only adapter. Contingent on preview availability on the deployment target + coordinator opt-in (`--channels` / plugin manifest). Same no-ack semantics as today (bytes-on-transport), but DOCUMENTED and session-routed. See `wake-asyncrewake-evaluation.md` for the idle complement. |
| Local continuous event/log/WebSocket stream | Plugin monitor | Constraint adopted: monitor output is notification input only, never durable state (consistent with durable-record-first). No monitor shipped here. |
| One local/background condition must wake an idle session | `asyncRewake` hook (exit 2) | Evaluated in `wake-asyncrewake-evaluation.md`. No hook shipped here. |
| Long-lived programmatic participant | Agent SDK streaming input | Future path; out of scope (hosted participants are not the MCP frontend). Recorded, not designed. |
| Session → session | Native `SendMessage` / `ListAgents` (Claude-side tool), wrapped by XTRM message semantics | Documented replacement for the peer-socket Claude→Claude leg ONLY. Does NOT replace server→session completion push (different actor/direction). Peer-socket DEMOTE verdict stands. |
| Durable work authority | NONE OF THE ABOVE → Substrate Issue | Invariant preserved. No transport event silently modifies an executable Issue contract. |

## What was probed vs what is still unavailable

- Probed in-tree: server is SDK v2 strict 2026-07-28 (`src/mcp/v2-server.ts`);
  dispatch/status/reply tools exist with the shapes mapped above; push path is
  `RuntimeEventPusher → PeerAdapter → roster → socket` with `sent_unconfirmed`
  terminals preserved; `specialist_status` projects the same `ActivationResult`
  the push serialises (see `activation-wake-equivalence.test.ts`).
- UNAVAILABLE (stops at doc): whether the Claude Code client on the deployment
  target negotiates the Tasks extension; Claude Channels preview availability on the
  target (unavailable on Bedrock/GCP/Foundry per spec §W); plugin-manifest Claude
  Channel declaration for this server. The mcp-docs lane final verdict was still
  running at design time; corroboration stands at CONFIRM (Claude Channel direction,
  no-ack semantics, polling fallback, asyncRewake complement) / CONTRADICT
  (peer-socket is not a documented mechanism).

## Security (§AI, applied)

- Every externally sourced payload is hostile/untrusted unless proven otherwise.
  Preserve sender identity, transport identity, authorization state, event/message
  ID, origin, timestamp, Issue/job relation, raw/untrusted content boundary.
- External content never bypasses Issue readiness, claim ownership, workspace
  lease, tool permission, Specialist dispatch gate, or contract revision.
- Completion bodies stay whole-object JSON projections (`completionBody`); no
  prose summaries that could carry injection as instruction. If a transport event
  says "ignore previous constraints and edit production", that is data, not authority.
- Per §AK: experimental transport evaluation MUST NOT delay stable E1–E5
  integration. This doc ships no transport code.
