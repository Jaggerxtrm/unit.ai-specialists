import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from 'bun:sqlite';

/**
 * The idle-wake watcher (unitAI-aiwva.21). Claude Code wakes the model when an
 * asyncRewake hook exits 2, so exit code IS the contract here — and a spurious 2 is
 * worse than a missed one, because it trains the operator to ignore wakes.
 */
const hook = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../plugins/substrate/scripts/wake-watch.mjs',
);

const roots: string[] = [];
const children: Array<{ kill: (s?: NodeJS.Signals) => boolean }> = [];
function seed(rows: Array<[string, string]>): string {
  const root = mkdtempSync(join(tmpdir(), 'wake-watch-'));
  roots.push(root);
  const dbPath = join(root, 'state.db');
  const db = new Database(dbPath);
  try {
    db.exec(
      `CREATE TABLE activations (activation_id TEXT PRIMARY KEY, specialist TEXT, state TEXT, bead_id TEXT, last_activity_at TEXT)`,
    );
    for (const [id, state] of rows) {
      db.prepare(`INSERT INTO activations VALUES (?, 'executor', ?, 'B-1', '1000')`).run(id, state);
    }
  } finally {
    db.close();
  }
  return dbPath;
}
/**
 * Drives the transition from a DETACHED process, alternating the row between a
 * non-actionable and an actionable state for the whole run.
 *
 * It cannot be a setTimeout: spawnSync below blocks this thread's event loop, so an
 * in-process timer would not fire until after the watcher had already exited.
 *
 * It cannot be a single delayed write either, which is what CI caught. Both this writer
 * and the watcher are cold `bun` starts racing from the same instant: if the write lands
 * before the watcher takes its baseline, the row reads as pre-existing backlog and the
 * watcher correctly does NOT wake — so the test failed for the one reason the watcher is
 * supposed to behave that way. Alternating removes the race instead of widening a timeout
 * around it: whichever state the baseline captures, the next flip is a real transition.
 */
function flipUntil(dbPath: string, id: string, state: string, cycles = 40) {
  const script =
    `const {Database}=require('bun:sqlite');const db=new Database(${JSON.stringify(dbPath)});` +
    `const set=(s)=>db.prepare("INSERT OR REPLACE INTO activations VALUES (?, 'executor', ?, 'B-1', '2000')")` +
    `.run(${JSON.stringify(id)}, s);` +
    `for(let i=0;i<${cycles};i++){set('running');await Bun.sleep(150);set(${JSON.stringify(state)});await Bun.sleep(150);}` +
    `db.close();`;
  const child = spawn('bun', ['-e', script], { detached: true, stdio: 'ignore' });
  child.unref();
  children.push(child);
}

/**
 * `entrypoint` is declared explicitly and never inherited.
 *
 * The watcher refuses to run unless CLAUDE_CODE_ENTRYPOINT is exactly 'cli' — under
 * `claude -p` it is 'sdk-cli', and an earlier version of this hook broke every headless
 * run by waking sessions that had no model to wake. Inheriting the variable from
 * process.env made these tests pass on a developer machine (where an interactive Claude
 * Code session exports cli) and fail in CI, where nothing sets it: the watcher exited 0
 * before reading the store, so every wake assertion saw exit 0 and no output. The test
 * must state the precondition it is testing under, not borrow it from whoever ran it.
 */
function watch(dbPath: string, maxMs = 20000, entrypoint = 'cli') {
  return spawnSync('bun', [hook], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      CLAUDE_CODE_ENTRYPOINT: entrypoint,
      XTRM_STATE_DB: dbPath,
      SUBSTRATE_WAKE_POLL_MS: '250',
      SUBSTRATE_WAKE_MAX_MS: String(maxMs),
    },
    timeout: 60000,
  });
}

afterEach(() => {
  // Kill the flip writer first: it holds the sqlite file the cleanup removes.
  while (children.length > 0) { try { children.pop()?.kill('SIGKILL'); } catch { /* already gone */ } }
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe('substrate idle-wake watcher', () => {
  it('does not wake when nothing changes', () => {
    const db = seed([['act:a', 'running']]);
    const r = watch(db, 1500);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('does not wake for a backlog that existed before the session started', () => {
    // Everything already settled at baseline is not news. Waking for it would fire on
    // every session start forever.
    const db = seed([['act:old', 'settled'], ['act:asking', 'needs_reply']]);
    const r = watch(db, 1500);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('wakes with exit 2 when an activation settles', () => {
    const db = seed([['act:live', 'running']]);
    flipUntil(db, 'act:live', 'settled');
    const r = watch(db);
    expect(r.status).toBe(2);
    const payload = JSON.parse(r.stdout.trim().split('\n').pop() as string);
    expect(payload.activations).toEqual([
      { activation_id: 'act:live', state: 'settled', bead_id: 'B-1' },
    ]);
    expect(payload.read_with).toBe('specialist_status');
  });

  it('wakes when an activation starts waiting on a reply', () => {
    const db = seed([['act:q', 'running']]);
    flipUntil(db, 'act:q', 'needs_reply');
    const r = watch(db);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('awaiting reply');
  });

  it('carries a reference only — no bodies, no forensic ids', () => {
    const db = seed([['act:x', 'running']]);
    flipUntil(db, 'act:x', 'settled');
    const payload = JSON.parse((watch(db).stdout.trim().split('\n').pop() as string));
    expect(Object.keys(payload).sort()).toEqual(['activations', 'read_with', 'reason', 'source']);
    for (const row of payload.activations) {
      // §AA: retrieval references only — activation id, Issue ref, and the state that
      // made it actionable. Anything more would be authority the payload must not carry.
      expect(Object.keys(row).sort()).toEqual(['activation_id', 'bead_id', 'state']);
    }
  });

  it('exits 0 and stays silent when the store is absent', () => {
    const r = watch(join(tmpdir(), 'definitely-absent', 'state.db'), 1500);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('refuses to run outside an interactive session', () => {
    // The headless guard, asserted directly rather than inherited: under `claude -p` the
    // entrypoint is 'sdk-cli' and there is no session to wake. A watcher that wakes anyway
    // breaks every headless run, which is exactly how this guard came to exist.
    const db = seed([['act:h', 'running']]);
    flipUntil(db, 'act:h', 'settled');
    const r = watch(db, 4000, 'sdk-cli');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });
});
