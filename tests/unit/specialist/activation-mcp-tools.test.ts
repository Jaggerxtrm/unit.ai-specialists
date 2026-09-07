import { describe, it, expect, vi } from 'vitest';

/**
 * The MCP path must never reach for a subprocess — that is the entire point of Phase 13,
 * and "no sp was spawned" is a claim about the system rather than about intent. `spawn` is
 * replaced with a throwing stub rather than a spy, so a regression to the `sp run`
 * boundary fails at the call site instead of passing and reporting a count afterwards.
 * This is the in-process half of the evidence; the process-table half is in
 * tests/integration/activation/mcp-activation.live.test.ts, because a mock cannot prove
 * the absence of a child this process never asked for.
 */
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      throw new Error(`MCP dispatch must not spawn a subprocess; got spawn(${String(args[0])})`);
    },
  };
});

import {
  createSpecialistDispatchTool,
  createSpecialistReplyTool,
  createSpecialistStopActivationTool,
  toActivationView,
} from '../../../src/tools/specialist/activation.tool.js';
import { createSpecialistStatusTool } from '../../../src/tools/specialist/specialist_status.tool.js';
import { NativeActivationHost } from '../../../src/activation/native-host.js';
import { REQUIRED_SECTIONS } from '../../../src/activation/bead-gate.js';
import { CircuitBreaker } from '../../../src/utils/circuitBreaker.js';
import type { PiSdk, PiAgentSessionLike, PiAgentSessionEvent } from '../../../src/activation/pi-sdk.js';

/**
 * PRD Phase 13 — the MCP frontend over NativeActivationHost.
 *
 * These tests exist to prove ONE property that a green suite does not otherwise give you:
 * that the MCP path is the same admission path, not a second one. Every gate assertion
 * below drives a REAL `NativeActivationHost` through the real tool `execute`, with only
 * the Pi SDK and the bead reader faked. A test that stubbed the host would prove the tool
 * calls a method, which is not the claim — the claim is that a gate the CLI enforces is
 * still enforced when the caller is Claude Code.
 *
 * The live no-subprocess evidence for acceptance AV is deliberately NOT here; a unit test
 * cannot prove the absence of a `sp` child. See
 * tests/integration/activation/mcp-activation.live.test.ts.
 */

const NO_STATE = { readContractState: () => undefined };

function contract(extra = 'SCRUTINY\nLOW — routine.') {
  const bodies: Record<string, string> = {
    PROBLEM: 'The thing is unclear.',
    SUCCESS: 'The thing is clear.',
    SCOPE: 'Investigate the thing.',
    NON_GOALS: 'Does not fix the thing.',
    CONSTRAINTS: 'Read-only.',
    VALIDATION: 'A written finding.',
    OUTPUT: 'A finding.',
  };
  const lines: string[] = [];
  for (const section of REQUIRED_SECTIONS) lines.push(section, bodies[section] ?? '', '');
  lines.push(extra);
  return { id: 'ISSUE-1', title: 'A task', status: 'open', description: lines.join('\n') };
}

interface HostFixture {
  bead?: unknown;
  permission?: string;
  readContractState?: () => string | undefined;
}

/**
 * A real host over a fake Pi SDK.
 *
 * `sessionsCreated` is the unit-level stand-in for "did anything actually start": every
 * refusal below must leave it at zero, which is the in-process shadow of the process-table
 * assertion the live test makes.
 */
function fakeSession(): PiAgentSessionLike {
  const listeners: Array<(e: PiAgentSessionEvent) => void> = [];
  const messages: unknown[] = [];
  const session = {
    sessionId: 'pi-sess-mcp',
    messages,
    isIdle: true,
    disposed: false,
    activeTools: ['read', 'grep'],
    async prompt() {
      listeners.forEach(l => l({ type: 'agent_start' }));
      messages.push({ role: 'assistant', content: 'done' });
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
  return session as unknown as PiAgentSessionLike;
}

function hostWith(fixture: HostFixture = {}) {
  const sessionsCreated = { count: 0 };
  const session = fakeSession();
  const sdk: PiSdk = {
    createAgentSession: async () => { sessionsCreated.count += 1; return { session }; },
    ModelRuntime: { create: async () => ({ hasConfiguredAuth: () => true }) },
    resolveModelScopeWithDiagnostics: () => ({
      scopedModels: [{ model: { id: 'test-model', provider: 'testprov' } }],
      diagnostics: [],
    }),
    defineTool: (d) => d,
  };
  const events: string[] = [];
  const host = new NativeActivationHost({
    beadGate: fixture.readContractState ? { readContractState: fixture.readContractState } : NO_STATE,
    loader: { get: async () => ({
      specialist: {
        metadata: { name: 'researcher', version: '1.0.0', description: 'd', category: 'c' },
        execution: {
          model: 'testprov/test-model',
          permission_required: fixture.permission ?? 'READ_ONLY',
          response_format: 'text',
          output_type: 'research',
          bare: false,
        },
        prompt: { system: 'You are the researcher.', task_template: 'Do: {{bead_id}}' },
      },
    }) } as never,
    beadsClient: { readBead: () => fixture.bead ?? contract() } as never,
    loadSdk: async () => sdk,
    forensics: { emit: (e) => { events.push(e.name); } },
    cwd: process.cwd(),
  });
  return { host, events, sessionsCreated };
}

describe('specialist_dispatch — the MCP dispatch path is the same admission path', () => {
  it('dispatches a Specialist and returns the activation, not a result', async () => {
    const { host, sessionsCreated } = hostWith();
    const tool = createSpecialistDispatchTool(() => host);

    const out = await tool.execute({ specialist: 'researcher', bead_id: 'ISSUE-1' }) as Record<string, unknown>;

    expect(out.status).toBe('dispatched');
    expect(out.activation_id).toMatch(/^act:/);
    expect(out.specialist).toBe('researcher');
    expect(out.bead_id).toBe('ISSUE-1');
    expect(sessionsCreated.count).toBe(1);

    // PRD acceptance AU: a validated ActivationResult and an interaction message are
    // different things. This tool returns NEITHER — it returns the activation's identity
    // and state, because it returns as soon as the child is admitted and started. A tool
    // that blocked until an ActivationResult existed would deadlock the first
    // clarification: the coordinator cannot answer a question it is blocked waiting on.
    expect(out).not.toHaveProperty('result');
    expect(out).not.toHaveProperty('output');
  });

  it('REFUSES a draft-contract bead exactly as the CLI path does', async () => {
    const { host, sessionsCreated, events } = hostWith({ readContractState: () => 'draft' });
    const tool = createSpecialistDispatchTool(() => host);

    const out = await tool.execute({ specialist: 'researcher', bead_id: 'ISSUE-1' }) as Record<string, unknown>;

    expect(out.status).toBe('rejected');
    expect(String(out.reason)).toContain('SPECIALIST_DISPATCH_REJECTED');
    // The gate refuses BEFORE a session exists. This is the property, not the message.
    expect(String(out.reason)).toContain('AgentSession:\n  not created');

    // The draft-specific explanation survives in `detail` but NOT in the rendered block.
    // `native-host.ts` passes `{ detail: readiness.reason }` into a detail object whose
    // only free-text field is `note`, so the renderer drops it; `reject`'s parameter is
    // Record<string, unknown>, which is why the compiler does not object. The rendered
    // refusal therefore reads "bead_contract_incomplete" with no missing sections — for a
    // bead whose sections are all present — which is the least actionable form the gate
    // could take. Asserted as it BEHAVES, not as it should behave. Fix proposed to the
    // native-host.ts owner (one-word change, `detail:` -> `note:`, five call sites);
    // when it lands, the `note` expectation below replaces the negative one.
    expect((out.detail as Record<string, unknown>).detail).toContain('draft');
    expect(String(out.reason)).not.toContain('draft');
    expect(sessionsCreated.count).toBe(0);
    expect(events).toContain('activation_rejected');
    expect(events).not.toContain('activation_admitted');
  });

  it('names the missing sections of an incomplete contract, so the refusal is actionable', async () => {
    const thin = { id: 'ISSUE-1', title: 'thin', status: 'open', description: 'PROBLEM\nx' };
    const { host, sessionsCreated } = hostWith({ bead: thin });
    const tool = createSpecialistDispatchTool(() => host);

    const out = await tool.execute({ specialist: 'researcher', bead_id: 'ISSUE-1' }) as Record<string, unknown>;

    expect(out.status).toBe('rejected');
    expect((out.detail as Record<string, unknown>).missing).toEqual(
      expect.arrayContaining(['SUCCESS', 'SCOPE', 'NON_GOALS', 'CONSTRAINTS', 'VALIDATION', 'OUTPUT']),
    );
    expect(sessionsCreated.count).toBe(0);
  });

  it('surfaces a refusal as a structured RESULT, never as an opaque MCP error', async () => {
    const { host } = hostWith({ readContractState: () => 'draft' });
    const tool = createSpecialistDispatchTool(() => host);

    // A thrown DispatchRejectedError would reach Claude as an error string and lose
    // `detail`, which is the part an operator acts on.
    await expect(tool.execute({ specialist: 'researcher', bead_id: 'ISSUE-1' })).resolves.toBeDefined();
  });

  /**
   * Writer-ready, per the Phase 13 / Phase 10 boundary.
   *
   * Writers are refused by `native-host.ts` today (`writer_not_supported_in_phase_1`), and
   * enabling them is unitAI-rrdnt.36. This test asserts the MCP path passes that refusal
   * through untouched rather than filtering write-capable Specialists out itself — so when
   * Phase 10 flips the single admission decision, there is no second dispatch path that
   * also needs teaching. When .36 lands, this expectation inverts into a lease assertion.
   */
  it('passes the writer refusal through rather than filtering writers itself', async () => {
    const { host, sessionsCreated } = hostWith({ permission: 'HIGH' });
    const tool = createSpecialistDispatchTool(() => host);

    const out = await tool.execute({ specialist: 'researcher', bead_id: 'ISSUE-1' }) as Record<string, unknown>;

    expect(out.status).toBe('rejected');
    expect(String(out.reason)).toContain('writer_not_supported_in_phase_1');
    expect(sessionsCreated.count).toBe(0);
  });
});

describe('specialist_status — an MCP activation reads back identically', () => {
  it('projects the host Fleet, so the reader need not know which transport dispatched', async () => {
    const { host } = hostWith();
    const dispatch = createSpecialistDispatchTool(() => host);
    const status = createSpecialistStatusTool(
      { list: async () => [] } as never,
      new CircuitBreaker(),
      () => host,
    );

    const dispatched = await dispatch.execute({ specialist: 'researcher', bead_id: 'ISSUE-1' }) as Record<string, unknown>;
    const out = await status.execute({}) as Record<string, unknown>;
    const activations = out.activations as Record<string, unknown>[];

    expect(activations).toHaveLength(1);
    expect(activations[0].activation_id).toBe(dispatched.activation_id);

    // VALIDATION 4 is an IDENTITY claim, so assert identity: what status reports is the
    // host's own snapshot projected by the same function, not a shape invented for MCP.
    expect(activations[0]).toEqual(toActivationView(host.list()[0]));
  });

  it('reports an empty Fleet rather than failing when no host is wired', async () => {
    const status = createSpecialistStatusTool({ list: async () => [] } as never, new CircuitBreaker());
    const out = await status.execute({}) as Record<string, unknown>;

    expect(out.activations).toEqual([]);
    expect(out.pending_asks).toEqual([]);
  });
});

describe('specialist_reply — correlation is by message id and nothing else', () => {
  it('reports an unknown message id instead of silently accepting the answer', async () => {
    const { host } = hostWith();
    const tool = createSpecialistReplyTool(() => host);

    const out = await tool.execute({ message_id: 'msg:nope', body: 'an answer' }) as Record<string, unknown>;

    expect(out.status).toBe('error');
    expect(String(out.error)).toContain('msg:nope');
  });
});

describe('specialist_stop_activation', () => {
  it('reports an unknown activation rather than reporting a successful stop', async () => {
    const { host } = hostWith();
    const tool = createSpecialistStopActivationTool(() => host);

    const out = await tool.execute({ activation_id: 'act:nope' }) as Record<string, unknown>;

    expect(out.status).toBe('error');
  });

  it('stops a dispatched activation and removes it from the Fleet', async () => {
    const { host } = hostWith();
    const dispatch = createSpecialistDispatchTool(() => host);
    const stop = createSpecialistStopActivationTool(() => host);

    const dispatched = await dispatch.execute({ specialist: 'researcher', bead_id: 'ISSUE-1' }) as Record<string, unknown>;
    const out = await stop.execute({ activation_id: String(dispatched.activation_id) }) as Record<string, unknown>;

    expect(out.status).toBe('stopped');
    expect(host.list()).toHaveLength(0);
  });
});
