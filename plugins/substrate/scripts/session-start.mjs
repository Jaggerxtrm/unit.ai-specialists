#!/usr/bin/env node
// Substrate plugin SessionStart hook.
//
// Injects live activation state plus the authority reminder, so a resumed session does
// not reason about stale activations. Reads the canonical Substrate store
// (~/.xtrm/state.db unless XTRM_STATE_DB overrides it in the environment); the DB path
// is never derived from the project directory or the plugin root.
//
// Discipline: try/catch everywhere, exit 0 on every path (missing store, locked DB,
// malformed row, absent sqlite), no result or prompt bodies, no forensic IDs. A plugin
// hook that can block session start is a support incident.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MAX_ROWS = 10;

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

async function readActiveRows(storePath) {
  const db = await openStore(storePath);
  try {
    return db
      .prepare(
        `SELECT activation_id, specialist, state, bead_id, last_activity_at
         FROM activations
         WHERE state NOT IN ('settled', 'disposed')
         ORDER BY last_activity_at DESC LIMIT ?`,
      )
      .all(MAX_ROWS);
  } finally {
    db.close();
  }
}

try {
  const storePath = resolveStorePath();
  if (!existsSync(storePath)) process.exit(0);
  const rows = await readActiveRows(storePath);
  console.log(`Substrate work authority: ${storePath}; MCP is the transport.`);
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const { activation_id, specialist, state, bead_id, last_activity_at } = row;
    console.log(
      `${activation_id ?? '?'} | ${specialist ?? '?'} | ${state ?? '?'} | ${bead_id ?? '-'} | ${last_activity_at ?? '?'}`,
    );
  }
} catch {
  // Silent on every failure path.
}
process.exit(0);
