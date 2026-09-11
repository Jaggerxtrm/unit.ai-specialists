---
title: Claude Channel Provider Constraints
scope: claude-channel-constraints
category: reference
version: 1.0.0
updated: 2026-09-10
description: Provider constraints on Claude Code Channels as an XTRM transport — preview status, platform availability, untrusted inbound handling, and no-acknowledgement delivery semantics.
---

# Claude Channel Provider Constraints

Claude Code Channels are the closest native equivalent to push into an open
Claude session, but they carry hard provider constraints. This document states
them in one place so implementers and operators do not rediscover them from
scattered notes. It mirrors the operator spec and the recorded wake-design
evidence; it adds no new normative claims.

Canonical sources:

- Operator spec `docs/claude-native-integration-spec-2026-09-09.md` §§U–X and
  wave E7 (§AK) — every claim below cites its section.
- Wake design on bead `unitAI-t2kol.10` §§1, 4, 5 and reconciliation R1–R5 —
  cited as `.10`.
- `mcp-docs` pane capture via `.10` §4/R5 — cited as `mcp-docs (via .10)`; the
  pane lane was still running when captured, so its findings are corroboration,
  not an independent verified source.

Do not make core Specialists or Substrate correctness depend on Channels
(spec §W).

## 1. Research-preview status and platform availability

Channels are a **research preview** (spec §U, §W). A Channel is an MCP server
that pushes an event into an already-open Claude session, advertising roughly
`experimental["claude/channel"]` and emitting `notifications/claude/channel`
with `params.content` and `params.meta` (spec §U). A two-way channel can also
expose ordinary MCP tools for replies (spec §U).

Availability constraints (spec §W; `.10` R5):

- Channels are opt-in: a session listens only when launched with the
  `--channels` flags (`.10` R5, `mcp-docs (via .10)`).
- Channel `meta` keys are restricted to `[A-Za-z0-9_]`; hyphens are silently
  dropped (`.10` R5, `mcp-docs (via .10)` — implementer constraint on
  completion-body meta).
- Whether a given deployment target actually supports Channels must be probed
  at runtime; treat preview-gating as excluding a platform until proven
  otherwise (`.10` §7: "preview-gating may exclude our target platform → wake
  stays polling-only; declared, not silent").

Treat Channels as a provider-native transport adapter **under** the durable
XTRM Channel, never as the Channel architecture itself (spec §V; `.10` R2).
The durable message/work state remains XTRM-owned; Claude's channel transport
is delivery, not authority (spec §§V–W). Experimental transport evaluation
must not delay the stable production integration (spec §AK, wave E6 rule).

## 2. Unsupported cloud platforms

Channels are not available on at least (spec §W):

- Amazon Bedrock
- Google Cloud Agent Platform
- Microsoft Foundry

Source status: the list is asserted by spec §W and corroborated by the
`mcp-docs` pane ("unavailable on Bedrock/GCP/Foundry per pane", `.10` R5).
Live availability on any specific platform or account was **not independently
verified** at the time of writing — confirm against the provider's current
Channels documentation and a runtime probe before depending on Channels on a
new target. Anything beyond these two sources is marked unverified rather
than stated.

## 3. Untrusted inbound data

Incoming Channel content is untrusted external input (spec §W). Treat it like
a webhook payload, email, external chat, or remote agent message — not trusted
instructions (spec §W). Before inbound content can affect durable work or
privileged tools, apply sender identity, authorization, routing, and
prompt-injection controls (spec §W). A channel event must never mutate an
Issue contract merely because the event text says to do so (spec §W).

Recorded implementation rules (`.10` §4 SECURITY, from the `mcp-docs` pane and
adopted as constraint):

- Gate inbound messages is required: channel/inbound content is
  attacker-controlled input and must pass the Gate before it reaches durable
  state or privileged tools.
- Completion bodies stay whole-object JSON projections — no prose summaries
  that could carry injection as instruction.

## 4. No-acknowledgement delivery and polling-authoritative fallback

Channel notification transport provides no application-level "Claude processed
this" acknowledgement (spec §X). A successful send means roughly "bytes
accepted by transport" — not "Claude saw the event", "Claude acted", or "work
completed" (spec §X). If the Channel was not loaded or policy prevented it,
delivery may be dropped (spec §X). The `mcp-docs` pane confirms: notifications
queue while busy, with no ack (`.10` §4). This matches the measured
`sent_unconfirmed` terminal for completion/finding delivery (`.10` §§1–2).

Consequences:

- Do not treat MCP notification completion as XTRM acknowledgement (spec §X).
  `delivered` means a receipt was seen, never merely that no error was thrown.
- XTRM retains its own durable delivery semantics where required (spec §X):
  persist the XTRM message/event first, attempt delivery over the Channel
  transport (`sent-to-transport`), and only mark consumed/acknowledged on a
  Claude/XTRM reply or receipt (spec §X model).
- The fallback is polling-authoritative: `specialist_status`
  `activation_results[]` + `pending_asks[]` is the authority and push is
  best-effort notify (`.10` §1). A pushed completion and a polled read must
  reach the same result object — push is a projection of the validated result,
  never a substitute (`.10` §§1–2; spec §X).
- Until a receipt test passes on the deployment target, receipt stays
  unproven and polling owns delivery confirmation (`.10` §5).
