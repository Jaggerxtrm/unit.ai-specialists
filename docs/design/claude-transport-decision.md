# Decision: Claude Code transport for native Specialist activation

Status: **accepted**
Bead: `unitAI-rrdnt.10` (P0, SCRUTINY HIGH)
Supersedes: PRD §102 and §110 transport assignment
Implementing bead: `unitAI-rrdnt.12`
Evidence: `docs/design/native-activation-reconciliation.md` §5, `/tmp/xtrm-native-specialists-references/NOTES/pi-claude-link.md`

## 1. Decision

MCP remains the **dispatch** surface for Claude Code. It does not carry
runtime-originated push.

| Direction | Transport | Why |
|---|---|---|
| Coordinator → Specialist (delegate, status, stop, message-in) | MCP tool calls | Request/response. Claude Code's MCP client implements this fully. |
| Specialist → coordinator (clarification, escalation, finding, completion) | Peer channel (per-PID UDS + session registration) | The only mechanism observed to deliver an unsolicited message into a running session. |
| Either, when no peer channel is registered or delivery is refused | Polling `specialist_status` | Reliable, needs no push, and is the state of record regardless. |

The peer/roster adapter moves from a Phase 15 additive integration to a **Phase 14
prerequisite**. PRD Phase 14 as written is not buildable without it.

Unchanged: the MCP server still hosts activations by calling shared library code
directly. PRD §99's prohibition on `MCP → Bash → sp run` stands. The peer channel is an
adapter and is never authoritative for activation identity, lease authority, result state,
or forensic state (PRD §107, invariant 14).

## 2. Why MCP push is unavailable

This is a property of Claude Code's MCP **client**, not of the MCP specification. Every
notification surface the PRD's §102 phrase "the supported Claude MCP channel/event
surface" could refer to is absent or inert:

| Surface | State in Claude Code | Issue |
|---|---|---|
| `sampling/createMessage` | not implemented | #1785 |
| `resources/subscribe` + `notifications/resources/updated` | server sends, client ignores; model context never refreshed | #7252 |
| progress notifications / tokens | not implemented; no streaming during a tool call | #31893, #51713 |
| `notifications/message` (logging) | received, silently discarded; no per-server logs | #3174, #33679 |
| `elicitation/create` | CLI only, partial; times out or cancels elsewhere | #2799, #85442, #56243 |
| `tools/list_changed` | works across turns, fails same-turn, startup races | #31893 |

Consequence: acceptance AX (Specialist asks, Claude answers, child resumes) cannot be
satisfied over MCP. Building it there would produce a channel that silently never
delivers — the same failure mode the table above already documents.

Re-evaluate this decision if Claude Code implements sampling or fixes resource
subscriptions. Track anthropics/claude-code#31893.

## 3. Why the peer channel is the right correction

The Phase 0 research concluded out-of-band delivery was "not supported (no webhooks, event
bus)". That conclusion is **wrong**, and correcting it is what makes Phase 14 buildable.

Direct evidence, observed rather than cited. During the authoring session, messages from a
peer Claude session arrived mid-turn, repeatedly, wrapped as
`<cross-session-message from="uds:/run/user/1000/cc-socks/<pid>.sock">`, while this session
was executing tools. Both mechanisms `pi-claude-link` (MIT,
`7fdccbdffd556f7e76b6a35a8bb545c89c76133a`) documents are present on this machine and were
verified by inspection:

- per-PID `0600` unix sockets under `/run/user/1000/cc-socks/*.sock`;
- session registrations under `~/.claude/sessions/<pid>.json`, carrying `pid`,
  `procStart`, `sessionId`, `name`, `nameSource`, `kind`, `status`,
  `messagingSocketPath`, and `peerProtocol`.

**`procStart` has TWO formats and an implementation must accept both.** Measured across all
18 registrations on this host: **13** carry it as a **number** — raw field 22 of
`/proc/<pid>/stat`, ticks since boot — and every one of those was written by Claude Code
itself (2.1.257 / 2.1.263), verified by exact equality for pids 1100092, 2176609, 3574376
and 404065. Only the **5** `pi-claude-link` entries use the `ps`-style string
(`"Mon Sep  7 11:10:29 2026"`). An earlier version of this section documented only the
string form, having generalised from a sample that excluded every registration Claude Code
writes. An adapter following it literally rejected 13 of 18 live sessions as
`missing_proc_start` — it would have refused to route to every native Claude coordinator,
and the symptom would have read as "the peer channel does not work" rather than "the
liveness check is wrong". Prefer the numeric form: it is an exact integer comparison with
no tolerance, where the string form needs a ±2s window.

`pi-claude-link` already implements registration, a colocated socket, route identity
separate from display name, `agent_end` reply relay, and a receipt frame carrying
`orig_msg_id`. The adapter reuses that shape; it does not invent a protocol.

**`steer` is a receiver-side behaviour, not a sender's choice.** An earlier draft of this
record listed "idle `sendUserMessage` versus busy `steer`" as something the adapter does.
It is not. `pi-claude-link/index.ts:91` selects `deliverAs: "steer"` for its *own* agent
when *it* is busy — the receiver injecting an inbound message into its current turn. Every
outbound frame carries the default `priority: "next"`. A sender that tried to choose would
have to branch on the registration's self-reported `status`, which §4 measures as
unreliable, so the adapter must not branch on it.

## 4. What the roster actually guarantees — measured

The roster is a discovery surface, not a liveness oracle. Measured on the authoring host:

- **20** registration files; **10** of them named PIDs with no `/proc` entry — dead
  sessions still advertising `status: "idle"` with their socket file present on disk.
- **128** socket files for those 20 registrations. The socket directory accumulates
  garbage and is never a membership list.
- `peerProtocol: 1` on every entry — the wire is versioned, so an adapter must check it.
- `nameSource` is `derived` or `user`. The display name is not stable identity, which is
  why route identity must stay separate from it.

Three rules follow, and they are the load-bearing part of this decision:

1. **Liveness is `/proc/<pid>` plus `procStart`**, never socket existence and never the
   registration's own `status` field. `status` is written by the session and is stale
   exactly when the session died — the case that matters.
2. **`procStart` is mandatory**, not optional hardening. PID reuse would otherwise route a
   Specialist's clarification into an unrelated process.
3. **Reachability is asymmetric and can lapse mid-session.** Observed directly: the
   `t4et` worker vanished from the roster and its socket path returned `ENOENT` on send,
   while it continued to deliver messages *to* this session. An adapter that infers "peer
   is gone" from a failed send will be wrong.

## 5. Delivery is best-effort, by design

Peer delivery passes the user's cross-session approval gate — observed as an explicit
"message was approved and released" step. A message may therefore be **held, delayed, or
refused**, and none of those are errors.

The adapter must never treat delivery as guaranteed or as authority (PRD §26, §111), and
must never lose a message (PRD §30). Therefore:

- Every runtime-originated event is written to its durable pending state **before** any
  send is attempted, and the send is an optimisation on top of that state.
- An undeliverable, held, or refused push degrades to pending state readable through
  `specialist_status`. The Specialist stays in `needs_reply`; it does not fail and does not
  silently proceed.
- A receipt is required to mark a push delivered. Absence of an error is not a receipt.

**Delivery and confirmation are separable, and measured to be.** A probe frame built by the
adapter itself — not by the host's own messaging tool — was written directly to a
coordinator's socket and **arrived** in that session. No `peer_message_status` receipt
returned to the sender's colocated socket within 15s. So raw delivery works from an
unregistered sender, while confirmation does not: receipts appear to be emitted only to
senders holding a `~/.claude/sessions/<pid>.json` registration, which `pi-claude-link`
writes via `registerPeer()` and the probe deliberately did not.

The consequence is a decision, not an implementation detail: **acceptance AX requires the
runtime to register itself as a peer**, and that writes to the user's environment. That is
the operator's call, and it has now been made.

**Ruling, 2026-09-07: approved.** The operator's words were "yes it can, i do approve."
The activation runtime may write `~/.claude/sessions/<pid>.json` and bind a colocated
socket so receipts return and a push can honestly be marked delivered. Tracked as
`unitAI-rrdnt.25`.

Approval was given on two conditions, and both are binding rather than advisory, because
the approval was granted on the understanding that registration does not degrade the
roster it joins:

1. **Deregistration on exit**, including abnormal exit as far as it can be made to hold.
2. **Orphan cleanup.** Measured baseline before this work: 128 socket files for 20 live
   registrations. Registration must not add to that ratio.

One design consequence follows from the second condition. Register once per **runtime
process**, never per activation: a per-activation registration multiplies roster entries by
concurrency and turns cleanup into a race against the activations themselves.

Two things this ruling does not change. The adapter's degraded behaviour stays exactly as
built and tested — `sent_unconfirmed`, claim nothing, leave the question readable through
the polling projection — because registration can still be absent, stale, or refused, and
the approval gate in this section is untouched by it. What changes is only the expected
steady state: with registration in place, `no_receipt` becomes a fault to investigate
rather than the normal outcome it was when this section was first written.

## 6. One protocol, two transports

Both paths normalise to the single semantic participant protocol (PRD invariant BH). The
`InteractionMessage` is produced once by the runtime; MCP and the peer channel are
serialisations of it, not two vocabularies. A clarification read by polling and the same
clarification delivered over the peer channel must be indistinguishable to the coordinator
apart from latency.

Corollary: a completion notification remains a *projection* of a validated
`ActivationResult`, never a substitute for it (`src/activation/types.ts`). A coordinator
that received a push and a coordinator that polled must reach the same result object.

## 7. Phase ordering change

- Phase 13/14 gain a hard prerequisite: the peer/roster adapter, including liveness and
  approval-gate handling from §4 and §5.
- Phase 15 loses the adapter as new work; it retains only what is genuinely additive on
  top of it.
- Polling via `specialist_status` is specified as the degraded fallback and must be built
  first, because it is the only path with no external dependency and it is what the pending
  state is read through.

## 8. Not settled here

This bead is a decision record. Its acceptance criteria are executable only by the
implementing bead, and are restated there rather than claimed here:

1. Acceptance AX over the peer channel — Specialist asks, busy coordinator receives,
   replies, child resumes in the same session.
2. Acceptance AY — a structured completion notification tied to a validated
   `ActivationResult`.
3. With the peer channel unavailable, `specialist_status` still surfaces the pending
   clarification and nothing is lost.
4. Both paths produce identical `InteractionMessage` semantics (BH).

Nothing in §1–§7 has been proven by a running Specialist. The evidence above establishes
that the transport exists and how it misreports liveness; it does not establish that the
adapter works.
