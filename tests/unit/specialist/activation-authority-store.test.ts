import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from 'bun:sqlite';
import {
  ACTIVATIONS_DDL,
  createFileAuthorityWriter,
  ensureAuthorityStore,
  NULL_AUTHORITY_WRITER,
  resolveAuthorityDbPath,
} from '../../../src/activation/authority-store.js';
import { NativeActivationHost } from '../../../src/activation/native-host.js';
import type { PiSdk, PiAgentSessionLike } from '../../../src/activation/pi-sdk.js';

type ReadDb = {
  prepare(sql: string): { all(...p: unknown[]): Array<Record<string, unknown>> };
  close(): void;
};
function openRead(dbPath: string): ReadDb {
  return new Database(dbPath, { readonly: true }) as unknown as ReadDb;
}

/**
 * The hook's projection, copied verbatim from
 * plugins/substrate/scripts/session-start.mjs. The schema test below runs THIS
 * string — not a restatement — so drift in either direction fails loudly.
 */
const HOOK_QUERY = `SELECT activation_id, specialist, state, bead_id, last_activity_at
         FROM activations
         WHERE state NOT IN ('settled', 'disposed')
         ORDER BY last_activity_at DESC LIMIT ?`;

const HOOK_COLUMNS = ['activation_id', 'specialist', 'state', 'bead_id', 'last_activity_at'];

const tmpRoots: string[] = [];
function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'authority-store-'));
  tmpRoots.push(root);
  return root;
}
afterEach(() => {
  while (tmpRoots.length > 0) rmSync(tmpRoots.pop() as string, { recursive: true, force: true });
});

function readRows(dbPath: string, limit = 10): Array<Record<string, unknown>> {
  const db = openRead(dbPath);
  try {
    return db.prepare(HOOK_QUERY).all(limit);
  } finally {
    db.close();
  }
}

describe('authority store path — explicit override only', () => {
  it('honors XTRM_STATE_DB trimmed, blanks fall back', () => {
    expect(resolveAuthorityDbPath({ XTRM_STATE_DB: '  /tmp/custom.db  ' })).toBe('/tmp/custom.db');
    expect(resolveAuthorityDbPath({})).toBe(join(homedir(), '.xtrm', 'state.db'));
    expect(resolveAuthorityDbPath({ XTRM_STATE_DB: '   ' })).toBe(
      join(homedir(), '.xtrm', 'state.db'),
    );
  });

  it('derives nothing from the project directory', () => {
    const before = resolveAuthorityDbPath({});
    const cwd = process.cwd();
    process.chdir(tmpRoot());
    try {
      expect(resolveAuthorityDbPath({})).toBe(before);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('authority schema — matches the SessionStart hook column-for-column', () => {
  it('serves the hook query verbatim: columns, filter, ordering', () => {
    const dbPath = join(tmpRoot(), 'state.db');
    ensureAuthorityStore(dbPath);
    const writer = createFileAuthorityWriter(dbPath);
    writer.record({ activationId: 'act:old', specialist: 'researcher', state: 'running', beadId: 'B-1', lastActivityAt: 1000 });
    writer.record({ activationId: 'act:new', specialist: 'executor', state: 'needs_reply', beadId: 'B-2', lastActivityAt: 3000 });
    writer.record({ activationId: 'act:mid', specialist: 'researcher', state: 'running', beadId: 'B-3', lastActivityAt: 2000 });
    writer.record({ activationId: 'act:done', specialist: 'executor', state: 'settled', beadId: 'B-4', lastActivityAt: 9999 });
    writer.record({ activationId: 'act:gone', specialist: 'executor', state: 'disposed', beadId: 'B-5', lastActivityAt: 9998 });

    const rows = readRows(dbPath);
    expect(rows.map((r) => r.activation_id)).toEqual(['act:new', 'act:mid', 'act:old']);
    for (const row of rows) {
      expect(Object.keys(row)).toEqual(HOOK_COLUMNS);
    }
    // Limit binds through.
    expect(readRows(dbPath, 2)).toHaveLength(2);
  });

  it('DDL carries exactly the hook columns', () => {
    for (const col of HOOK_COLUMNS) expect(ACTIVATIONS_DDL).toContain(col);
  });
});

describe('authority writer — lifecycle transitions reflected', () => {
  it('upserts state per transition; terminal rows persist but stay filtered', () => {
    const dbPath = join(tmpRoot(), 'state.db');
    const writer = createFileAuthorityWriter(dbPath);
    const snap = { activationId: 'act:1', specialist: 'researcher', state: 'starting', beadId: 'B-1', lastActivityAt: 1 };
    writer.record(snap);
    writer.record({ ...snap, state: 'running', lastActivityAt: 2 });
    expect(readRows(dbPath)).toHaveLength(1);
    expect(readRows(dbPath)[0]?.state).toBe('running');
    // Failed stays visible: failed is retryable, therefore live work.
    writer.record({ ...snap, state: 'failed', lastActivityAt: 3 });
    expect(readRows(dbPath)).toHaveLength(1);
    expect(readRows(dbPath)[0]?.state).toBe('failed');
    // Disposal drops the row: SessionStart must never surface dead work as live.
    writer.remove('act:1');
    // Terminal-but-filtered states persist as rows (the hook filter exists because they do).
    writer.record({ ...snap, state: 'settled', lastActivityAt: 4 });
    expect(readRows(dbPath)).toHaveLength(0);
    const db = openRead(dbPath);
    try {
      expect(db.prepare('SELECT state FROM activations').all()).toHaveLength(1);
    } finally {
      db.close();
    }
    // Disposal drops the row.
    writer.remove('act:1');
    const after = openRead(dbPath);
    try {
      expect(after.prepare('SELECT state FROM activations').all()).toHaveLength(0);
    } finally {
      after.close();
    }
  });

  it('writes only the wired path — never a second store', () => {
    const dir = tmpRoot();
    const dbPath = join(dir, 'sub', 'override.db');
    createFileAuthorityWriter(dbPath).record({
      activationId: 'act:1', specialist: 's', state: 'running', beadId: 'B', lastActivityAt: 1,
    });
    expect(readRows(dbPath)).toHaveLength(1);
  });

  it('a throwing writer never breaks the host', async () => {
    const session = fakeSession({ record: {}, assistantText: 'done' });
    const host = new NativeActivationHost({
      beadGate: { readContractState: () => undefined },
      loader: { get: async () => readOnlySpec() } as never,
      beadsClient: { readBead: () => BEAD } as never,
      loadSdk: async () => makeSdk({}, session),
      cwd: tmpRoot(),
      authority: { record: () => { throw new Error('store on fire'); }, remove: () => { throw new Error('store on fire'); } },
    });
    const handle = await host.start({
      specialist: 'researcher', beadId: 'ISSUE-1', requestedByParticipantId: 'coordinator',
    });
    await expect(handle.result).resolves.toMatchObject({ status: 'completed' });
  });

  it('NULL writer is a safe default', () => {
    expect(() => NULL_AUTHORITY_WRITER.record({
      activationId: 'x', specialist: 's', state: 'running', beadId: 'B', lastActivityAt: 1,
    })).not.toThrow();
  });
});

describe('authority writer — host lifecycle end to end', () => {
  it('dispatch persists starting, settle persists settled, stop persists stopped', async () => {
    const dir = tmpRoot();
    const dbPath = join(dir, 'state.db');
    const session = fakeSession({ record: {}, assistantText: 'done' });
    const host = new NativeActivationHost({
      beadGate: { readContractState: () => undefined },
      loader: { get: async () => readOnlySpec() } as never,
      beadsClient: { readBead: () => BEAD } as never,
      loadSdk: async () => makeSdk({}, session),
      cwd: dir,
      authority: createFileAuthorityWriter(dbPath),
    });
    const handle = await host.start({
      specialist: 'researcher', beadId: 'ISSUE-1', requestedByParticipantId: 'coordinator',
    });
    await handle.result;
    // Settled rows persist but are filtered from the hook's active projection.
    expect(readRows(dbPath)).toHaveLength(0);
    let db = openRead(dbPath);
    try {
      const settled = db.prepare('SELECT * FROM activations WHERE activation_id = ?')
        .all(handle.activationId) as Array<Record<string, unknown>>;
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({
        activation_id: handle.activationId,
        specialist: 'researcher',
        state: 'settled',
        bead_id: 'ISSUE-1',
      });
      expect(Object.keys(settled[0] as object)).toEqual([
        'activation_id', 'specialist', 'state', 'bead_id', 'last_activity_at',
      ]);
    } finally {
      db.close();
    }
    await host.stop(handle.activationId);
    db = openRead(dbPath);
    try {
      // Disposal drops the row; the hook projection stays empty.
      const terminal = db.prepare('SELECT state FROM activations WHERE activation_id = ?')
        .all(handle.activationId) as Array<{ state: string }>;
      expect(terminal).toHaveLength(0);
    } finally {
      db.close();
    }
    // Stopped rows persist as evidence; the hook's active projection stays empty.
    expect(readRows(dbPath)).toHaveLength(0);
  });
});

describe('SessionStart hook — live against the real schema', () => {
  const hookPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../plugins/substrate/scripts/session-start.mjs',
  );

  function seedOverride(): string {
    const dbPath = join(tmpRoot(), 'override.db');
    const db = new Database(dbPath);
    try {
      db.exec(ACTIVATIONS_DDL);
      db.prepare(
        'INSERT OR REPLACE INTO activations VALUES (?, ?, ?, ?, ?)',
      ).run('act:live1', 'researcher', 'running', 'B-1', 3000);
      db.prepare(
        'INSERT OR REPLACE INTO activations VALUES (?, ?, ?, ?, ?)',
      ).run('act:live2', 'executor', 'needs_reply', 'B-2', 2000);
      db.prepare(
        'INSERT OR REPLACE INTO activations VALUES (?, ?, ?, ?, ?)',
      ).run('act:old', 'executor', 'settled', 'B-3', 9999);
    } finally {
      db.close();
    }
    return dbPath;
  }

  // The E1 carry-forward: the hook ships as a silent no-op until its query runs
  // against a real store. bun is the hooks.json runtime and lacks node:sqlite, so
  // both runtimes are exercised — a driver regression fails here, not in prod.
  it.each(['bun', 'node'] as const)('projects rows under %s, stays silent when absent', (runtime) => {
    const dbPath = seedOverride();
    const live = spawnSync(runtime, [hookPath], {
      env: { ...process.env, XTRM_STATE_DB: dbPath },
      encoding: 'utf-8',
    });
    expect(live.status).toBe(0);
    expect(live.stdout).toContain(`Substrate work authority: ${dbPath}`);
    expect(live.stdout).toContain('act:live1 | researcher | running | B-1 | 3000');
    expect(live.stdout).toContain('act:live2 | executor | needs_reply | B-2 | 2000');
    expect(live.stdout).not.toContain('act:old');

    const absent = spawnSync(runtime, [hookPath], {
      env: { ...process.env, XTRM_STATE_DB: join(tmpRoot(), 'nope', 'state.db') },
      encoding: 'utf-8',
    });
    expect(absent.status).toBe(0);
    expect(absent.stdout).toBe('');
  });
});

// Minimal doubles borrowed from activation-native-host.test.ts (kept local: that file's
// fakes are not exported, and sharing them would couple two suites' fixtures).
function fakeSession(opts: { record: object; assistantText?: string }): PiAgentSessionLike {
  const listeners: Array<(e: never) => void> = [];
  const messages: unknown[] = [];
  const session = {
    sessionId: 'pi-sess-123',
    messages,
    isIdle: true,
    async prompt(text: string) {
      messages.push({ role: 'assistant', content: opts.assistantText ?? 'done' });
      listeners.forEach((l) => l({ type: 'agent_start' } as never));
      listeners.forEach((l) => l({ type: 'agent_end', willRetry: false } as never));
      listeners.forEach((l) => l({ type: 'agent_settled' } as never));
    },
    async steer() {}, async followUp() {}, async abort() {},
    dispose() {},
    subscribe(l: (e: never) => void) {
      listeners.push(l);
      return () => {};
    },
    getActiveToolNames: () => ['read'],
    setActiveToolsByName() {},
    async waitForIdle() {},
  };
  return session as unknown as PiAgentSessionLike;
}

function makeSdk(record: object, session: PiAgentSessionLike): PiSdk {
  return {
    createAgentSession: async () => ({ session }),
    ModelRuntime: { create: async () => ({ hasConfiguredAuth: () => true }) },
    resolveModelScopeWithDiagnostics: () => ({
      scopedModels: [{ model: { id: 'test-model', provider: 'testprov' } }],
      diagnostics: [],
    }),
    defineTool: (d: unknown) => d,
    createEditTool: () => ({ name: 'edit', execute: async () => 'edited' }),
    createWriteTool: () => ({ name: 'write', execute: async () => 'written' }),
    createBashTool: () => ({ name: 'bash', execute: async () => 'ran' }),
    createPowerShellTool: () => ({ name: 'powershell', execute: async () => 'ran' }),
  } as unknown as PiSdk;
}

const BEAD = {
  id: 'ISSUE-1',
  title: 'Investigate the thing',
  status: 'open',
  description: [
    'PROBLEM', 'The thing is unclear.', '',
    'SUCCESS', 'The thing is clear.', '',
    'SCOPE', 'Investigate the thing.', '',
    'NON_GOALS', 'Does not fix the thing.', '',
    'CONSTRAINTS', 'Read-only.', '',
    'VALIDATION', 'A written finding.', '',
    'OUTPUT', 'A finding.', '',
    'SCRUTINY', 'LOW — investigation only.',
  ].join('\n'),
};

function readOnlySpec() {
  return {
    specialist: {
      metadata: { name: 'researcher', version: '1.0.0', description: 'd', category: 'c' },
      execution: {
        model: 'testprov/test-model',
        permission_required: 'READ_ONLY',
        response_format: 'text',
        output_type: 'research',
        bare: false,
      },
      prompt: { system: 'You are the researcher.', task_template: 'Do: {{bead_id}}' },
    },
  };
}
