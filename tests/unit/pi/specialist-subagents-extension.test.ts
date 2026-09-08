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
  const calls = { start: [], answer: [], stop: [], resume: [] };
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
    resume: vi.fn(async (activationId, prompt) => {
      calls.resume.push([activationId, prompt]);
      return {
        activationId, participantId: 'specialist::explorer', attemptId: 'att:aaaa:2',
        result: Promise.resolve({
          activationId, participantId: 'specialist::explorer', attemptId: 'att:aaaa:2',
          beadId: 'bd-1', status: 'completed', output: 'resumed report',
          validation: { valid: true }, piSessionId: 'sess-1', configuredModel: 'm',
          resolvedModel: 'm', modelOverride: false, fallbackUsed: false, completedAt: 200,
        }),
      };
    }),
  };
  return { host, calls };
}

function makeFakePi({ flags = {} } = {}) {
  const tools = [];
  const commands = [];
  // Pi allows MANY handlers per event and invokes all of them. Modelling one
  // handler per event silently dropped the second registration on the same
  // event, which is precisely the class of defect this suite exists to catch.
  const handlers = {};
  const sent = [];
  const registeredFlags = {};
  return {
    registerTool: (def) => tools.push(def),
    registerCommand: (name, options) => commands.push({ name, ...options }),
    on: (event, handler) => { (handlers[event] ??= []).push(handler); },
    // Variadic, because the two registrations differ in arity: the UI surface is
    // handed (payload, ctx) at session_start and the wake path takes the payload
    // alone. A fixed signature here would silently pass undefined to one of them.
    fire: async (event, ...args) => {
      for (const handler of handlers[event] ?? []) await handler(...args);
    },
    registerFlag: (name, opts) => { registeredFlags[name] = opts; },
    getFlag: (name) => (name in flags ? flags[name] : registeredFlags[name]?.default),
    sendMessage: (message, options) => { sent.push({ message, options }); },
    get tools() { return tools; },
    get commands() { return commands; },
    get handlers() { return handlers; },
    get sent() { return sent; },
    get registeredFlags() { return registeredFlags; },
  };
}

/**
 * A UI-capable ExtensionContext double: records what the extension paints.
 *
 * The union of what two lanes needed — widgets and statuses for the operator
 * panel, notices for the coordinator wake. `notices` is aliased onto `painted`
 * rather than duplicated, so the two surfaces cannot drift apart in the double
 * the way they would if each lane kept its own.
 */
function makeFakeCtx({ hasUI = true, mode = 'tui', sessionId = 'sess-1' } = {}) {
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
    get notices() { return painted.notices; },
  };
}

/**
 * Look a registered tool up by NAME, never by index.
 *
 * These were `pi.tools[3]` and friends until adding one tool (specialist_resume,
 * unitAI-rrdnt.33.1) shifted three of them and produced failures that pointed at the wrong
 * thing — "expected undefined to deeply equal [...]" says nothing about the cause.
 * Registration order is not a contract; the names are.
 */
function toolNamed(pi, name) {
  const tool = pi.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool not registered: ${name} (have: ${pi.tools.map(t => t.name).join(', ')})`);
  return tool;
}

function resultText(result) {
  const text = (result.content ?? []).find((c) => c.type === 'text');
  return JSON.parse(text.text);
}

describe('specialist-subagents extension (Pi coordinator surface)', () => {
  it('registers exactly the six specialist_* tools over the host', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    mod.default(pi);
    expect(pi.tools.map((t) => t.name)).toEqual([
      'specialist_dispatch',
      'specialist_status',
      'specialist_reply',
      'specialist_resume',
      'specialist_stop_activation',
      'specialist_list',
    ]);
    // No free-form task text for tracked work (PRD §10/§14).
    const dispatch = toolNamed(pi, 'specialist_dispatch');
    expect(dispatch.parameters.properties).not.toHaveProperty('task');
    expect(dispatch.parameters.properties).toHaveProperty('bead_id');
    // .48: inline contract path is a first-class parameter.
    expect(dispatch.parameters.properties).toHaveProperty('contract');
    expect(dispatch.parameters.properties).toHaveProperty('title');
    // No second permission logic: schemas carry arguments only, never tool grants.
    expect(pi.tools.every((t) => typeof t.execute === 'function')).toBe(true);
  });

  it('dispatch calls host.start with a pi-adapter participant default and renders step_contract counts', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    const { host, calls } = makeFakeHost();
    mod.default(pi, { createHost: () => host });
    const dispatch = toolNamed(pi, 'specialist_dispatch');
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
    const dispatch = toolNamed(pi, 'specialist_dispatch');
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
    const out = resultText(await toolNamed(pi, 'specialist_dispatch').execute('tc1', { specialist: 'explorer', bead_id: 'bd-draft' }));
    expect(out.status).toBe('rejected');
    expect(out.reason).toContain('SPECIALIST_DISPATCH_REJECTED');
    expect(out.detail.missing).toEqual(['VALIDATION', 'OUTPUT']);
  });

  const INLINE_CONTRACT =
    'PROBLEM\nProve the inline-dispatch path.\n\nSUCCESS\nA read-only activation settles.\n\n' +
    'SCOPE\nRead-only.\n\nNON_GOALS\nNo writes.\n\nCONSTRAINTS\nRead-only.\n\n' +
    'VALIDATION\nOutput confirms.\n\nOUTPUT\nA short report.\n\nSCRUTINY LOW';

  it('inline contract: gate runs BEFORE creating the bead, refusal leaves the board unchanged (.48)', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    const { host } = makeFakeHost();
    const createBead = vi.fn(() => 'bd-new');
    mod.default(pi, { createHost: () => host, createBead });
    const out = resultText(await toolNamed(pi, 'specialist_dispatch').execute('tc1', {
      specialist: 'explorer',
      contract: 'PROBLEM\nMissing everything else.',
    }));
    expect(out.status).toBe('rejected');
    expect(out.missing).toContain('SUCCESS');
    expect(out.missing).not.toContain('PROBLEM');
    expect(createBead).not.toHaveBeenCalled();
    expect(host.start).not.toHaveBeenCalled();

    // All seven sections present but no SCRUTINY: refused with SCRUTINY missing.
    const noScrutiny = resultText(await toolNamed(pi, 'specialist_dispatch').execute('tc2', {
      specialist: 'explorer',
      contract: 'PROBLEM\np\n\nSUCCESS\ns\n\nSCOPE\nsc\n\nNON_GOALS\nng\n\nCONSTRAINTS\nc\n\nVALIDATION\nv\n\nOUTPUT\no',
    }));
    expect(noScrutiny.status).toBe('rejected');
    expect(noScrutiny.missing).toEqual(['SCRUTINY']);
    expect(createBead).not.toHaveBeenCalled();
  });

  it('inline contract: valid contract creates the bead then dispatches against it (.48)', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    const { host, calls } = makeFakeHost();
    const createBead = vi.fn(() => 'bd-inline-1');
    mod.default(pi, { createHost: () => host, createBead });
    const out = resultText(await toolNamed(pi, 'specialist_dispatch').execute('tc1', {
      specialist: 'explorer',
      contract: INLINE_CONTRACT,
    }));
    expect(createBead).toHaveBeenCalledTimes(1);
    expect(calls.start[0]).toMatchObject({ beadId: 'bd-inline-1', specialist: 'explorer' });
    expect(out.status).toBe('dispatched');
  });

  it('inline contract: bead_id plus contract is a refusal, not a precedence rule (.48)', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    const { host } = makeFakeHost();
    const createBead = vi.fn();
    mod.default(pi, { createHost: () => host, createBead });
    const out = resultText(await toolNamed(pi, 'specialist_dispatch').execute('tc1', {
      specialist: 'explorer',
      bead_id: 'bd-1',
      contract: INLINE_CONTRACT,
    }));
    expect(out.status).toBe('rejected');
    expect(out.reason).toContain('both bead_id and contract were provided');
    expect(createBead).not.toHaveBeenCalled();
    expect(host.start).not.toHaveBeenCalled();
  });

  it('inline contract: neither bead_id nor contract is a refusal (.48)', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    const { host } = makeFakeHost();
    mod.default(pi, { createHost: () => host });
    const out = resultText(await toolNamed(pi, 'specialist_dispatch').execute('tc1', { specialist: 'explorer' }));
    expect(out.status).toBe('rejected');
    expect(out.reason).toContain('neither bead_id nor contract');
    expect(host.start).not.toHaveBeenCalled();
  });

  it('specialist_list projects the resolved registry with dispatchability markers (.49)', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    const { host } = makeFakeHost();
    mod.default(pi, { createHost: () => host });
    const listTool = toolNamed(pi, 'specialist_list');
    const out = resultText(await listTool.execute('tc1', {}));
    expect(out.note).toContain('sp help');
    expect(Array.isArray(out.specialists)).toBe(true);
    expect(out.specialists.length).toBeGreaterThan(0);
    for (const row of out.specialists) {
      expect(typeof row.name).toBe('string');
      expect(['read', 'write']).toContain(row.access);
      expect(typeof row.dispatchable).toBe('boolean');
    }
    const explorer = out.specialists.find((r) => r.name === 'explorer');
    expect(explorer).toBeDefined();
  });

  it('status projects the Fleet with the shared ActivationView and attaches a settled result', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    const { host } = makeFakeHost();
    mod.default(pi, { createHost: () => host });
    // The dispatch result cache fills as the child result settles.
    await toolNamed(pi, 'specialist_dispatch').execute('tc1', { specialist: 'explorer', bead_id: 'bd-1' });
    await new Promise((r) => setTimeout(r, 0));
    const out = resultText(await toolNamed(pi, 'specialist_status').execute('tc2', {}));
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
    const reply = toolNamed(pi, 'specialist_reply');
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
    const stop = toolNamed(pi, 'specialist_stop_activation');
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
    await toolNamed(pi, 'specialist_status').execute('tc0', {});
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

    // Null client (the node-pi runtime case when the sqlite layer cannot open):
    // the host is built with a no-op sink so the wake wrapper still installs over
    // it — a forensics outage must not become a notification outage (.45).
    let wrapped;
    const withoutClient = mod.createCoordinatorHost({
      createClient: () => null,
      wrapSink: (sink) => { wrapped = sink; return sink; },
      Host: class { constructor(deps) { this.deps = deps; } },
    });
    expect(withoutClient.deps.forensics).toBeDefined();
    expect(wrapped).toBeDefined();
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
    await toolNamed(pi, 'specialist_status').execute('tc0', {});          // any tool call builds the host
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
    await toolNamed(pi, 'specialist_status').execute('tc0', {});
    const base = [];
    wrapSink({ emit: (e) => base.push(e.name) }).emit(askEvent('escalation_raised'));

    expect(pi.sent).toEqual([]);
    // The ask is untouched: forensics still written, and specialist_status still
    // projects it from the host's own pending list.
    expect(base).toEqual(['escalation_raised']);
    const status = resultText(await toolNamed(pi, 'specialist_status').execute('tc1', {}));
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
    await toolNamed(pi, 'specialist_status').execute('tc0', {});
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
    await toolNamed(pi, 'specialist_status').execute('tc0', {});
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
    await toolNamed(pi, 'specialist_status').execute('tc0', {});
    const before = ctx.notices.length;
    sessionId = 'sess-2';                        // switchSession keeps the ctx object
    wrapSink({ emit: () => {} }).emit(askEvent('escalation_raised'));

    expect(ctx.notices).toHaveLength(before);
    expect(pi.sent).toHaveLength(1);
  });

  it('tells the caller it created a bead, because the side effect is invisible otherwise', async () => {
    const mod = await loadExtension();
    const { host } = makeFakeHost();
    const pi = makeFakePi();
    mod.default(pi, { createHost: () => host, createBead: () => 'bd-created-1' });

    const contract = [
      'PROBLEM: p', 'SUCCESS: s', 'SCRUTINY: LOW', 'SCOPE: sc',
      'NON_GOALS: n', 'CONSTRAINTS: c', 'VALIDATION: v', 'OUTPUT: o',
    ].join('\n');
    const out = resultText(await toolNamed(pi, 'specialist_dispatch')
      .execute('tc1', { specialist: 'explorer', contract }));

    // An operator reported having to infer this and then clean up an orphan bead by hand.
    expect(out.status).toBe('dispatched');
    expect(out.created_bead_id).toBe('bd-created-1');
    expect(out.created_bead_note).toMatch(/yours to track/i);
  });

  it('says nothing about created beads when the caller supplied one', async () => {
    const mod = await loadExtension();
    const { host } = makeFakeHost();
    const pi = makeFakePi();
    mod.default(pi, { createHost: () => host });

    const out = resultText(await toolNamed(pi, 'specialist_dispatch')
      .execute('tc1', { specialist: 'explorer', bead_id: 'bd-1' }));

    expect(out.created_bead_id).toBeUndefined();
    expect(out.created_bead_note).toBeUndefined();
  });

  // ── Resume (unitAI-rrdnt.33.1) ──────────────────────────────────────────────
  //
  // resume() was complete, unit-tested, and reachable from nothing: no MCP tool, no CLI and
  // no extension command called it. A settled Specialist is documented as "waiting and
  // resumable" and the lease REACQUISITION path exists solely for resume, so the whole
  // resume half of the runtime had no operator surface. These prove the surface exists and
  // reaches the host; PRD acceptances Y and Z still need a live run.

  it('resume reaches the host with the activation id and the new prompt', async () => {
    const mod = await loadExtension();
    const { host, calls } = makeFakeHost();
    const pi = makeFakePi();
    mod.default(pi, { createHost: () => host });

    const out = resultText(await toolNamed(pi, 'specialist_resume')
      .execute('tc1', { activation_id: 'act:aaaa', prompt: 'keep going' }));

    expect(calls.resume).toEqual([['act:aaaa', 'keep going']]);
    expect(out.status).toBe('resumed');
    // A resume is not a second activation: the id is kept, the attempt advances.
    expect(out.activation_id).toBe('act:aaaa');
    expect(out.previous_attempt_id).toBe('att:aaaa:1');
  });

  it('reports the PREVIOUS attempt even though inspect() hands back a live object', async () => {
    const mod = await loadExtension();
    const { host } = makeFakeHost();
    // The real host returns its live snapshot from inspect() and mutates it in place during
    // resume. A fake that returns a fresh object per call is a BETTER-behaved double than the
    // product, and it hid this: previous_attempt_id came back equal to attempt_id on a live
    // run (act:25bc5ad5-cc3 reported att:...:2 for both). Model the aliasing.
    const live = { activationId: 'act:aaaa', attemptId: 'att:aaaa:1', specialist: 'explorer',
      beadId: 'bd-1', state: 'settled', access: 'write', workspace: '/ws',
      participantId: 'specialist::explorer', startedAt: 0, lastActivityAt: 0 };
    host.inspect = vi.fn(() => live);
    host.resume = vi.fn(async () => {
      live.attemptId = 'att:aaaa:2';           // in place, exactly as the host does
      return { activationId: 'act:aaaa', attemptId: 'att:aaaa:2', result: Promise.resolve({}) };
    });
    const pi = makeFakePi();
    mod.default(pi, { createHost: () => host });

    const out = resultText(await toolNamed(pi, 'specialist_resume')
      .execute('tc1', { activation_id: 'act:aaaa', prompt: 'go' }));

    expect(out.previous_attempt_id).toBe('att:aaaa:1');
    expect(out.attempt_id).toBe('att:aaaa:2');
  });

  it('refuses an unknown activation without calling the host', async () => {
    const mod = await loadExtension();
    const { host, calls } = makeFakeHost();
    host.inspect = vi.fn(() => undefined);
    const pi = makeFakePi();
    mod.default(pi, { createHost: () => host });

    const out = resultText(await toolNamed(pi, 'specialist_resume')
      .execute('tc1', { activation_id: 'act:nope', prompt: 'x' }));

    expect(out.status).toBe('error');
    expect(calls.resume).toEqual([]);
  });

  it('renders a refused resume as a RESULT, never a throw', async () => {
    const mod = await loadExtension();
    const { host } = makeFakeHost();
    host.resume = vi.fn(async () => { throw new Error('activation is disposed'); });
    const pi = makeFakePi();
    mod.default(pi, { createHost: () => host });

    // A refused resume is evidence, not a malfunction — the same shape every other refusal
    // on this surface takes.
    const out = resultText(await toolNamed(pi, 'specialist_resume')
      .execute('tc1', { activation_id: 'act:aaaa', prompt: 'x' }));

    expect(out.status).toBe('rejected');
    expect(out.reason).toMatch(/disposed/);
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

    await toolNamed(pi, 'specialist_status').execute('tc0', {});   // specialist_status creates the host
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
    await toolNamed(pi, 'specialist_status').execute('tc0', {});
    host.list.mockReturnValue([]);
    host.pendingAsks.mockReturnValue([]);
    await command_tick();
    expect(ctx.painted.widgets['specialist-fleet']).toBeUndefined();
    expect(ctx.painted.statuses['specialist-fleet']).toBeUndefined();
  });

  it('/fleet hide stops painting and /fleet show resumes it', async () => {
    const { pi, ctx, command } = await boot();
    await toolNamed(pi, 'specialist_status').execute('tc0', {});
    await command('fleet').handler('hide', ctx);
    expect(ctx.painted.widgets['specialist-fleet']).toBeUndefined();
    await command('fleet').handler('show', ctx);
    expect(ctx.painted.widgets['specialist-fleet']).toBeDefined();
  });

  it('/fleet reports in text too, so json and print modes are not blind', async () => {
    const { pi, ctx, command } = await boot();
    await toolNamed(pi, 'specialist_status').execute('tc0', {});
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
    await toolNamed(pi, 'specialist_status').execute('tc0', {});
    expect(command('fleet:reply').getArgumentCompletions('msg').map((i) => i.value)).toEqual(['msg:1']);
    expect(command('fleet:stop').getArgumentCompletions('act').map((i) => i.value)).toEqual(['act:aaaa']);
    expect(command('fleet:reply').getArgumentCompletions('nomatch')).toBeNull();
    expect(command('fleet').getArgumentCompletions('h').map((i) => i.value)).toEqual(['hide']);
  });

  it('does not install the view without UI, and never throws there', async () => {
    const { pi, ctx, command } = await boot({ hasUI: false, mode: 'print' });
    await toolNamed(pi, 'specialist_status').execute('tc0', {});
    await command('fleet').handler('', ctx);
    expect(ctx.painted.widgets['specialist-fleet']).toBeUndefined();
    expect(ctx.painted.notices).toEqual([]);   // report() falls back to console
  });

  it('stops painting into a context whose session was replaced', async () => {
    const { pi, ctx } = await boot();
    await toolNamed(pi, 'specialist_status').execute('tc0', {});
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
    await toolNamed(pi, 'specialist_status').execute('tc0', {});
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

describe('coordinator workspace fence — PRD acceptance U (unitAI-rrdnt.61)', () => {
  function bootFence(admit: (i: { toolName: string }) => { allow: boolean; reason?: string }) {
    const pi = makeFakePi();
    return { pi, admit };
  }

  async function fire(mod: Record<string, any>, admit: unknown, toolName: string) {
    const pi = makeFakePi();
    mod.installCoordinatorFence(pi, {
      admitCoordinatorToolCall: admit,
      leaseScopeFor: () => ({ worktreePath: '/ws', repositoryRoot: '/ws' }),
      cwd: '/ws',
    });
    const results: unknown[] = [];
    for (const h of pi.handlers['tool_call'] ?? []) results.push(await h({ toolName }));
    return results[0];
  }

  it('blocks a mutating call while a Specialist holds the workspace, and names the holder', async () => {
    const mod = await loadExtension();
    const out = await fire(mod,
      () => ({ allow: false, reason: 'workspace /ws is held by executor act:aaaa' }), 'write');

    expect(out).toMatchObject({ block: true });
    expect((out as { reason: string }).reason).toMatch(/held by executor act:aaaa/);
  });

  it('ALLOWS a mutating call when the workspace is free', async () => {
    // The trap this exists to catch. The Specialist-side admitToolCall REFUSES an unleased
    // workspace, because a Specialist must hold a lease to mutate. Reusing that predicate here
    // would refuse every coordinator write whenever no Specialist was running — which is
    // almost always. A coordinator that cannot edit its own repository is not a fence.
    const mod = await loadExtension();
    expect(await fire(mod, () => ({ allow: true }), 'write')).toBeUndefined();
  });

  it('fails OPEN when the admission check throws', async () => {
    // This handler runs on the operator's own session. A bug here must never be the reason
    // they cannot write; a fence that misses a block is recoverable, one that wrongly blocks
    // the operator is not.
    const mod = await loadExtension();
    const out = await fire(mod, () => { throw new Error('lease store unreadable'); }, 'write');
    expect(out).toBeUndefined();
  });

  it('registers on tool_call, the only hook that can block before execution', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    mod.installCoordinatorFence(pi, {
      admitCoordinatorToolCall: () => ({ allow: true }),
      leaseScopeFor: () => ({ worktreePath: '/ws', repositoryRoot: '/ws' }),
      cwd: '/ws',
    });
    expect(pi.handlers['tool_call']?.length).toBe(1);
  });
});

describe('specialist_list progressive disclosure (operator report 2026-09-08)', () => {
  // The unconditional form returned 32 specialists x 9 fields = 16,161 bytes over 357 lines,
  // 44% of it `description` prose. A coordinator scanning the registry to pick one specialist
  // never needs that; it needs the name, the tier, and why something is unavailable.

  async function list(args: Record<string, unknown>) {
    const mod = await loadExtension();
    const pi = makeFakePi();
    mod.default(pi, { createHost: () => makeFakeHost().host });
    return resultText(await toolNamed(pi, 'specialist_list').execute('tc1', args));
  }

  it('omits description and the other drill-down fields by default', async () => {
    const out = await list({});
    expect(out.detail).toBe('compact');
    expect(out.specialists.length).toBeGreaterThan(0);
    for (const row of out.specialists) {
      expect(row).not.toHaveProperty('description');
      expect(row).not.toHaveProperty('scope');
      expect(row).not.toHaveProperty('version');
      expect(row).not.toHaveProperty('source');
      expect(row.name).toBeTruthy();
      expect(row.tier).toBeTruthy();
    }
  });

  it('always reports dispatchable, and carries a reason only when it is false', async () => {
    // dispatchable stays on every row even though omitting it when true would save bytes:
    // absence would then mean "dispatchable", which is indistinguishable from the field
    // going missing through a bug. The reason is conditional because there is no reason
    // when nothing is wrong.
    const out = await list({});
    for (const row of out.specialists) {
      expect(typeof row.dispatchable).toBe('boolean');
      if (row.dispatchable === false) expect(row.reason).toBeTruthy();
      else expect(row).not.toHaveProperty('reason');
    }
    expect(typeof out.undispatchable).toBe('number');
  });

  it('returns one full record, description included, for name=', async () => {
    const all = await list({});
    const target = all.specialists[0].name;
    const out = await list({ name: target });
    expect(out.specialist.name).toBe(target);
    expect(out.specialist).toHaveProperty('description');
  });

  it('names what IS known when asked for a specialist that is not', async () => {
    const out = await list({ name: 'no-such-specialist' });
    expect(out.error).toMatch(/Unknown specialist/);
    expect(Array.isArray(out.known)).toBe(true);
    expect(out.known.length).toBeGreaterThan(0);
  });

  it('keeps the full dump reachable, so nothing is lost', async () => {
    const out = await list({ detail: 'full' });
    expect(out.detail).toBe('full');
    expect(out.specialists[0]).toHaveProperty('description');
  });

  it('is materially smaller than the full dump', async () => {
    const compact = JSON.stringify(await list({}));
    const full = JSON.stringify(await list({ detail: 'full' }));
    expect(compact.length).toBeLessThan(full.length / 3);
  });
});
