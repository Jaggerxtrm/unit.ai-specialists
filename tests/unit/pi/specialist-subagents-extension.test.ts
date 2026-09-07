// Unit tests for the PRIMARY coordinator surface (unitAI-rrdnt.37) — the Pi
// extension over NativeActivationHost. Exercises the REAL bundled artifact
// (config/pi-extensions/specialist-subagents/index.mjs) through its factory with
// a fake pi and an injected host, mirroring tests/unit/pi/extension-tool-policy
// style. The host is stubbed; NativeActivationHost itself has its own suite
// (activation-native-host.test.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
// Import from the BUNDLE, exactly as the extension does: `instanceof` must match
// the class identity the extension's dist/lib.js import resolved.
import { DispatchRejectedError } from '../../../dist/lib.js';

// The extension imports Type from 'typebox' (resolved from pi's own install at
// runtime). Under vitest the worktree has no typebox, so stub the few members the
// factory uses — schemas are captured, never validated, in this test.
vi.mock('typebox', () => ({
  Type: {
    Object: (props) => ({ type: 'object', properties: props }),
    String: (opts = {}) => ({ type: 'string', ...opts }),
    Optional: (schema) => schema,
  },
}));

const EXTENSION_PATH = resolve('config/pi-extensions/specialist-subagents/index.mjs');

async function loadExtension() {
  expect(existsSync(EXTENSION_PATH)).toBe(true);
  const mod = await import(EXTENSION_PATH);
  return mod;
}

const SNAPSHOT = {
  activationId: 'act:aaaa',
  participantId: 'specialist::explorer',
  attemptId: 'att:aaaa:1',
  specialist: 'explorer',
  beadId: 'bd-1',
  state: 'running',
  access: 'read',
  workspace: { repositoryRoot: '/r', worktreePath: '/r/wt' },
  piSessionId: 'sess-1',
  configuredModel: 'm',
  resolvedModel: 'm',
  modelOverride: false,
  startedAt: 1,
  lastActivityAt: 1,
};

const ASK = {
  message: {
    messageId: 'msg:1',
    kind: 'question',
    from: 'specialist::explorer',
    to: 'adapter::pi-extension',
    activationId: 'act:aaaa',
    attemptId: 'att:aaaa:1',
    body: 'Which option?',
    createdAt: 1,
  },
  delivery: 'pending',
  askedAt: 1,
};

function makeFakeHost() {
  const calls = { start: [], answer: [], stop: [] };
  const host = {
    start: vi.fn(async (req) => {
      calls.start.push(req);      return {
        activationId: 'act:aaaa',
        participantId: 'specialist::explorer',
        attemptId: 'att:aaaa:1',
        specialist: req.specialist,
        beadId: req.beadId,
        access: 'read',
        workspace: SNAPSHOT.workspace,
        resolvedModel: req.modelOverride ?? 'm',
        stepContract: { rootWorkRef: req.beadId, inputs: [1], outputs: [1] },
        result: Promise.resolve({
          activationId: 'act:aaaa',
          participantId: 'specialist::explorer',
          attemptId: 'att:aaaa:1',
          beadId: req.beadId,
          status: 'completed',
          output: 'report',
          validation: { valid: true },
          piSessionId: 'sess-1',
          configuredModel: 'm',
          resolvedModel: req.modelOverride ?? 'm',
          modelOverride: Boolean(req.modelOverride),
          fallbackUsed: false,
          completedAt: 100,
        }),
      };
    }),
    inspect: vi.fn(() => SNAPSHOT),
    list: vi.fn(() => [SNAPSHOT]),
    pendingAsks: vi.fn(() => [ASK]),
    answer: vi.fn(async (messageId, body) => {
      calls.answer.push([messageId, body]);
      return undefined;
    }),
    stop: vi.fn(async (activationId, reason) => {
      calls.stop.push([activationId, reason]);
    }),
  };
  return { host, calls };
}

function makeFakePi() {
  const tools = [];
  const commands = [];
  // Pi allows MANY handlers per event and invokes all of them. Modelling one
  // handler per event silently dropped the second registration on the same
  // event, which is precisely the class of defect this suite exists to catch.
  const handlers = {};
  const fire = async (event, payload, ctx) => {
    for (const handler of handlers[event] ?? []) await handler(payload, ctx);
  };
  return {
    registerTool: (def) => tools.push(def),
    registerCommand: (name, options) => commands.push({ name, ...options }),
    on: (event, handler) => { (handlers[event] ??= []).push(handler); },
    get tools() { return tools; },
    get commands() { return commands; },
    get handlers() { return handlers; },
    fire,
  };
}

/** A UI-capable ExtensionContext double: records what the extension paints. */
function makeFakeCtx({ hasUI = true, mode = 'tui', sessionId = 'session-1' } = {}) {
  const painted = { widgets: {}, statuses: {}, notices: [] };
  return {
    hasUI,
    mode,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      setWidget: (key, content) => { painted.widgets[key] = content; },
      setStatus: (key, text) => { painted.statuses[key] = text; },
      notify: (message, level = 'info') => { painted.notices.push([message, level]); },
    },
    painted,
  };
}

function resultText(result) {
  const text = (result.content ?? []).find((c) => c.type === 'text');
  return JSON.parse(text.text);
}

describe('specialist-subagents extension (Pi coordinator surface)', () => {
  it('registers exactly the four specialist_* tools over the host', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    mod.default(pi);
    expect(pi.tools.map((t) => t.name)).toEqual([
      'specialist_dispatch',
      'specialist_status',
      'specialist_reply',
      'specialist_stop_activation',
    ]);
    // No free-form task text for tracked work (PRD §10/§14).
    const dispatch = pi.tools[0];
    expect(dispatch.parameters.properties).not.toHaveProperty('task');
    expect(dispatch.parameters.properties).toHaveProperty('bead_id');
    // No second permission logic: schemas carry arguments only, never tool grants.
    expect(pi.tools.every((t) => typeof t.execute === 'function')).toBe(true);
  });

  it('dispatch calls host.start with a pi-adapter participant default and renders step_contract counts', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    const { host, calls } = makeFakeHost();
    mod.default(pi, { createHost: () => host });
    const dispatch = pi.tools[0];
    const out = resultText(await dispatch.execute('tc1', { specialist: 'explorer', bead_id: 'bd-1' }));
    expect(calls.start[0]).toMatchObject({
      specialist: 'explorer',
      beadId: 'bd-1',
      requestedByParticipantId: 'adapter::pi-extension',
    });
    expect(out.status).toBe('dispatched');
    expect(out.activation_id).toBe('act:aaaa');
    expect(out.step_contract).toMatchObject({ root_work_ref: 'bd-1', inputs: 1, outputs: 1 });
  });

  it('honours requested_by / coordinator_session_id / model_override passthrough', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    const { host, calls } = makeFakeHost();
    mod.default(pi, { createHost: () => host });
    const dispatch = pi.tools[0];
    await dispatch.execute('tc1', {
      specialist: 'explorer',
      bead_id: 'bd-1',
      model_override: 'opencode-go/deepseek-v4-flash',
      requested_by: 'orch::scheduler-1',
      coordinator_session_id: 'sess-9',
    });
    expect(calls.start[0]).toMatchObject({
      modelOverride: 'opencode-go/deepseek-v4-flash',
      requestedByParticipantId: 'orch::scheduler-1',
      coordinatorSessionId: 'sess-9',
    });
  });

  it('renders a DispatchRejectedError as a structured result, preserving detail.missing', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    const { host } = makeFakeHost();
    host.start.mockRejectedValueOnce(new DispatchRejectedError('bead_contract_incomplete', {
      specialist: 'explorer',
      beadId: 'bd-draft',
      missing: ['VALIDATION', 'OUTPUT'],
    }));
    mod.default(pi, { createHost: () => host });
    const out = resultText(await pi.tools[0].execute('tc1', { specialist: 'explorer', bead_id: 'bd-draft' }));
    expect(out.status).toBe('rejected');
    expect(out.reason).toContain('SPECIALIST_DISPATCH_REJECTED');
    expect(out.detail.missing).toEqual(['VALIDATION', 'OUTPUT']);
  });

  it('status projects the Fleet with the shared ActivationView and attaches a settled result', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    const { host } = makeFakeHost();
    mod.default(pi, { createHost: () => host });
    // The dispatch result cache fills as the child result settles.
    await pi.tools[0].execute('tc1', { specialist: 'explorer', bead_id: 'bd-1' });
    await new Promise((r) => setTimeout(r, 0));
    const out = resultText(await pi.tools[1].execute('tc2', {}));
    expect(out.activations[0]).toMatchObject({
      activation_id: 'act:aaaa',
      specialist: 'explorer',
      state: 'running',
      worktree_path: '/r/wt',
      result: { status: 'completed', output: 'report', validation: { valid: true } },
    });
    expect(out.pending_asks[0]).toMatchObject({
      message_id: 'msg:1',
      kind: 'question',
      from: 'specialist::explorer',
      body: 'Which option?',
      delivery: 'pending',
    });
  });

  it('reply correlates on message_id only and reports unknown asks as an error result', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    const { host, calls } = makeFakeHost();
    host.answer.mockResolvedValueOnce({
      messageId: 'msg:1',
      inReplyTo: 'msg:0',
      activationId: 'act:aaaa',
      attemptId: 'att:aaaa:1',
    });
    mod.default(pi, { createHost: () => host });
    const reply = pi.tools[2];
    const answered = resultText(await reply.execute('tc3', { message_id: 'msg:1', body: 'Option A' }));
    expect(host.answer.mock.calls[0]).toEqual(['msg:1', 'Option A']);
    expect(answered).toMatchObject({ status: 'answered', message_id: 'msg:1', in_reply_to: 'msg:0' });

    const missing = resultText(await reply.execute('tc4', { message_id: 'msg:9', body: 'x' }));
    expect(missing.status).toBe('error');
    expect(missing.error).toContain('msg:9');
  });

  it('stop disposes the activation and reports unknown ids as an error result', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    const { host, calls } = makeFakeHost();
    mod.default(pi, { createHost: () => host });
    const stop = pi.tools[3];
    const stopped = resultText(await stop.execute('tc5', { activation_id: 'act:aaaa', reason: 'done' }));
    expect(calls.stop[0]).toEqual(['act:aaaa', 'done']);
    expect(stopped).toEqual({ status: 'stopped', activation_id: 'act:aaaa' });

    host.inspect.mockReturnValueOnce(undefined);
    const missing = resultText(await stop.execute('tc6', { activation_id: 'act:nope' }));
    expect(missing.status).toBe('error');
  });

  it('disposes every live activation on session_shutdown', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    const { host, calls } = makeFakeHost();
    mod.default(pi, { createHost: () => host });
    // Create the host first (a real session has it after any tool call).
    await pi.tools[1].execute('tc0', {});
    await pi.fire('session_shutdown', { type: 'session_shutdown', reason: 'quit' });
    expect(calls.stop).toEqual([['act:aaaa', 'session shutdown']]);
  });

  it('createCoordinatorHost wires the canonical forensic sink and is null-safe (unitAI-rrdnt.37.1)', async () => {
    const mod = await loadExtension();

    // Non-null client -> host receives the forensic sink.
    const client = { appendForensicEvent: () => {} };
    const withClient = mod.createCoordinatorHost({
      createClient: () => client,
      Host: class { constructor(deps) { this.deps = deps; } },
    });
    expect(withClient.deps.forensics).toBeDefined();

    // Null client (the node-pi runtime case: bun:sqlite unavailable) -> host is
    // built without a sink; construction must not throw.
    const withoutClient = mod.createCoordinatorHost({
      createClient: () => null,
      Host: class { constructor(deps) { this.deps = deps; } },
    });
    expect(withoutClient.deps).toBeUndefined();
  });
});

describe('operator surface: commands and Fleet view (unitAI-rrdnt.46)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** Boot the extension with a live host and a UI context already captured. */
  async function boot(ctxOptions) {
    const mod = await loadExtension();
    const pi = makeFakePi();
    const { host, calls } = makeFakeHost();
    mod.default(pi, { createHost: () => host });
    const ctx = makeFakeCtx(ctxOptions);
    await pi.fire('session_start', { type: 'session_start' }, ctx);
    const command = (name) => pi.commands.find((c) => c.name === name);
    return { pi, host, calls, ctx, command };
  }

  it('registers the three operator commands', async () => {
    const { pi } = await boot();
    expect(pi.commands.map((c) => c.name)).toEqual(['fleet', 'fleet:reply', 'fleet:stop']);
  });

  it('paints the Fleet and pending asks into a widget without a tool call', async () => {
    const { pi, host, ctx } = await boot();
    // The host exists only after a tool call, so the operator's first paint is
    // empty — this is the state the bead reported as "nothing rendered".
    expect(ctx.painted.widgets['specialist-fleet']).toBeUndefined();

    await pi.tools[1].execute('tc0', {});   // specialist_status creates the host
    await command_tick();

    const lines = ctx.painted.widgets['specialist-fleet'];
    expect(lines).toBeDefined();
    expect(lines[0]).toContain('1 activation(s), 1 pending ask(s)');
    expect(lines.join('\n')).toContain('explorer');
    expect(lines.join('\n')).toContain('act:aaaa');
    expect(lines.join('\n')).toContain('Which option?');
    expect(lines.join('\n')).toContain('/fleet:reply msg:1');
    expect(ctx.painted.statuses['specialist-fleet']).toBe('specialists: 1 · 1 waiting');
    // The projection is re-read every paint, never cached.
    expect(host.list).toHaveBeenCalled();
    expect(host.pendingAsks).toHaveBeenCalled();
  });

  it('clears the widget when the Fleet is empty rather than painting a bare header', async () => {
    const { pi, host, ctx } = await boot();
    await pi.tools[1].execute('tc0', {});
    host.list.mockReturnValue([]);
    host.pendingAsks.mockReturnValue([]);
    await command_tick();
    expect(ctx.painted.widgets['specialist-fleet']).toBeUndefined();
    expect(ctx.painted.statuses['specialist-fleet']).toBeUndefined();
  });

  it('/fleet hide stops painting and /fleet show resumes it', async () => {
    const { pi, ctx, command } = await boot();
    await pi.tools[1].execute('tc0', {});
    await command('fleet').handler('hide', ctx);
    expect(ctx.painted.widgets['specialist-fleet']).toBeUndefined();
    await command('fleet').handler('show', ctx);
    expect(ctx.painted.widgets['specialist-fleet']).toBeDefined();
  });

  it('/fleet reports in text too, so json and print modes are not blind', async () => {
    const { pi, ctx, command } = await boot();
    await pi.tools[1].execute('tc0', {});
    await command('fleet').handler('', ctx);
    expect(ctx.painted.notices.at(-1)[0]).toContain('1 activation(s), 1 pending ask(s)');
  });

  it('/fleet:reply answers by message_id and reports an unknown id instead of silently passing', async () => {
    const { host, ctx, command } = await boot();
    // mockResolvedValueOnce replaces the implementation, so assert on the spy's
    // arguments rather than on the recorder the default implementation feeds.
    host.answer.mockResolvedValueOnce({ messageId: 'msg:1', activationId: 'act:aaaa' });
    await command('fleet:reply').handler('msg:1 use the second option', ctx);
    expect(host.answer).toHaveBeenCalledWith('msg:1', 'use the second option');
    expect(ctx.painted.notices.at(-1)[0]).toContain('Answered msg:1');

    // host.answer returns undefined for an unknown id.
    await command('fleet:reply').handler('msg:nope anything', ctx);
    expect(ctx.painted.notices.at(-1)).toEqual([
      expect.stringContaining("No outstanding ask with message_id 'msg:nope'"),
      'warning',
    ]);
  });

  it('/fleet:reply rejects a missing body rather than answering with an empty string', async () => {
    const { calls, ctx, command } = await boot();
    await command('fleet:reply').handler('msg:1', ctx);
    await command('fleet:reply').handler('msg:1    ', ctx);
    expect(calls.answer).toEqual([]);
    expect(ctx.painted.notices.at(-1)[1]).toBe('warning');
  });

  it('/fleet:stop disposes a known activation and refuses an unknown one', async () => {
    const { host, calls, ctx, command } = await boot();
    await command('fleet:stop').handler('act:aaaa operator changed their mind', ctx);
    expect(calls.stop).toEqual([['act:aaaa', 'operator changed their mind']]);

    host.inspect.mockReturnValueOnce(undefined);
    await command('fleet:stop').handler('act:zzzz', ctx);
    expect(calls.stop).toHaveLength(1);
    expect(ctx.painted.notices.at(-1)).toEqual(['Unknown activation: act:zzzz', 'warning']);
  });

  it('completes message ids and activation ids from live host state', async () => {
    const { pi, command } = await boot();
    await pi.tools[1].execute('tc0', {});
    expect(command('fleet:reply').getArgumentCompletions('msg').map((i) => i.value)).toEqual(['msg:1']);
    expect(command('fleet:stop').getArgumentCompletions('act').map((i) => i.value)).toEqual(['act:aaaa']);
    expect(command('fleet:reply').getArgumentCompletions('nomatch')).toBeNull();
    expect(command('fleet').getArgumentCompletions('h').map((i) => i.value)).toEqual(['hide']);
  });

  it('does not install the view without UI, and never throws there', async () => {
    const { pi, ctx, command } = await boot({ hasUI: false, mode: 'print' });
    await pi.tools[1].execute('tc0', {});
    await command('fleet').handler('', ctx);
    expect(ctx.painted.widgets['specialist-fleet']).toBeUndefined();
    expect(ctx.painted.notices).toEqual([]);   // report() falls back to console
  });

  it('stops painting into a context whose session was replaced', async () => {
    const { pi, ctx } = await boot();
    await pi.tools[1].execute('tc0', {});
    await command_tick();
    expect(ctx.painted.widgets['specialist-fleet']).toBeDefined();

    // A switchSession keeps the same ctx object but changes the session id.
    ctx.painted.widgets['specialist-fleet'] = 'STALE';
    ctx.sessionManager.getSessionId = () => 'session-2';
    await command_tick();
    expect(ctx.painted.widgets['specialist-fleet']).toBe('STALE');
  });

  it('survives a context that throws on property access during teardown', async () => {
    const { pi, ctx } = await boot();
    await pi.tools[1].execute('tc0', {});
    ctx.sessionManager.getSessionId = () => { throw new Error('session torn down'); };
    await expect(command_tick(pi, ctx)).resolves.not.toThrow();
  });
});

/**
 * Advance one poll interval. This drives the REAL timer the extension installs
 * rather than re-firing session_start, which would re-capture the context and
 * quietly defeat every staleness assertion below.
 */
async function command_tick() {
  await vi.advanceTimersByTimeAsync(1000);
}