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
    Integer: (opts = {}) => ({ type: 'integer', ...opts }),
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
  const painted = { widgets: {}, widgetOptions: {}, statuses: {}, notices: [], customs: [] };
  return {
    hasUI,
    mode,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      setWidget: (key, content, options) => { painted.widgets[key] = content; painted.widgetOptions[key] = options; },
      setStatus: (key, text) => { painted.statuses[key] = text; },
      notify: (message, level = 'info') => { painted.notices.push([message, level]); },
      // Default: RPC degrade — custom() returns undefined like rpc-mode.ts.
      custom: (...args) => { painted.customs.push(args); return Promise.resolve(undefined); },
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

  it('thinking_override passes through on bead_id dispatch, omitted by default', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    const { host, calls } = makeFakeHost();
    mod.default(pi, { createHost: () => host });
    const dispatch = toolNamed(pi, 'specialist_dispatch');
    await dispatch.execute('tc1', { specialist: 'explorer', bead_id: 'bd-1', thinking_override: 'high' });
    expect(calls.start[0]).toMatchObject({ thinkingOverride: 'high' });
    await dispatch.execute('tc2', { specialist: 'explorer', bead_id: 'bd-1' });
    expect(calls.start[1]).not.toHaveProperty('thinkingOverride');
  });

  it('epic_context_depth passes through on bead_id dispatch, omitted by default', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    const { host, calls } = makeFakeHost();
    mod.default(pi, { createHost: () => host });
    const dispatch = toolNamed(pi, 'specialist_dispatch');
    await dispatch.execute('tc1', { specialist: 'explorer', bead_id: 'bd-1', epic_context_depth: 2 });
    expect(calls.start[0]).toMatchObject({ epicContextDepth: 2 });
    await dispatch.execute('tc2', { specialist: 'explorer', bead_id: 'bd-1' });
    expect(calls.start[1]).not.toHaveProperty('epicContextDepth');
  });

  it('epic_context_depth refuses values outside 1|2 without dispatching', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    const { host } = makeFakeHost();
    mod.default(pi, { createHost: () => host });
    const dispatch = toolNamed(pi, 'specialist_dispatch');
    for (const bad of [0, 3, -1]) {
      const out = resultText(await dispatch.execute('tc1', {
        specialist: 'explorer', bead_id: 'bd-1', epic_context_depth: bad,
      }));
      expect(out.status).toBe('rejected');
      expect(out.reason).toContain('epic_context_depth must be 1 or 2');
    }
    expect(host.start).not.toHaveBeenCalled();
  });

  it('inline contract dispatch carries no lineage even with epic_context_depth', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    const { host, calls } = makeFakeHost();
    const createBead = vi.fn(() => 'bd-inline-1');
    mod.default(pi, { createHost: () => host, createBead });
    const out = resultText(await toolNamed(pi, 'specialist_dispatch').execute('tc1', {
      specialist: 'explorer',
      contract: INLINE_CONTRACT,
      epic_context_depth: 2,
    }));
    expect(out.status).toBe('dispatched');
    expect(calls.start[0]).not.toHaveProperty('epicContextDepth');
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
    // Was `toContain('sp help')`. The operator ruled the CLI out entirely — sp is deferred
    // while this extension is what runs Specialists — so the listing must point at
    // specialist_dispatch, not at a shell (unitAI-rrdnt.63).
    expect(out.note).toMatch(/Do not shell out/i);
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
  async function boot(ctxOptions, extOptions = {}) {
    const mod = await loadExtension();
    const pi = makeFakePi();
    const { host, calls } = makeFakeHost();
    mod.default(pi, { createHost: () => host, ...extOptions });
    const ctx = makeFakeCtx(ctxOptions);
    await pi.fire('session_start', { type: 'session_start' }, ctx);
    const command = (name) => pi.commands.find((c) => c.name === name);
    return { pi, host, calls, ctx, command, mod };
  }

  it('registers the /specialists operator commands with /fleet compat aliases', async () => {
    const { pi } = await boot();
    expect(pi.commands.map((c) => c.name)).toEqual(['specialists', 'fleet', 'specialists:reply', 'fleet:reply', 'specialists:stop', 'fleet:stop', 'specialists:resume', 'fleet:resume']);
  });

  it('names /specialists in help and collapsed hints, never /fleet (unitAI-beqby.6)', async () => {
    const { pi, mod } = await boot();
    for (const cmd of pi.commands) {
      expect(cmd.description).not.toContain('/fleet');
    }
    expect(mod.renderCollapsedLine({ activations: [], asks: [] })).not.toContain('/fleet');
    const asking = {
      activations: [{
        activation_id: 'act:aaaa', participant_id: 'p', attempt_id: 'a',
        specialist: 'explorer', bead_id: 'bd-1', state: 'running',
        resolved_model: 'm', elapsed_s: 5, last_activity_at: Math.floor(Date.now() / 1000),
      }],
      asks: [{ message_id: 'msg:1', kind: 'question', activation_id: 'act:aaaa', from: 'x', body: 'Which?' }],
    };
    expect(mod.renderCollapsedLine(asking)).not.toContain('/fleet');
    expect(mod.renderCollapsedLine(asking)).toContain('/specialists:reply');
  });

  it('/fleet aliases still reach the /specialists handlers (unitAI-beqby.6)', async () => {
    const { pi, host, ctx, command } = await boot({ hasUI: true, mode: 'tui' });
    await toolNamed(pi, 'specialist_status').execute('tc0', {});
    await command('fleet').handler('inspect', ctx);
    expect(ctx.painted.notices.at(-1)[0]).toContain('specialists');
    const fleetReply = pi.commands.find((c) => c.name === 'fleet:reply');
    host.answer.mockResolvedValueOnce({ messageId: 'msg:1', activationId: 'act:aaaa' });
    await fleetReply.handler('msg:1 alias answer', ctx);
    expect(ctx.painted.notices.at(-1)[0]).toContain('Answered msg:1');
  });

  it('/specialists:resume resumes in place and refuses an unknown id (unitAI-beqby.6, unitAI-beqby.7)', async () => {
    const { host, calls, ctx, command } = await boot();
    await command('specialists:resume').handler('act:aaaa continue with option two', ctx);
    expect(calls.resume).toEqual([['act:aaaa', 'continue with option two']]);
    expect(ctx.painted.notices.at(-1)[0]).toContain('Resumed act:aaaa');

    host.inspect.mockReturnValueOnce(undefined);
    await command('specialists:resume').handler('act:zzzz anything', ctx);
    expect(calls.resume).toHaveLength(1);
    expect(ctx.painted.notices.at(-1)).toEqual(['Unknown activation: act:zzzz', 'warning']);

    await command('specialists:resume').handler('act:aaaa', ctx);
    expect(calls.resume).toHaveLength(1);
    expect(ctx.painted.notices.at(-1)[1]).toBe('warning');
  });

  it('registers a footer section when the seam exists, and paints no widget and no setStatus', async () => {
    const sections = new Map();
    const registerFooterSection = (key, renderBelow) => { sections.set(key, renderBelow); return () => { sections.delete(key); }; };
    const { pi, ctx } = await boot(undefined, { registerFooterSection });
    await toolNamed(pi, 'specialist_status').execute('tc0', {});   // specialist_status creates the host
    await command_tick();
    expect(sections.has('specialist-fleet')).toBe(true);
    expect(ctx.painted.widgets['specialist-fleet']).toBeUndefined();
    expect(ctx.painted.statuses['specialist-fleet']).toBeUndefined();
    const lines = sections.get('specialist-fleet')(80);
    expect(lines[0]).toContain('specialists');
    expect(lines[0]).toContain('need reply');
  });

  it('registers through the globalThis hook when present (core custom-footer loaded)', async () => {
    const sections = new Map();
    const prev = (globalThis as any).__registerFooterSection;
    (globalThis as any).__registerFooterSection = (key, renderBelow) => { sections.set(key, renderBelow); return () => { sections.delete(key); }; };
    try {
      const { pi, ctx } = await boot();   // no options seam: the global hook is the only path
      await toolNamed(pi, 'specialist_status').execute('tc0', {});
      await command_tick();
      expect(sections.has('specialist-fleet')).toBe(true);
      expect(ctx.painted.widgets['specialist-fleet']).toBeUndefined();
      expect(ctx.painted.statuses['specialist-fleet']).toBeUndefined();
      const lines = sections.get('specialist-fleet')(80);
      expect(lines[0]).toContain('specialists');
      expect(lines[0]).toContain('need reply');
    } finally {
      if (prev === undefined) delete (globalThis as any).__registerFooterSection;
      else (globalThis as any).__registerFooterSection = prev;
    }
  });

  it('stays hidden when the seam is absent — never paints a widget (unitAI-beqby.9)', async () => {
    const { pi, ctx } = await boot();
    await toolNamed(pi, 'specialist_status').execute('tc0', {});
    await command_tick();
    expect(ctx.painted.widgets['specialist-fleet']).toBeUndefined();
    expect(ctx.painted.statuses['specialist-fleet']).toBeUndefined();
    for (const options of Object.values(ctx.painted.widgetOptions)) {
      expect(options?.placement).not.toBe('aboveEditor');
      expect(options?.placement).not.toBe('belowEditor');
    }
  });

  it('collapsed line prioritises needs-reply and row lines carry no forensic ids', async () => {
    const { mod } = await boot();
    // unitAI-4n9of: hint names only working triggers, never arrow keys.
    const idle = mod.renderCollapsedLine({ activations: [], asks: [] });
    expect(idle).toContain('idle');
    expect(idle).toContain('/specialists inspect');
    expect(idle).not.toContain('↓');
    expect(idle).not.toContain('←');
    const fleet = {
      activations: [{
        activation_id: 'act:aaaa', participant_id: 'p', attempt_id: 'a',
        specialist: 'explorer', bead_id: 'bd-1', state: 'running',
        resolved_model: 'm', thinking_level: 'high', elapsed_s: 180,
        token_usage: { input: 800, output: 400, cache: 0 }, last_activity_at: Math.floor(Date.now() / 1000),
      }],
      asks: [{ message_id: 'msg:1', kind: 'question', activation_id: 'act:aaaa', from: 'x', body: 'Which option?' }],
    };
    expect(mod.renderCollapsedLine(fleet)).toContain('1 need reply');
    expect(mod.renderCollapsedLine(fleet)).toContain('/specialists inspect');
    expect(mod.renderCollapsedLine(fleet)).toContain('/specialists:reply');
    expect(mod.renderCollapsedLine(fleet)).not.toContain('↓');
    expect(mod.renderCollapsedLine(fleet)).not.toContain('←');
    const rows = mod.renderSectionLines(fleet, { expanded: true });
    expect(rows[1]).toContain('explorer');
    expect(rows[1]).toContain('bd-1');
    expect(rows[1]).not.toContain('act:aaaa');
    expect(rows[1]).not.toContain('msg:1');
  });

  it('bounds expanded rows with an overflow line', async () => {
    const { mod } = await boot();
    const activations = Array.from({ length: mod.FLEET_MAX_ROWS + 3 }, (_, i) => ({
      activation_id: `act:${i}`, specialist: `spec-${i}`, bead_id: 'bd-1', state: 'running',
      resolved_model: 'm', elapsed_s: 10,
    }));
    const lines = mod.renderSectionLines({ activations, asks: [] }, { expanded: true });
    expect(lines).toHaveLength(mod.FLEET_MAX_ROWS + 2); // collapsed + rows + overflow
    expect(lines.at(-1)).toContain('+3 more');
  });

  it('/specialists inspect degrades to text when ui.custom is unavailable (RPC)', async () => {
    const { command, ctx } = await boot({ hasUI: true, mode: 'tui' });
    ctx.ui.custom = undefined;
    await command('specialists').handler('inspect', ctx);
    expect(ctx.painted.notices.at(-1)[0]).toContain('specialists');
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

  it('/specialists hide/show report text and never paint a widget without the seam', async () => {
    const { pi, ctx, command } = await boot();
    await toolNamed(pi, 'specialist_status').execute('tc0', {});
    await command('specialists').handler('hide', ctx);
    expect(ctx.painted.widgets['specialist-fleet']).toBeUndefined();
    expect(ctx.painted.notices.at(-1)[0]).toContain('specialists');
    await command('specialists').handler('show', ctx);
    expect(ctx.painted.widgets['specialist-fleet']).toBeUndefined();
    expect(ctx.painted.notices.at(-1)[0]).toContain('specialists');
  });

  it('/specialists inspect prints the expanded text report and never mounts ui.custom (unitAI-nmxhg)', async () => {
    const { pi, ctx, command } = await boot({ hasUI: true, mode: 'tui' });
    await toolNamed(pi, 'specialist_status').execute('tc0', {});
    const custom = vi.fn((...args) => { ctx.painted.customs.push(args); return Promise.resolve(undefined); });
    ctx.ui.custom = custom;
    await command('specialists').handler('inspect', ctx);
    expect(custom).not.toHaveBeenCalled(); // no custom-pane mount anywhere on the specialists path
    const text = ctx.painted.notices.at(-1)[0];
    expect(text).toContain('specialists');
    expect(text).toContain('explorer'); // expanded rows, not the collapsed line alone
  });

  it('renders expanded rows by default; /specialists collapse opts out, /specialists expand is a no-op', async () => {
    const { pi, ctx, command, mod } = await boot({ hasUI: true, mode: 'tui' });
    await toolNamed(pi, 'specialist_status').execute('tc0', {});
    // Unit default: no opts means expanded.
    const fleet = {
      activations: [{
        activation_id: 'act:aaaa', specialist: 'researcher', bead_id: 'ISSUE-92',
        state: 'running', resolved_model: 'gpt-5.6-sol', thinking_level: 'high',
        elapsed_s: 47, token_usage: { input: 1500, output: 600, cache: 0 },
        last_activity_at: Math.floor(Date.now() / 1000),
      }],
      asks: [],
    };
    const lines = mod.renderSectionLines(fleet);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[1]).toMatch(/⠧ researcher \(gpt-5\.6-sol high\) · ISSUE-92 · running 47s · 2\.1k · working/);
    expect(lines[1]).not.toContain('spent');
    // Command default: /specialists with no action reports the expanded rows.
    await command('specialists').handler('', ctx);
    expect(ctx.painted.notices.at(-1)[0].split('\n').length).toBeGreaterThan(1);
    expect(ctx.painted.notices.at(-1)[0]).toContain('explorer');
    // Opt-out: collapse drops to the single line.
    await command('specialists').handler('collapse', ctx);
    expect(ctx.painted.notices.at(-1)[0].split('\n')).toHaveLength(1);
    // Expand restores the default rows (no-op when already expanded).
    await command('specialists').handler('expand', ctx);
    expect(ctx.painted.notices.at(-1)[0].split('\n').length).toBeGreaterThan(1);
  });

  it('specialists mapping never yields index-derived elapsed (unitAI-d99hb)', async () => {
    const sections = new Map();
    const registerFooterSection = (key, render) => { sections.set(key, render); return () => { sections.delete(key); }; };
    const { pi, host } = await boot(undefined, { registerFooterSection });
    await toolNamed(pi, 'specialist_status').execute('tc0', {});
    const startedAt = Date.now() - 41000;
    host.list.mockReturnValue([0, 1].map((i) => ({
      ...SNAPSHOT,
      activationId: `act:live${i}`,
      specialist: `spec-${i}`,
      startedAt,
      lastActivityAt: Math.floor(Date.now() / 1000),
    })));
    host.pendingAsks.mockReturnValue([]);
    const text = (sections.get('specialist-fleet')() ?? []).join('\n');
    // Bare `.map(toActivationView)` passed the element index as nowMs, freezing
    // every row at 0s. Both rows must show live elapsed, neither 0s.
    expect(text).toMatch(/spec-0.*4[12]s/);
    expect(text).toMatch(/spec-1.*4[12]s/);
    expect(text).not.toMatch(/running 0s/);
  });

  it('zero/absent tokens render as nothing with no "spent" word (unitAI-d99hb)', async () => {
    const { mod } = await boot();
    const base = {
      activation_id: 'act:x', specialist: 'explorer', bead_id: 'bd-1', state: 'running',
      resolved_model: 'm', elapsed_s: 41, last_activity_at: Math.floor(Date.now() / 1000),
    };
    expect(mod.formatSpendShort(undefined)).toBe('');
    expect(mod.formatSpendShort({ input_tokens: 0, output_tokens: 0 })).toBe('');
    for (const view of [base, { ...base, token_usage: { input_tokens: 0, output_tokens: 0 } }]) {
      const row = mod.renderFleetRowLine(view);
      expect(row).toBe('    ⠙ explorer (m) · bd-1 · running 41s · working');
      expect(row).not.toContain('spent');
    }
  });

  it('renders live snake_case token usage as a bare count (unitAI-d99hb)', async () => {
    const { mod } = await boot();
    expect(mod.formatSpendShort({ input_tokens: 1500, output_tokens: 600 })).toBe('2.1k');
    const row = mod.renderFleetRowLine({
      activation_id: 'act:x', specialist: 'researcher', bead_id: 'ISSUE-92',
      state: 'running', resolved_model: 'gpt-5.6-sol', thinking_level: 'high',
      elapsed_s: 47, token_usage: { input_tokens: 1500, output_tokens: 600 },
      last_activity_at: Math.floor(Date.now() / 1000),
    });
    expect(row).toMatch(/running 47s · 2\.1k · working/);
    expect(row.startsWith('    ⠧ ')).toBe(true); // 47 % 10 = frame 7
    expect(row).not.toContain('spent');
  });

  it('working rows tick a braille spinner from elapsed_s; other rows keep markers (unitAI-beqby.18)', async () => {
    const { mod } = await boot();
    const base = {
      activation_id: 'act:x', specialist: 'explorer', bead_id: 'bd-1', state: 'running',
      resolved_model: 'm', last_activity_at: Math.floor(Date.now() / 1000),
    };
    // Deterministic: same elapsed_s always yields the same frame, no Date.now in the choice.
    expect(mod.renderFleetRowLine({ ...base, elapsed_s: 41 }))
      .toBe(mod.renderFleetRowLine({ ...base, elapsed_s: 41 }));
    expect(mod.renderFleetRowLine({ ...base, elapsed_s: 41 }))
      .toBe('    ⠙ explorer (m) · bd-1 · running 41s · working');
    expect(mod.renderFleetRowLine({ ...base, elapsed_s: 42 }))
      .toBe('    ⠹ explorer (m) · bd-1 · running 42s · working');
    // Settled rows keep ●; idle (>30s quiet) keeps ●; needs-reply keeps !.
    expect(mod.renderFleetRowLine({ ...base, state: 'done', elapsed_s: 41 }))
      .toBe('    ● explorer (m) · bd-1 · done 41s · done');
    expect(mod.renderFleetRowLine({ ...base, elapsed_s: 41, last_activity_at: Math.floor(Date.now() / 1000) - 60 }))
      .toMatch(/^    ● .* · idle 60s/);
    const askRow = mod.renderFleetRowLine({ ...base, elapsed_s: 41 }, [
      { activation_id: 'act:x', asked_at: Math.floor(Date.now() / 1000) - 5 },
    ]);
    expect(askRow.startsWith('    ! ')).toBe(true);
  });

  it('needs-reply rows render with a ! marker and sort before idle rows (unitAI-nmxhg)', async () => {
    const { mod } = await boot();
    const now = Math.floor(Date.now() / 1000);
    const fleet = {
      activations: [
        {
          activation_id: 'act:idle', specialist: 'researcher', bead_id: 'ISSUE-92',
          state: 'running', resolved_model: 'gpt-5.6-sol', thinking_level: 'high',
          elapsed_s: 47, token_usage: { input: 1500, output: 600, cache: 0 },
          last_activity_at: now,
        },
        {
          activation_id: 'act:ask', specialist: 'reviewer', bead_id: 'ISSUE-92',
          state: 'running', resolved_model: 'gpt-5.6-sol', thinking_level: 'high',
          elapsed_s: 90, token_usage: { input: 500, output: 200, cache: 0 },
          last_activity_at: now,
        },
      ],
      asks: [{
        message_id: 'msg:1', kind: 'question', activation_id: 'act:ask',
        from: 'x', body: 'Which option?', asked_at: now - 31,
      }],
    };
    const lines = mod.renderSectionLines(fleet);
    expect(lines[1]).toMatch(/! reviewer \(gpt-5\.6-sol high\) · ISSUE-92 · needs reply 31s/);
    expect(lines[2]).toContain('⠧ researcher');
    expect(lines.join('\n')).not.toContain('act:ask'); // no forensic ids in rows
  });

  it('/specialists reports in text too, so json and print modes are not blind', async () => {
    const { pi, ctx, command } = await boot();
    await toolNamed(pi, 'specialist_status').execute('tc0', {});
    await command('specialists').handler('', ctx);
    expect(ctx.painted.notices.at(-1)[0]).toContain('specialists');
  });

  it('/specialists:reply answers by message_id and reports an unknown id instead of silently passing', async () => {
    const { host, ctx, command } = await boot();
    // mockResolvedValueOnce replaces the implementation, so assert on the spy's
    // arguments rather than on the recorder the default implementation feeds.
    host.answer.mockResolvedValueOnce({ messageId: 'msg:1', activationId: 'act:aaaa' });
    await command('specialists:reply').handler('msg:1 use the second option', ctx);
    expect(host.answer).toHaveBeenCalledWith('msg:1', 'use the second option');
    expect(ctx.painted.notices.at(-1)[0]).toContain('Answered msg:1');

    // host.answer returns undefined for an unknown id.
    await command('specialists:reply').handler('msg:nope anything', ctx);
    expect(ctx.painted.notices.at(-1)).toEqual([
      expect.stringContaining("No outstanding ask with message_id 'msg:nope'"),
      'warning',
    ]);
  });

  it('/specialists:reply rejects a missing body rather than answering with an empty string', async () => {
    const { calls, ctx, command } = await boot();
    await command('specialists:reply').handler('msg:1', ctx);
    await command('specialists:reply').handler('msg:1    ', ctx);
    expect(calls.answer).toEqual([]);
    expect(ctx.painted.notices.at(-1)[1]).toBe('warning');
  });

  it('/specialists:stop disposes a known activation and refuses an unknown one', async () => {
    const { host, calls, ctx, command } = await boot();
    await command('specialists:stop').handler('act:aaaa operator changed their mind', ctx);
    expect(calls.stop).toEqual([['act:aaaa', 'operator changed their mind']]);

    host.inspect.mockReturnValueOnce(undefined);
    await command('specialists:stop').handler('act:zzzz', ctx);
    expect(calls.stop).toHaveLength(1);
    expect(ctx.painted.notices.at(-1)).toEqual(['Unknown activation: act:zzzz', 'warning']);
  });

  it('completes message ids and activation ids from live host state', async () => {
    const { pi, command } = await boot();
    await toolNamed(pi, 'specialist_status').execute('tc0', {});
    expect(command('specialists:reply').getArgumentCompletions('msg').map((i) => i.value)).toEqual(['msg:1']);
    expect(command('specialists:stop').getArgumentCompletions('act').map((i) => i.value)).toEqual(['act:aaaa']);
    expect(command('specialists:reply').getArgumentCompletions('nomatch')).toBeNull();
    expect(command('specialists').getArgumentCompletions('h').map((i) => i.value)).toEqual(['hide']);
  });

  it('does not install the view without UI, and never throws there', async () => {
    const { pi, ctx, command } = await boot({ hasUI: false, mode: 'print' });
    await toolNamed(pi, 'specialist_status').execute('tc0', {});
    await command('specialists').handler('', ctx);
    expect(ctx.painted.widgets['specialist-fleet']).toBeUndefined();
    expect(ctx.painted.notices).toEqual([]);   // report() falls back to console
  });

  it('paints nothing without the seam, even across a session switch', async () => {
    const { pi, ctx } = await boot();
    await toolNamed(pi, 'specialist_status').execute('tc0', {});
    await command_tick();
    expect(ctx.painted.widgets['specialist-fleet']).toBeUndefined();

    // A switchSession keeps the same ctx object but changes the session id.
    // Hide-until-seam paints no widget into any context, stale or live.
    ctx.sessionManager.getSessionId = () => 'session-2';
    await command_tick();
    expect(ctx.painted.widgets['specialist-fleet']).toBeUndefined();
  });

  it('survives a context that throws on property access during teardown', async () => {
    const { pi, ctx } = await boot();
    await toolNamed(pi, 'specialist_status').execute('tc0', {});
    ctx.sessionManager.getSessionId = () => { throw new Error('session torn down'); };
    await expect(command_tick(pi, ctx)).resolves.not.toThrow();
  });
});

/**
 * Advance one (former) poll interval. Kept so seam-absent tests assert
 * steadiness across ticks: with hide-until-seam there is no timer, so this
 * is a no-op that proves nothing gets painted late either.
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

  it('is smaller than the full dump, and carries none of its prose', async () => {
    // The first version of this asserted compact < full/3 and passed locally at 13x while
    // FAILING in CI at 2.15x. The ratio is a property of the environment, not of the code:
    // where most specialists are undispatchable, refusal reasons dominate the payload. CI
    // caught an assertion I wrote that measured the fixture rather than the behaviour.
    // What is invariant is that compact drops the drill-down prose and is strictly smaller.
    const compactRows = (await list({})).specialists;
    const fullRows = (await list({ detail: 'full' })).specialists;

    expect(JSON.stringify(compactRows).length).toBeLessThan(JSON.stringify(fullRows).length);
    const compactText = JSON.stringify(compactRows);
    for (const row of fullRows) {
      if (row.description && row.description.length > 40) {
        expect(compactText).not.toContain(row.description);
      }
    }
  });

  it('truncates the refusal reason in compact and keeps it whole under name=', async () => {
    const out = await list({});
    for (const row of out.specialists) {
      if (row.dispatchable === false) expect(row.reason.length).toBeLessThanOrEqual(120);
    }
  });
});

describe('dispatch guidance must not route work off the native runtime', () => {
  // A live coordinator asked a small bounded question about the repo and answered it by
  // shelling out to `sp run --prompt` as a background task, because the contract parameter
  // told it that native dispatch "is not the path for a throwaway question". That guidance
  // was mine and it was wrong three ways: PRD Phase 13 says NO CLI shell-out; the shelled
  // run has no Fleet entry, no ask/answer channel, no lease and no forensics; and the
  // premise was false, since a short contract is a perfectly good contract.

  it('no tool description anywhere routes the coordinator to the specialists CLI', async () => {
    // Widened from specialist_dispatch to EVERY tool after the operator ruled the CLI out
    // entirely: the sp CLI is deferred while this extension is what runs Specialists, so a
    // one-off either lives in the extension or does not exist. specialist_list was the other
    // offender — its every answer ended with 'Full CLI surface: sp help', which is precisely
    // the moment a coordinator is deciding how to delegate.
    const mod = await loadExtension();
    const pi = makeFakePi();
    mod.default(pi, { createHost: () => makeFakeHost().host });

    for (const tool of pi.tools as Array<{ name: string; description?: string;
      parameters?: { properties?: Record<string, { description?: string }> } }>) {
      const text = [
        tool.description ?? '',
        ...Object.values(tool.parameters?.properties ?? {}).map((p) => p.description ?? ''),
      ].join(' ');
      expect(text, `${tool.name} routes to the CLI`).not.toMatch(/\bsp (run|help|ps|feed)\b/);
      expect(text, `${tool.name} disparages the native path`).not.toMatch(/not the path for/i);
    }
  });

  it('does not put the CLI in a listing RESULT either', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    mod.default(pi, { createHost: () => makeFakeHost().host });
    const out = resultText(await toolNamed(pi, 'specialist_list').execute('tc1', {}));
    expect(JSON.stringify(out)).not.toMatch(/\bsp (run|help)\b/);
    expect(out.note).toMatch(/Do not shell out/i);
  });

  it('says small work belongs here too', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    mod.default(pi, { createHost: () => makeFakeHost().host });
    const dispatch = toolNamed(pi, 'specialist_dispatch') as unknown as {
      parameters: { properties?: Record<string, { description?: string }> };
    };
    const contract = dispatch.parameters?.properties?.contract?.description ?? '';
    expect(contract).toMatch(/small|quick|short contract/i);
  });
});

describe('settlement wake — a finished child notifies its coordinator (unitAI-rrdnt.64)', () => {
  // The operator's original complaint was "he started polling for results". The ask wake
  // (.45) fixed only asks; a coordinator that dispatched and waited still had to poll to
  // learn anything had finished. The .46 Fleet widget does not close it either — it repaints
  // for an operator watching a TUI and never wakes the coordinator model.

  const ev = (name: string, payload?: Record<string, unknown>) => ({
    activationId: 'act:aaaa', attemptId: 'att:aaaa:1', participantId: 'specialist::explorer',
    specialist: 'explorer', beadId: 'bd-1', name, payload,
  });

  function observe() {
    const asks: unknown[] = [];
    const done: any[] = [];
    return { asks, done, sink: (mod: any) => mod.createAskObserverSink(
      { emit: () => {} }, (a: unknown) => asks.push(a), (d: unknown) => done.push(d)) };
  }

  it('reports completion and failure, and reports each exactly once', async () => {
    const mod = await loadExtension();
    const o = observe();
    const sink = o.sink(mod);

    sink.emit(ev('activation_settled'));            // precedes validation — must NOT wake
    sink.emit(ev('activation_completed'));
    sink.emit(ev('activation_failed', { error: 'provider 429' }));

    expect(o.done.map((d) => d.outcome)).toEqual(['completed', 'failed']);
    expect(o.done[1].error).toBe('provider 429');
    expect(o.asks).toEqual([]);
  });

  it('does not wake on admission refusal, which is a synchronous tool result', async () => {
    // A refusal is the return value of the dispatch call the coordinator is already blocked
    // on, so there is no asynchronous window for silence to hide in. A wake there would be
    // redundant, not missing — the bounded claim is that POST-ADMISSION events are silent.
    const mod = await loadExtension();
    const o = observe();
    o.sink(mod).emit(ev('activation_rejected', { reason: 'bead_contract_incomplete' }));
    expect(o.done).toEqual([]);
  });

  it('still forwards every event to the base sink', async () => {
    const mod = await loadExtension();
    const seen: string[] = [];
    const sink = mod.createAskObserverSink(
      { emit: (e: { name: string }) => seen.push(e.name) }, () => {}, () => {});
    sink.emit(ev('activation_completed'));
    sink.emit(ev('activation_rejected'));
    expect(seen).toEqual(['activation_completed', 'activation_rejected']);
  });

  it('survives a throwing settlement wake, because forensics outrank notification', async () => {
    const mod = await loadExtension();
    const seen: string[] = [];
    const sink = mod.createAskObserverSink(
      { emit: (e: { name: string }) => seen.push(e.name) },
      () => {},
      () => { throw new Error('no coordinator'); },
    );
    expect(() => sink.emit(ev('activation_completed'))).not.toThrow();
    expect(seen).toEqual(['activation_completed']);
  });

  it('wake content carries the #8d7fe8 rail; rows and cards carry none (unitAI-beqby.17)', async () => {
    const mod = await loadExtension();
    expect(mod.RAIL).toBe('\x1b[38;2;141;127;232m│\x1b[0m');
    const wake = mod.formatSettlementWake({
      activationId: 'act:aaaa', specialist: 'explorer', beadId: 'bd-1', outcome: 'completed',
    });
    for (const line of wake.split('\n')) {
      expect(line.startsWith(mod.RAIL)).toBe(true);
    }
    const ask = mod.formatAskWake({
      activationId: 'act:aaaa', specialist: 'explorer', beadId: 'bd-1', kind: 'question', body: 'Which?',
    });
    for (const line of ask.split('\n')) {
      expect(line.startsWith(mod.RAIL)).toBe(true);
    }
    const row = mod.renderFleetRowLine({
      activation_id: 'act:x', specialist: 'explorer', bead_id: 'bd-1', state: 'running',
      resolved_model: 'm', elapsed_s: 41, last_activity_at: Math.floor(Date.now() / 1000),
    });
    expect(row).not.toContain(mod.RAIL);
    expect(mod.renderCollapsedLine({ activations: [], asks: [] })).not.toContain(mod.RAIL);
    for (const line of mod.renderSectionLines({ activations: [], asks: [] }, { expanded: true })) {
      expect(line).not.toContain(mod.RAIL);
    }
  });

  it('names the activation and says what to call next', async () => {
    const mod = await loadExtension();
    const ok = mod.formatSettlementWake({
      activationId: 'act:aaaa', specialist: 'explorer', beadId: 'bd-1', outcome: 'completed',
    });
    expect(ok).toMatch(/act:aaaa/);
    expect(ok).toMatch(/specialist_status/);
    expect(ok).toMatch(/finished/);

    const bad = mod.formatSettlementWake({
      activationId: 'act:bbbb', specialist: 'executor', outcome: 'failed', error: 'provider 429',
    });
    expect(bad).toMatch(/FAILED/);
    expect(bad).toMatch(/provider 429/);
    // A failed activation is still resumable; saying so is the difference between an
    // operator retrying and an operator starting over.
    expect(bad).toMatch(/specialist_resume/);
  });

  it('the flag description no longer claims the wake is ask-only', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    mod.default(pi, { createHost: () => makeFakeHost().host });
    const flag = pi.registeredFlags['no-specialist-wake'];
    expect(flag.description).toMatch(/finishes or fails/i);
  });
});

describe('build identity on every outcome surface (unitAI-rrdnt.55)', () => {
  // The pinned requirement: identity rides the refusal, the status read, and the
  // successful dispatch alike — the incident behind the bead was a successful
  // dispatch whose build the coordinator could not name.

  it('a bead-path refusal carries the loaded build, matching the file on disk', async () => {
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
    expect(out.build).toContain('build: ');
    // The test process loaded this same dist file, so loaded and on-disk agree.
    expect(out.build).toContain('(loaded module matches the file on disk)');
  });

  it('an inline-contract refusal carries the build identity too', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    const { host } = makeFakeHost();
    mod.default(pi, { createHost: () => host });
    const out = resultText(await toolNamed(pi, 'specialist_dispatch').execute('tc1', {
      specialist: 'explorer',
      contract: 'PROBLEM\nMissing everything else.',
    }));
    expect(out.status).toBe('rejected');
    expect(out.build).toContain('build: ');
  });

  it('a successful dispatch result carries the build identity', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    const { host } = makeFakeHost();
    mod.default(pi, { createHost: () => host });
    const out = resultText(await toolNamed(pi, 'specialist_dispatch').execute('tc1', { specialist: 'explorer', bead_id: 'bd-1' }));
    expect(out.status).toBe('dispatched');
    expect(out.build).toContain('build: ');
  });

  it('specialist_status carries the build identity', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    mod.default(pi, { createHost: () => makeFakeHost().host });
    const out = resultText(await toolNamed(pi, 'specialist_status').execute('tc1', {}));
    expect(out.build).toContain('build: ');
  });

  it('annexBuildIdentity names staleness when the on-disk build moved', async () => {
    const mod = await loadExtension();
    const out = mod.annexBuildIdentity({ status: 'rejected' }, 'aaaabbbbcccc', 'ddddffff0000');
    expect(out.status).toBe('rejected');
    expect(out.build).toContain('module loaded aaaabbbbcccc, file on disk ddddffff0000');
    expect(out.build).toContain('rebuilt after');
  });
});

describe('duty to stop unneeded activations (unitAI-llvfi)', () => {
  // A settled activation keeps its session and Fleet entry until explicitly
  // stopped — nothing expires it. The descriptions must say so normatively.
  // Proven by the smoke-test activation that sat in the Fleet until ordered out.

  it('specialist_stop_activation states the duty normatively', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    mod.default(pi, { createHost: () => makeFakeHost().host });
    const desc = toolNamed(pi, 'specialist_stop_activation').description;
    expect(desc).toContain('You MUST stop every activation you are unlikely');
    expect(desc).toContain('until YOU stop it');
    expect(desc).toContain('nothing expires it for you');
  });

  it('specialist_status says entries persist until stopped', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    mod.default(pi, { createHost: () => makeFakeHost().host });
    const desc = toolNamed(pi, 'specialist_status').description;
    expect(desc).toContain('stay listed until stopped');
    expect(desc).toContain('every activation you will not resume');
  });

  it('specialist_dispatch states ownership of the activation', async () => {
    const mod = await loadExtension();
    const pi = makeFakePi();
    mod.default(pi, { createHost: () => makeFakeHost().host });
    const desc = toolNamed(pi, 'specialist_dispatch').description;
    expect(desc).toContain('creates a persistent activation YOU own');
    expect(desc).toContain('specialist_stop_activation when you are done');
  });
});

describe('human-readable tool-result views (unitAI-55yjs)', () => {
  // renderResult changes only what the operator SEES: content[].text stays the
  // byte-identical machine JSON the coordinator parses. Every test below asserts
  // both halves — the human line renders, and resultText() round-trips unchanged.
  async function setup() {
    const mod = await loadExtension();
    const pi = makeFakePi();
    const { host } = makeFakeHost();
    mod.default(pi, { createHost: () => host });
    return { pi, host };
  }

  function linesOf(tool: { renderResult?: Function }, result: unknown, expanded = false) {
    expect(typeof tool.renderResult).toBe('function');
    const component = tool.renderResult(result, { expanded }, {}, {});
    const lines = component.render(80);
    expect(Array.isArray(lines)).toBe(true);
    return (lines as string[]).join('\n');
  }

  function expectMachineJsonUnchanged(result: { content: { type: string; text: string }[] }) {
    const before = result.content[0].text;
    expect(() => JSON.parse(before)).not.toThrow();
    return before;
  }

  it('specialist_dispatch renders a dispatched line', async () => {
    const { pi } = await setup();
    const tool = toolNamed(pi, 'specialist_dispatch');
    const result = await tool.execute('tc1', { specialist: 'explorer', bead_id: 'bd-1' });
    const raw = expectMachineJsonUnchanged(result);
    expect(resultText(result).status).toBe('dispatched');
    const text = linesOf(tool, result);
    expect(text).toContain('Dispatched explorer on bd-1');
    expect(text).toContain('act:aaaa');
    expect(result.content[0].text).toBe(raw);
  });

  it('specialist_dispatch renders a rejection reason', async () => {
    const { pi } = await setup();
    const tool = toolNamed(pi, 'specialist_dispatch');
    const result = await tool.execute('tc1', { specialist: 'explorer', bead_id: 'bd-1', contract: 'x' });
    expectMachineJsonUnchanged(result);
    expect(resultText(result).status).toBe('rejected');
    expect(linesOf(tool, result)).toContain('Rejected:');
  });

  it('specialist_status renders fleet counts and rows', async () => {
    const { pi } = await setup();
    const tool = toolNamed(pi, 'specialist_status');
    const result = await tool.execute('tc1', {});
    expectMachineJsonUnchanged(result);
    expect(resultText(result).activations).toHaveLength(1);
    const text = linesOf(tool, result);
    expect(text).toContain('Fleet: 1 activation(s), 1 pending ask(s)');
    expect(text).toContain('explorer on bd-1');
    expect(text).toContain('msg:1');
  });

  it('specialist_reply renders answered and error outcomes', async () => {
    const { pi, host } = await setup();
    const tool = toolNamed(pi, 'specialist_reply');
    host.answer = vi.fn(async (messageId: string) => ({
      messageId, inReplyTo: null, activationId: 'act:aaaa', attemptId: 'att:aaaa:1',
    }));
    const answered = await tool.execute('tc1', { message_id: 'msg:1', body: 'Option A' });
    expectMachineJsonUnchanged(answered);
    expect(resultText(answered).status).toBe('answered');
    expect(linesOf(tool, answered)).toContain('Answered msg:1 for act:aaaa');
    host.answer = vi.fn(async () => undefined);
    const missing = await tool.execute('tc2', { message_id: 'msg:9', body: 'x' });
    expectMachineJsonUnchanged(missing);
    expect(resultText(missing).status).toBe('error');
    expect(linesOf(tool, missing)).toContain('msg:9');
  });

  it('specialist_resume renders the attempt advance', async () => {
    const { pi } = await setup();
    const tool = toolNamed(pi, 'specialist_resume');
    const result = await tool.execute('tc1', { activation_id: 'act:aaaa', prompt: 'more work' });
    expectMachineJsonUnchanged(result);
    expect(resultText(result).status).toBe('resumed');
    expect(linesOf(tool, result)).toContain('Resumed act:aaaa');
  });

  it('specialist_stop_activation renders the stopped id', async () => {
    const { pi } = await setup();
    const tool = toolNamed(pi, 'specialist_stop_activation');
    const result = await tool.execute('tc1', { activation_id: 'act:aaaa', reason: 'done' });
    expectMachineJsonUnchanged(result);
    expect(resultText(result).status).toBe('stopped');
    expect(linesOf(tool, result)).toContain('Stopped act:aaaa');
  });

  it('specialist_list renders registry counts and rows', async () => {
    const { pi } = await setup();
    const tool = toolNamed(pi, 'specialist_list');
    const result = await tool.execute('tc1', {});
    expectMachineJsonUnchanged(result);
    expect(resultText(result).detail).toBe('compact');
    expect(linesOf(tool, result)).toContain('Registry:');
  });

  it('expanded view appends the full JSON under the summary', async () => {
    const { pi } = await setup();
    const tool = toolNamed(pi, 'specialist_dispatch');
    const result = await tool.execute('tc1', { specialist: 'explorer', bead_id: 'bd-1' });
    const collapsed = linesOf(tool, result, false);
    expect(collapsed).not.toContain('"status": "dispatched"');
    const expanded = linesOf(tool, result, true);
    expect(expanded).toContain('Dispatched explorer on bd-1');
    expect(expanded).toContain('"status": "dispatched"');
  });
});

describe('renderer component contract (unitAI-q02sz)', () => {
  // pi wraps every tool renderResult/renderCall in a MouseRegion and walks
  // invalidate() on theme/resume. A renderer object without a callable
  // invalidate kills the session (this.child.invalidate is not a function).
  // Every custom renderer in the extension must satisfy this contract.
  async function setup() {
    const mod = await loadExtension();
    const pi = makeFakePi();
    const { host } = makeFakeHost();
    mod.default(pi, { createHost: () => host });
    return { pi, host };
  }

  const TOOL_CASES = [
    ['specialist_dispatch', { specialist: 'explorer', bead_id: 'bd-1' }],
    ['specialist_status', {}],
    ['specialist_reply', { message_id: 'msg:1', body: 'x' }],
    ['specialist_resume', { activation_id: 'act:aaaa', prompt: 'more' }],
    ['specialist_stop_activation', { activation_id: 'act:aaaa' }],
    ['specialist_list', {}],
  ] as const;

  it.each(TOOL_CASES)('%s renderResult exposes dispose/invalidate and array render', async (name, params) => {
    const { pi } = await setup();
    const tool = toolNamed(pi, name);
    expect(typeof tool.renderResult).toBe('function');
    const result = await tool.execute('tc1', params);
    const component = tool.renderResult(result, { expanded: false }, {}, {});
    expect(typeof component.dispose).toBe('function');
    expect(typeof component.invalidate).toBe('function');
    expect(() => component.invalidate()).not.toThrow();
    const lines = component.render(80);
    expect(Array.isArray(lines)).toBe(true);
    // Recomputed per render call: repeated renders agree (no first-call capture).
    expect(component.render(80)).toEqual(lines);
  });

  it.each([
    ['specialist_dispatch', { specialist: 'explorer', bead_id: 'bd-1' }],
    ['specialist_reply', { message_id: 'msg:1', body: 'x' }],
    ['specialist_resume', { activation_id: 'act:aaaa', prompt: 'more' }],
    ['specialist_stop_activation', { activation_id: 'act:aaaa' }],
  ] as const)('%s renderCall exposes dispose/invalidate and array render', async (name, params) => {
    const { pi } = await setup();
    const tool = toolNamed(pi, name);
    expect(typeof tool.renderCall).toBe('function');
    const component = tool.renderCall(params, {}, {}, {});
    expect(typeof component.dispose).toBe('function');
    expect(typeof component.invalidate).toBe('function');
    expect(() => component.invalidate()).not.toThrow();
    expect(Array.isArray(component.render(80))).toBe(true);
  });
});
