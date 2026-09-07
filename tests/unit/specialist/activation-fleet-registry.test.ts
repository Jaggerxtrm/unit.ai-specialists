import { describe, it, expect, vi } from 'vitest';

/** Same guard as activation-native-host.test.ts: the native path must never spawn. */
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
import { DispatchRejectedError } from '../../../src/activation/types.js';
import { nextAttemptId } from '../../../src/activation/registry.js';
import type { PiSdk, PiAgentSessionLike, PiAgentSessionEvent } from '../../../src/activation/pi-sdk.js';

/**
 * Phase 2 acceptance: a persistent Fleet registry and attach/return/resume over the
 * existing AgentSession. This file exercises the registry surface added on top of the
 * Phase 1 host; Phase 1 behaviour itself stays pinned in activation-native-host.test.ts.
 */

function fakeSession(): PiAgentSessionLike & { disposed: boolean; prompts: string[] } {
  const listeners: Array<(e: PiAgentSessionEvent) => void> = [];
  const messages: unknown[] = [];
  const session = {
    sessionId: 'pi-sess-fleet',
    messages,
    isIdle: true,
    disposed: false,
    prompts: [] as string[],
    activeTools: ['read', 'grep'],
    async prompt(text: string) {
      session.prompts.push(text);
      listeners.forEach(l => l({ type: 'agent_start' }));
      messages.push({ role: 'assistant', content: `reply to: ${text}` });
      listeners.forEach(l => l({ type: 'agent_end', willRetry: false }));
      listeners.forEach(l => l({ type: 'agent_settled' }));
    },
    async steer() {}, async followUp() {}, async abort() {},
    dispose() { session.disposed = true; },
    subscribe(l: (e: PiAgentSessionEvent) => void) {
      listeners.push(l);
      return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); };
    },
    getActiveToolNames: () => session.activeTools,
    setActiveToolsByName(names: string[]) { session.activeTools = names; },
    async waitForIdle() {},
  };
  return session as unknown as ReturnType<typeof fakeSession>;
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
  };
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

const NO_CONTRACT_STATE = { readContractState: () => undefined };

function loaderFor(spec: Record<string, unknown>) {
  return { get: async () => spec } as never;
}

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

function newHost(session: PiAgentSessionLike) {
  return new NativeActivationHost({
    beadGate: NO_CONTRACT_STATE,
    loader: loaderFor(readOnlySpec()),
    beadsClient: { readBead: () => BEAD } as never,
    loadSdk: async () => makeSdk(session),
    cwd: process.cwd(),
  });
}

describe('nextAttemptId', () => {
  it('increments the trailing attempt counter', () => {
    expect(nextAttemptId('att:abc123:1')).toBe('att:abc123:2');
    expect(nextAttemptId('att:abc123:9')).toBe('att:abc123:10');
  });

  it('appends :2 to an id with no counter suffix, rather than throwing', () => {
    expect(nextAttemptId('att:abc123')).toBe('att:abc123:2');
  });
});

describe('NativeActivationHost — Fleet registry projection', () => {
  it('survives across calls: list() and inspect() reflect the same registry after settle', async () => {
    const host = newHost(fakeSession());

    const handle = await host.start({
      specialist: 'researcher', beadId: 'ISSUE-1', requestedByParticipantId: 'coordinator',
    });
    await handle.result;

    const projected = host.list();
    expect(projected).toHaveLength(1);
    expect(projected[0].activationId).toBe(handle.activationId);
    expect(host.inspect(handle.activationId)?.state).toBe('settled');

    // The projection is a plain ActivationSnapshot — no host/session internals leak.
    const keys = Object.keys(projected[0]).sort();
    expect(keys).toEqual([
      'access', 'activationId', 'attemptId', 'beadId', 'configuredModel', 'lastActivityAt',
      'modelOverride', 'participantId', 'piSessionId', 'requestedModel', 'resolvedModel',
      'specialist',
      'startedAt', 'state', 'workspace',
    ].sort());
  });

  it('attach observes the live event stream without perturbing the running turn', async () => {
    const session = fakeSession();
    const host = newHost(session);

    const handle = await host.start({
      specialist: 'researcher', beadId: 'ISSUE-1', requestedByParticipantId: 'coordinator',
    });
    await handle.result;

    const seen: string[] = [];
    const attachment = host.attach(handle.activationId, (event) => seen.push(event.type));
    expect(attachment).toBeDefined();
    expect(attachment!.snapshot.activationId).toBe(handle.activationId);

    // Resume drives a new turn; the attachment observes it without the host's own
    // lifecycle subscription being displaced (asserted separately below via state).
    await (await host.resume(handle.activationId, 'follow-up question')).result;

    expect(seen).toEqual(expect.arrayContaining(['agent_start', 'agent_end', 'agent_settled']));
    // The initial prompt is the fully rendered task template; only the resume prompt is
    // passed through verbatim, so assert on that rather than the rendered initial one.
    expect(session.prompts).toHaveLength(2);
    expect(session.prompts[1]).toBe('follow-up question');

    host.return(attachment!);
    // Detaching does not stop or alter the activation.
    expect(host.inspect(handle.activationId)?.state).toBe('settled');
  });

  it('resume keeps activationId, advances attemptId, and does not create a second activation', async () => {
    const host = newHost(fakeSession());

    const handle = await host.start({
      specialist: 'researcher', beadId: 'ISSUE-1', requestedByParticipantId: 'coordinator',
    });
    await handle.result;
    expect(handle.attemptId).toMatch(/:1$/);

    const resumed = await host.resume(handle.activationId, 'continue please');
    const result = await resumed.result;

    expect(resumed.activationId).toBe(handle.activationId);
    expect(resumed.attemptId).not.toBe(handle.attemptId);
    expect(resumed.attemptId).toMatch(/:2$/);
    expect(result.activationId).toBe(handle.activationId);
    expect(result.attemptId).toBe(resumed.attemptId);
    expect(result.status).toBe('completed');

    expect(host.list()).toHaveLength(1);
    expect(host.inspect(handle.activationId)?.attemptId).toBe(resumed.attemptId);
  });

  it('rejects resuming an unknown activation', async () => {
    const host = newHost(fakeSession());
    await expect(host.resume('act:does-not-exist', 'x')).rejects.toBeInstanceOf(DispatchRejectedError);
  });

  it('rejects resuming an activation that is not in a resumable state', async () => {
    const host = newHost(fakeSession());
    const handle = await host.start({
      specialist: 'researcher', beadId: 'ISSUE-1', requestedByParticipantId: 'coordinator',
    });
    await handle.result;

    await host.stop(handle.activationId);

    // Stopped activations are disposed and removed from the registry entirely.
    await expect(host.resume(handle.activationId, 'x')).rejects.toBeInstanceOf(DispatchRejectedError);
  });
});
