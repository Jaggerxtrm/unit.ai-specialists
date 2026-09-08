import { describe, it, expect, vi } from 'vitest';
import {
  InteractionTransport,
  UncorrelatedReplyError,
  type InteractionMessage,
} from '../../../src/activation/interaction.js';

/**
 * PRD Phase 5. The assertions that matter are the three properties a second transport
 * could quietly violate: correlation is by id and not by ordering, asking does not kill
 * the child, and a message that cannot be delivered becomes pending rather than lost.
 */

const CHILD = 'specialist::researcher';
const PARENT = 'coordinator::dawid';

function base(overrides: Partial<Parameters<InteractionTransport['send']>[0]> = {}) {
  return {
    from: CHILD,
    to: PARENT,
    activationId: 'act:abc',
    attemptId: 'att:abc:1',
    body: 'Which config layer wins?',
    ...overrides,
  };
}

describe('InteractionMessage identity', () => {
  it('carries all three lineage layers so a message attributes to one attempt', async () => {
    const t = new InteractionTransport({ now: () => 1000 });
    const message = await t.send({ ...base(), kind: 'question' });

    expect(message.activationId).toBe('act:abc');
    expect(message.attemptId).toBe('att:abc:1');
    expect(message.from).toBe(CHILD);
    expect(message.messageId).not.toBe(message.activationId);
  });
});

describe('correlation', () => {
  it('matches a reply to its request by id with two asks outstanding at once', async () => {
    // The load-bearing case: a transport that correlates positionally would cross these.
    const t = new InteractionTransport();

    const first = await t.send({ ...base({ body: 'question one' }), kind: 'question' });
    const second = await t.send({ ...base({ body: 'question two' }), kind: 'question' });
    expect(t.pendingAsks()).toHaveLength(2);

    // Answer the SECOND one first.
    await t.send({
      ...base({ from: PARENT, to: CHILD, body: 'answer to two' }),
      kind: 'reply',
      inReplyTo: second.messageId,
    });

    const stillPending = t.pendingAsks();
    expect(stillPending).toHaveLength(1);
    expect(stillPending[0].message.messageId).toBe(first.messageId);
    expect(stillPending[0].message.body).toBe('question one');
  });

  it('refuses a reply that cites nothing, because ordering is not correlation', async () => {
    const t = new InteractionTransport();
    await expect(
      t.send({ ...base({ from: PARENT, to: CHILD }), kind: 'reply' }),
    ).rejects.toBeInstanceOf(UncorrelatedReplyError);
  });

  it('refuses a reply to an already-answered message', async () => {
    const t = new InteractionTransport();
    const ask = await t.send({ ...base(), kind: 'question' });
    const reply = { ...base({ from: PARENT, to: CHILD }), kind: 'reply' as const, inReplyTo: ask.messageId };

    await t.send(reply);
    await expect(t.send(reply)).rejects.toBeInstanceOf(UncorrelatedReplyError);
  });
});

describe('blocking request', () => {
  it('suspends the asker until the reply arrives, and resolves with that reply', async () => {
    const t = new InteractionTransport();
    const settled = vi.fn();

    const pending = t.request(base()).then((reply) => { settled(reply); return reply; });
    await Promise.resolve();

    // The child is not dead and not resolved — it is waiting. PRD invariant 7.
    expect(settled).not.toHaveBeenCalled();
    const [ask] = t.pendingAsks();
    expect(ask).toBeDefined();

    await t.send({
      ...base({ from: PARENT, to: CHILD, body: 'the user layer wins' }),
      kind: 'reply',
      inReplyTo: ask.message.messageId,
    });

    const reply = await pending;
    expect(reply.body).toBe('the user layer wins');
    expect(t.pendingAsks()).toHaveLength(0);
  });
});

describe('pending asks and attention', () => {
  it('enumerates asks oldest first and raises attention for the addressee only', async () => {
    const t = new InteractionTransport({ now: (() => { let n = 0; return () => (n += 10); })() });

    await t.send({ ...base({ body: 'older' }), kind: 'question' });
    await t.send({ ...base({ body: 'newer' }), kind: 'question' });

    expect(t.pendingAsks().map(a => a.message.body)).toEqual(['older', 'newer']);
    expect(t.attention(PARENT)).toBe(true);
    expect(t.attention(CHILD)).toBe(false);
  });

  it('derives the activation state an outstanding ask implies, escalation winning', async () => {
    const t = new InteractionTransport();
    expect(t.impliedState('act:abc')).toBeUndefined();

    await t.send({ ...base(), kind: 'question' });
    expect(t.impliedState('act:abc')).toBe('needs_reply');

    await t.send({ ...base({ body: 'I need a decision' }), kind: 'escalation' });
    expect(t.impliedState('act:abc')).toBe('escalated');

    // Another activation's asks never leak into this one.
    expect(t.impliedState('act:other')).toBeUndefined();
  });

  it('a finding or completion is not an ask and creates no attention', async () => {
    const t = new InteractionTransport();
    await t.send({ ...base({ body: 'found a thing' }), kind: 'finding' });
    await t.send({ ...base({ body: 'done' }), kind: 'completion' });

    expect(t.pendingAsks()).toHaveLength(0);
    expect(t.attention(PARENT)).toBe(false);
  });
});

describe('no silent loss', () => {
  it('keeps an undeliverable ask pending rather than failing the send', async () => {
    const t = new InteractionTransport({ deliver: () => false });
    const message = await t.send({ ...base(), kind: 'question' });

    const [ask] = t.pendingAsks();
    expect(ask.message.messageId).toBe(message.messageId);
    expect(ask.delivery).toBe('pending');
  });

  it('treats a throwing transport as failed delivery, never as a lost message', async () => {
    const t = new InteractionTransport({ deliver: () => { throw new Error('socket gone'); } });
    await t.send({ ...base(), kind: 'question' });

    expect(t.pendingAsks()[0].delivery).toBe('pending');
  });

  it('marks delivered only on an explicit receipt, never on absence of an error', async () => {
    // A transport that returns undefined has not acknowledged anything.
    const silent = new InteractionTransport({ deliver: (() => undefined) as unknown as () => boolean });
    await silent.send({ ...base(), kind: 'question' });
    expect(silent.pendingAsks()[0].delivery).toBe('pending');

    const acknowledging = new InteractionTransport({ deliver: () => true });
    await acknowledging.send({ ...base(), kind: 'question' });
    expect(acknowledging.pendingAsks()[0].delivery).toBe('delivered');
  });

  it('marks an ask pending when there is no transport at all (unitAI-rrdnt.45)', async () => {
    // The Pi coordinator's configuration: no peer hook, polling only. Nothing
    // received the ask, so nothing may claim it was delivered — otherwise
    // specialist_status reports "delivered" for a question no one has seen, which
    // is what a live run actually showed before this was fixed.
    const t = new InteractionTransport();
    await t.send({ ...base(), kind: 'question' });
    expect(t.pendingAsks()[0].delivery).toBe('pending');
  });

  it('records every message in history, delivered or not', async () => {
    const t = new InteractionTransport({ deliver: () => false });
    await t.send({ ...base(), kind: 'question' });
    await t.send({ ...base({ body: 'a finding' }), kind: 'finding' });

    const history: InteractionMessage[] = t.history();
    expect(history.map(m => m.kind)).toEqual(['question', 'finding']);
  });
});
