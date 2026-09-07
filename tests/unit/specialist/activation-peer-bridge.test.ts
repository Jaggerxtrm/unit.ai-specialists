import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPeerDelivery } from '../../../src/activation/peer-bridge.js';
import { InteractionTransport } from '../../../src/activation/interaction.js';
import { create, recordReply } from '../../../src/activation/transport/pending-store.js';
import type { PeerAdapter, PushResult } from '../../../src/activation/transport/peer-adapter.js';

/**
 * unitAI-rrdnt.30. The bridge is where the participant protocol meets the peer wire, and
 * the property that matters is the one that is easy to get wrong in a way that looks fine:
 * the ask must resolve on a reply written to the DURABLE STORE, not on anything the socket
 * did. That is what makes a pushed question and a polled question indistinguishable to the
 * Specialist, and it is why a coordinator that never saw the push can still answer.
 */

const CHILD = 'specialist::researcher';
const PARENT = 'coordinator::dawid';

let repoRoot: string;
beforeEach(() => { repoRoot = mkdtempSync(join(tmpdir(), 'peer-bridge-')); });
afterEach(() => { rmSync(repoRoot, { recursive: true, force: true }); });

/**
 * A stub for the WIRE only. It still writes the durable record, because that is the real
 * adapter's first action and the whole design rests on it: durable state exists before any
 * send is attempted, so a reply can be correlated even when the send never happened. A stub
 * that skipped it would let this suite pass against a bridge that had no durable path at
 * all — the same false-confidence shape that made the lease concurrency test pass against a
 * deliberately broken implementation.
 */
function stubAdapter(outcome: PushResult['outcome'] = 'no_receipt') {
  const pushes: Array<{ messageId: string; kind: string; body: string }> = [];
  const adapter = {
    push: vi.fn(async (request: {
      messageId: string; activationId: string; kind: string; body: string; message: unknown;
    }) => {
      pushes.push({ messageId: request.messageId, kind: request.kind, body: request.body });
      const record = create(repoRoot, {
        messageId: request.messageId,
        activationId: request.activationId,
        kind: request.kind,
        message: request.message as never,
      });
      return { outcome, record } as unknown as PushResult;
    }),
  } as unknown as PeerAdapter;
  return { adapter, pushes };
}

const ask = (activationId = 'act:abc') => ({
  from: CHILD, to: PARENT, activationId, attemptId: 'att:abc:1',
  body: 'Which config layer wins?',
});

describe('peer bridge', () => {
  it('pushes the ask and does NOT claim delivery without a receipt', async () => {
    const { adapter, pushes } = stubAdapter('no_receipt');
    const transport = new InteractionTransport({
      deliver: createPeerDelivery({
        transport: () => transport, adapter, repoRoot,
        coordinatorSessionId: 'sess-abc', pollIntervalMs: 5,
      }),
    });

    const message = await transport.send({ ...ask(), kind: 'question' });

    expect(pushes).toEqual([{ messageId: message.messageId, kind: 'question', body: ask().body }]);
    // Claude Code emits no receipt to a peer sender. `pending` is the honest steady state.
    expect(transport.pendingAsks()[0].delivery).toBe('pending');
  });

  it('resolves the blocked ask from the DURABLE STORE, so a polling coordinator also works', async () => {
    // The coordinator here never receives a push — the stub reports no route at all — and
    // answers through the store, which is the degraded path. The Specialist cannot tell.
    const { adapter } = stubAdapter('no_route');
    let transport!: InteractionTransport;
    transport = new InteractionTransport({
      deliver: createPeerDelivery({
        transport: () => transport, adapter, repoRoot,
        coordinatorSessionId: 'sess-abc', pollIntervalMs: 5,
      }),
    });

    const settled = vi.fn();
    const pending = transport.request(ask()).then(r => { settled(r); return r; });
    await new Promise(r => setTimeout(r, 20));
    expect(settled).not.toHaveBeenCalled();

    const [outstanding] = transport.pendingAsks();
    recordReply(repoRoot, 'act:abc', outstanding.message.messageId, {
      ...outstanding.message,
      kind: 'reply',
      body: 'the repo user layer wins',
      inReplyTo: outstanding.message.messageId,
    });

    const reply = await pending;
    expect(reply.body).toBe('the repo user layer wins');
    expect(transport.pendingAsks()).toHaveLength(0);
  });

  it('does not watch kinds that nobody replies to', async () => {
    const { adapter, pushes } = stubAdapter();
    let transport!: InteractionTransport;
    transport = new InteractionTransport({
      deliver: createPeerDelivery({
        transport: () => transport, adapter, repoRoot,
        coordinatorSessionId: 'sess-abc', pollIntervalMs: 5,
      }),
    });

    await transport.send({ ...ask(), kind: 'finding', body: 'found a thing' });
    await transport.send({ ...ask(), kind: 'completion', body: 'done' });

    // Both were pushed — they are not silently dropped...
    expect(pushes.map(p => p.kind)).toEqual(['finding', 'completion']);
    // ...but neither creates an outstanding ask, so neither can ever reach `delivered`.
    expect(transport.pendingAsks()).toHaveLength(0);
  });

  it('survives the polling path answering first, without a duplicate reply', async () => {
    const { adapter } = stubAdapter('no_route');
    let transport!: InteractionTransport;
    transport = new InteractionTransport({
      deliver: createPeerDelivery({
        transport: () => transport, adapter, repoRoot,
        coordinatorSessionId: 'sess-abc', pollIntervalMs: 5,
      }),
    });

    const pending = transport.request(ask());
    await new Promise(r => setTimeout(r, 10));
    const [outstanding] = transport.pendingAsks();

    // Someone answers in-process first — `specialist_status` reply, say.
    await transport.send({
      ...ask(), kind: 'reply', from: PARENT, to: CHILD,
      body: 'answered in process', inReplyTo: outstanding.message.messageId,
    });
    // ...and the store gets a reply too. The watcher must not throw the uncorrelated
    // rejection into an unhandled promise.
    recordReply(repoRoot, 'act:abc', outstanding.message.messageId, {
      ...outstanding.message, kind: 'reply', body: 'answered by store',
      inReplyTo: outstanding.message.messageId,
    });

    await expect(pending).resolves.toMatchObject({ body: 'answered in process' });
    await new Promise(r => setTimeout(r, 20));
    expect(transport.pendingAsks()).toHaveLength(0);
  });
});
