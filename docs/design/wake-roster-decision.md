# Wake roster decision record (E6 E2)

Bead: `unitAI-aiwva.5` · grounding: unitAI-t2kol.10 §3 + RECONCILIATION R4 ·
spec §§AF/AG/AI · status: **record shipped; socket-send stays opt-in-only**

## Terminology (§AG, applied)

- **XTRM Channel**: durable, provider-neutral message abstraction. The pending-store
  record + `specialist_status` projection. Provider transport failure never erases it.
- **Claude Channel transport**: research-preview delivery adapter under the XTRM
  Channel (`notifications/claude/channel`). Evaluation-only per §AK.
- **Peer-socket / roster**: undocumented discovery surface (`~/.claude/sessions/*.json`
  + per-PID UDS). Neither an XTRM Channel nor the Claude Channel transport.

## Measurement (read-only, `bun scripts/measure-roster.ts`)

Script applies the production liveness rules (`selectRoute`: /proc + `procStart`
mandatory, socket path present, protocol v1) with the real process probe. No
registration, no cleanup, no sends. Socket-file counts are informational only —
socket presence is never liveness evidence.

Authoring-host baseline (rrdnt.12 §4, prior): 20 registrations, 50% stale,
128 orphan sockets → OPT-IN-ONLY.

This host (`~/.claude/sessions`), 2026-09-09:

```text
roster: /home/dawid/.claude/sessions
total registrations: 15  live: 15  live-rate: 100.0%
stale_no_proc=0 procstart_mismatch=0 missing_procstart=0 no_socket=0 unparsable=0 unsupported_protocol=0
orphan .sock files (informational, never liveness): 206
verdict: MAY-PROPOSE-DEFAULT-ON (still needs E3 receipt test PASS; decision record required)
```

Self-check on a synthetic roster (1 proc-mismatch, 1 dead pid, 1 missing procStart):

```text
total registrations: 3  live: 0  live-rate: 0.0%
stale_no_proc=1 procstart_mismatch=1 missing_procstart=1
verdict: OPT-IN-ONLY (live-route rate <50%: socket-send must not be default-on here)
```

## Decision

**Socket-send stays opt-in-only on every host, including this one.**

- The ≥80% bar is a *sustained* bar for a *proposal*, not a single-sample flip:
  one 15/15 snapshot is not sustained, and the 206 orphan sockets confirm the
  directory accumulates garbage that liveness rules must keep excluding.
- E3 receipt is UNPROVEN (blocked on rrdnt.25 user ruling; not run in this lane).
  Per §3, even a sustained ≥80% still needs E3 PASS before any default-on proposal.
- Stale entries need no cleanup action: `selectRoute` already rejects them, and
  every rejection degrades to polling-authoritative, which is the proven path.

## Consequences

- E5 peer-socket demotion (flag-gate socket-send, keep durable writes + polling)
  proceeds as a **decision-record now, code action sequenced after spec E3**
  (RECONCILIATION R4 sequencing flag) — follow-up lane, not this bead.
- E3 receipt test remains the only path to `delivered`: record as follow-up with
  owner = user ruling (rrdnt.25) + assigned implementer; do not run here.
- Until measured per-host + E3 PASS, §13.1 wake conformance over MCP is UNPROVEN
  on any host regardless of this host's 100% snapshot.

## Security (§AI, applied)

Roster entries are claims, not facts: `status` and display names are never
liveness or identity. `procStart` is mandatory (PID-reuse routing is the failure
it prevents). Inbound content arriving over any route stays attacker-controlled
input behind the Gate; completion bodies stay whole-object JSON projections,
never prose summaries that could carry injection as instruction.
