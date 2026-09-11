/**
 * Substrate work-authority store: the one `~/.xtrm/state.db`.
 *
 * Writer owner (unitAI-aiwva.3): NativeActivationHost lifecycle. The host already owns
 * the in-memory FleetRegistry; persisting that projection here is one hop. There is no
 * sb daemon code in this repo, so no sb-runtime writer exists to choose, and per-repo
 * observability.db is forensic evidence, not work authority — no migration, no second
 * store. A future sb writes this same path; the path resolver below is the one place
 * that decision lives.
 *
 * Override is explicit environment only (`XTRM_STATE_DB`); the path is never derived
 * from the project directory or the plugin root. Writes are best-effort: the authority
 * must never fail an activation, the same discipline as the SessionStart hook (exit 0
 * always) and the forensic sink.
 */

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ActivationSnapshot } from './types.js';

const require = createRequire(import.meta.url);

/** Increment when the DDL below changes shape. */
export const AUTHORITY_SCHEMA_VERSION = 1;

/**
 * The exact projection the SessionStart hook queries. Column names must stay
 * column-for-column identical to plugins/substrate/scripts/session-start.mjs:
 * activation_id, specialist, state, bead_id, last_activity_at.
 */
export const ACTIVATIONS_DDL = `CREATE TABLE IF NOT EXISTS activations (
  activation_id TEXT PRIMARY KEY,
  specialist TEXT NOT NULL,
  state TEXT NOT NULL,
  bead_id TEXT,
  last_activity_at INTEGER NOT NULL
)`;

/**
 * Resolve the one authority path. Explicit `XTRM_STATE_DB` wins; otherwise the
 * canonical `~/.xtrm/state.db`. Blank override falls back — an unset-feeling value
 * must never become a store path. Takes no cwd/project/plugin input by design.
 */
export function resolveAuthorityDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.XTRM_STATE_DB ?? '').trim();
  if (override) return override;
  return join(homedir(), '.xtrm', 'state.db');
}

type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown };
  close(): void;
};

function openAuthorityDb(dbPath: string): SqliteDb | null {
  try {
    const bun = require('bun:sqlite') as { Database?: new (path: string) => SqliteDb };
    if (bun?.Database) return new bun.Database(dbPath);
  } catch {
    // Fall through to node:sqlite.
  }
  try {
    const node = require('node:sqlite') as {
      DatabaseSync?: new (path: string) => {
        exec(sql: string): void;
        prepare(sql: string): { run(...params: unknown[]): unknown };
        close(): void;
      };
    };
    if (node?.DatabaseSync) {
      const DatabaseSync = node.DatabaseSync;
      const inner = new DatabaseSync(dbPath);
      return {
        exec: (sql) => inner.exec(sql),
        // bun binds undefined as NULL; node:sqlite refuses it. Normalize at the seam.
        prepare: (sql) => {
          const stmt = inner.prepare(sql);
          return { run: (...params) => stmt.run(...params.map((v) => (v === undefined ? null : v))) };
        },
        close: () => inner.close(),
      };
    }
  } catch {
    // Absent sqlite: silent, same as the hook's missing-store path.
  }
  return null;
}

/**
 * Creation/migration path: idempotent. `IF NOT EXISTS` is the whole migration story
 * for E2 — the table either exists with these columns or is created; no data moves.
 */
export function ensureAuthorityStore(dbPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openAuthorityDb(dbPath);
  if (!db) throw new Error(`authority store: no sqlite driver for ${dbPath}`);
  try {
    db.exec(ACTIVATIONS_DDL);
  } finally {
    db.close();
  }
}

/** The host persists its Fleet projection through this; tests inject a temp path. */
export interface AuthorityWriter {
  record(
    snapshot: Pick<
      ActivationSnapshot,
      'activationId' | 'specialist' | 'state' | 'beadId' | 'lastActivityAt'
    >,
  ): void;
  /**
   * Drop a disposed activation. `stop()` is the only ordinary path to disposal, so
   * the row must go with it — otherwise SessionStart would surface dead work as
   * live (its filter covers settled/disposed, and a stopped row is neither).
   * Settled rows stay: settled means waiting and resumable, never disposed.
   */
  remove(activationId: string): void;
}

/** Used where authority persistence is genuinely not wanted (unit tests). */
export const NULL_AUTHORITY_WRITER: AuthorityWriter = { record: () => {}, remove: () => {} };

/**
 * File-backed writer against the one authority (default path resolved from the
 * environment at wiring time). One connection per record: lifecycle transitions are
 * low-frequency, and a held-open writer would lock the hook's reader out.
 */
export function createFileAuthorityWriter(
  dbPath: string = resolveAuthorityDbPath(),
): AuthorityWriter {
  return {
    record(snapshot): void {
      try {
        mkdirSync(dirname(dbPath), { recursive: true });
        const db = openAuthorityDb(dbPath);
        if (!db) return;
        try {
          db.exec(ACTIVATIONS_DDL);
          db.prepare(
            `INSERT OR REPLACE INTO activations
               (activation_id, specialist, state, bead_id, last_activity_at)
             VALUES (?, ?, ?, ?, ?)`,
          ).run(
            snapshot.activationId,
            snapshot.specialist,
            snapshot.state,
            snapshot.beadId,
            snapshot.lastActivityAt,
          );
        } finally {
          db.close();
        }
      } catch {
        // The authority must never fail an activation.
      }
    },
    remove(activationId): void {
      try {
        const db = openAuthorityDb(dbPath);
        if (!db) return;
        try {
          db.exec(ACTIVATIONS_DDL);
          db.prepare('DELETE FROM activations WHERE activation_id = ?').run(activationId);
        } finally {
          db.close();
        }
      } catch {
        // The authority must never fail an activation.
      }
    },
  };
}
