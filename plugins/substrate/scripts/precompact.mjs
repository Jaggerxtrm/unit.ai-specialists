#!/usr/bin/env node
// Substrate plugin PreCompact hook.
//
// Writes the Journal continuity pointer (activation IDs currently owned by this session
// plus the store path) so post-compaction the session re-derives authoritative state
// instead of trusting summary prose. The pointer lives under CLAUDE_PLUGIN_DATA when
// set, else a temp path: plugin installation state, never the user's repo.
//
// Discipline: try/catch everywhere, exit 0 always, no bodies, no forensic IDs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
    // Stdin absent or malformed: pointer without session binding.
  }
  return 'unknown';
}

async function readOwnedActivationIds(storePath) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT activation_id FROM activations
         WHERE state NOT IN ('settled', 'disposed')
         ORDER BY last_activity_at DESC LIMIT 50`,
      )
      .all()
      .map((row) => row?.activation_id)
      .filter((id) => typeof id === 'string' && id);
  } finally {
    db.close();
  }
}

try {
  const storePath = resolveStorePath();
  const sessionId = readSessionId().replace(/[^A-Za-z0-9_-]/g, '_');
  const owned = existsSync(storePath) ? await readOwnedActivationIds(storePath) : [];
  const dir = (process.env.CLAUDE_PLUGIN_DATA ?? '').trim() || tmpdir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `substrate-continuity-${sessionId}.json`),
    JSON.stringify(
      {
        store: storePath,
        session_id: sessionId,
        active_activation_ids: owned,
        written_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
} catch {
  // Silent on every failure path.
}
process.exit(0);
