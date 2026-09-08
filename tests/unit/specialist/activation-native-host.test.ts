import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The native path must never reach for a subprocess. `spawn` is replaced with a throwing
 * stub rather than a spy: if the host ever regressed to the legacy `sp run` boundary the
 * test fails at the call site with a clear cause, instead of passing and reporting a count
 * afterwards. Everything else in node:child_process stays real — `execSync` is used by
 * tool-catalog resolution and the system-prompt defaults.
 */
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      throw new Error(`native activation must not spawn a subprocess; got spawn(${String(args[0])})`);
    },
  };
});
import { NativeActivationHost, type ActivationForensicSink } from '../../../src/activation/native-host.js';
import { DispatchRejectedError } from '../../../src/activation/types.js';
import type { PiSdk, PiAgentSessionLike, PiAgentSessionEvent } from '../../../src/activation/pi-sdk.js';

/**
 * Phase 1 acceptance. The load-bearing assertions here are:
 *   - a real Specialist definition drives the child (acceptance A);
 *   - a read-only child cannot receive mutation tools (acceptance G);
 *   - NO subprocess is spawned — this is the whole point of the native path;
 *   - the session is NOT disposed when it settles (acceptance H's precondition);
 *   - a write-capable Specialist is refused while no lease exists.
 */

interface FakeSessionOptions { record: { createArgs?: Record<string, unknown> } }

/**
 * `holdOpen` suspends the turn: `prompt()` never resolves, so the activation stays RUNNING.
 *
 * Needed since unitAI-rrdnt.59 released the writer lease on settle AND on completion. A
 * writer now holds its workspace for the duration of its turn and no longer, so contention
 * and per-call mutation admission only exist inside that window. Without this the fake
 * finishes the turn inside `start()` and there is nothing left to contend with — the tests
 * would have to be weakened to pass, which would delete what they check.
 */
function fakeSession(opts: FakeSessionOptions & { assistantText?: string; stopReason?: string; errorMessage?: string; holdOpen?: boolean }): PiAgentSessionLike & {
  disposed: boolean; prompts: string[]; emit: (e: PiAgentSessionEvent) => void;
} {
  const listeners: Array<(e: PiAgentSessionEvent) => void> = [];
  const messages: unknown[] = [];
  const session = {
    sessionId: 'pi-sess-123',
    messages,
    isIdle: true,
    disposed: false,
    prompts: [] as string[],
    activeTools: ['read', 'grep'],
    async prompt(text: string) {
      session.prompts.push(text);
      listeners.forEach(l => l({ type: 'agent_start' }));
      if (opts.holdOpen) return new Promise<never>(() => {});
      messages.push({
        role: 'assistant',
        content: opts.assistantText ?? 'done',
        ...(opts.stopReason ? { stopReason: opts.stopReason } : {}),
        ...(opts.errorMessage ? { errorMessage: opts.errorMessage } : {}),
      });
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
    emit: (e: PiAgentSessionEvent) => listeners.forEach(l => l(e)),
  };
  return session as unknown as ReturnType<typeof fakeSession>;
}

function makeSdk(record: { createArgs?: Record<string, unknown> }, session: PiAgentSessionLike): PiSdk {
  return {
    createAgentSession: async (options?: Record<string, unknown>) => {
      record.createArgs = options;
      return { session };
    },
    ModelRuntime: { create: async () => ({ hasConfiguredAuth: () => true }) },
    resolveModelScopeWithDiagnostics: () => ({
      scopedModels: [{ model: { id: 'test-model', provider: 'testprov' } }],
      diagnostics: [],
    }),
    defineTool: (d) => d,
    // The mutating builtins pi exports. The host RECONSTRUCTS these and wraps their
    // execute with the lease check (unitAI-rrdnt.36.2), and refuses a dispatch when it
    // cannot — so a double that omits them models a runtime where nothing is fenceable,
    // and every writer dispatch is correctly refused. Modelling the real surface is the
    // point: the refusal is the guard working, not a test artefact.
    createEditTool: () => ({ name: 'edit', execute: async () => 'edited' }),
    createWriteTool: () => ({ name: 'write', execute: async () => 'written' }),
    createBashTool: () => ({ name: 'bash', execute: async () => 'ran' }),
    createPowerShellTool: () => ({ name: 'powershell', execute: async () => 'ran' }),
  } as unknown as PiSdk;
}

/**
 * A COMPLETE task contract. The Phase 3 bead gate refuses anything less, so this fixture
 * carries all seven sections plus SCRUTINY — it is a stub for the host's other assertions,
 * not the subject of them. Gate behaviour itself is tested in activation-bead-gate.test.ts.
 */
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

/** Keeps the gate off the real `bd` binary in unit tests. */
/**
 * A throwaway repository root per host.
 *
 * Since unitAI-rrdnt.36 a write-capable activation ACQUIRES a real lease under
 * `<workspace>/.specialists/leases/`. A host built on `process.cwd()` writes that lease
 * into THIS repository, and when the vitest worker exits its holder pid is gone and the
 * lease is left uncertain — which by design cannot be stolen, so the next writer in any
 * suite, or a real dispatch by a developer, is refused. It happened once and had to be
 * reconciled by hand. Same class as the observability.db incident: a test operating on live
 * developer state, invisible until something downstream refuses.
 */
const hostWorkspaces: string[] = [];
function hostWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'native-host-ws-'));
  hostWorkspaces.push(root);
  return root;
}
afterEach(() => {
  while (hostWorkspaces.length > 0) {
    rmSync(hostWorkspaces.pop() as string, { recursive: true, force: true });
  }
});

const NO_CONTRACT_STATE = { readContractState: () => undefined };

function loaderFor(spec: Record<string, unknown>) {
  return { get: async () => spec } as never;
}

function readOnlySpec(executionExtra: Record<string, unknown> = {}) {
  return {
    specialist: {
      metadata: { name: 'researcher', version: '1.0.0', description: 'd', category: 'c' },
      execution: {
        model: 'testprov/test-model',
        permission_required: 'READ_ONLY',
        response_format: 'text',
        output_type: 'research',
        bare: false,
        ...executionExtra,
      },
      prompt: { system: 'You are the researcher.', task_template: 'Do: {{bead_id}}' },
    },
  };
}

function collectingSink(): ActivationForensicSink & { names: string[]; events: Array<Record<string, unknown>> } {
  const names: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  return {
    names, events,
    emit(e) { names.push(e.name); events.push(e as unknown as Record<string, unknown>); },
  };
}

describe('NativeActivationHost — Phase 1 read-only', () => {
  it('runs a read-only Specialist in-process without spawning a subprocess', async () => {
    const record: { createArgs?: Record<string, unknown> } = {};
    const session = fakeSession({ record, assistantText: 'the answer' });
    const sink = collectingSink();

    const host = new NativeActivationHost({
      beadGate: NO_CONTRACT_STATE,
      loader: loaderFor(readOnlySpec()),
      beadsClient: { readBead: () => BEAD } as never,
      forensics: sink,
      loadSdk: async () => makeSdk(record, session),
      cwd: hostWorkspace(),
    });

    const handle = await host.start({
      specialist: 'researcher',
      beadId: 'ISSUE-1',
      requestedByParticipantId: 'coordinator',
    });
    const result = await handle.result;

    // Reaching here at all proves no subprocess was spawned — the mock throws.
    expect(result.status).toBe('completed');
    expect(result.output).toBe('the answer');
    expect(result.piSessionId).toBe('pi-sess-123');
    expect(handle.access).toBe('read');
  });

  it('grants the child only its resolved tool contract, with pi builtins suppressed', async () => {
    const record: { createArgs?: Record<string, unknown> } = {};
    const session = fakeSession({ record });

    const host = new NativeActivationHost({
      beadGate: NO_CONTRACT_STATE,
      loader: loaderFor(readOnlySpec()),
      beadsClient: { readBead: () => BEAD } as never,
      loadSdk: async () => makeSdk(record, session),
      cwd: hostWorkspace(),
    });

    await (await host.start({
      specialist: 'researcher', beadId: 'ISSUE-1', requestedByParticipantId: 'coordinator',
    })).result;

    const args = record.createArgs!;
    // `noTools: "builtin"` rather than `tools: []` — the latter also empties customTools.
    expect(args.noTools).toBe('builtin');

    const tools = args.tools as string[];
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
    // Acceptance G: a read-only child must not hold mutation tools.
    expect(tools).not.toContain('edit');
    expect(tools).not.toContain('write');
  });

  it('does not dispose the session when the agent settles', async () => {
    const record: { createArgs?: Record<string, unknown> } = {};
    const session = fakeSession({ record });

    const host = new NativeActivationHost({
      beadGate: NO_CONTRACT_STATE,
      loader: loaderFor(readOnlySpec()),
      beadsClient: { readBead: () => BEAD } as never,
      loadSdk: async () => makeSdk(record, session),
      cwd: hostWorkspace(),
    });

    const handle = await host.start({
      specialist: 'researcher', beadId: 'ISSUE-1', requestedByParticipantId: 'coordinator',
    });
    await handle.result;

    // A settled Specialist stays alive and resumable. Disposal is explicit only.
    expect((session as unknown as { disposed: boolean }).disposed).toBe(false);
    expect(host.inspect(handle.activationId)?.state).toBe('settled');

    await host.stop(handle.activationId);
    expect((session as unknown as { disposed: boolean }).disposed).toBe(true);
    expect(host.inspect(handle.activationId)).toBeUndefined();
  });

  it('emits admission and lifecycle forensics, including a settled event', async () => {
    const record: { createArgs?: Record<string, unknown> } = {};
    const session = fakeSession({ record });
    const sink = collectingSink();

    const host = new NativeActivationHost({
      beadGate: NO_CONTRACT_STATE,
      loader: loaderFor(readOnlySpec()),
      beadsClient: { readBead: () => BEAD } as never,
      forensics: sink,
      loadSdk: async () => makeSdk(record, session),
      cwd: hostWorkspace(),
    });

    await (await host.start({
      specialist: 'researcher', beadId: 'ISSUE-1', requestedByParticipantId: 'coordinator',
    })).result;

    expect(sink.names).toEqual(expect.arrayContaining([
      'activation_requested', 'activation_admitted', 'activation_starting',
      'activation_started', 'turn_started', 'turn_completed',
      'activation_settled', 'activation_completed',
    ]));
  });

  it('admits a write-capable Specialist now that it takes the workspace lease', async () => {
    const record: { createArgs?: Record<string, unknown> } = {};
    const session = fakeSession({ record, holdOpen: true });
    const sink = collectingSink();
    const spec = readOnlySpec();
    (spec.specialist.execution as Record<string, unknown>).permission_required = 'HIGH';

    const host = new NativeActivationHost({
      beadGate: NO_CONTRACT_STATE,
      loader: loaderFor(spec),
      beadsClient: { readBead: () => BEAD } as never,
      forensics: sink,
      loadSdk: async () => makeSdk(record, session),
      cwd: hostWorkspace(),
    });

    // Before unitAI-rrdnt.36 this asserted a blanket refusal, because the lease existed and
    // nothing acquired it. Writers are now admitted by TAKING the lease, so the refusal
    // moved from "writers are not supported" to "this workspace is held by someone else" —
    // a statement about contention rather than about a missing phase.
    const handle = await host.start({
      specialist: 'executor', beadId: 'ISSUE-1', requestedByParticipantId: 'coordinator',
    });

    expect(handle.access).toBe('write');
    expect(record.createArgs).toBeDefined();
    expect(sink.names).toContain('lease_acquired');
    expect(sink.names).not.toContain('activation_rejected');

    // Contention is now the real refusal, and it names the holder rather than a phase.
    const second = new NativeActivationHost({
      beadGate: NO_CONTRACT_STATE,
      loader: loaderFor(spec),
      beadsClient: { readBead: () => BEAD } as never,
      forensics: sink,
      loadSdk: async () => makeSdk({}, fakeSession({ record: {}, holdOpen: true })),
      cwd: handle.workspace.worktreePath,
    });

    const refusal = await second.start({
      specialist: 'executor', beadId: 'ISSUE-2', requestedByParticipantId: 'coordinator',
    }).catch((caught: unknown) => caught as DispatchRejectedError);

    expect(refusal).toBeInstanceOf(DispatchRejectedError);
    expect((refusal as DispatchRejectedError).reason).toBe('workspace_held_by_another_writer');
    expect(sink.names).toContain('lease_denied');
  });

  it('rejects an unavailable model override before creating a session', async () => {
    const record: { createArgs?: Record<string, unknown> } = {};
    const session = fakeSession({ record });
    const sink = collectingSink();

    const sdk = makeSdk(record, session);
    sdk.resolveModelScopeWithDiagnostics = () => ({
      scopedModels: [],
      diagnostics: [{ type: 'warning', code: 'no-match', message: 'No models match pattern "bogus/model"', pattern: 'bogus/model' }],
    });

    const host = new NativeActivationHost({
      beadGate: NO_CONTRACT_STATE,
      loader: loaderFor(readOnlySpec()),
      beadsClient: { readBead: () => BEAD } as never,
      forensics: sink,
      loadSdk: async () => sdk,
      cwd: hostWorkspace(),
    });

    await expect(host.start({
      specialist: 'researcher',
      beadId: 'ISSUE-1',
      requestedByParticipantId: 'coordinator',
      modelOverride: 'bogus/model',
    })).rejects.toThrow(/model_unavailable/);

    expect(record.createArgs).toBeUndefined();
    expect(sink.names).toContain('activation_rejected');
  });

  it('resolves an explicit thinking override over the definition level and records it', async () => {
    const record: { createArgs?: Record<string, unknown> } = {};
    const session = fakeSession({ record, assistantText: 'the answer' });

    const host = new NativeActivationHost({
      beadGate: NO_CONTRACT_STATE,
      loader: loaderFor(readOnlySpec({ thinking_level: 'low' })),
      beadsClient: { readBead: () => BEAD } as never,
      loadSdk: async () => makeSdk(record, session),
      cwd: hostWorkspace(),
    });

    const handle = await host.start({
      specialist: 'researcher',
      beadId: 'ISSUE-1',
      requestedByParticipantId: 'coordinator',
      thinkingOverride: 'high',
    });
    const result = await handle.result;

    expect(record.createArgs!.thinkingLevel).toBe('high');
    const snapshot = host.inspect(handle.activationId)!;
    expect(snapshot.thinkingLevel).toBe('high');
    expect(snapshot.thinkingOverride).toBe(true);
    expect(result.thinkingLevel).toBe('high');
    expect(result.thinkingOverride).toBe(true);
  });

  it('preserves the definition level when no thinking override is given', async () => {
    const record: { createArgs?: Record<string, unknown> } = {};
    const session = fakeSession({ record, assistantText: 'the answer' });

    const host = new NativeActivationHost({
      beadGate: NO_CONTRACT_STATE,
      loader: loaderFor(readOnlySpec({ thinking_level: 'low' })),
      beadsClient: { readBead: () => BEAD } as never,
      loadSdk: async () => makeSdk(record, session),
      cwd: hostWorkspace(),
    });

    const handle = await host.start({
      specialist: 'researcher',
      beadId: 'ISSUE-1',
      requestedByParticipantId: 'coordinator',
    });
    const result = await handle.result;

    expect(record.createArgs!.thinkingLevel).toBe('low');
    const snapshot = host.inspect(handle.activationId)!;
    expect(snapshot.thinkingLevel).toBe('low');
    expect(snapshot.thinkingOverride).toBe(false);
    expect(result.thinkingLevel).toBe('low');
    expect(result.thinkingOverride).toBe(false);
  });

  it('rejects an unknown thinking override before creating a session', async () => {
    const record: { createArgs?: Record<string, unknown> } = {};
    const session = fakeSession({ record });
    const sink = collectingSink();

    const host = new NativeActivationHost({
      beadGate: NO_CONTRACT_STATE,
      loader: loaderFor(readOnlySpec({ thinking_level: 'low' })),
      beadsClient: { readBead: () => BEAD } as never,
      forensics: sink,
      loadSdk: async () => makeSdk(record, session),
      cwd: hostWorkspace(),
    });

    await expect(host.start({
      specialist: 'researcher',
      beadId: 'ISSUE-1',
      requestedByParticipantId: 'coordinator',
      thinkingOverride: 'turbo' as never,
    })).rejects.toThrow(/invalid_thinking_override/);

    expect(record.createArgs).toBeUndefined();
    expect(sink.names).toContain('activation_rejected');
  });
});

describe('createActivationForensicSink', () => {
  it('routes native events through the shared timeline writer and never throws on writer failure', async () => {
    const { createActivationForensicSink } = await import('../../../src/activation/forensic-sink.js');
    const statuses: Array<Record<string, unknown>> = [];
    const rows: Array<{ jobId: string; event: Record<string, unknown>; identity: Record<string, unknown> }> = [];

    const sink = createActivationForensicSink({
      upsertStatus: (status: Record<string, unknown>) => statuses.push(status),
      upsertStatusWithEvents: (
        status: Record<string, unknown>,
        events: Record<string, unknown>[],
        identity: Record<string, unknown>,
      ) => {
        statuses.push(status);
        rows.push(...events.map(event => ({ jobId: String(status.id), event, identity })));
      },
    } as never);

    sink.emit({
      activationId: 'act:abc', attemptId: 'att:abc:1', participantId: 'specialist::researcher',
      specialist: 'researcher', beadId: 'ISSUE-1', name: 'activation_requested',
    });
    sink.emit({
      activationId: 'act:abc', attemptId: 'att:abc:1', participantId: 'specialist::researcher',
      specialist: 'researcher', beadId: 'ISSUE-1', name: 'activation_rejected', payload: { reason: 'x' },
    });

    expect(statuses).toHaveLength(2);
    expect(statuses[1]).toMatchObject({
      id: 'act:abc', specialist: 'researcher', bead_id: 'ISSUE-1', status: 'error', error: 'x',
    });
    expect(rows.map(row => row.event.type)).toEqual(['run_complete']);
    expect(rows[0]).toMatchObject({
      jobId: 'act:abc',
      identity: { attemptId: 'att:abc:1', attemptNo: 1 },
    });

    // Observability must never be the reason an activation fails.
    const exploding = createActivationForensicSink({
      upsertStatus: () => {},
      upsertStatusWithEvents: () => { throw new Error('db gone'); },
    } as never);
    expect(() => exploding.emit({
      activationId: 'a', attemptId: 'att:a:1', participantId: 'specialist::d', specialist: 'd', name: 'activation_started',
    })).not.toThrow();
    expect(() => exploding.sessionEvent?.({
      activationId: 'a', attemptId: 'att:a:1', participantId: 'specialist::d', specialist: 'd',
      piSessionId: 'pi-a', workspacePath: '/tmp/a', event: { type: 'turn_start' },
    })).not.toThrow();

    // A null client yields a no-op sink rather than throwing at construction.
    const noOp = createActivationForensicSink(null);
    expect(() => noOp.emit({
      activationId: 'a', attemptId: 'att:a:1', participantId: 'specialist::d', specialist: 'd', name: 'activation_started',
    })).not.toThrow();
    expect(() => noOp.sessionEvent?.({
      activationId: 'a', attemptId: 'att:a:1', participantId: 'specialist::d', specialist: 'd',
      piSessionId: 'pi-a', workspacePath: '/tmp/a', event: { type: 'turn_start' },
    })).not.toThrow();
  });
});

/**
 * Both cases below are regressions found by the live smoke (unitAI-rrdnt.11), not by this
 * file. The original doubles were permissive enough to pass while the real runtime failed:
 * a stub `createAgentSession` accepts any `model` value, and a stub session never reports a
 * failed turn. Each is now pinned here so the cheap suite catches it next time.
 */
describe('NativeActivationHost — defects found by the live smoke', () => {
  it('derives participant_id with the house `::` separator, the lineage join key', async () => {
    const record: { createArgs?: Record<string, unknown> } = {};
    const session = fakeSession({ record });
    const sink = collectingSink();
    const host = new NativeActivationHost({
      beadGate: NO_CONTRACT_STATE,
      loader: loaderFor(readOnlySpec()),
      beadsClient: { readBead: () => BEAD } as never,
      loadSdk: async () => makeSdk(record, session),
      forensics: sink,
      cwd: hostWorkspace(),
    });

    const handle = await host.start({
      specialist: 'researcher',
      beadId: 'ISSUE-1',
      requestedByParticipantId: 'coordinator:test',
    });
    await handle.result;

    // `orch::`, `node::` and `<container>::emitter::` all use `::`. A single colon here
    // writes a participant_id that no cross-runtime lineage query joins against.
    expect(handle.participantId).toBe('specialist::researcher');
    expect(sink.events.every(e => e.participantId === 'specialist::researcher')).toBe(true);
  });

  it('attaches a compiled StepContract to the activation and records its provenance', async () => {
    const record: { createArgs?: Record<string, unknown> } = {};
    const session = fakeSession({ record });
    const sink = collectingSink();
    const host = new NativeActivationHost({
      beadGate: NO_CONTRACT_STATE,
      loader: loaderFor(readOnlySpec()),
      beadsClient: { readBead: () => BEAD } as never,
      loadSdk: async () => makeSdk(record, session),
      forensics: sink,
      cwd: hostWorkspace(),
    });

    const handle = await host.start({
      specialist: 'researcher',
      beadId: 'ISSUE-1',
      requestedByParticipantId: 'coordinator:test',
    });
    await handle.result;

    expect(handle.stepContract.rootWorkRef).toBe('ISSUE-1');
    expect(handle.stepContract.provenance.specialist).toBe('researcher');
    expect(handle.stepContract.nonGoals).toEqual(['Does not fix the thing.']);
    expect(sink.names).toContain('step_contract_compiled');

    // Compilation is derived and creates nothing: the root ref is the Bead itself, never
    // a synthetic step id that would seed a second work graph.
    expect(handle.stepContract.rootWorkRef).toBe(handle.beadId);
  });

  it('passes the resolved pi Model object to createAgentSession, never a provider-qualified string', async () => {
    const record: { createArgs?: Record<string, unknown> } = {};
    const session = fakeSession({ record });
    const host = new NativeActivationHost({
      beadGate: NO_CONTRACT_STATE,
      loader: loaderFor(readOnlySpec()),
      beadsClient: { readBead: () => BEAD } as never,
      loadSdk: async () => makeSdk(record, session),
      cwd: hostWorkspace(),
    });

    const handle = await host.start({
      specialist: 'researcher',
      beadId: 'ISSUE-1',
      requestedByParticipantId: 'coordinator:test',
    });
    await handle.result;

    // pi's createAgentSession takes `model?: Model<any>`. A string is accepted silently and
    // then fails mid-turn with "No API key found for undefined".
    expect(record.createArgs?.model).toEqual({ id: 'test-model', provider: 'testprov' });
    expect(typeof record.createArgs?.model).not.toBe('string');
  });

  it('reports a turn that ended in error as failed, not as completed with empty output', async () => {
    const record: { createArgs?: Record<string, unknown> } = {};
    const session = fakeSession({
      record,
      assistantText: '',
      stopReason: 'error',
      errorMessage: '429: monthly usage limit reached',
    });
    const sink = collectingSink();
    const host = new NativeActivationHost({
      beadGate: NO_CONTRACT_STATE,
      loader: loaderFor(readOnlySpec()),
      beadsClient: { readBead: () => BEAD } as never,
      loadSdk: async () => makeSdk(record, session),
      forensics: sink,
      cwd: hostWorkspace(),
    });

    const handle = await host.start({
      specialist: 'researcher',
      beadId: 'ISSUE-1',
      requestedByParticipantId: 'coordinator:test',
    });
    const result = await handle.result;

    expect(result.status).toBe('failed');
    expect(result.validation.valid).toBe(false);
    expect(result.validation.errors?.[0]).toContain('429');
    expect(sink.names).toContain('activation_failed');
    expect(sink.names).not.toContain('activation_completed');
  });
});

/**
 * unitAI-rrdnt.27. The Phase 7 parity lane produces timeline rows from the RAW event
 * stream, so the hook must offer every event — including the types the switch does not
 * translate — and must stay optional so existing sinks are unaffected.
 */
describe('NativeActivationHost — raw session event hook', () => {
  it('offers every raw event to sessionEvent, including untranslated types', async () => {
    const record: { createArgs?: Record<string, unknown> } = {};
    const session = fakeSession({ record });
    const raw: string[] = [];
    const sink: ActivationForensicSink = {
      emit: () => {},
      sessionEvent: (input) => { raw.push(String(input.event.type)); },
    };

    const host = new NativeActivationHost({
      beadGate: NO_CONTRACT_STATE,
      loader: loaderFor(readOnlySpec()),
      beadsClient: { readBead: () => BEAD } as never,
      loadSdk: async () => makeSdk(record, session),
      forensics: sink,
      cwd: hostWorkspace(),
    });

    const handle = await host.start({
      specialist: 'researcher',
      beadId: 'ISSUE-1',
      requestedByParticipantId: 'coordinator:test',
    });
    await handle.result;

    // `some_unmapped_event` has no case in the switch — the translated path drops it and
    // the raw path must not, or Phase 7 cannot reach parity with the legacy runner.
    session.emit({ type: 'some_unmapped_event' } as never);

    expect(raw).toContain('agent_start');
    expect(raw).toContain('agent_end');
    expect(raw).toContain('agent_settled');
    expect(raw).toContain('some_unmapped_event');
  });

  it('carries the activation identity needed to attribute a raw event', async () => {
    const record: { createArgs?: Record<string, unknown> } = {};
    const session = fakeSession({ record });
    const seen: Array<Record<string, unknown>> = [];
    const host = new NativeActivationHost({
      beadGate: NO_CONTRACT_STATE,
      loader: loaderFor(readOnlySpec()),
      beadsClient: { readBead: () => BEAD } as never,
      loadSdk: async () => makeSdk(record, session),
      forensics: { emit: () => {}, sessionEvent: (i) => { seen.push(i as never); } },
      cwd: hostWorkspace(),
    });

    const handle = await host.start({
      specialist: 'researcher',
      beadId: 'ISSUE-1',
      requestedByParticipantId: 'coordinator:test',
    });
    await handle.result;

    expect(seen[0]).toMatchObject({
      activationId: handle.activationId,
      participantId: 'specialist::researcher',
      specialist: 'researcher',
      beadId: 'ISSUE-1',
      piSessionId: 'pi-sess-123',
    });
  });

  it('works with a sink that has no sessionEvent, so existing sinks are unaffected', async () => {
    const record: { createArgs?: Record<string, unknown> } = {};
    const session = fakeSession({ record });
    const host = new NativeActivationHost({
      beadGate: NO_CONTRACT_STATE,
      loader: loaderFor(readOnlySpec()),
      beadsClient: { readBead: () => BEAD } as never,
      loadSdk: async () => makeSdk(record, session),
      forensics: collectingSink(),
      cwd: hostWorkspace(),
    });

    const handle = await host.start({
      specialist: 'researcher',
      beadId: 'ISSUE-1',
      requestedByParticipantId: 'coordinator:test',
    });

    await expect(handle.result).resolves.toMatchObject({ status: 'completed' });
  });
});

describe('snapshot tokenUsage (unitAI-crjh7)', () => {
  it('populates snapshot.tokenUsage from the nested message.usage short-key shape', async () => {
    const record: { createArgs?: Record<string, unknown> } = {};
    const session = fakeSession({ record, holdOpen: true });
    const host = new NativeActivationHost({
      beadGate: NO_CONTRACT_STATE,
      loader: loaderFor(readOnlySpec()),
      beadsClient: { readBead: () => BEAD } as never,
      loadSdk: async () => makeSdk(record, session),
      forensics: { emit: () => {} },
      cwd: hostWorkspace(),
    });

    const handle = await host.start({
      specialist: 'researcher',
      beadId: 'ISSUE-1',
      requestedByParticipantId: 'coordinator:test',
    });

    expect(host.inspect(handle.activationId)?.tokenUsage).toBeUndefined();

    // Realistic message_end: usage nests under event.message with short keys, and no
    // top-level token_usage/tokenUsage/usage exists — the shape the old extractor read.
    session.emit({
      type: 'message_end',
      message: {
        role: 'assistant', provider: 'provider', model: 'model', stopReason: 'stop',
        usage: { input: 12000, output: 1500, cacheWrite: 200, cacheRead: 100, reasoning: 52, totalTokens: 13852 },
        content: [{ type: 'text', text: 'answer' }],
      },
    } as never);

    expect(host.inspect(handle.activationId)?.tokenUsage).toEqual({
      input_tokens: 12000,
      output_tokens: 1500,
      cache_creation_tokens: 200,
      cache_read_tokens: 100,
      reasoning_tokens: 52,
      total_tokens: 13852,
    });
    expect(host.liveStats(handle.activationId)?.token_usage?.total_tokens).toBe(13852);
  });

  it('accumulates per-message counts monotonically across interleaved usage/no-usage events (unitAI-beqby.12)', async () => {
    const record: { createArgs?: Record<string, unknown> } = {};
    const session = fakeSession({ record, holdOpen: true });
    const host = new NativeActivationHost({
      beadGate: NO_CONTRACT_STATE,
      loader: loaderFor(readOnlySpec()),
      beadsClient: { readBead: () => BEAD } as never,
      loadSdk: async () => makeSdk(record, session),
      forensics: { emit: () => {} },
      cwd: hostWorkspace(),
    });

    const handle = await host.start({
      specialist: 'researcher',
      beadId: 'ISSUE-1',
      requestedByParticipantId: 'coordinator:test',
    });
    const totals = () => {
      const usage = host.inspect(handle.activationId)?.tokenUsage;
      return ['input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens', 'reasoning_tokens', 'tool_tokens']
        .reduce((n, k) => n + ((usage as Record<string, number> | undefined)?.[k] ?? 0), 0);
    };
    const assistantEnd = (usage?: Record<string, number>) => ({
      type: 'message_end',
      message: {
        role: 'assistant', provider: 'provider', model: 'model', stopReason: 'stop',
        ...(usage ? { usage } : {}),
        content: [{ type: 'text', text: 'answer' }],
      },
    } as never);

    // First message: large context load, as seen live.
    session.emit(assistantEnd({ input: 15798, output: 118, cacheWrite: 0, cacheRead: 0, reasoning: 7, totalTokens: 15916 }));
    expect(totals()).toBe(15923);

    // Interleaved events with no usage (tool traffic, streaming updates, user echo)
    // must leave the total untouched — this is the flap window.
    session.emit({ type: 'tool_execution_start', toolName: 'grep' } as never);
    session.emit({ type: 'message_update', message: { role: 'assistant', content: [] } } as never);
    session.emit(assistantEnd());
    session.emit({ type: 'agent_end', willRetry: false } as never);
    expect(totals()).toBe(15923);

    // Second message is small with cache hits; the old spread-merge replaced the
    // total with these per-message counts and the row visibly dropped.
    session.emit(assistantEnd({ input: 303, output: 120, cacheWrite: 0, cacheRead: 15729, reasoning: 0, totalTokens: 16152 }));
    expect(totals()).toBe(15923 + 16152);
    expect(host.liveStats(handle.activationId)?.token_usage?.input_tokens).toBe(15798 + 303);
  });
});

/**
 * unitAI-rrdnt.40. `reject()` takes `Record<string, unknown>`, so passing a key that
 * `DispatchRejectedError` does not render compiles cleanly and the explanation is dropped.
 * Four call sites had drifted onto `detail:` when the only free-text field is `note:`.
 *
 * These assert on the RENDERED message, which is the whole point. A test that checked the
 * object handed to `reject()` would have passed for as long as the defect existed — the
 * object was always right; the rendering discarded it.
 */
describe('dispatch refusals carry their explanation', () => {
  it('names the draft state when a contract:draft bead is refused', async () => {
    const spec = readOnlySpec();
    const host = new NativeActivationHost({
      beadGate: { readContractState: () => 'draft' },
      loader: loaderFor(spec),
      beadsClient: { readBead: () => BEAD } as never,
      loadSdk: async () => makeSdk({}, fakeSession({ record: {} })),
      cwd: hostWorkspace(),
    });

    const error = await host.start({
      specialist: 'reader', beadId: 'ISSUE-1', requestedByParticipantId: 'coordinator',
    }).catch((caught: unknown) => caught as DispatchRejectedError);

    expect(error).toBeInstanceOf(DispatchRejectedError);
    // Without this, the operator sees `reason: bead_contract_incomplete` and nothing else —
    // for a bead whose seven sections are all present and correct.
    expect(String((error as Error).message)).toMatch(/draft/i);
  });

  it('renders the provider explanation when a model cannot be resolved', async () => {
    const spec = readOnlySpec();
    const host = new NativeActivationHost({
      beadGate: NO_CONTRACT_STATE,
      loader: loaderFor(spec),
      beadsClient: { readBead: () => BEAD } as never,
      loadSdk: async () => ({
        ...makeSdk({}, fakeSession({ record: {} })),
        resolveModelScopeWithDiagnostics: () => ({
          scopedModels: [],
          diagnostics: [{ kind: 'no-match', requested: 'nowhere/nothing' }],
        }),
      }) as never,
      cwd: hostWorkspace(),
    });

    const error = await host.start({
      specialist: 'reader',
      beadId: 'ISSUE-1',
      requestedByParticipantId: 'coordinator',
      execution: { model: 'nowhere/nothing' },
    } as never).catch((caught: unknown) => caught as DispatchRejectedError);

    expect(error).toBeInstanceOf(DispatchRejectedError);
    const message = String((error as Error).message);
    expect(message).toContain('reason:');
    // The refusal must say something beyond its reason code, or the gate is unhelpful.
    expect(message).toMatch(/note:/);
  });
});

/**
 * PRD §52, unitAI-rrdnt.7. The guard must be a per-CALL verdict, not a tool-set change:
 * within a turn the agent loop runs against a snapshot taken at turn start, so revoking a
 * tool cannot cancel a call that is already planned. Every handler in a batch fires before
 * any execution, so a block is enforceable exactly where `setActiveToolsByName` is not.
 */
describe('per-call mutation admission', () => {
  it('lets the lease holder mutate and refuses a reader the same call', async () => {
    const writerSpec = readOnlySpec();
    (writerSpec.specialist.execution as Record<string, unknown>).permission_required = 'HIGH';
    const sink = collectingSink();

    const writerHost = new NativeActivationHost({
      beadGate: NO_CONTRACT_STATE,
      loader: loaderFor(writerSpec),
      beadsClient: { readBead: () => BEAD } as never,
      forensics: sink,
      loadSdk: async () => makeSdk({}, fakeSession({ record: {}, holdOpen: true })),
      cwd: hostWorkspace(),
    });

    const writer = await writerHost.start({
      specialist: 'executor', beadId: 'ISSUE-1', requestedByParticipantId: 'coordinator',
    });

    // The holder may mutate; a non-mutating call is never gated at all.
    expect(writerHost.admitToolCall(writer.activationId, 'write').allow).toBe(true);
    expect(writerHost.admitToolCall(writer.activationId, 'read').allow).toBe(true);

    // A READER in the same workspace holds no lease, because it is not entitled to one.
    // Refusing it is the capability grant being enforced, not an error state.
    const readerHost = new NativeActivationHost({
      beadGate: NO_CONTRACT_STATE,
      loader: loaderFor(readOnlySpec()),
      beadsClient: { readBead: () => BEAD } as never,
      forensics: sink,
      loadSdk: async () => makeSdk({}, fakeSession({ record: {}, holdOpen: true })),
      cwd: writer.workspace.worktreePath,
    });
    const reader = await readerHost.start({
      specialist: 'reader', beadId: 'ISSUE-2', requestedByParticipantId: 'coordinator',
    });

    const verdict = readerHost.admitToolCall(reader.activationId, 'write');
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toContain('write');
    expect(sink.names).toContain('tool_blocked');

    // Reading is untouched: readers coexist with a writer (acceptance T).
    expect(readerHost.admitToolCall(reader.activationId, 'read').allow).toBe(true);
  });

  it('refuses an unknown activation rather than defaulting to allow', async () => {
    const host = new NativeActivationHost({
      beadGate: NO_CONTRACT_STATE,
      loader: loaderFor(readOnlySpec()),
      beadsClient: { readBead: () => BEAD } as never,
      loadSdk: async () => makeSdk({}, fakeSession({ record: {} })),
      cwd: hostWorkspace(),
    });

    // Fail closed. An activation this host does not know is not one it can vouch for.
    expect(host.admitToolCall('act:does-not-exist', 'write').allow).toBe(false);
  });
});

/**
 * unitAI-rrdnt.43. `tools` is a hard filter on pi 0.85.1 and it applies to `customTools`
 * too, so the ask tools have to be NAMED in the allowlist as well as supplied. Before the
 * fix, `customTools: [ask_coordinator]` with `tools: ['read']` produced a session whose
 * tool set was exactly `['read']` — silently, with no error and no diagnostic. No
 * Specialist could ever reach its coordinator.
 *
 * This asserts on what is REQUESTED, which is the most a double can see; the SDK-side
 * behaviour is proven by a live probe recorded on the bead. The complementary trap is
 * worth stating: a test that only checked `customTools` was passed would have been green
 * for the entire life of the defect, because that argument was always correct.
 */
describe('ask tools reach the child', () => {
  it('names both ask tools in the allowlist without widening it', async () => {
    const record: { createArgs?: Record<string, unknown> } = {};
    const host = new NativeActivationHost({
      beadGate: NO_CONTRACT_STATE,
      loader: loaderFor(readOnlySpec()),
      beadsClient: { readBead: () => BEAD } as never,
      loadSdk: async () => makeSdk(record, fakeSession({ record })),
      cwd: hostWorkspace(),
    });

    await host.start({
      specialist: 'reader', beadId: 'ISSUE-1', requestedByParticipantId: 'coordinator',
    });

    const tools = (record.createArgs?.tools ?? []) as string[];
    expect(tools).toContain('ask_coordinator');
    expect(tools).toContain('escalate_to_coordinator');

    // Asking is not a workspace operation. A read-only Specialist gains the ability to ask
    // and gains no mutation capability — widening the allowlist to admit the ask tools must
    // not smuggle an edit tool in with them.
    for (const forbidden of ['bash', 'edit', 'write', 'powershell']) {
      expect(tools).not.toContain(forbidden);
    }

    // And they are still supplied as custom tools: naming them is necessary, not sufficient.
    const custom = (record.createArgs?.customTools ?? []) as Array<{ name: string }>;
    expect(custom.map(t => t.name).sort()).toEqual(['ask_coordinator', 'escalate_to_coordinator']);
  });
});

describe('PRD acceptance Z — a resume conflict is refused (unitAI-rrdnt.36)', () => {
  it('refuses to resume a settled writer whose workspace another writer took', async () => {
    // Z was structurally UNREACHABLE until unitAI-rrdnt.59: while the lease was held until
    // explicit disposal, a resuming activation still held its own lease and could never
    // contend. The lease now releases on settle and resume() reacquires, so a settled writer
    // CAN lose its workspace — and its resume must then be refused.
    //
    // The model session is faked; the LEASE IS REAL, a file store under
    // <workspace>/.specialists/leases/. Faking it would assert the fixture, not the system.
    const spec = readOnlySpec();
    (spec.specialist.execution as Record<string, unknown>).permission_required = 'HIGH';
    const shared = hostWorkspace();

    const hostA = new NativeActivationHost({
      beadGate: NO_CONTRACT_STATE,
      loader: loaderFor(spec),
      beadsClient: { readBead: () => BEAD } as never,
      forensics: collectingSink(),
      loadSdk: async () => makeSdk({}, fakeSession({ record: {} })),
      cwd: shared,
    });
    const a = await hostA.start({
      specialist: 'executor', beadId: 'ISSUE-1', requestedByParticipantId: 'coordinator',
    });
    await a.result.catch(() => undefined);
    expect(a.access).toBe('write');

    // B takes the freed workspace. Under hold-until-disposal this dispatch was REFUSED,
    // which is precisely why Z could never occur.
    const sinkB = collectingSink();
    const hostB = new NativeActivationHost({
      beadGate: NO_CONTRACT_STATE,
      loader: loaderFor(spec),
      beadsClient: { readBead: () => BEAD } as never,
      forensics: sinkB,
      loadSdk: async () => makeSdk({}, fakeSession({ record: {}, holdOpen: true })),
      cwd: a.workspace.worktreePath,
    });
    const b = await hostB.start({
      specialist: 'executor', beadId: 'ISSUE-1', requestedByParticipantId: 'coordinator',
    });
    expect(sinkB.names).toContain('lease_acquired');
    expect(b.activationId).not.toBe(a.activationId);

    const refusal = await hostA.resume(a.activationId, 'carry on')
      .catch((caught: unknown) => caught as DispatchRejectedError);

    expect(refusal).toBeInstanceOf(DispatchRejectedError);
    expect((refusal as DispatchRejectedError).reason).toBe('workspace_held_by_another_writer');

    // A refused resume leaves the activation exactly as it was — still settled, still
    // resumable if the workspace frees later. A half-advanced resume is worse than a failed one.
    expect(hostA.inspect(a.activationId)?.state).toBe('settled');
    expect(hostA.inspect(a.activationId)?.attemptId).toBe(a.attemptId);
  });
});
