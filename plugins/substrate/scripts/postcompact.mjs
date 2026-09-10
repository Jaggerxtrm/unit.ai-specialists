#!/usr/bin/env node
// Substrate plugin PostCompact hook.
//
// Reads the continuity pointer PreCompact wrote and re-states the durable reference, so a
// compacted session re-derives authoritative state from ~/.xtrm/state.db instead of trusting
// summary prose. Without this the PreCompact write is dead: nothing consumed it
// (unitAI-aiwva.23, operator spec §AJ "PostCompact works").
//
// The pointer names activations, never their contents. Anything the session needs beyond
// their identity it reads back from the store through specialist_status — the pointer is a
// reference, not a cache, so a stale pointer can never contradict the store.
//
// Discipline: try/catch everywhere, exit 0 always, no bodies, no forensic IDs.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

function resolveStorePath() {
  const override = (process.env.XTRM_STATE_DB ?? '').trim();
  if (override) return override;
  return join(homedir(), '.xtrm', 'state.db');
}

function readSessionId() {
  try {
    const parsed = JSON.parse(readFileSync(0, 'utf-8'));
    if (typeof parsed?.session_id === 'string' && parsed.session_id) return parsed.session_id;
  } catch {
    // Stdin absent or malformed: fall back to the unbound pointer PreCompact writes.
  }
  return 'unknown';
}

try {
  const sessionId = readSessionId().replace(/[^A-Za-z0-9_-]/g, '_');
  const dir = (process.env.CLAUDE_PLUGIN_DATA ?? '').trim() || tmpdir();
  const pointerPath = join(dir, `substrate-continuity-${sessionId}.json`);
  if (existsSync(pointerPath)) {
    const pointer = JSON.parse(readFileSync(pointerPath, 'utf-8'));
    const ids = Array.isArray(pointer?.active_activation_ids) ? pointer.active_activation_ids : [];
    const store = typeof pointer?.store === 'string' ? pointer.store : resolveStorePath();
    if (ids.length > 0) {
      console.log(
        `Substrate continuity: ${ids.length} activation(s) were live before compaction — ` +
          `${ids.join(', ')}. Re-read them with specialist_status; the summary above is not authoritative.`,
      );
    } else {
      console.log(
        `Substrate continuity: no activations were live before compaction. Authority remains ${store}.`,
      );
    }
  }
} catch {
  // Silent on every failure path: a hook must never block a compacted session.
}
process.exit(0);
