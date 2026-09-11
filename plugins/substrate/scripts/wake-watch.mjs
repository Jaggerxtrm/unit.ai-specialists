#!/usr/bin/env node
// Substrate plugin idle-wake watcher (asyncRewake, operator spec §Z/§AA/§AF).
//
// RECOVERY PATH, NOT THE PRIMARY WAKE. Since unitAI-aiwva.21 the primary wake is a
// Claude Code Channel push (`src/mcp/channel.ts`): the MCP server sends
// `notifications/claude/channel` the instant the host emits a transition, which reaches
// an idle session with no polling and no model wakeup until a real event exists.
//
// This watcher stays because that push is gated EIGHT ways on the client — capability,
// protocol era, provider, feature flag, org policy, `--channels` membership, marketplace
// match, plugin allowlist — and every failing gate is a SILENT no-op. It is also
// interactive-only: Claude Code registers the channel listener in the TUI, so any session
// where a gate is closed has no push path at all and this hook is the only thing that
// reaches it. Delivery is unacknowledged, so a push that vanishes leaves no trace either.
//
// Cadence is therefore relaxed rather than tuned: this is the slow safety net behind a
// fast path, and paying a 5s poll for an event the channel usually already delivered is
// the exact cost the channel work removed.
//
// Claude Code's own schema: "If true, hook runs in background and wakes the model on exit
// code 2 (blocking error). Implies async." So this process blocks in the background and the
// ONLY way it wakes the session is exiting 2.
//
// What it watches: activations in the Substrate store crossing into a state the coordinator
// must act on — `settled` (a result is readable) or `needs_reply` (a question is waiting).
// A baseline is taken at start so a session is woken for NEW events, never for the backlog
// that was already there when it began.
//
// What it emits: a REFERENCE, never authority — activation_id, state, reason. No result
// bodies, no prompt bodies, no forensic IDs, no instructions. The woken session reads
// authoritative state through specialist_status, exactly as a polling coordinator does.
// A wake that is missed degrades to polling: the coordinator reads the same object late,
// never a different object.
//
// Discipline: exit 0 on every failure path. Exit 2 ONLY on a real observed transition —
// a spurious 2 wakes a session for nothing, which trains the operator to ignore wakes.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// 30s, not 5s: recovery latency behind the channel push, not primary wake latency.
const POLL_MS = Number(process.env.SUBSTRATE_WAKE_POLL_MS ?? 30000);
// Must finish INSIDE the hook's `timeout` (900000ms in hooks.json — timeout IS enforced for
// asyncRewake). Exiting cleanly beforehand beats being killed: a killed watcher stops
// watching silently, which is the failure this whole hook exists to avoid.
const MAX_MS = Number(process.env.SUBSTRATE_WAKE_MAX_MS ?? 870000);
const ACTIONABLE = new Set(['settled', 'needs_reply']);

function resolveStorePath() {
  const override = (process.env.XTRM_STATE_DB ?? '').trim();
  if (override) return override;
  return join(homedir(), '.xtrm', 'state.db');
}

async function openStore(storePath) {
  try {
    const { Database } = await import('bun:sqlite');
    return new Database(storePath, { readonly: true });
  } catch {
    // Not under bun: node:sqlite serves the same prepare/close surface.
  }
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(storePath, { readOnly: true });
}

/** activation_id -> state, for rows in a state the coordinator must act on. */
async function readActionable(storePath) {
  const db = await openStore(storePath);
  try {
    const rows = db
      .prepare(
        `SELECT activation_id, state, bead_id FROM activations WHERE state IN ('settled', 'needs_reply')`,
      )
      .all();
    const map = new Map();
    for (const row of rows) {
      if (row && typeof row.activation_id === 'string' && ACTIONABLE.has(row.state)) {
        map.set(row.activation_id, { state: row.state, bead_id: row.bead_id ?? null });
      }
    }
    return map;
  } finally {
    db.close();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Interactive sessions only. Under `claude -p` the entrypoint is `sdk-cli`, and a hook that
// blocks there does not merely fail to wake anything (spec §AB says headless may kill
// background hooks) — it breaks the run outright: every `claude -p` against this plugin
// returned "No messages returned from query" until this guard existed. A plugin must never
// cost a user their scripted invocations to serve an interactive feature.
if ((process.env.CLAUDE_CODE_ENTRYPOINT ?? '') !== 'cli') process.exit(0);

try {
  const storePath = resolveStorePath();
  if (!existsSync(storePath)) process.exit(0);

  // Baseline: everything already actionable when this session started is NOT news.
  let seen = await readActionable(storePath);
  const deadline = Date.now() + MAX_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    let current;
    try {
      current = await readActionable(storePath);
    } catch {
      continue; // A transient read (locked db, mid-write) is not a reason to stop watching.
    }

    const fresh = [];
    for (const [id, row] of current) {
      // §AA: the payload carries retrieval references — the Issue ref rides along with the
      // activation id so the woken session can reach the durable contract, not just the run.
      if (seen.get(id)?.state !== row.state) {
        fresh.push({ activation_id: id, state: row.state, bead_id: row.bead_id });
      }
    }
    seen = current;

    if (fresh.length > 0) {
      const settled = fresh.filter((f) => f.state === 'settled').length;
      const asking = fresh.filter((f) => f.state === 'needs_reply').length;
      const reason =
        asking > 0 && settled > 0
          ? `${asking} awaiting reply, ${settled} settled`
          : asking > 0
            ? `${asking} awaiting reply`
            : `${settled} settled`;
      const payload = JSON.stringify({
        source: 'substrate',
        reason,
        activations: fresh.slice(0, 10),
        read_with: 'specialist_status',
      });
      // Sources disagree on which stream becomes the system reminder: the E6 staging
      // fragment says stderr, Claude Code's own rewakeMessage schema says "hook output".
      // Writing both costs one line and removes the question.
      console.error(payload);
      console.log(payload);
      process.exit(2); // The wake. Nothing else in this file may exit 2.
    }
  }
} catch {
  // Silent on every failure path: a watcher must never wake a session by accident.
}
process.exit(0);
