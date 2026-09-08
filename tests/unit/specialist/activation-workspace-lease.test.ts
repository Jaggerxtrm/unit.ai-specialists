// tests/unit/specialist/activation-workspace-lease.test.ts
//
// The property under test is that a lease never frees itself on uncertainty. A lease that
// frees when it cannot establish liveness is worse than no lease, because it grants a
// confidence that is not warranted and two writers in one worktree is data loss.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquire,
  admitToolCall,
  inspect,
  isMutatingTool,
  leaseDir,
  release,
  workspaceKey,
  type LeaseProcessProbe,
} from '../../../src/activation/workspace-lease.js';
import { DispatchRejectedError, type WorkspaceIdentity } from '../../../src/activation/types.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sp-lease-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A probe with a fixed idea of which PIDs are running. */
function probeFor(running: Record<number, number>, canVerify = true): LeaseProcessProbe {
  return {
    canVerify: () => canVerify,
    startTicks: pid => running[pid],
  };
}

/** A probe that agrees this process is alive, so `selfHolder()` can record a real guard. */
function liveSelfProbe(extra: Record<number, number> = {}): LeaseProcessProbe {
  return probeFor({ [process.pid]: 111_111, ...extra });
}

function workspaceAt(path: string, gitCommonDir?: string): WorkspaceIdentity {
  mkdirSync(path, { recursive: true });
  return { repositoryRoot: path, worktreePath: path, gitCommonDir };
}

describe('workspace identity — the worktree path is the mutation domain', () => {
  it('gives two linked worktrees of one repository distinct keys', () => {
    const common = join(root, 'repo', '.git');
    mkdirSync(common, { recursive: true });
    const a = workspaceAt(join(root, 'wt-a'), common);
    const b = workspaceAt(join(root, 'wt-b'), common);

    expect(workspaceKey(a)).not.toBe(workspaceKey(b));
    // They share one lease directory — discoverable together, leased independently.
    expect(leaseDir(a)).toBe(leaseDir(b));
  });

  it('leases two linked worktrees independently', () => {
    const common = join(root, 'repo', '.git');
    mkdirSync(common, { recursive: true });
    const a = workspaceAt(join(root, 'wt-a'), common);
    const b = workspaceAt(join(root, 'wt-b'), common);
    const probe = liveSelfProbe();

    acquire({ workspace: a, activationId: 'act-a', attemptId: 'att:a:1' }, probe);
    // Sharing history and one observability database does not make them one domain.
    expect(() => acquire({ workspace: b, activationId: 'act-b', attemptId: 'att:b:1' }, probe)).not.toThrow();
    expect(inspect(a, probe).lease?.activationId).toBe('act-a');
    expect(inspect(b, probe).lease?.activationId).toBe('act-b');
  });

  it('treats two spellings of one worktree as the same domain', () => {
    const real = join(root, 'wt');
    mkdirSync(real, { recursive: true });
    expect(workspaceKey({ repositoryRoot: real, worktreePath: real }))
      .toBe(workspaceKey({ repositoryRoot: real, worktreePath: join(root, '.', 'wt') }));
  });
});

describe('acquisition — exactly one writer', () => {
  it('refuses a second writer and names the holder', () => {
    const ws = workspaceAt(join(root, 'wt'));
    const probe = liveSelfProbe();
    acquire({ workspace: ws, activationId: 'act-1', attemptId: 'att:1:1', specialist: 'executor' }, probe);

    let error: unknown;
    try {
      acquire({ workspace: ws, activationId: 'act-2', attemptId: 'att:2:1', specialist: 'debugger' }, probe);
    } catch (err) { error = err; }

    expect(error).toBeInstanceOf(DispatchRejectedError);
    const message = (error as Error).message;
    expect(message).toContain('workspace_held_by_another_writer');
    expect(message).toContain('executor act-1');           // the holder is named
    expect(message).toContain(ws.worktreePath);
    expect(message).toContain('AgentSession:\n  not created');
  });

  it('lets the same activation reacquire on resume rather than contend with itself', () => {
    const ws = workspaceAt(join(root, 'wt'));
    const probe = liveSelfProbe();
    acquire({ workspace: ws, activationId: 'act-1', attemptId: 'att:1:1' }, probe);

    const resumed = acquire({ workspace: ws, activationId: 'act-1', attemptId: 'att:1:2' }, probe);
    expect(resumed.attemptId).toBe('att:1:2');
    expect(inspect(ws, probe).lease?.attemptId).toBe('att:1:2');
  });

  it('fences the coordinator too — a lease is not a Specialist-only concept', () => {
    const ws = workspaceAt(join(root, 'wt'));
    const probe = liveSelfProbe();
    acquire({ workspace: ws, activationId: 'coordinator', attemptId: 'att:c:1' }, probe);
    expect(() => acquire({ workspace: ws, activationId: 'act-1', attemptId: 'att:1:1' }, probe)).toThrow(DispatchRejectedError);
  });

  it('is atomic against genuinely concurrent acquirers in other processes', async () => {
    // This test is shaped by what actually discriminates, measured rather than assumed.
    //
    // Eight real processes contend, released by a tight spin on a file's existence rather
    // than by a wall-clock instant: with a Date.now() barrier the winner finished writing
    // before the losers had even read, and a deliberately NON-atomic read-then-write
    // implementation passed just as cleanly as this one. Under the file barrier the naive
    // implementation produced 2, 1, 4, 2 and 1 winners across five rounds while the
    // link-based one produced exactly 1 every time — so the race is repeated, because a
    // single round lets a broken implementation through about 40% of the time.
    //
    // Do not simplify this into one sequential round. It would still pass, and it would
    // stop testing anything.
    const script = join(root, 'contend.ts');
    const moduleUrl = join(process.cwd(), 'src', 'activation', 'workspace-lease.ts');
    writeFileSync(script, `
      import { existsSync } from 'node:fs';
      import { acquire } from ${JSON.stringify(moduleUrl)};
      const [, , worktree, goFile, activationId] = process.argv;
      const ws = { repositoryRoot: worktree, worktreePath: worktree };
      while (!existsSync(goFile)) { /* tight spin — no clock granularity */ }
      try {
        acquire({ workspace: ws, activationId, attemptId: 'att:1' });
        console.log('WON');
      } catch {
        console.log('LOST');
      }
    `);

    for (let round = 0; round < 4; round++) {
      const ws = workspaceAt(join(root, `race-${round}`));
      const goFile = join(root, `go-${round}`);
      const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(x => `act-${x}`);

      const runs = ids.map(id => new Promise<string>((resolve, reject) => {
        execFile('bun', ['run', script, ws.worktreePath, goFile, id], (err, stdout) => {
          if (err) reject(err); else resolve(stdout.trim());
        });
      }));

      // Let every runtime boot and reach its spin loop before releasing them together.
      await new Promise(r => setTimeout(r, 1500));
      writeFileSync(goFile, '');
      const results = await Promise.all(runs);

      expect(results).toHaveLength(8);
      expect(results.filter(r => r === 'WON'), `round ${round}`).toHaveLength(1);
      expect(inspect(ws, liveSelfProbe()).lease).toBeDefined();
    }
  }, 120_000);
});

describe('uncertainty — a crashed holder is never a blind free', () => {
  it('reads uncertain, not free, when the holder process is gone', () => {
    const ws = workspaceAt(join(root, 'wt'));
    acquire({ workspace: ws, activationId: 'act-1', attemptId: 'att:1:1' }, liveSelfProbe());

    // The uncertain state is reachable without killing a real process: the probe simply
    // reports that nothing is running.
    const status = inspect(ws, probeFor({}));
    expect(status.state).toBe('uncertain');
    expect(status.uncertainReason).toBe('holder_process_gone');
    expect(status.lease?.activationId).toBe('act-1');
  });

  it('reads uncertain when the PID is reused by a different process', () => {
    const ws = workspaceAt(join(root, 'wt'));
    acquire({ workspace: ws, activationId: 'act-1', attemptId: 'att:1:1' }, liveSelfProbe());
    const status = inspect(ws, probeFor({ [process.pid]: 999_999 }));
    expect(status.state).toBe('uncertain');
    expect(status.uncertainReason).toBe('holder_start_mismatch');
  });

  it('reads uncertain on a host that cannot establish liveness at all', () => {
    const ws = workspaceAt(join(root, 'wt'));
    acquire({ workspace: ws, activationId: 'act-1', attemptId: 'att:1:1' }, liveSelfProbe());
    const status = inspect(ws, probeFor({ [process.pid]: 111_111 }, false));
    expect(status.state).toBe('uncertain');
    expect(status.uncertainReason).toBe('liveness_unverifiable');
  });

  it('reads uncertain — not free — when the record cannot be parsed', () => {
    const ws = workspaceAt(join(root, 'wt'));
    acquire({ workspace: ws, activationId: 'act-1', attemptId: 'att:1:1' }, liveSelfProbe());
    const path = join(leaseDir(ws), `${workspaceKey(ws)}.json`);
    writeFileSync(path, '{ truncated');
    expect(inspect(ws, liveSelfProbe())).toMatchObject({ state: 'uncertain', uncertainReason: 'unreadable_record' });
  });

  it('REFUSES to acquire an uncertain lease rather than stealing it', () => {
    const ws = workspaceAt(join(root, 'wt'));
    acquire({ workspace: ws, activationId: 'act-1', attemptId: 'att:1:1' }, liveSelfProbe());

    let error: unknown;
    try {
      acquire({ workspace: ws, activationId: 'act-2', attemptId: 'att:2:1' }, probeFor({}));
    } catch (err) { error = err; }

    expect((error as Error).message).toContain('workspace_lease_uncertain');
    expect((error as Error).message).toContain('uncertain, not free');
    // The record survives: recovery is Phase 9's decision, not an acquirer's.
    expect(existsSync(join(leaseDir(ws), `${workspaceKey(ws)}.json`))).toBe(true);
  });

  it('REFUSES to release an uncertain lease', () => {
    const ws = workspaceAt(join(root, 'wt'));
    acquire({ workspace: ws, activationId: 'act-1', attemptId: 'att:1:1' }, liveSelfProbe());
    expect(() => release(ws, 'act-1', probeFor({}))).toThrow(/workspace_lease_uncertain/);
  });
});

describe('release', () => {
  it('frees the workspace for the next writer', () => {
    const ws = workspaceAt(join(root, 'wt'));
    const probe = liveSelfProbe();
    acquire({ workspace: ws, activationId: 'act-1', attemptId: 'att:1:1' }, probe);
    release(ws, 'act-1', probe);
    expect(inspect(ws, probe).state).toBe('free');
    expect(() => acquire({ workspace: ws, activationId: 'act-2', attemptId: 'att:2:1' }, probe)).not.toThrow();
  });

  it('refuses to release a lease held by another activation', () => {
    const ws = workspaceAt(join(root, 'wt'));
    const probe = liveSelfProbe();
    acquire({ workspace: ws, activationId: 'act-1', attemptId: 'att:1:1' }, probe);
    expect(() => release(ws, 'act-2', probe)).toThrow(/workspace_lease_not_held_by_caller/);
    expect(inspect(ws, probe).state).toBe('held');
  });

  it('is a no-op on a workspace that is already free', () => {
    const ws = workspaceAt(join(root, 'wt'));
    expect(() => release(ws, 'act-1', liveSelfProbe())).not.toThrow();
  });
});

describe('mutation admission — the per-call block', () => {
  it('classifies unknown tools as mutating', () => {
    // Fail closed: a denylist would admit every tool added after it was written, which is
    // the "only Edit/Write are protected" failure PRD section 54 warns about.
    expect(isMutatingTool('read')).toBe(false);
    expect(isMutatingTool('Grep')).toBe(false);
    expect(isMutatingTool('write')).toBe(true);
    expect(isMutatingTool('bash')).toBe(true);
    expect(isMutatingTool('some_custom_extension_tool')).toBe(true);
  });

  it('admits a read even with no lease at all', () => {
    const ws = workspaceAt(join(root, 'wt'));
    expect(admitToolCall({ toolName: 'read', workspace: ws, activationId: 'act-1' }, liveSelfProbe()).allow).toBe(true);
  });

  it('admits the holder and blocks everyone else', () => {
    const ws = workspaceAt(join(root, 'wt'));
    const probe = liveSelfProbe();
    acquire({ workspace: ws, activationId: 'act-1', attemptId: 'att:1:1', specialist: 'executor' }, probe);

    expect(admitToolCall({ toolName: 'write', workspace: ws, activationId: 'act-1' }, probe).allow).toBe(true);

    const blocked = admitToolCall({ toolName: 'write', workspace: ws, activationId: 'act-2' }, probe);
    expect(blocked.allow).toBe(false);
    expect(blocked.reason).toContain('executor act-1');
  });

  it('blocks a read-only activation that holds no lease', () => {
    const ws = workspaceAt(join(root, 'wt'));
    const verdict = admitToolCall({ toolName: 'edit', workspace: ws, activationId: 'reader' }, liveSelfProbe());
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toContain('not leased by this activation');
  });

  it('blocks mutation while the lease is uncertain, including for the original holder', () => {
    const ws = workspaceAt(join(root, 'wt'));
    acquire({ workspace: ws, activationId: 'act-1', attemptId: 'att:1:1' }, liveSelfProbe());
    const verdict = admitToolCall({ toolName: 'write', workspace: ws, activationId: 'act-1' }, probeFor({}));
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toContain('uncertain');
  });
});

describe('lease record', () => {
  it('records a start-time guard so PID reuse cannot be mistaken for the holder', () => {
    const ws = workspaceAt(join(root, 'wt'));
    acquire({ workspace: ws, activationId: 'act-1', attemptId: 'att:1:1' }, liveSelfProbe());
    const record = JSON.parse(readFileSync(join(leaseDir(ws), `${workspaceKey(ws)}.json`), 'utf-8'));
    expect(record.holder.pid).toBe(process.pid);
    expect(typeof record.holder.startTicks).toBe('number');
    // The readable path is kept in the record even though the filename is a hash.
    expect(record.worktreePath).toBe(ws.worktreePath);
  });

  it('refuses to acquire when this process start time cannot be read', () => {
    const ws = workspaceAt(join(root, 'wt'));
    expect(() => acquire({ workspace: ws, activationId: 'act-1', attemptId: 'att:1:1' }, probeFor({})))
      .toThrow(/PID-reuse guard/);
  });
});
