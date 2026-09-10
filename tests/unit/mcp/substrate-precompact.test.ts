import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from 'bun:sqlite';

const hookPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../plugins/substrate/scripts/precompact.mjs',
);

const tmpRoots: string[] = [];
function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'precompact-hook-'));
  tmpRoots.push(root);
  return root;
}
afterEach(() => {
  while (tmpRoots.length > 0) rmSync(tmpRoots.pop() as string, { recursive: true, force: true });
});

function seedStore(): string {
  const dbPath = join(tmpRoot(), 'state.db');
  const db = new Database(dbPath);
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS activations (
        activation_id TEXT PRIMARY KEY,
        specialist TEXT NOT NULL,
        state TEXT NOT NULL,
        bead_id TEXT,
        last_activity_at INTEGER NOT NULL
      )`,
    );
    const put = db.prepare('INSERT OR REPLACE INTO activations VALUES (?, ?, ?, ?, ?)');
    put.run('act:live1', 'researcher', 'running', 'B-1', 3000);
    put.run('act:live2', 'executor', 'needs_reply', 'B-2', 2000);
    put.run('act:old', 'executor', 'settled', 'B-3', 9999);
    put.run('act:gone', 'executor', 'disposed', 'B-4', 9998);
  } finally {
    db.close();
  }
  return dbPath;
}

function run(
  runtime: 'bun' | 'node',
  opts: { store: string; dataDir: string; stdin?: string },
) {
  return spawnSync(runtime, [hookPath], {
    input: opts.stdin ?? JSON.stringify({ session_id: 'sess-1' }),
    env: { ...process.env, XTRM_STATE_DB: opts.store, CLAUDE_PLUGIN_DATA: opts.dataDir },
    encoding: 'utf-8',
  });
}

function readPointer(dataDir: string, sessionId = 'sess-1') {
  return JSON.parse(
    readFileSync(join(dataDir, `substrate-continuity-${sessionId}.json`), 'utf-8'),
  ) as {
    store: string;
    session_id: string;
    active_activation_ids: string[];
    written_at: string;
  };
}

describe('PreCompact hook — live against a seeded store', () => {
  // Carry-forward from E2: precompact.mjs shared the node:sqlite-only driver
  // pattern that made session-start.mjs a silent no-op under bun (the
  // hooks.json runtime, which lacks node:sqlite). The bun case below fails on
  // that regression — no pointer file — while node passes.
  it.each(['bun', 'node'] as const)(
    'writes the continuity pointer with live ids only under %s',
    (runtime) => {
      const dbPath = seedStore();
      const dataDir = join(tmpRoot(), 'plugindata');
      const res = run(runtime, { store: dbPath, dataDir });
      expect(res.status).toBe(0);
      expect(res.stdout).toBe('');
      const pointer = readPointer(dataDir);
      expect(pointer.store).toBe(dbPath);
      expect(pointer.session_id).toBe('sess-1');
      expect(pointer.active_activation_ids).toEqual(['act:live1', 'act:live2']);
      expect(typeof pointer.written_at).toBe('string');
    },
  );

  it.each(['bun', 'node'] as const)(
    'absent store writes an empty pointer under %s, still exit 0',
    (runtime) => {
      const dataDir = join(tmpRoot(), 'plugindata');
      const res = run(runtime, {
        store: join(tmpRoot(), 'nope', 'state.db'),
        dataDir,
      });
      expect(res.status).toBe(0);
      expect(readPointer(dataDir).active_activation_ids).toEqual([]);
    },
  );

  it('malformed stdin binds the pointer to unknown, exit 0', () => {
    const dbPath = seedStore();
    const dataDir = join(tmpRoot(), 'plugindata');
    const res = run('bun', { store: dbPath, dataDir, stdin: 'not-json{' });
    expect(res.status).toBe(0);
    expect(readPointer(dataDir, 'unknown').session_id).toBe('unknown');
    expect(readdirSync(dataDir)).toHaveLength(1);
  });
});
