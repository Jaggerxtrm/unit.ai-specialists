import { describe, it, expect, vi } from 'vitest';
import { DispatchRejectedError } from '../../../src/activation/types.js';
import { createSpecialistResumeTool } from '../../../src/mcp/resume-tool.js';

/**
 * Wave E4 Resume-only: `specialist_resume` on the v2 server mirrors the Pi
 * tool of the same name — same params, same session continuity, same
 * unknown-activation error shape, same refusal-as-result rule through the
 * shared renderer. The host double below models the two load-bearing host
 * behaviors: `inspect` hands back the LIVE snapshot object, and `resume`
 * mutates it in place.
 */

const SNAPSHOT = {
  activationId: 'act:aaaa',
  participantId: 'specialist::explorer',
  attemptId: 'att:aaaa:1',
  specialist: 'explorer',
  beadId: 'bd-1',
  state: 'settled',
  access: 'read',
  workspace: { worktreePath: '/ws' },
  resolvedModel: 'm',
  modelOverride: false,
  thinkingOverride: false,
  startedAt: 0,
  lastActivityAt: 1,
};

function makeHost() {
  const calls: { resume: Array<[string, string]> } = { resume: [] };
  const live = { ...SNAPSHOT, workspace: { ...SNAPSHOT.workspace } };
  const host = {
    inspect: vi.fn((_id: string) => live),
    resume: vi.fn(async (activationId: string, prompt: string) => {
      calls.resume.push([activationId, prompt]);
      live.attemptId = 'att:aaaa:2';
      live.state = 'running';
      return {
        activationId,
        attemptId: 'att:aaaa:2',
        result: Promise.resolve({
          activationId,
          participantId: 'specialist::explorer',
          attemptId: 'att:aaaa:2',
          beadId: 'bd-1',
          status: 'completed',
          output: 'resumed report',
          validation: { valid: true },
          resolvedModel: 'm',
          modelOverride: false,
          thinkingOverride: false,
          fallbackUsed: false,
          completedAt: 200,
        }),
      };
    }),
  };
  return { host, calls, live };
}

function makePusher() {
  return {
    settle: vi.fn(),
    pushCompletion: vi.fn(async () => ({ delivered: false as const, reason: 'test' })),
  };
}

describe('specialist_resume factory (v2)', () => {
  it('resumes in place: id kept, previous attempt reported, view attached', async () => {
    const { host, calls } = makeHost();
    const tool = createSpecialistResumeTool(() => host as never);
    const out = await tool.execute({ activation_id: 'act:aaaa', prompt: 'keep going' }) as Record<string, unknown>;

    expect(calls.resume).toEqual([['act:aaaa', 'keep going']]);
    expect(out.status).toBe('resumed');
    expect(out.activation_id).toBe('act:aaaa');
    expect(out.previous_attempt_id).toBe('att:aaaa:1');
    expect(out.attempt_id).toBe('att:aaaa:2');
  });

  it('reports an unknown activation without calling the host', async () => {
    const { host, calls } = makeHost();
    host.inspect = vi.fn(() => undefined);
    const tool = createSpecialistResumeTool(() => host as never);
    const out = await tool.execute({ activation_id: 'act:nope', prompt: 'x' }) as Record<string, unknown>;

    expect(out.status).toBe('error');
    expect(out.error).toContain('Unknown activation: act:nope');
    expect(out.activation_id).toBe('act:nope');
    expect(calls.resume).toEqual([]);
  });

  it('renders a host refusal via the shared renderer, never a throw', async () => {
    const { host } = makeHost();
    const thrown = new DispatchRejectedError('not_resumable', {
      activationId: 'act:aaaa',
      note: 'state is "running"',
    });
    host.resume = vi.fn(async () => { throw thrown; });
    const tool = createSpecialistResumeTool(() => host as never);
    const out = await tool.execute({ activation_id: 'act:aaaa', prompt: 'x' }) as Record<string, unknown>;

    expect(out.status).toBe('rejected');
    // Byte-identical reason: the host's own message, passed through unchanged.
    expect(out.reason).toBe(thrown.message);
  });

  it('rethrows non-gate failures so they surface as isError, like dispatch', async () => {
    const { host } = makeHost();
    host.resume = vi.fn(async () => { throw new Error('boom'); });
    const tool = createSpecialistResumeTool(() => host as never);
    await expect(tool.execute({ activation_id: 'act:aaaa', prompt: 'x' })).rejects.toThrow('boom');
  });

  it('settles the new attempt result so specialist_status projects it', async () => {
    const { host } = makeHost();
    const pusher = makePusher();
    const tool = createSpecialistResumeTool(() => host as never, () => pusher as never);
    await tool.execute({ activation_id: 'act:aaaa', prompt: 'go' });
    await new Promise((r) => setImmediate(r));
    expect(pusher.settle).toHaveBeenCalledTimes(1);
    expect(pusher.settle.mock.calls[0]?.[0]).toMatchObject({
      activationId: 'act:aaaa',
      attemptId: 'att:aaaa:2',
    });
  });
});
