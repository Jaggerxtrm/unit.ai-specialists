// Unit tests for the PRIMARY coordinator surface (unitAI-rrdnt.37) — the Pi
// extension over NativeActivationHost. Exercises the REAL bundled artifact
// (config/pi-extensions/specialist-subagents/index.mjs) through its factory with
// a fake pi and an injected host, mirroring tests/unit/pi/extension-tool-policy
// style. The host is stubbed; NativeActivationHost itself has its own suite
// (activation-native-host.test.ts).

import { describe, expect, it, vi } from 'vitest';
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

function makeFakePi({ flags = {} } = {}) {
  const tools = [];
  const handlers = {};
  const sent = [];
  const registeredFlags = {};
  return {
    registerTool: (def) => tools.push(def),
    // One handler per event would let a second pi.on() for the same event silently
    // replace the first — which is exactly the collision two lanes registering
    // session_start/session_shutdown need this fake to expose, not hide.
    on: (event, handler) => { (handlers[event] ??= []).push(handler); },
    fire: async (event, ...args) => {
      for (const handler of handlers[event] ?? []) await handler(...args);
    },
    registerFlag: (name, opts) => { registeredFlags[name] = opts; },
    getFlag: (name) => (name in flags ? flags[name] : registeredFlags[name]?.default),
    sendMessage: (message, options) => { sent.push({ message, options }); },
    get tools() { return tools; },
    get handlers() { return handlers; },
    get sent() { return sent; },
    get registeredFlags() { return registeredFlags; },
  };
}

/** A live ExtensionContext, as `session_start` hands one over. */
function makeFakeCtx({ hasUI = true, sessionId = 'sess-1' } = {}) {
  const notices = [];
  return {
    hasUI,
    mode: 'tui',
    ui: { notify: (message, level) => notices.push([message, level]) },
    sessionManager: { getSessionId: () => sessionId },
    get notices() { return notices; },
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

    // Null client (the node-pi runtime case: bun:sqlite unavailable) -> construction
    // must not throw. The host still receives a sink rather than nothing, because
    // the ask observer rides it (unitAI-rrdnt.45): a coordinator whose forensics
    // failed to open must still be woken by a blocked child.
    const withoutClient = mod.createCoordinatorHost({
      createClient: () => null,
      Host: class { constructor(deps) { this.deps = deps; } },
    });
    expect(withoutClient.deps.forensics).toBeDefined();
    expect(() => withoutClient.deps.forensics.emit({ name: 'activation_started' })).not.toThrow();
  });

  // ── Coordinator wake-up (unitAI-rrdnt.45) ─────────────────────────────────
  //
  // These prove the WIRING. They do not prove the bug is fixed: the acceptance is
  // that an operator who does nothing learns a child is blocked, and only a live
  // interactive run can show that. See the transcripts on the bead.

  const askEvent = (name) => ({
    activationId: 'act:aaaa',
    attemptId: 'att:aaaa:1',
    participantId: 'specialist::explorer',
    specialist: 'explorer',
    beadId: 'bd-1',
    name,
    payload: { body: 'Which option?' },
  });

  it('createAskObserverSink forwards every event and reports only asks', async () => {
    const mod = await loadExtension();
    const seen = [];
    const asks = [];
    const sink = mod.createAskObserverSink({ emit: (e) => seen.push(e.name) }, (a) => asks.push(a));

    sink.emit(askEvent('activation_started'));
    sink.emit(askEvent('clarification_requested'));
    sink.emit(askEvent('escalation_raised'));
    sink.emit(askEvent('clarification_answered'));

    // Forensics are unchanged: wrapping must not cost the base sink an event.
    expect(seen).toEqual([
      'activation_started', 'clarification_requested', 'escalation_raised', 'clarification_answered',
    ]);
    expect(asks.map((a) => a.kind)).toEqual(['question', 'escalation']);
    expect(asks[0]).toMatchObject({ activationId: 'act:aaaa', specialist: 'explorer', body: 'Which option?' });
  });

  it('createAskObserverSink survives a throwing wake and still writes forensics', async () => {
    const mod = await loadExtension();
    const seen = [];
    const sink = mod.createAskObserverSink(
      { emit: (e) => seen.push(e.name) },
      () => { throw new Error('no coordinator'); },
    );
    // A failed notification is a diagnostic loss; a failed activation is a
    // functional one. The ask stays pending and readable either way.
    expect(() => sink.emit(askEvent('escalation_raised'))).not.toThrow();
    expect(seen).toEqual(['escalation_raised']);
  });

  it('createAskObserverSink forwards optional sink members only when the base has them', async () => {
    const mod = await loadExtension();
    const bare = mod.createAskObserverSink({ emit: () => {} }, () => {});
    expect(bare.sessionEvent).toBeUndefined();
    expect(bare.peerTransportEvent).toBeUndefined();

    const raw = [];
    const full = mod.createAskObserverSink(
      { emit: () => {}, sessionEvent: (i) => raw.push(i), peerTransportEvent: (e) => raw.push(e) },
      () => {},
    );
    full.sessionEvent({ activationId: 'act:aaaa' });
    full.peerTransportEvent({ kind: 'route' });
    expect(raw).toHaveLength(2);
  });

  it('an ask wakes the coordinator: a custom message that triggers a turn, plus a toast', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    const ctx = makeFakeCtx();
    let wrapSink;
    const { host } = makeFakeHost();
    mod.default(pi, { createHost: (opts) => { wrapSink = opts.wrapSink; return host; } });

    await pi.fire('session_start', { type: 'session_start' }, ctx);
    await pi.tools[1].execute('tc0', {});          // any tool call builds the host
    wrapSink({ emit: () => {} }).emit(askEvent('escalation_raised'));

    expect(pi.sent).toHaveLength(1);
    // followUp so the wake lands between turns rather than splitting one;
    // triggerTurn so an IDLE coordinator acts, which is the entire bug.
    expect(pi.sent[0].options).toEqual({ deliverAs: 'followUp', triggerTurn: true });
    expect(pi.sent[0].message.customType).toBe('specialist_ask');
    expect(pi.sent[0].message.content).toContain('act:aaaa');
    expect(pi.sent[0].message.content).toContain('Which option?');
    // No message_id: onAsk fires before transport.request(), so the projection is
    // the only place a correlation id may come from.
    expect(pi.sent[0].message.content).not.toContain('message_id:');
    expect(pi.sent[0].message.content).toContain('specialist_status');
    expect(ctx.notices.some(([, level]) => level === 'warning')).toBe(true);
  });

  it('--no-specialist-wake suppresses the notification and nothing else', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi({ flags: { 'no-specialist-wake': true } });
    const ctx = makeFakeCtx();
    let wrapSink;
    const { host } = makeFakeHost();
    mod.default(pi, { createHost: (opts) => { wrapSink = opts.wrapSink; return host; } });

    await pi.fire('session_start', { type: 'session_start' }, ctx);
    await pi.tools[1].execute('tc0', {});
    const base = [];
    wrapSink({ emit: (e) => base.push(e.name) }).emit(askEvent('escalation_raised'));

    expect(pi.sent).toEqual([]);
    // The ask is untouched: forensics still written, and specialist_status still
    // projects it from the host's own pending list.
    expect(base).toEqual(['escalation_raised']);
    const status = resultText(await pi.tools[1].execute('tc1', {}));
    expect(status.pending_asks[0].message_id).toBe('msg:1');
    expect(status.pending_asks[0].delivery).toBe('pending');
    // The suppressed state announces itself; a silent session is unexplainable.
    expect(ctx.notices.some(([msg]) => msg.includes('OFF'))).toBe(true);
  });

  it('wakes with no live context: the message still goes, only the toast is lost', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    let wrapSink;
    const { host } = makeFakeHost();
    mod.default(pi, { createHost: (opts) => { wrapSink = opts.wrapSink; return host; } });

    // No session_start: nothing was ever captured.
    await pi.tools[1].execute('tc0', {});
    wrapSink({ emit: () => {} }).emit(askEvent('clarification_requested'));
    expect(pi.sent).toHaveLength(1);
  });

  it('a stale context is not used: session_shutdown releases the capture', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    const ctx = makeFakeCtx();
    let wrapSink;
    const { host } = makeFakeHost();
    mod.default(pi, { createHost: (opts) => { wrapSink = opts.wrapSink; return host; } });

    await pi.fire('session_start', { type: 'session_start' }, ctx);
    await pi.tools[1].execute('tc0', {});
    const before = ctx.notices.length;
    await pi.fire('session_shutdown', { type: 'session_shutdown', reason: 'quit' });
    wrapSink({ emit: () => {} }).emit(askEvent('escalation_raised'));

    expect(ctx.notices).toHaveLength(before);   // no toast onto a dead session
    expect(pi.sent).toHaveLength(1);            // the message is still not lost
  });

  it('a context whose session was switched underneath it is treated as dead', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    let sessionId = 'sess-1';
    const ctx = makeFakeCtx();
    ctx.sessionManager.getSessionId = () => sessionId;
    let wrapSink;
    const { host } = makeFakeHost();
    mod.default(pi, { createHost: (opts) => { wrapSink = opts.wrapSink; return host; } });

    await pi.fire('session_start', { type: 'session_start' }, ctx);
    await pi.tools[1].execute('tc0', {});
    const before = ctx.notices.length;
    sessionId = 'sess-2';                        // switchSession keeps the ctx object
    wrapSink({ emit: () => {} }).emit(askEvent('escalation_raised'));

    expect(ctx.notices).toHaveLength(before);
    expect(pi.sent).toHaveLength(1);
  });
});