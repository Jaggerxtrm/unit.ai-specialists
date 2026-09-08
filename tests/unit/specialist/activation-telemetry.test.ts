import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Same guard as the other activation suites: the native path must never spawn. */
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      throw new Error(`native activation must not spawn a subprocess; got spawn(${String(args[0])})`);
    },
  };
});

import { NativeActivationHost } from '../../../src/activation/native-host.js';
import type { ActivationSnapshot } from '../../../src/activation/types.js';
import { toActivationView } from '../../../src/tools/specialist/activation.tool.js';
import type { PiSdk, PiAgentSessionLike, PiAgentSessionEvent } from '../../../src/activation/pi-sdk.js';

/**
 * Fleet telemetry (unitAI-beqby.3): elapsed runtime, token spend, thinking level and
 * activity signal, projected live from existing in-memory state. No observability.db on
 * the tick path, no lifecycle behaviour change.
 */

function baseSnapshot(overrides: Partial<ActivationSnapshot> = {}): ActivationSnapshot {
  return {
    activationId: 'act-1',
    participantId: 'part-1',
    attemptId: 'att-1:1',
    specialist: 'researcher',
    beadId: 'ISSUE-1',
    state: 'running',
    access: 'read',
    workspace: { repositoryRoot: '/repo', worktreePath: '/repo' },
    resolvedModel: 'testprov/test-model',
    modelOverride: false,
    startedAt: 1_000_000,
    lastActivityAt: 1_005_000,
    ...overrides,
  };
}

describe('toActivationView telemetry projection', () => {
  it('projects elapsed, tokens, thinking level and activity when present', () => {
    const view = toActivationView(
      baseSnapshot({
        thinkingLevel: 'high',
        tokenUsage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      }),
      1_007_000,
    );
    expect(view.elapsed_s).toBe(7);
    expect(view.token_usage).toEqual({ input_tokens: 100, output_tokens: 50, total_tokens: 150 });
    expect(view.thinking_level).toBe('high');
    expect(view.last_activity_at).toBe(1_005_000);
  });

  it('omits thinking level and token usage when unset instead of zero-filling', () => {
    const view = toActivationView(baseSnapshot(), 1_003_000);
    expect(view.elapsed_s).toBe(3);
    expect('thinking_level' in view).toBe(false);
    expect('token_usage' in view).toBe(false);
    expect(view.last_activity_at).toBe(1_005_000);
  });

  it('clamps elapsed at zero when the clock runs backwards', () => {
    expect(toActivationView(baseSnapshot(), 999_000).elapsed_s).toBe(0);
  });
});

const hostWorkspaces: string[] = [];
function hostWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'telemetry-ws-'));
  hostWorkspaces.push(root);
  return root;
}
afterEach(() => {
  while (hostWorkspaces.length > 0) {
    rmSync(hostWorkspaces.pop() as string, { recursive: true, force: true });
  }
});

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

function specWithThinking() {
  return {
    specialist: {
      metadata: { name: 'researcher', version: '1.0.0', description: 'd', category: 'c' },
      execution: {
        model: 'testprov/test-model',
        permission_required: 'READ_ONLY',
        response_format: 'text',
        output_type: 'research',
        bare: false,
        thinking_level: 'high',
      },
      prompt: { system: 'You are the researcher.', task_template: 'Do: {{bead_id}}' },
    },
  };
}

function fakeSession(): PiAgentSessionLike & { emit: (e: PiAgentSessionEvent) => void } {
  const listeners: Array<(e: PiAgentSessionEvent) => void> = [];
  const session = {
    sessionId: 'pi-sess-telemetry',
    messages: [] as unknown[],
    isIdle: true,
    async prompt() {
      listeners.forEach(l => l({ type: 'agent_start' }));
      (session.messages as unknown[]).push({ role: 'assistant', content: 'done' });
      // Realistic per-message usage: one message_end carrying the final assistant
      // message with nested short-key usage (unitAI-beqby.12). The SDK emits no
      // `token_usage`-typed session event.
      listeners.forEach(l => l({
        type: 'message_end',
        message: {
          role: 'assistant', provider: 'testprov', model: 'test-model', stopReason: 'stop',
          usage: { input: 100, output: 50, totalTokens: 150 },
          content: [{ type: 'text', text: 'done' }],
        },
      }));
      listeners.forEach(l => l({ type: 'agent_end', willRetry: false }));
      listeners.forEach(l => l({ type: 'agent_settled' }));
    },
    async steer() {}, async followUp() {}, async abort() {},
    dispose() {},
    subscribe(l: (e: PiAgentSessionEvent) => void) {
      listeners.push(l);
      return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); };
    },
    getActiveToolNames: () => [] as string[],
    setActiveToolsByName() {},
    async waitForIdle() {},
    emit: (e: PiAgentSessionEvent) => listeners.forEach(l => l(e)),
  };
  return session;
}

function makeSdk(session: PiAgentSessionLike): PiSdk {
  return {
    createAgentSession: async () => ({ session }),
    ModelRuntime: { create: async () => ({ hasConfiguredAuth: () => true }) },
    resolveModelScopeWithDiagnostics: () => ({
      scopedModels: [{ model: { id: 'test-model', provider: 'testprov' } }],
      diagnostics: [],
    }),
    defineTool: (d) => d,
  } as unknown as PiSdk;
}

describe('host liveStats', () => {
  it('returns values consistent with a dispatched-then-settled activation', async () => {
    let now = 1_000_000;
    const session = fakeSession();
    const host = new NativeActivationHost({
      beadGate: { readContractState: () => undefined },
      loader: { get: async () => specWithThinking() } as never,
      beadsClient: { readBead: () => BEAD } as never,
      forensics: { emit: () => {} },
      loadSdk: async () => makeSdk(session),
      cwd: hostWorkspace(),
      now: () => now,
    });

    const handle = await host.start({
      specialist: 'researcher',
      beadId: 'ISSUE-1',
      requestedByParticipantId: 'coordinator',
    });
    await handle.result;

    now = 1_007_000;
    const stats = host.liveStats(handle.activationId);
    expect(stats).toMatchObject({
      activationId: handle.activationId,
      elapsed_s: 7,
      thinking_level: 'high',
      token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    });
    expect(stats?.last_activity_at).toBeGreaterThanOrEqual(1_000_000);

    const view = toActivationView(host.inspect(handle.activationId)!, now);
    expect(view.elapsed_s).toBe(7);
    expect(view.thinking_level).toBe('high');
    expect(view.token_usage).toEqual({ input_tokens: 100, output_tokens: 50, total_tokens: 150 });
  });

  it('projects purpose when present and omits it when absent (unitAI-uvg4j)', () => {
    expect(toActivationView(baseSnapshot({ purpose: 'researching activation transport' }), 1_003_000).purpose)
      .toBe('researching activation transport');
    expect('purpose' in toActivationView(baseSnapshot(), 1_003_000)).toBe(false);
  });

  it('returns undefined for an unknown activation and omits unset fields', async () => {
    const host = new NativeActivationHost({
      beadGate: { readContractState: () => undefined },
      cwd: hostWorkspace(),
    });
    expect(host.liveStats('act-nope')).toBeUndefined();
  });
});
