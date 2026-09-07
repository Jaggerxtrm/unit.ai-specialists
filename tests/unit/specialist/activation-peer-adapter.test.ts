// tests/unit/specialist/activation-peer-adapter.test.ts
//
// The failure mode under test is a channel that silently never delivers. Every assertion
// here is written against that: a route that must not be selected, a send that must not be
// read as delivery, and a push that fails without losing the message.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as store from '../../../src/activation/transport/pending-store.js';
import {
  awaitReply,
  projectInteractionsForStatus,
  projectOutstandingAsks,
} from '../../../src/activation/transport/polling.js';
import {
  buildEnvelope,
  createSocketReceiptSource,
  isReceiptFor,
  sendFrame,
} from '../../../src/activation/transport/peer-transport.js';
import {
  evaluateRegistration,
  scanRoster,
  selectRoute,
  type ProcessProbe,
  type SessionRegistration,
} from '../../../src/activation/transport/roster.js';
import { PeerAdapter } from '../../../src/activation/transport/peer-adapter.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sp-interactions-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A probe that reports whatever the test says is running. */
function probeFor(running: Record<number, { ticks: number; epoch: number }>): ProcessProbe {
  return {
    startOf(pid) {
      const hit = running[pid];
      return hit ? { ticksSinceBoot: hit.ticks, epochSeconds: hit.epoch } : undefined;
    },
  };
}

function registration(overrides: Partial<SessionRegistration> = {}): SessionRegistration {
  return {
    pid: 4242,
    sessionId: 'sess-coordinator',
    peerProtocol: 1,
    messagingSocketPath: '/run/user/1000/cc-socks/4242.sock',
    procStart: 1440523852,
    name: 'dawid-0b',
    status: 'idle',
    ...overrides,
  };
}

function writeRoster(dir: string, entries: SessionRegistration[]): void {
  mkdirSync(dir, { recursive: true });
  for (const entry of entries) {
    writeFileSync(join(dir, `${entry.pid}.json`), JSON.stringify(entry));
  }
}

describe('roster — a discovery surface, not a liveness oracle', () => {
  const live = probeFor({ 4242: { ticks: 1440523852, epoch: 1788772229 } });

  it('accepts a registration whose /proc start matches the numeric procStart', () => {
    const verdict = evaluateRegistration(registration(), live);
    expect(verdict).toHaveProperty('route');
    expect((verdict as { route: { routeRef: string } }).route.routeRef)
      .toBe('pid:4242/session:sess-coordinator');
  });

  it('accepts the ps-style string procStart that pi-claude-link writes', () => {
    // Both formats occur on one host: Claude Code writes raw /proc stat ticks, while
    // pi-claude-link writes `ps -o lstart`. Rejecting the string form would exclude every
    // bridged peer; rejecting the numeric form would exclude every native Claude session.
    const asString = new Date(1788772229 * 1000).toString();
    const verdict = evaluateRegistration(registration({ procStart: asString }), live);
    expect(verdict).toHaveProperty('route');
  });

  it('rejects a string procStart outside the tolerance', () => {
    const drifted = new Date((1788772229 + 60) * 1000).toString();
    expect(evaluateRegistration(registration({ procStart: drifted }), live))
      .toEqual({ reason: 'proc_start_mismatch' });
  });

  it('REJECTS a registration naming a dead PID even though it advertises status idle', () => {
    // The measured case: 10 of 20 registrations named dead PIDs while reporting idle.
    const verdict = evaluateRegistration(registration({ status: 'idle' }), probeFor({}));
    expect(verdict).toEqual({ reason: 'no_proc_entry' });
  });

  it('REJECTS a live PID whose procStart disagrees — the PID-reuse guard', () => {
    const reused = probeFor({ 4242: { ticks: 99_999_999, epoch: 1799999999 } });
    expect(evaluateRegistration(registration(), reused)).toEqual({ reason: 'proc_start_mismatch' });
  });

  it('REJECTS a registration with no procStart at all', () => {
    expect(evaluateRegistration(registration({ procStart: undefined }), live))
      .toEqual({ reason: 'missing_proc_start' });
  });

  it('REJECTS an unsupported peerProtocol rather than guessing the wire', () => {
    expect(evaluateRegistration(registration({ peerProtocol: 2 }), live))
      .toEqual({ reason: 'unsupported_peer_protocol' });
  });

  it('never consults socket existence — the socket path need not exist on disk', () => {
    const verdict = evaluateRegistration(
      registration({ messagingSocketPath: '/definitely/not/on/disk.sock' }),
      live,
    );
    expect(verdict).toHaveProperty('route');
  });

  it('scanRoster reports why each entry was skipped instead of an empty roster', () => {
    const dir = join(root, 'sessions');
    writeRoster(dir, [registration(), registration({ pid: 7, sessionId: 'dead', procStart: 1 })]);
    const scan = scanRoster({ dir, probe: live });
    expect(scan.live).toHaveLength(1);
    expect(scan.rejected).toEqual([{ file: '7.json', pid: 7, reason: 'no_proc_entry' }]);
  });

  it('resolves a route by session id only — never by display name', () => {
    const dir = join(root, 'sessions');
    writeRoster(dir, [registration()]);
    expect(selectRoute('sess-coordinator', { dir, probe: live })?.pid).toBe(4242);
    expect(selectRoute('dawid-0b', { dir, probe: live })).toBeUndefined();
  });
});

describe('pending store — durable before any send', () => {
  it('refuses to replace an existing record', () => {
    store.create(root, { messageId: 'm1', activationId: 'a1', kind: 'question', message: { body: 'x' } });
    expect(() =>
      store.create(root, { messageId: 'm1', activationId: 'a1', kind: 'question', message: { body: 'y' } }),
    ).toThrow(/already exists/);
  });

  it('starts pending, and no send attempt can reach delivered', () => {
    store.create(root, { messageId: 'm1', activationId: 'a1', kind: 'question', message: {} });
    expect(store.read(root, 'a1', 'm1')?.delivery.state).toBe('pending');

    store.recordAttempt(root, 'a1', 'm1', { atMs: 1, route: 'pid:1/session:s', outcome: 'sent_unconfirmed' });
    expect(store.read(root, 'a1', 'm1')?.delivery.state).toBe('sent_unconfirmed');

    store.recordAttempt(root, 'a1', 'm1', { atMs: 2, route: 'pid:1/session:s', outcome: 'refused' });
    const record = store.read(root, 'a1', 'm1');
    expect(record?.delivery.state).toBe('refused');
    expect(record?.delivery.attempts).toHaveLength(2);
  });

  it('marks delivered only against a receipt naming this message', () => {
    store.create(root, { messageId: 'm1', activationId: 'a1', kind: 'question', message: {} });
    expect(() => store.recordReceipt(root, 'a1', 'm1', { origMsgId: 'someone-else' }))
      .toThrow(/does not match/);
    expect(store.read(root, 'a1', 'm1')?.delivery.state).toBe('pending');

    store.recordReceipt(root, 'a1', 'm1', { origMsgId: 'm1', receiptMsgId: 'r1' });
    expect(store.read(root, 'a1', 'm1')?.delivery.state).toBe('delivered');
  });

  it('a later failed attempt never downgrades a confirmed delivery', () => {
    store.create(root, { messageId: 'm1', activationId: 'a1', kind: 'question', message: {} });
    store.recordReceipt(root, 'a1', 'm1', { origMsgId: 'm1' });
    store.recordAttempt(root, 'a1', 'm1', { atMs: 3, route: 'pid:1/session:s', outcome: 'undeliverable' });
    expect(store.read(root, 'a1', 'm1')?.delivery.state).toBe('delivered');
  });

  it('projects the richer wire states down to the shared three-state protocol', () => {
    expect(store.projectDeliveryState('sent_unconfirmed')).toBe('pending');
    expect(store.projectDeliveryState('undeliverable')).toBe('pending');
    expect(store.projectDeliveryState('refused')).toBe('refused');
    expect(store.projectDeliveryState('delivered')).toBe('delivered');
  });

  it('only question and escalation create an outstanding ask', () => {
    expect(store.createsPendingAsk('question')).toBe(true);
    expect(store.createsPendingAsk('escalation')).toBe(true);
    expect(store.createsPendingAsk('finding')).toBe(false);
    expect(store.createsPendingAsk('completion')).toBe(false);
  });

  it('writes the reply to its own file so the two processes never race', () => {
    store.create(root, { messageId: 'm1', activationId: 'a1', kind: 'question', message: {} });
    store.recordReply(root, 'a1', 'm1', { body: 'use the second option' });
    expect(store.readReply(root, 'a1', 'm1')?.body).toEqual({ body: 'use the second option' });
    // The record file is untouched by the reply.
    expect(store.read(root, 'a1', 'm1')?.delivery.state).toBe('pending');
  });
});

describe('polling fallback — nothing is lost when the peer channel is unavailable', () => {
  it('surfaces a question whose push was never routed', () => {
    store.create(root, { messageId: 'm1', activationId: 'a1', kind: 'question', message: { body: 'which base?' } });
    store.recordAttempt(root, 'a1', 'm1', {
      atMs: 1, route: 'session:gone', outcome: 'undeliverable', detail: 'no live registration',
    });

    const [projection] = projectOutstandingAsks(root);
    expect(projection).toMatchObject({
      activation_id: 'a1',
      message_id: 'm1',
      kind: 'question',
      delivery: 'pending',
      wire_delivery: 'undeliverable',
      awaiting_reply: true,
      answered: false,
      body: 'which base?',
    });
  });

  it('an informational message creates no outstanding ask', () => {
    store.create(root, { messageId: 'm2', activationId: 'a1', kind: 'completion', message: {} });
    expect(projectOutstandingAsks(root)).toHaveLength(0);
    expect(projectInteractionsForStatus(root)).toHaveLength(1);
  });

  it('drops out of the outstanding set once answered, however the ask was read', () => {
    store.create(root, { messageId: 'm1', activationId: 'a1', kind: 'question', message: {} });
    store.recordReply(root, 'a1', 'm1', { body: 'master' });
    expect(projectOutstandingAsks(root)).toHaveLength(0);
    expect(projectInteractionsForStatus(root)[0].answered).toBe(true);
  });

  it('awaitReply returns undefined on timeout rather than throwing', async () => {
    store.create(root, { messageId: 'm1', activationId: 'a1', kind: 'question', message: {} });
    expect(await awaitReply(root, 'a1', 'm1', { timeoutMs: 60, intervalMs: 10 })).toBeUndefined();
    // The record survives the timeout; the Specialist stays in needs_reply.
    expect(store.read(root, 'a1', 'm1')).toBeDefined();
  });

  it('awaitReply resolves when a coordinator answers after reading the status surface', async () => {
    store.create(root, { messageId: 'm1', activationId: 'a1', kind: 'question', message: {} });
    setTimeout(() => store.recordReply(root, 'a1', 'm1', { body: 'answered by polling' }), 30);
    const reply = await awaitReply(root, 'a1', 'm1', { timeoutMs: 2000, intervalMs: 10 });
    expect(reply?.body).toEqual({ body: 'answered by polling' });
  });

  it('one corrupt record does not hide the others', () => {
    store.create(root, { messageId: 'm1', activationId: 'a1', kind: 'question', message: {} });
    writeFileSync(join(store.interactionsRoot(root), 'a1', 'broken.json'), '{ not json');
    expect(projectInteractionsForStatus(root)).toHaveLength(1);
  });
});

describe('peer adapter — a send is not a delivery', () => {
  const live = probeFor({ 4242: { ticks: 1440523852, epoch: 1788772229 } });

  it('writes durable state and degrades to polling when no route can be selected', async () => {
    const dir = join(root, 'sessions');
    writeRoster(dir, [registration({ pid: 4242, procStart: 1 })]); // registration names a dead PID
    const events: string[] = [];
    const adapter = new PeerAdapter({
      repoRoot: root, rosterDir: dir, probe: probeFor({}), emit: e => events.push(e.event),
    });

    const result = await adapter.push({
      messageId: 'm1', activationId: 'a1', kind: 'question',
      message: { body: 'which base?' }, body: 'which base?',
      coordinatorSessionId: 'sess-coordinator',
    });

    expect(result.outcome).toBe('no_route');
    expect(events).toEqual(['peer.route_absent']);
    // The message is not lost: it is readable exactly as if no push had been attempted.
    expect(projectOutstandingAsks(root)).toHaveLength(1);
  });

  it('records sent_unconfirmed — not delivered — when no receipt arrives', async () => {
    const dir = join(root, 'sessions');
    const socketPath = join(root, 'peer.sock');
    writeRoster(dir, [registration({ messagingSocketPath: socketPath })]);

    // A peer that accepts the bytes and says nothing. This is the silent-never-delivered
    // failure mode; the adapter must not report success.
    const server: Server = createServer(conn => { conn.on('end', () => conn.end()); conn.on('error', () => {}); });
    await new Promise<void>(res => server.listen(socketPath, () => res()));

    try {
      const adapter = new PeerAdapter({
        repoRoot: root, rosterDir: dir, probe: live,
        receipts: { waitForReceipt: async () => undefined, close: async () => {} },
        receiptTimeoutMs: 50,
      });
      const result = await adapter.push({
        messageId: 'm1', activationId: 'a1', kind: 'question',
        message: {}, body: 'ping', coordinatorSessionId: 'sess-coordinator',
      });

      expect(result.outcome).toBe('no_receipt');
      expect(result.record.delivery.state).toBe('sent_unconfirmed');
      expect(projectInteractionsForStatus(root)[0].delivery).toBe('pending');
      expect(projectOutstandingAsks(root)).toHaveLength(1);
    } finally {
      await new Promise<void>(res => server.close(() => res()));
    }
  });

  it('marks delivered only on a receipt, and refused on an explicit decline', async () => {
    const dir = join(root, 'sessions');
    const socketPath = join(root, 'peer.sock');
    writeRoster(dir, [registration({ messagingSocketPath: socketPath })]);
    const server: Server = createServer(conn => { conn.on('end', () => conn.end()); conn.on('error', () => {}); });
    await new Promise<void>(res => server.listen(socketPath, () => res()));

    try {
      const base = { repoRoot: root, rosterDir: dir, probe: live, receiptTimeoutMs: 50 };
      const delivered = new PeerAdapter({
        ...base,
        receipts: {
          waitForReceipt: async id => ({
            msgV: 1, msg_id: 'r1', type: 'control', action: 'peer_message_status',
            status: 'delivered', orig_msg_id: id,
          }),
          close: async () => {},
        },
      });
      const ok = await delivered.push({
        messageId: 'm1', activationId: 'a1', kind: 'question',
        message: {}, body: 'ping', coordinatorSessionId: 'sess-coordinator',
      });
      expect(ok.outcome).toBe('delivered');
      expect(ok.record.delivery.state).toBe('delivered');

      const declined = new PeerAdapter({
        ...base,
        receipts: {
          waitForReceipt: async id => ({
            msgV: 1, msg_id: 'r2', type: 'control', action: 'peer_message_status',
            status: 'refused', reason: 'user declined', orig_msg_id: id,
          }),
          close: async () => {},
        },
      });
      const no = await declined.push({
        messageId: 'm2', activationId: 'a1', kind: 'question',
        message: {}, body: 'ping', coordinatorSessionId: 'sess-coordinator',
      });
      // Refusal is not an error, and the message stays readable.
      expect(no.outcome).toBe('refused');
      expect(no.reason).toBe('user declined');

      // Both questions are still outstanding: delivery is not an answer. The delivered
      // one and the refused one differ only in how they got there, which is exactly what
      // a coordinator must not have to care about.
      const outstanding = projectOutstandingAsks(root);
      expect(outstanding.map(p => p.message_id)).toEqual(['m1', 'm2']);
      expect(outstanding.map(p => p.delivery)).toEqual(['delivered', 'refused']);
    } finally {
      await new Promise<void>(res => server.close(() => res()));
    }
  });

  it('treats an unrecognised receipt status as non-delivery', async () => {
    const dir = join(root, 'sessions');
    const socketPath = join(root, 'peer.sock');
    writeRoster(dir, [registration({ messagingSocketPath: socketPath })]);
    const server: Server = createServer(conn => { conn.on('end', () => conn.end()); conn.on('error', () => {}); });
    await new Promise<void>(res => server.listen(socketPath, () => res()));

    try {
      const adapter = new PeerAdapter({
        repoRoot: root, rosterDir: dir, probe: live, receiptTimeoutMs: 50,
        receipts: {
          waitForReceipt: async id => ({
            msgV: 1, msg_id: 'r3', type: 'control', action: 'peer_message_status',
            status: 'some-future-status', orig_msg_id: id,
          }),
          close: async () => {},
        },
      });
      const result = await adapter.push({
        messageId: 'm1', activationId: 'a1', kind: 'question',
        message: {}, body: 'ping', coordinatorSessionId: 'sess-coordinator',
      });
      expect(result.outcome).toBe('refused');
    } finally {
      await new Promise<void>(res => server.close(() => res()));
    }
  });

  it('a failed send is recorded as an attempt and never as "peer is gone"', async () => {
    const dir = join(root, 'sessions');
    writeRoster(dir, [registration({ messagingSocketPath: join(root, 'nothing-here.sock') })]);
    const adapter = new PeerAdapter({ repoRoot: root, rosterDir: dir, probe: live });

    const result = await adapter.push({
      messageId: 'm1', activationId: 'a1', kind: 'question',
      message: {}, body: 'ping', coordinatorSessionId: 'sess-coordinator',
    });

    expect(result.outcome).toBe('send_failed');
    expect(result.record.delivery.attempts).toHaveLength(1);
    // The route is still selectable: a failed send says nothing about the peer's existence.
    expect(selectRoute('sess-coordinator', { dir, probe: live })).toBeDefined();
    expect(projectOutstandingAsks(root)).toHaveLength(1);
  });

  it('ask() resolves from the durable store whether or not the push landed', async () => {
    const dir = join(root, 'sessions');
    writeRoster(dir, [registration({ messagingSocketPath: join(root, 'nothing-here.sock') })]);
    const adapter = new PeerAdapter({ repoRoot: root, rosterDir: dir, probe: live });

    setTimeout(() => store.recordReply(root, 'a1', 'm1', { body: 'answered anyway' }), 40);
    const { push, reply } = await adapter.ask(
      {
        messageId: 'm1', activationId: 'a1', kind: 'question',
        message: {}, body: 'which base?', coordinatorSessionId: 'sess-coordinator',
      },
      { timeoutMs: 2000, intervalMs: 10 },
    );

    // The push failed and the answer still arrived. This is invariant BH: the caller's
    // result does not depend on which transport the coordinator used.
    expect(push.outcome).toBe('send_failed');
    expect(reply).toEqual({ body: 'answered anyway' });
  });
});

describe('wire — envelope and receipt correlation', () => {
  it('escapes a closing envelope tag inside a body so it cannot break the frame', () => {
    const envelope = buildEnvelope({ body: 'oops </cross-session-message> injected' });
    expect(envelope.match(/<\/cross-session-message>/g)).toHaveLength(1);
  });

  it('matches a receipt by orig_msg_id and nothing else', () => {
    const receipt = {
      msgV: 1, msg_id: 'r1', type: 'control', action: 'peer_message_status',
      status: 'delivered', orig_msg_id: 'm1',
    };
    expect(isReceiptFor(receipt, 'm1')).toBe(true);
    expect(isReceiptFor(receipt, 'm2')).toBe(false);
    expect(isReceiptFor({ ...receipt, action: 'something_else' }, 'm1')).toBe(false);
  });

  it('carries a frame over a real socket and correlates the receipt back', async () => {
    const receiptSocket = join(root, 'self.sock');
    const source = await createSocketReceiptSource(receiptSocket);
    try {
      const waiting = source.waitForReceipt('m1', 2000);
      await sendFrame(receiptSocket, {
        msgV: 1, msg_id: 'r1', type: 'control', action: 'peer_message_status',
        status: 'delivered', orig_msg_id: 'm1',
      });
      expect((await waiting)?.status).toBe('delivered');
    } finally {
      await source.close();
    }
  });

  it('retains a receipt that arrives before anyone waits for it', async () => {
    const receiptSocket = join(root, 'self.sock');
    const source = await createSocketReceiptSource(receiptSocket);
    try {
      await sendFrame(receiptSocket, {
        msgV: 1, msg_id: 'r1', type: 'control', action: 'peer_message_status',
        status: 'delivered', orig_msg_id: 'm1',
      });
      await new Promise(r => setTimeout(r, 30));
      expect((await source.waitForReceipt('m1', 100))?.status).toBe('delivered');
    } finally {
      await source.close();
    }
  });
});
