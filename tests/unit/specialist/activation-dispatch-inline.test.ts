import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * MCP dispatch mirror for contract/title/epic_context_depth (unitAI-t2kol.5).
 *
 * The inline path is tool + shared gate + shared bead-creation helper + real host:
 * `createBeadFromContract` is the ONLY seam (mocked — it is the `bd create` side
 * effect, and "refused dispatch leaves the board unchanged" is asserted as
 * "the helper was never called"). Everything else is real: the zod schema, the
 * execute mutual-exclusion checks, `evaluateBeadReadiness`, and
 * `NativeActivationHost.start` with only the Pi SDK and the bead reader faked
 * (same fixture shape as activation-mcp-tools.test.ts).
 */

const { mockCreateBead } = vi.hoisted(() => ({ mockCreateBead: vi.fn() }));

vi.mock('../../../src/specialist/beads.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/specialist/beads.js')>();
  return { ...actual, createBeadFromContract: mockCreateBead };
});

import {
  createSpecialistDispatchTool,
  specialistDispatchSchema,
} from '../../../src/tools/specialist/activation.tool.js';
import { NativeActivationHost } from '../../../src/activation/native-host.js';
import { REQUIRED_SECTIONS } from '../../../src/activation/bead-gate.js';
import type { PiSdk, PiAgentSessionLike, PiAgentSessionEvent } from '../../../src/activation/pi-sdk.js';

const NO_STATE = { readContractState: () => undefined };

const INLINE_CONTRACT =
  'PROBLEM\nProve the inline-dispatch path.\n\nSUCCESS\nA read-only activation settles.\n\n' +
  'SCOPE\nRead-only.\n\nNON_GOALS\nNo writes.\n\nCONSTRAINTS\nRead-only.\n\n' +
  'VALIDATION\nOutput confirms.\n\nOUTPUT\nA short report.\n\nSCRUTINY LOW';

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

function fakeSession(): PiAgentSessionLike {
  const listeners: Array<(e: PiAgentSessionEvent) => void> = [];
  const messages: unknown[] = [];
  const session = {
    sessionId: 'pi-sess-mcp-inline',
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

const workspaces: string[] = [];
afterEach(() => {
  while (workspaces.length > 0) {
    rmSync(workspaces.pop() as string, { recursive: true, force: true });
  }
});

function hostWith(fixture: { bead?: unknown; permission?: string } = {}) {
  const sessionsCreated = { count: 0 };
  const root = mkdtempSync(join(tmpdir(), 'mcp-inline-ws-'));
  workspaces.push(root);
  const session = fakeSession();
  const sdk: PiSdk = {
    createAgentSession: async () => { sessionsCreated.count += 1; return { session }; },
    ModelRuntime: { create: async () => ({ hasConfiguredAuth: () => true }) },
    resolveModelScopeWithDiagnostics: () => ({
      scopedModels: [{ model: { id: 'test-model', provider: 'testprov' } }],
      diagnostics: [],
    }),
    defineTool: (d) => d,
    createEditTool: () => ({ name: 'edit', execute: async () => 'edited' }),
    createWriteTool: () => ({ name: 'write', execute: async () => 'written' }),
    createBashTool: () => ({ name: 'bash', execute: async () => 'ran' }),
    createPowerShellTool: () => ({ name: 'powershell', execute: async () => 'ran' }),
  } as unknown as PiSdk;
  const host = new NativeActivationHost({
    beadGate: NO_STATE,
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
    forensics: { emit: () => {} },
    cwd: root,
  });
  return { host, sessionsCreated };
}

beforeEach(() => {
  mockCreateBead.mockReset();
  mockCreateBead.mockReturnValue('bd-inline-1');
});

describe('specialist_dispatch schema — contract/title/epic_context_depth mirror Pi', () => {
  it('bead_id is optional and the inline fields exist with Pi-matching descriptions', () => {
    const shape = specialistDispatchSchema.shape;
    expect(shape.bead_id.isOptional()).toBe(true);
    expect(shape.contract.isOptional()).toBe(true);
    expect(shape.title.isOptional()).toBe(true);
    expect(shape.epic_context_depth.isOptional()).toBe(true);
    expect(String(shape.contract.description)).toContain('SAME readiness gate');
    expect(String(shape.title.description)).toContain('derived from PROBLEM');
    expect(String(shape.epic_context_depth.description)).toContain('## Epic lineage');
    expect(String(shape.bead_id.description)).toContain('exactly one of bead_id');
  });
});

describe('specialist_dispatch inline path — one gate, create only after it passes', () => {
  it('refuses bead_id plus contract instead of picking a precedence', async () => {
    const { host, sessionsCreated } = hostWith();
    const tool = createSpecialistDispatchTool(() => host);

    const out = await tool.execute({
      specialist: 'researcher', bead_id: 'ISSUE-1', contract: INLINE_CONTRACT,
    }) as Record<string, unknown>;

    expect(out.status).toBe('rejected');
    expect(String(out.reason)).toContain('both bead_id and contract were provided');
    expect(mockCreateBead).not.toHaveBeenCalled();
    expect(sessionsCreated.count).toBe(0);
  });

  it('refuses neither bead_id nor contract', async () => {
    const { host, sessionsCreated } = hostWith();
    const tool = createSpecialistDispatchTool(() => host);

    const out = await tool.execute({ specialist: 'researcher' }) as Record<string, unknown>;

    expect(out.status).toBe('rejected');
    expect(String(out.reason)).toContain('neither bead_id nor contract');
    expect(mockCreateBead).not.toHaveBeenCalled();
    expect(sessionsCreated.count).toBe(0);
  });

  it('refuses epic_context_depth outside 1|2 without dispatching', async () => {
    const { host, sessionsCreated } = hostWith();
    const tool = createSpecialistDispatchTool(() => host);

    for (const bad of [0, 3, -1, 1.5]) {
      const out = await tool.execute({
        specialist: 'researcher', bead_id: 'ISSUE-1', epic_context_depth: bad,
      }) as Record<string, unknown>;
      expect(out.status).toBe('rejected');
      expect(String(out.reason)).toContain('epic_context_depth must be 1 or 2');
    }
    expect(mockCreateBead).not.toHaveBeenCalled();
    expect(sessionsCreated.count).toBe(0);
  });

  it('gate runs BEFORE creating the bead: a draft inline contract leaves the board unchanged', async () => {
    const { host, sessionsCreated } = hostWith();
    const tool = createSpecialistDispatchTool(() => host);

    const out = await tool.execute({
      specialist: 'researcher', contract: 'PROBLEM\nMissing everything else.',
    }) as Record<string, unknown>;

    expect(out.status).toBe('rejected');
    expect(out.missing).toContain('SUCCESS');
    expect(out.missing).not.toContain('PROBLEM');
    expect(mockCreateBead).not.toHaveBeenCalled();
    expect(sessionsCreated.count).toBe(0);

    // All seven sections present but no SCRUTINY: refused with SCRUTINY missing.
    const noScrutiny = await tool.execute({
      specialist: 'researcher',
      contract: 'PROBLEM\np\n\nSUCCESS\ns\n\nSCOPE\nsc\n\nNON_GOALS\nng\n\nCONSTRAINTS\nc\n\nVALIDATION\nv\n\nOUTPUT\no',
    }) as Record<string, unknown>;
    expect(noScrutiny.status).toBe('rejected');
    expect(noScrutiny.missing).toEqual(['SCRUTINY']);
    expect(mockCreateBead).not.toHaveBeenCalled();
  });

  it('valid inline contract creates the bead then dispatches against it', async () => {
    const { host, sessionsCreated } = hostWith();
    const tool = createSpecialistDispatchTool(() => host);

    const out = await tool.execute({
      specialist: 'researcher', contract: INLINE_CONTRACT,
    }) as Record<string, unknown>;

    expect(mockCreateBead).toHaveBeenCalledTimes(1);
    expect(mockCreateBead).toHaveBeenCalledWith(INLINE_CONTRACT, undefined);
    expect(out.status).toBe('dispatched');
    expect(out.bead_id).toBe('bd-inline-1');
    expect(out.created_bead_id).toBe('bd-inline-1');
    expect(String(out.created_bead_note)).toMatch(/yours to track/i);
    expect(sessionsCreated.count).toBe(1);
    // The created bead reads back through the host Fleet.
    expect(host.list().map(s => s.beadId)).toContain('bd-inline-1');
  });

  it('passes title through to bead creation', async () => {
    const { host } = hostWith();
    const tool = createSpecialistDispatchTool(() => host);

    const out = await tool.execute({
      specialist: 'researcher', contract: INLINE_CONTRACT, title: 'My inline title',
    }) as Record<string, unknown>;

    expect(out.status).toBe('dispatched');
    expect(mockCreateBead).toHaveBeenCalledWith(INLINE_CONTRACT, 'My inline title');
  });

  it('drops epic_context_depth for auto-created parentless beads (Pi :932 rule)', async () => {
    const { host } = hostWith();
    const startSpy = vi.spyOn(host, 'start');
    const tool = createSpecialistDispatchTool(() => host);

    const out = await tool.execute({
      specialist: 'researcher', contract: INLINE_CONTRACT, epic_context_depth: 2,
    }) as Record<string, unknown>;

    expect(out.status).toBe('dispatched');
    expect(startSpy.mock.calls[0][0]).not.toHaveProperty('epicContextDepth');
  });

  it('passes epic_context_depth through on bead_id dispatch, omitted by default', async () => {
    const { host } = hostWith();
    const startSpy = vi.spyOn(host, 'start');
    const tool = createSpecialistDispatchTool(() => host);

    await tool.execute({ specialist: 'researcher', bead_id: 'ISSUE-1', epic_context_depth: 2 });
    expect(startSpy.mock.calls[0][0]).toMatchObject({ epicContextDepth: 2 });
    await tool.execute({ specialist: 'researcher', bead_id: 'ISSUE-1' });
    expect(startSpy.mock.calls[1][0]).not.toHaveProperty('epicContextDepth');
  });

  it('ignores title on the bead_id path, creating nothing', async () => {
    const { host, sessionsCreated } = hostWith();
    const startSpy = vi.spyOn(host, 'start');
    const tool = createSpecialistDispatchTool(() => host);

    const out = await tool.execute({
      specialist: 'researcher', bead_id: 'ISSUE-1', title: 'Ignored title',
    }) as Record<string, unknown>;

    expect(out.status).toBe('dispatched');
    expect(out.bead_id).toBe('ISSUE-1');
    expect(out).not.toHaveProperty('created_bead_id');
    expect(mockCreateBead).not.toHaveBeenCalled();
    expect(startSpy.mock.calls[0][0]).toMatchObject({ beadId: 'ISSUE-1' });
    expect(sessionsCreated.count).toBe(1);
  });

  it('reports bd create failure as an error with the board unchanged', async () => {
    mockCreateBead.mockReturnValue(null);
    const { host, sessionsCreated } = hostWith();
    const tool = createSpecialistDispatchTool(() => host);

    const out = await tool.execute({
      specialist: 'researcher', contract: INLINE_CONTRACT,
    }) as Record<string, unknown>;

    expect(out.status).toBe('error');
    expect(String(out.error)).toContain('board unchanged');
    expect(sessionsCreated.count).toBe(0);
  });
});
