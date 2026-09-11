import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * PostCompact closes the loop PreCompact opens (unitAI-aiwva.23). Without it the
 * continuity pointer is written and never read, and operator spec §AJ's "PostCompact
 * works" has nothing behind it.
 */
const scripts = join(dirname(fileURLToPath(import.meta.url)), '../../../plugins/substrate/scripts');
const preHook = join(scripts, 'precompact.mjs');
const postHook = join(scripts, 'postcompact.mjs');

const tmpRoots: string[] = [];
function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'postcompact-hook-'));
  tmpRoots.push(root);
  return root;
}
afterEach(() => {
  while (tmpRoots.length > 0) rmSync(tmpRoots.pop() as string, { recursive: true, force: true });
});

function runHook(hook: string, dataDir: string, sessionId: string, storePath?: string) {
  return spawnSync('bun', [hook], {
    encoding: 'utf-8',
    input: JSON.stringify({ session_id: sessionId }),
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dataDir,
      ...(storePath ? { XTRM_STATE_DB: storePath } : {}),
    },
    timeout: 60000,
  });
}

describe('substrate PostCompact hook', () => {
  it('re-states the activations the pointer names', () => {
    const dir = tmpRoot();
    writeFileSync(
      join(dir, 'substrate-continuity-s1.json'),
      JSON.stringify({
        store: '/nonexistent/state.db',
        session_id: 's1',
        active_activation_ids: ['act:one', 'act:two'],
      }),
    );
    const result = runHook(postHook, dir, 's1');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('act:one');
    expect(result.stdout).toContain('act:two');
    // It must send the reader back to the store, never present itself as the state.
    expect(result.stdout).toContain('specialist_status');
  });

  it('consumes the pointer PreCompact actually writes', () => {
    const dir = tmpRoot();
    // No store: PreCompact still writes a pointer, with an empty activation list.
    const pre = runHook(preHook, dir, 'rt', join(tmpRoot(), 'absent.db'));
    expect(pre.status).toBe(0);
    const post = runHook(postHook, dir, 'rt');
    expect(post.status).toBe(0);
    expect(post.stdout).toContain('Substrate continuity');
  });

  it('exits 0 and stays silent when there is no pointer', () => {
    const result = runHook(postHook, tmpRoot(), 'absent');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('exits 0 and stays silent when the pointer is malformed', () => {
    const dir = tmpRoot();
    writeFileSync(join(dir, 'substrate-continuity-bad.json'), 'not json');
    const result = runHook(postHook, dir, 'bad');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });
});
