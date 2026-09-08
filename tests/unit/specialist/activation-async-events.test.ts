// tests/unit/specialist/activation-async-events.test.ts
//
// PRD Phase 14, acceptance AY (unitAI-rrdnt.34).
//
// The failure this file is written against is a completion notification that DIVERGES from
// the result it claims to describe — a coordinator that was pushed to and one that polled
// reaching different conclusions about the same activation. Every assertion below is about
// that: the pushed body is compared to the polled object field by field rather than by
// summary, the peer channel is deliberately made unroutable to prove the result survives
// without it, and a push with no validated result behind it must be refused.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RuntimeEventPusher,
  ResultNotValidatedError,
  completionBody,
  parseCompletionBody,
} from '../../../src/activation/async-events.js';
import { PeerAdapter } from '../../../src/activation/transport/peer-adapter.js';
import { read } from '../../../src/activation/transport/pending-store.js';
import type { ActivationResult } from '../../../src/activation/types.js';
import {
  createSpecialistDispatchTool,
  toActivationResultView,
} from '../../../src/tools/specialist/activation.tool.js';
import type { NativeActivationHost } from '../../../src/activation/native-host.js';

let root: string;
/** An empty roster directory: no registration can match, so no route is ever selected. */
let rosterDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sp-async-events-'));
  rosterDir = mkdtempSync(join(tmpdir(), 'sp-async-roster-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(rosterDir, { recursive: true, force: true });
});

const RESULT: ActivationResult = {
  activationId: 'act:aaaabbbbcccc',
  participantId: 'node::executor',
  attemptId: 'att:aaaabbbbcccc:1',
  beadId: 'unitAI-rrdnt.34',
  status: 'completed',
  output: { summary: 'did the thing', files: ['src/a.ts'] },
  validation: { valid: true, schema: 'none' },
  piSessionId: 'pi:sess-9911',
  configuredModel: 'openai-codex/gpt-5.5',
  resolvedModel: 'openai-codex/gpt-5.5',
  modelOverride: false,
  fallbackUsed: false,
  completedAt: 1_760_000_000_000,
};

function pusherOn(repoRoot: string): RuntimeEventPusher {
  return new RuntimeEventPusher({
    adapter: new PeerAdapter({ repoRoot, rosterDir }),
    now: () => 1_760_000_000_001,
    newMessageId: () => 'msg:completion01',
  });
}

describe('RuntimeEventPusher — completion projection', () => {
  it('pushes the SAME ActivationResult the polling path returns, field by field', async () => {
    const pusher = pusherOn(root);
    pusher.track(RESULT.activationId, {
      coordinatorSessionId: 'claude-sess-1',
      coordinatorParticipantId: 'adapter::specialists-mcp',
    });
    pusher.settle(RESULT);

    const push = await pusher.pushCompletion(RESULT.activationId);

    // The durable record is written before any send is attempted, so it exists even though
    // this push had nowhere to go.
    const record = read(root, RESULT.activationId, 'msg:completion01');
    expect(record).toBeDefined();

    const pushed = parseCompletionBody(record!.message.body);
    const polled = pusher.result(RESULT.activationId);

    // Not a summary comparison. The whole object, or the two coordinators can disagree.
    expect(pushed).toEqual(polled);
    expect(pushed).toEqual(RESULT);
    expect(push.record.message.body).toBe(completionBody(RESULT));
  });

  it('keeps the completion readable and NOT delivered when the peer channel is unavailable', async () => {
    const pusher = pusherOn(root);
    pusher.track(RESULT.activationId, {
      coordinatorSessionId: 'nobody-is-listening',
      coordinatorParticipantId: 'adapter::specialists-mcp',
    });
    pusher.settle(RESULT);

    const push = await pusher.pushCompletion(RESULT.activationId);

    expect(push.outcome).toBe('no_route');
    expect(push.record.delivery.state).not.toBe('delivered');
    expect(push.record.delivery.receiptMsgId).toBeUndefined();

    // The status projection — the read half — still answers with the full result.
    const projected = pusher.allResults().map(toActivationResultView);
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      activation_id: RESULT.activationId,
      status: 'completed',
      pi_session_id: 'pi:sess-9911',
      bead_id: 'unitAI-rrdnt.34',
      configured_model: 'openai-codex/gpt-5.5',
    });
  });

  it('carries participant, activation, attempt and pi session lineage on the pushed event', async () => {
    const pusher = pusherOn(root);
    pusher.track(RESULT.activationId, {
      coordinatorSessionId: 'claude-sess-1',
      coordinatorParticipantId: 'orch::dawid',
    });
    pusher.settle(RESULT);
    await pusher.pushCompletion(RESULT.activationId);

    const message = read(root, RESULT.activationId, 'msg:completion01')!.message;
    expect(message.from).toBe('node::executor');
    expect(message.to).toBe('orch::dawid');
    expect(message.activationId).toBe('act:aaaabbbbcccc');
    expect(message.attemptId).toBe('att:aaaabbbbcccc:1');
    expect(message.piSessionId).toBe('pi:sess-9911');
    expect(message.kind).toBe('completion');
  });

  it('refuses a push for an activation that has not produced a validated result', async () => {
    const pusher = pusherOn(root);
    pusher.track('act:never-settled', { coordinatorParticipantId: 'adapter::specialists-mcp' });

    await expect(pusher.pushCompletion('act:never-settled')).rejects.toBeInstanceOf(ResultNotValidatedError);
    // Refused before the durable record, so nothing describes a result that does not exist.
    expect(pusher.result('act:never-settled')).toBeUndefined();
  });

  it('rejects a body that is not a serialised result rather than inventing one', () => {
    expect(parseCompletionBody('not json')).toBeUndefined();
    expect(parseCompletionBody(JSON.stringify({ hello: 'world' }))).toBeUndefined();
  });
});

describe('specialist_dispatch — the push path is actually reached', () => {
  // This test exists because five modules in this epic were complete, unit-tested and
  // reachable by nothing. It asserts the wiring, not the pusher: dispatching must record
  // the route, settle the result and push it without any further call.
  it('tracks, settles and pushes when the activation resolves', async () => {
    const pusher = pusherOn(root);

    const host = {
      start: async () => ({
        activationId: RESULT.activationId,
        participantId: RESULT.participantId,
        attemptId: RESULT.attemptId,
        specialist: 'executor',
        beadId: RESULT.beadId,
        access: 'write' as const,
        workspace: { repositoryRoot: root, worktreePath: root },
        resolvedModel: RESULT.resolvedModel,
        stepContract: { rootWorkRef: RESULT.beadId, inputs: [], outputs: [] },
        result: Promise.resolve(RESULT),
      }),
      inspect: () => undefined,
    } as unknown as NativeActivationHost;

    const tool = createSpecialistDispatchTool(() => host, () => pusher);
    await tool.execute({
      specialist: 'executor',
      bead_id: RESULT.beadId,
      requested_by: 'orch::dawid',
      coordinator_session_id: 'claude-sess-1',
    });

    // The push is attached to the result promise, so let the microtask queue drain.
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(pusher.result(RESULT.activationId)).toEqual(RESULT);
    expect(read(root, RESULT.activationId, 'msg:completion01')?.kind).toBe('completion');
  });
});

describe('one projection of ActivationResult, not two', () => {
  // The Pi extension used to carry its own `toResultView`. Two functions describing the
  // same settled activation is how a Pi coordinator and a Claude coordinator end up
  // disagreeing about one object, so `toActivationResultView` is exported from lib.js and
  // this asserts it still emits every field the extension's projection did.
  it('emits every field the Pi extension projection carries', () => {
    const view = toActivationResultView({ ...RESULT, requestedModel: 'openai-codex/gpt-5.5' });
    for (const key of [
      'status', 'output', 'validation', 'pi_session_id', 'configured_model',
      'requested_model', 'resolved_model', 'model_override', 'fallback_used', 'completed_at',
    ]) {
      expect(view).toHaveProperty(key);
    }
  });

  it('projects an absent output as null rather than dropping the key', () => {
    const view = toActivationResultView({ ...RESULT, output: undefined });
    expect(view.output).toBeNull();
  });
});
