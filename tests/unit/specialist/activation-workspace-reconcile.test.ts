// tests/unit/specialist/activation-workspace-reconcile.test.ts
//
// The property under test is that there is no path from `uncertain` to `free` that does not
// pass through a recorded decision. Freeing is the dangerous direction — two writers in one
// worktree is data loss — so every test here that admits a free asserts WHY it was admitted,
// and every test that refuses one asserts that the refusal survived as evidence.
//
// The first test kills a real process. Three claims in this epic passed inspection and were
// then falsified by a live probe, so the crash case is exercised against the real `/proc`
// probe and a real SIGKILL rather than a stub that can only agree with the code it stubs.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquire,
  inspect,
  leaseDir,
  leasePath,
  procLeaseProbe,
  workspaceKey,
  type LeaseProcessProbe,
} from '../../../src/activation/workspace-lease.js';
import {
  projectUncertainWorkspaces,
  readReconciliationLog,
  reconcile,
  reconciliationLogPath,
  type ReconciliationForensicSink,
  type ReconciliationRecord,
} from '../../../src/activation/workspace-reconcile.js';
import type { WorkspaceIdentity } from '../../../src/activation/types.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sp-reconcile-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function probeFor(running: Record<number, number>, canVerify = true): LeaseProcessProbe {
  return { canVerify: () => canVerify, startTicks: pid => running[pid] };
}

function liveSelfProbe(extra: Record<number, number> = {}): LeaseProcessProbe {
  return probeFor({ [process.pid]: 111_111, ...extra });
}

function workspaceAt(path: string, gitCommonDir?: string): WorkspaceIdentity {
  mkdirSync(path, { recursive: true });
  return { repositoryRoot: path, worktreePath: path, gitCommonDir };
}

/**
 * The identity a status surface passes: it names the shared lease directory, and its own
 * `worktreePath` is irrelevant because each row is inspected under the path its own record
 * carries.
 */
function scopeAt(gitCommonDir: string): WorkspaceIdentity {
  return { repositoryRoot: join(gitCommonDir, '..'), worktreePath: join(gitCommonDir, '..'), gitCommonDir };
}

/** A workspace already in `uncertain` for a chosen reason, with the probe that produces it. */
function uncertainWorkspace(
  reason: 'holder_process_gone' | 'holder_start_mismatch' | 'liveness_unverifiable' | 'unreadable_record',
  dir = join(root, 'wt'),
): { ws: WorkspaceIdentity; probe: LeaseProcessProbe } {
  const ws = workspaceAt(dir);
  acquire({ workspace: ws, activationId: 'act-1', attemptId: 'att:1:1', specialist: 'executor' }, liveSelfProbe());
  switch (reason) {
    case 'holder_process_gone':
      return { ws, probe: probeFor({}) };
    case 'holder_start_mismatch':
      return { ws, probe: probeFor({ [process.pid]: 999_999 }) };
    case 'liveness_unverifiable':
      return { ws, probe: probeFor({ [process.pid]: 111_111 }, false) };
    case 'unreadable_record':
      writeFileSync(leasePath(ws), '{ truncated');
      return { ws, probe: liveSelfProbe() };
  }
}

function collectingSink(): { sink: ReconciliationForensicSink; events: Parameters<ReconciliationForensicSink['emit']>[0][] } {
  const events: Parameters<ReconciliationForensicSink['emit']>[0][] = [];
  return { sink: { emit: e => { events.push(e); } }, events };
}

const BASIS = ['forensic:activation_failed#e-77', 'git:worktree clean at 9f2c1ab'];

// ------------------------------------------------------------------------------- live

describe('criterion 1 — a real SIGKILL mid-mutation, measured with the real /proc probe', () => {
  it('leaves the workspace uncertain for holder_process_gone, not free', async () => {
    // Everything here is real: a real child process, a real lease record it published with
    // the real probe, a real SIGKILL, and a real `/proc` read afterwards. A stubbed probe
    // would only demonstrate that the stub agrees with the assertion.
    const ws = workspaceAt(join(root, 'live-wt'));
    const script = join(root, 'holder.ts');
    const moduleUrl = join(process.cwd(), 'src', 'activation', 'workspace-lease.ts');
    const readyFile = join(root, 'acquired');

    writeFileSync(script, `
      import { writeFileSync } from 'node:fs';
      import { acquire } from ${JSON.stringify(moduleUrl)};
      const [, , worktree, readyFile] = process.argv;
      const ws = { repositoryRoot: worktree, worktreePath: worktree };
      acquire({ workspace: ws, activationId: 'act-live', attemptId: 'att:1', specialist: 'executor' });
      // The mutation is deliberately never resolved: the process is killed while holding.
      writeFileSync(readyFile, String(process.pid));
      setInterval(() => {}, 1000);
    `);

    const child = spawn('bun', ['run', script, ws.worktreePath, readyFile], { stdio: 'ignore' });
    try {
      const deadline = Date.now() + 30_000;
      while (!existsSync(readyFile) && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 50));
      }
      expect(existsSync(readyFile), 'child never published its lease').toBe(true);

      const holderPid = Number(readFileSync(readyFile, 'utf-8'));
      // While it is alive the real probe must read `held` — otherwise the crash assertion
      // below would pass even if the probe were simply blind.
      const alive = inspect(ws, procLeaseProbe());
      expect(alive.state).toBe('held');
      expect(alive.lease?.holder.pid).toBe(holderPid);

      child.kill('SIGKILL');
      const gone = Date.now() + 30_000;
      while (existsSync(`/proc/${holderPid}`) && Date.now() < gone) {
        await new Promise(r => setTimeout(r, 50));
      }
      expect(existsSync(`/proc/${holderPid}`), 'holder did not actually die').toBe(false);

      const after = inspect(ws, procLeaseProbe());
      // The reason, not just the state: `uncertain` alone would also be produced by a host
      // that cannot see processes, which is a different situation with a different safe
      // action. Acceptance AB is about this specific reason.
      expect(after.state).toBe('uncertain');
      expect(after.uncertainReason).toBe('holder_process_gone');
      expect(after.lease?.activationId).toBe('act-live');
      expect(existsSync(leasePath(ws)), 'the record must survive for recovery to read').toBe(true);

      // Criterion 2, on the same real crash rather than a synthetic one.
      const record = reconcile(
        ws,
        { outcome: 'safe_free', decidedBy: 'operator:dawid', basis: [`proc:/proc/${holderPid} absent`, 'git:worktree clean'] },
        { probe: procLeaseProbe() },
      );
      expect(record.applied).toBe(true);
      expect(record.outcome).toBe('safe_free');
      expect(record.observedUncertainReason).toBe('holder_process_gone');
      expect(inspect(ws, procLeaseProbe()).state).toBe('free');
    } finally {
      child.kill('SIGKILL');
    }
  }, 90_000);
});

// -------------------------------------------------------------------- decision, not guess

describe('criterion 2 — reconciliation records what it decided and on what basis', () => {
  it('frees a workspace whose holder is provably gone and writes durable evidence', () => {
    const { ws, probe } = uncertainWorkspace('holder_process_gone');
    const { sink, events } = collectingSink();

    const record = reconcile(ws, {
      outcome: 'safe_free',
      decidedBy: 'operator:dawid',
      basis: BASIS,
      note: 'executor died after its last write flushed',
    }, { probe, forensics: sink, now: () => 1_700_000_000_000 });

    expect(record).toMatchObject({
      applied: true,
      outcome: 'safe_free',
      observedState: 'uncertain',
      observedUncertainReason: 'holder_process_gone',
      decidedBy: 'operator:dawid',
      basis: BASIS,
      decidedAtMs: 1_700_000_000_000,
      holder: { activationId: 'act-1', specialist: 'executor' },
    });
    expect(inspect(ws, probe).state).toBe('free');

    // Durable on disk, not only in the return value.
    const log = readReconciliationLog(ws);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ outcome: 'safe_free', decidedBy: 'operator:dawid', basis: BASIS });

    // And in the forensic store's vocabulary.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ name: 'lease_reconciled', activationId: 'act-1', specialist: 'executor' });
    expect(events[0].payload).toMatchObject({
      outcome: 'safe_free',
      applied: true,
      decided_by: 'operator:dawid',
      basis: BASIS,
      uncertain_reason: 'holder_process_gone',
    });
  });

  it('records a named successor for superseded, and refuses one that is not named', () => {
    const { ws, probe } = uncertainWorkspace('holder_process_gone');

    const unnamed = reconcile(ws, { outcome: 'superseded', decidedBy: 'operator:dawid', basis: BASIS }, { probe });
    expect(unnamed.applied).toBe(false);
    expect(unnamed.refusalReason).toBe('successor_not_named');
    expect(inspect(ws, probe).state).toBe('uncertain');

    const named = reconcile(
      ws,
      { outcome: 'superseded', decidedBy: 'operator:dawid', basis: BASIS, supersededBy: 'act-9' },
      { probe },
    );
    expect(named).toMatchObject({ applied: true, outcome: 'superseded', supersededBy: 'act-9' });
    expect(inspect(ws, probe).state).toBe('free');
    // Supersession frees the workspace but never publishes a lease for the successor: that
    // would fabricate liveness for a process nothing has probed.
    expect(existsSync(leasePath(ws))).toBe(false);
  });

  it('keeps every attempt, so a refusal is not overwritten by the next try', () => {
    const { ws, probe } = uncertainWorkspace('holder_process_gone');
    reconcile(ws, { outcome: 'safe_free', decidedBy: 'runtime', basis: [] }, { probe });
    reconcile(ws, { outcome: 'safe_free', decidedBy: 'operator:a', basis: ['git:dirty worktree'] }, { probe });

    const log = readReconciliationLog(ws);
    expect(log.map((r: ReconciliationRecord) => [r.applied, r.refusalReason])).toEqual([
      [false, 'insufficient_evidence'],
      [true, undefined],
    ]);
    expect(existsSync(reconciliationLogPath(ws))).toBe(true);
  });
});

// ------------------------------------------------------------------------- the refusals

describe('criterion 3 — reconciliation refuses when the evidence does not support it', () => {
  it('refuses every outcome with an empty basis, including manual attention', () => {
    const { ws, probe } = uncertainWorkspace('holder_process_gone');
    for (const outcome of ['safe_free', 'superseded', 'manual_attention_required'] as const) {
      const record = reconcile(ws, { outcome, decidedBy: 'runtime', basis: [], supersededBy: 'act-9' }, { probe });
      expect(record.applied, outcome).toBe(false);
      expect(record.refusalReason, outcome).toBe('insufficient_evidence');
    }
    expect(inspect(ws, probe).state).toBe('uncertain');
  });

  it('refuses to free a workspace on a host that cannot establish liveness at all', () => {
    // The bright line. Nothing this runtime can observe distinguishes a departed holder
    // from a live one here, so no evidence — however rich — licenses a free.
    const { ws, probe } = uncertainWorkspace('liveness_unverifiable');

    for (const outcome of ['safe_free', 'superseded'] as const) {
      const record = reconcile(
        ws,
        { outcome, decidedBy: 'operator:dawid', basis: BASIS, supersededBy: 'act-9' },
        { probe },
      );
      expect(record.applied, outcome).toBe(false);
      expect(record.refusalReason, outcome).toBe('reason_forbids_outcome');
    }
    expect(inspect(ws, probe).state).toBe('uncertain');
    expect(existsSync(leasePath(ws))).toBe(true);

    // Only recording that a human must look is open.
    const manual = reconcile(
      ws,
      { outcome: 'manual_attention_required', decidedBy: 'runtime', basis: ['probe:canVerify=false'] },
      { probe },
    );
    expect(manual).toMatchObject({ applied: true, outcome: 'manual_attention_required' });
    // Applied, and still not free: this outcome resolves the question of who is looking, not
    // the question of who held the workspace.
    expect(inspect(ws, probe).state).toBe('uncertain');
  });

  it('refuses safe_free for an unreadable record, because nothing can be attributed', () => {
    const { ws, probe } = uncertainWorkspace('unreadable_record');
    const record = reconcile(ws, { outcome: 'safe_free', decidedBy: 'operator:dawid', basis: BASIS }, { probe });
    expect(record.applied).toBe(false);
    expect(record.refusalReason).toBe('reason_forbids_outcome');
    expect(record.holder).toBeUndefined();

    // Naming a successor is still open: that asserts ownership rather than completion.
    const superseded = reconcile(
      ws,
      { outcome: 'superseded', decidedBy: 'operator:dawid', basis: BASIS, supersededBy: 'act-9' },
      { probe },
    );
    expect(superseded.applied).toBe(true);
  });

  it('does not collapse the four uncertain reasons into one rule', () => {
    const permitted = (reason: Parameters<typeof uncertainWorkspace>[0], outcome: 'safe_free' | 'superseded') => {
      const { ws, probe } = uncertainWorkspace(reason, join(root, `wt-${reason}-${outcome}`));
      return reconcile(
        ws,
        { outcome, decidedBy: 'operator:dawid', basis: BASIS, supersededBy: 'act-9' },
        { probe },
      ).applied;
    };

    expect({
      holder_process_gone: [permitted('holder_process_gone', 'safe_free'), permitted('holder_process_gone', 'superseded')],
      holder_start_mismatch: [permitted('holder_start_mismatch', 'safe_free'), permitted('holder_start_mismatch', 'superseded')],
      unreadable_record: [permitted('unreadable_record', 'safe_free'), permitted('unreadable_record', 'superseded')],
      liveness_unverifiable: [permitted('liveness_unverifiable', 'safe_free'), permitted('liveness_unverifiable', 'superseded')],
    }).toEqual({
      holder_process_gone: [true, true],
      holder_start_mismatch: [true, true],
      unreadable_record: [false, true],
      liveness_unverifiable: [false, false],
    });
  });

  it('emits the refusal as a forensic event rather than discarding it', () => {
    const { ws, probe } = uncertainWorkspace('liveness_unverifiable');
    const { sink, events } = collectingSink();
    reconcile(ws, { outcome: 'safe_free', decidedBy: 'runtime', basis: BASIS }, { probe, forensics: sink });

    expect(events[0]).toMatchObject({ name: 'lease_uncertain' });
    expect(events[0].payload).toMatchObject({
      applied: false,
      proposed_outcome: 'safe_free',
      refusal_reason: 'reason_forbids_outcome',
      uncertain_reason: 'liveness_unverifiable',
    });
  });

  it('never lets a forensic sink failure change the decision', () => {
    const { ws, probe } = uncertainWorkspace('holder_process_gone');
    const record = reconcile(
      ws,
      { outcome: 'safe_free', decidedBy: 'operator:dawid', basis: BASIS },
      { probe, forensics: { emit: () => { throw new Error('observability.db is locked'); } } },
    );
    expect(record.applied).toBe(true);
    expect(readReconciliationLog(ws)).toHaveLength(1);
  });
});

// --------------------------------------------------------------------- the live-writer guard

describe('criterion 4 — a live writer is never reconciled out from under itself', () => {
  it('records recovered_holder and touches nothing when the holder is alive at decision time', () => {
    const ws = workspaceAt(join(root, 'wt'));
    acquire({ workspace: ws, activationId: 'act-1', attemptId: 'att:1:1', specialist: 'executor' }, liveSelfProbe());

    // The caller believes the workspace is uncertain — it may have read it a second ago, or
    // be acting on a stale status page. Re-inspection at decision time is what makes
    // `recovered_holder` unforgeable: the caller cannot assert it and cannot avoid it.
    const record = reconcile(
      ws,
      { outcome: 'safe_free', decidedBy: 'operator:dawid', basis: BASIS },
      { probe: liveSelfProbe() },
    );

    expect(record).toMatchObject({
      applied: false,
      outcome: 'recovered_holder',
      proposedOutcome: 'safe_free',
      refusalReason: 'holder_is_live',
      observedState: 'held',
    });
    expect(inspect(ws, liveSelfProbe()).state).toBe('held');
    expect(existsSync(leasePath(ws))).toBe(true);
  });

  it('cannot be asked for recovered_holder — it is computed, never proposed', () => {
    const { ws, probe } = uncertainWorkspace('holder_process_gone');
    // @ts-expect-error `recovered_holder` is excluded from ProposedOutcome by construction.
    const record = reconcile(ws, { outcome: 'recovered_holder', decidedBy: 'x', basis: BASIS }, { probe });
    // Even forced past the type system it is not honoured: the permission table has no such
    // entry, so a caller asserting the holder came back is refused rather than believed.
    expect(record.applied).toBe(false);
    expect(record.refusalReason).toBe('reason_forbids_outcome');
  });

  it('refuses on a workspace that is simply free', () => {
    const ws = workspaceAt(join(root, 'wt'));
    const record = reconcile(ws, { outcome: 'safe_free', decidedBy: 'x', basis: BASIS }, { probe: liveSelfProbe() });
    expect(record).toMatchObject({ applied: false, refusalReason: 'workspace_not_uncertain' });
  });
});

// ------------------------------------------------------------------------ status surface

describe('the specialist_status surface', () => {
  it('is empty for a repository with no leases at all', () => {
    expect(projectUncertainWorkspaces(workspaceAt(join(root, 'empty-repo')))).toEqual([]);
  });

  it('lists an uncertain workspace with its reason and the outcomes still open', () => {
    const common = join(root, 'repo', '.git');
    mkdirSync(common, { recursive: true });
    const ws = workspaceAt(join(root, 'wt-a'), common);
    acquire({ workspace: ws, activationId: 'act-1', attemptId: 'att:1:1', specialist: 'executor' }, liveSelfProbe());

    const rows = projectUncertainWorkspaces(scopeAt(common), probeFor({}));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspace_key: workspaceKey(ws),
      worktree_path: ws.worktreePath,
      uncertain_reason: 'holder_process_gone',
      holder_activation_id: 'act-1',
      holder_specialist: 'executor',
      reconciliation_attempts: 0,
    });
    expect(rows[0].permitted_outcomes.sort()).toEqual(['manual_attention_required', 'safe_free', 'superseded']);
  });

  it('omits a held workspace, because only uncertainty needs an operator', () => {
    const common = join(root, 'repo', '.git');
    mkdirSync(common, { recursive: true });
    const ws = workspaceAt(join(root, 'wt-a'), common);
    acquire({ workspace: ws, activationId: 'act-1', attemptId: 'att:1:1' }, liveSelfProbe());
    expect(projectUncertainWorkspaces(scopeAt(common), liveSelfProbe())).toEqual([]);
  });

  it('surfaces a refusal instead of throwing it away — criterion 3', () => {
    const common = join(root, 'repo', '.git');
    mkdirSync(common, { recursive: true });
    const ws = workspaceAt(join(root, 'wt-a'), common);
    acquire({ workspace: ws, activationId: 'act-1', attemptId: 'att:1:1' }, liveSelfProbe());
    const probe = probeFor({ [process.pid]: 111_111 }, false);

    reconcile(ws, { outcome: 'safe_free', decidedBy: 'runtime', basis: ['probe:canVerify=false'] }, { probe });

    const rows = projectUncertainWorkspaces(scopeAt(common), probe);
    expect(rows).toHaveLength(1);
    expect(rows[0].uncertain_reason).toBe('liveness_unverifiable');
    expect(rows[0].permitted_outcomes).toEqual(['manual_attention_required']);
    expect(rows[0].reconciliation_attempts).toBe(1);
    expect(rows[0].last_reconciliation).toMatchObject({
      applied: false,
      outcome: 'manual_attention_required',
      refusal_reason: 'reason_forbids_outcome',
      decided_by: 'runtime',
    });
  });

  it('still reports a workspace whose record it cannot parse', () => {
    const common = join(root, 'repo', '.git');
    mkdirSync(common, { recursive: true });
    const ws = workspaceAt(join(root, 'wt-a'), common);
    acquire({ workspace: ws, activationId: 'act-1', attemptId: 'att:1:1' }, liveSelfProbe());
    writeFileSync(leasePath(ws), '{ truncated');

    const rows = projectUncertainWorkspaces(scopeAt(common), liveSelfProbe());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ uncertain_reason: 'unreadable_record', worktree_path: undefined });
    expect(rows[0].permitted_outcomes.sort()).toEqual(['manual_attention_required', 'superseded']);
  });

  it('reports two linked worktrees of one repository separately', () => {
    const common = join(root, 'repo', '.git');
    mkdirSync(common, { recursive: true });
    const a = workspaceAt(join(root, 'wt-a'), common);
    const b = workspaceAt(join(root, 'wt-b'), common);
    acquire({ workspace: a, activationId: 'act-a', attemptId: 'att:1' }, liveSelfProbe());
    acquire({ workspace: b, activationId: 'act-b', attemptId: 'att:1' }, liveSelfProbe());

    const rows = projectUncertainWorkspaces(scopeAt(common), probeFor({}));
    expect(rows.map(r => r.holder_activation_id).sort()).toEqual(['act-a', 'act-b']);
    expect(new Set(rows.map(r => r.workspace_key)).size).toBe(2);
    expect(existsSync(leaseDir(a))).toBe(true);
  });
});
