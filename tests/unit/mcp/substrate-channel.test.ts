import { describe, it, expect } from 'vitest';
import {
  CHANNEL_CAPABILITY,
  CHANNEL_METHOD,
  buildChannelFrame,
  withChannelPush,
  type ChannelFrame,
} from '../../../src/mcp/channel.js';
import type { ActivationForensicSink } from '../../../src/activation/native-host.js';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { buildV2Server } from '../../../src/mcp/v2-server.js';

/**
 * Channel push (unitAI-aiwva.21). Claude Code's gate chain is silent on every
 * failure, so nothing downstream reports a malformed frame — these assertions
 * are the only place a meta-key or payload regression surfaces.
 */
const EVENT = {
  activationId: 'act:1',
  attemptId: 'att:1',
  participantId: 'p:1',
  specialist: 'executor',
  beadId: 'unitAI-aiwva.21',
};

function recorder() {
  const sent: ChannelFrame[] = [];
  const seen: string[] = [];
  const base: ActivationForensicSink = { emit: (e) => { seen.push(e.name); } };
  return { sent, seen, sink: withChannelPush(base, (f) => { sent.push(f); }) };
}

describe('channel capability', () => {
  it('declares the exact key Claude Code registers its listener on', () => {
    // The client matches this literal; a rename silently disables push.
    expect(CHANNEL_CAPABILITY).toEqual({ 'claude/channel': {} });
    expect(CHANNEL_METHOD).toBe('notifications/claude/channel');
  });
});

describe('buildChannelFrame', () => {
  it('carries only identity in meta, with client-legal keys', () => {
    const { params } = buildChannelFrame({ ...EVENT, eventClass: 'completed' });
    expect(params.meta).toEqual({
      activation_id: 'act:1',
      specialist: 'executor',
      event: 'completed',
      read_with: 'specialist_status',
      bead_id: 'unitAI-aiwva.21',
    });
    for (const key of Object.keys(params.meta)) {
      expect(key).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
    }
    for (const value of Object.values(params.meta)) {
      expect(typeof value).toBe('string');
    }
  });

  it('points at specialist_status instead of carrying a result', () => {
    const { params } = buildChannelFrame({ ...EVENT, eventClass: 'completed' });
    expect(params.content).toContain('specialist_status');
    expect(params.content).toContain('act:1');
    // Reference-only discipline: a frame is rendered straight into session
    // context, so its size must follow identity length, never result length.
    expect(params.content.length).toBeLessThan(320);
  });

  it('omits bead_id rather than emitting an empty one', () => {
    const { params } = buildChannelFrame({
      activationId: 'act:2', specialist: 'researcher', eventClass: 'needs_reply',
    });
    expect(params.meta.bead_id).toBeUndefined();
    expect(params.meta.activation_id).toBe('act:2');
  });
});

describe('withChannelPush', () => {
  it('pushes only actionable transitions', () => {
    const { sent, sink } = recorder();
    for (const name of [
      'activation_settled', 'activation_failed',
      'escalation_raised', 'clarification_requested',
    ]) sink.emit({ ...EVENT, name });

    expect(sent.map((f) => f.params.meta.event)).toEqual([
      'completed', 'failed', 'escalation', 'needs_reply',
    ]);
  });

  it('stays silent on progress events', () => {
    const { sent, seen, sink } = recorder();
    for (const name of [
      'turn_started', 'turn_completed', 'retry_started',
      'compaction_started', 'lease_acquired', 'activation_admitted',
    ]) sink.emit({ ...EVENT, name });

    // Progress is why the poller was expensive; pushing it would rebuild that cost.
    expect(sent).toHaveLength(0);
    expect(seen).toHaveLength(6);
  });

  it('forwards every event to the wrapped sink', () => {
    const { seen, sink } = recorder();
    sink.emit({ ...EVENT, name: 'turn_started' });
    sink.emit({ ...EVENT, name: 'activation_settled' });
    expect(seen).toEqual(['turn_started', 'activation_settled']);
  });

  it('isolates a throwing sender from the activation', () => {
    const seen: string[] = [];
    const base: ActivationForensicSink = { emit: (e) => { seen.push(e.name); } };
    const sink = withChannelPush(base, () => { throw new Error('transport gone'); });

    expect(() => sink.emit({ ...EVENT, name: 'activation_settled' })).not.toThrow();
    expect(seen).toEqual(['activation_settled']);
  });

  it('isolates a rejecting sender', async () => {
    const base: ActivationForensicSink = { emit: () => {} };
    const sink = withChannelPush(base, () => Promise.reject(new Error('closed')));

    expect(() => sink.emit({ ...EVENT, name: 'activation_failed' })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('preserves optional sink members', () => {
    let raw = 0;
    const base = {
      emit: () => {},
      sessionEvent: () => { raw += 1; },
    } as unknown as ActivationForensicSink;
    const sink = withChannelPush(base, () => {});
    sink.sessionEvent?.({} as never);
    expect(raw).toBe(1);
  });
});

describe('wire', () => {
  it('writes the frame on a legacy connection, despite the method being outside the SDK union', async () => {
    // The one thing unit-testing the sink cannot answer: whether the SDK's
    // Protocol.notification() refuses a method it has no schema for. It does
    // not — but that is an observed behaviour of this SDK version, so it is
    // pinned here rather than assumed.
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const received: Array<{ method?: string }> = [];
    clientT.onmessage = (m: unknown) => { received.push(m as { method?: string }); };
    await clientT.start();

    const server = buildV2Server({ era: 'legacy' });
    await server.connect(serverT);
    await server.server.notification(
      buildChannelFrame({ activationId: 'act:w1', specialist: 'executor', eventClass: 'completed' }) as never,
    );
    await new Promise((r) => setTimeout(r, 50));

    const hit = received.find((m) => m.method === CHANNEL_METHOD);
    expect(hit).toBeDefined();
    await server.close();
  });
});
