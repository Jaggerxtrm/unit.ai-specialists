import { describe, it, expect } from 'vitest';
import { createAskTools, ASK_TOOL, ESCALATE_TOOL } from '../../../src/activation/ask-tool.js';
import { InteractionTransport } from '../../../src/activation/interaction.js';
import type { PiSdk } from '../../../src/activation/pi-sdk.js';

/**
 * PRD Phase 6. The property under test is the one that separates a clarification from a
 * restart: the child asks from INSIDE a tool call and the answer returns as that call's
 * result, so the same session continues with its context intact. A design that ended the
 * turn and replayed the answer into a fresh session would pass a naive "did it get the
 * answer" check and silently destroy the child's context.
 */

/**
 * The SDK calls execute as `(toolCallId, args, ...)`. Modelling it as `(args)` here is what
 * let the real signature be wrong for the whole life of Phase 6: the unit test invoked the
 * tool the way it wished the SDK did, so it passed against a tool no live model could use.
 * Every call below therefore goes through `call()`, which supplies the id.
 */
interface Tool { name: string; description: string; execute: (toolCallId: string, args: never) => Promise<string> }

let callSeq = 0;
const call = (tool: Tool, args: unknown) => tool.execute(`call_${++callSeq}`, args as never);

function sdkCapturingTools(): PiSdk {
  return {
    createAgentSession: async () => { throw new Error('not used'); },
    ModelRuntime: { create: async () => ({ hasConfiguredAuth: () => true }) },
    resolveModelScopeWithDiagnostics: () => ({ scopedModels: [], diagnostics: [] }),
    defineTool: (d) => d,
  };
}

function harness(overrides: Partial<Parameters<typeof createAskTools>[1]> = {}) {
  const transport = new InteractionTransport();
  const asked: Array<{ kind: string; body: string }> = [];
  const answered: string[] = [];

  const tools = createAskTools(sdkCapturingTools(), {
    transport,
    activationId: 'act:abc',
    currentAttemptId: () => 'att:abc:1',
    self: 'specialist::researcher',
    parent: 'coordinator::dawid',
    onAsk: (kind, body) => asked.push({ kind, body }),
    onAnswered: (kind) => answered.push(kind),
    ...overrides,
  }) as unknown as Tool[];

  const byName = (name: string) => tools.find(t => t.name === name) as Tool;
  return { transport, tools, asked, answered, ask: byName(ASK_TOOL), escalate: byName(ESCALATE_TOOL) };
}

describe('ask/escalate tools', () => {
  it('exposes exactly the two ask tools and no mutation capability', () => {
    const { tools } = harness();
    expect(tools.map(t => t.name).sort()).toEqual([ASK_TOOL, ESCALATE_TOOL].sort());
    // Asking is not a workspace operation: nothing here writes, edits or executes.
    expect(tools.every(t => !/write|edit|bash|exec/i.test(t.name))).toBe(true);
  });

  it('blocks inside the tool call until answered, then returns the answer as the result', async () => {
    const { transport, ask, asked, answered } = harness();

    const inFlight = call(ask, { question: 'Which config layer wins?' });
    await Promise.resolve();

    // The child is suspended inside its tool call — not finished, not dead.
    expect(asked).toEqual([{ kind: 'question', body: 'Which config layer wins?' }]);
    expect(answered).toEqual([]);

    const [pending] = transport.pendingAsks();
    await transport.send({
      kind: 'reply',
      from: 'coordinator::dawid',
      to: 'specialist::researcher',
      activationId: 'act:abc',
      attemptId: 'att:abc:1',
      body: 'the repo user layer wins',
      inReplyTo: pending.message.messageId,
    });

    // The answer is the TOOL RESULT — this is what keeps the same session running.
    await expect(inFlight).resolves.toBe('the repo user layer wins');
    expect(answered).toEqual(['question']);
  });

  it('escalates without dying and resumes when resolved', async () => {
    const { transport, escalate, asked } = harness();

    const inFlight = call(escalate, { blocker: 'I lack permission to edit config' });
    await Promise.resolve();

    expect(asked[0].kind).toBe('escalation');
    expect(transport.impliedState('act:abc')).toBe('escalated');

    const [pending] = transport.pendingAsks();
    await transport.send({
      kind: 'reply',
      from: 'coordinator::dawid',
      to: 'specialist::researcher',
      activationId: 'act:abc',
      attemptId: 'att:abc:1',
      body: 'permission granted, proceed',
      inReplyTo: pending.message.messageId,
    });

    await expect(inFlight).resolves.toBe('permission granted, proceed');
    expect(transport.impliedState('act:abc')).toBeUndefined();
  });

  it('routes two outstanding asks to the request that asked them, answered out of order', async () => {
    const { transport, ask } = harness();

    const first = call(ask, { question: 'question one' });
    const second = call(ask, { question: 'question two' });
    await Promise.resolve();
    await Promise.resolve();

    const pending = transport.pendingAsks();
    expect(pending).toHaveLength(2);

    const reply = (inReplyTo: string, body: string) => transport.send({
      kind: 'reply',
      from: 'coordinator::dawid',
      to: 'specialist::researcher',
      activationId: 'act:abc',
      attemptId: 'att:abc:1',
      body,
      inReplyTo,
    });

    // Answer the SECOND first — a positional implementation crosses these.
    await reply(pending[1].message.messageId, 'answer two');
    await reply(pending[0].message.messageId, 'answer one');

    await expect(first).resolves.toBe('answer one');
    await expect(second).resolves.toBe('answer two');
  });

  it('reads the attempt id at call time so a resumed activation attributes correctly', async () => {
    let attempt = 'att:abc:1';
    const { transport, ask } = harness({ currentAttemptId: () => attempt });

    attempt = 'att:abc:2';
    void call(ask, { question: 'after resume' });
    await Promise.resolve();

    expect(transport.pendingAsks()[0].message.attemptId).toBe('att:abc:2');
  });

  it('refuses an empty question rather than asking one nobody can answer', async () => {
    const { transport, ask, asked } = harness();
    await expect(call(ask, { question: '   '  })).resolves.toContain('Refused');
    expect(asked).toEqual([]);
    expect(transport.pendingAsks()).toHaveLength(0);
  });
});
