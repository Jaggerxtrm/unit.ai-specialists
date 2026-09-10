// Canonical wake equivalence: push body vs status projection (E6 E1).
//
// E(push,status) := deepEqual(toActivationResultView(parseCompletionBody(push.body)), statusEntry)
// AND activation/attempt/participant/bead ids match.
//
// The push body is the full camelCase ActivationResult; the status entry is the snake_case
// ActivationResultView subset. They are NOT byte-identical by construction — that
// non-equivalence is asserted behavior below, not a bug. The projection function is the
// comparator: one renderer, never a second comparison vocabulary.
//
// Grounding: unitAI-t2kol.10 §2 + RECONCILIATION R3 (Tasks owns lifecycle, not wake;
// polling-authoritative retained), spec §§AF/AG/AI (XTRM Channel = durable abstraction,
// Claude Channel transport = delivery adapter, whole-object projections, no prose
// summaries as instructions). Push stays a projection of the validated result;
// completion/finding terminals stay sent_unconfirmed (asserted as not-delivered here).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RuntimeEventPusher,
  parseCompletionBody,
} from '../../../src/activation/async-events.js';
import { PeerAdapter } from '../../../src/activation/transport/peer-adapter.js';
import { read } from '../../../src/activation/transport/pending-store.js';
import type { ActivationResult } from '../../../src/activation/types.js';
import { toActivationResultView } from '../../../src/tools/specialist/activation.tool.js';

let root: string;
let rosterDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sp-wake-equiv-'));
  rosterDir = mkdtempSync(join(tmpdir(), 'sp-wake-equiv-roster-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(rosterDir, { recursive: true, force: true });
});

const FULL: ActivationResult = {
  activationId: 'act:equiv00000001',
  participantId: 'node::executor',
  attemptId: 'att:equiv00000001:1',
  beadId: 'unitAI-aiwva.5',
  status: 'completed',
  output: { summary: 'did the thing', files: ['src/a.ts'] },
  validation: { valid: true, schema: 'none' },
  piSessionId: 'pi:sess-9911',
  configuredModel: 'openai-codex/gpt-5.5',
  requestedModel: 'openai-codex/gpt-5.5',
  resolvedModel: 'openai-codex/gpt-5.5',
  modelOverride: false,
  thinkingLevel: 'medium',
  thinkingOverride: false,
  fallbackUsed: false,
  completedAt: 1_760_000_000_000,
};

const MINIMAL: ActivationResult = {
  activationId: 'act:equiv00000002',
  participantId: 'node::executor',
  attemptId: 'att:equiv00000002:1',
  beadId: 'unitAI-aiwva.5',
  status: 'failed',
  output: undefined,
  validation: { valid: false, errors: ['boom'] },
  resolvedModel: 'openai-codex/gpt-5.5',
  modelOverride: false,
  thinkingOverride: false,
  fallbackUsed: true,
  completedAt: 1_760_000_000_001,
};

function pusherOn(repoRoot: string, msgId: string): RuntimeEventPusher {
  return new RuntimeEventPusher({
    adapter: new PeerAdapter({ repoRoot, rosterDir }),
    now: () => 1_760_000_000_002,
    newMessageId: () => msgId,
  });
}

async function pushAndProject(result: ActivationResult, msgId: string) {
  const pusher = pusherOn(root, msgId);
  pusher.track(result.activationId, {
    coordinatorSessionId: 'nobody-is-listening',
    coordinatorParticipantId: 'adapter::specialists-mcp',
  });
  pusher.settle(result);
  const push = await pusher.pushCompletion(result.activationId);
  const record = read(root, result.activationId, msgId)!;
  expect(record).toBeDefined();
  const parsed = parseCompletionBody(record.message.body);
  expect(parsed).toBeDefined();
  // Status projection: the same read half specialist_status activation_results serves.
  const statusEntry = pusher.allResults().map(toActivationResultView)
    .find(v => v.activation_id === result.activationId)!;
  expect(statusEntry).toBeDefined();
  return { pusher, push, record, parsed: parsed!, statusEntry };
}

describe('wake equivalence E(push,status)', () => {
  it('full result: projected push body deep-equals the status entry, ids match', async () => {
    const { push, parsed, statusEntry } = await pushAndProject(FULL, 'msg:equiv01');

    // Canonical E: one renderer compares both sides.
    expect(toActivationResultView(parsed)).toEqual(statusEntry);
    expect(parsed.activationId).toBe(statusEntry.activation_id);
    expect(parsed.attemptId).toBe(statusEntry.attempt_id);
    expect(parsed.participantId).toBe(statusEntry.participant_id);
    expect(parsed.beadId).toBe(statusEntry.bead_id);

    // Terminal honesty: completion never claims delivered on the peer-socket transport.
    expect(push.record.delivery.state).not.toBe('delivered');
  });

  it('minimal result: equivalence holds across omission rules', async () => {
    const { parsed, statusEntry } = await pushAndProject(MINIMAL, 'msg:equiv02');

    expect(toActivationResultView(parsed)).toEqual(statusEntry);
    // output null-vs-absent: raw may omit, projection emits explicit null.
    expect(statusEntry.output).toBeNull();
    // thinking_level omission rule: unset → absent, never fabricated.
    expect(statusEntry).not.toHaveProperty('thinking_level');
    expect(statusEntry).not.toHaveProperty('requested_model');
    expect(statusEntry).not.toHaveProperty('pi_session_id');
    // completed_at present on both sides.
    expect(statusEntry.completed_at).toBe(MINIMAL.completedAt);
    // validation exact.
    expect(statusEntry.validation).toEqual({ valid: false, errors: ['boom'] });
  });

  it('asserted non-equivalence: raw camelCase body is NOT the snake_case view', async () => {
    const { record, statusEntry } = await pushAndProject(FULL, 'msg:equiv03');

    const raw = JSON.parse(record.message.body) as Record<string, unknown>;
    // Raw carries camelCase identity; the view carries snake_case.
    expect(raw).toHaveProperty('activationId');
    expect(raw).not.toHaveProperty('activation_id');
    expect(statusEntry).toHaveProperty('activation_id');
    expect(statusEntry).not.toHaveProperty('activationId');
    // Byte-level / object-level inequality is by construction, not drift.
    expect(raw).not.toEqual(statusEntry);
    expect(record.message.body).not.toBe(JSON.stringify(statusEntry));
  });

  it('view-only fields never enter the equivalence', async () => {
    const { statusEntry } = await pushAndProject(FULL, 'msg:equiv04');

    // token_usage / purpose live on ActivationView, never on ActivationResultView.
    expect(statusEntry).not.toHaveProperty('token_usage');
    expect(statusEntry).not.toHaveProperty('purpose');
    expect(Object.keys(statusEntry).sort()).toEqual([
      'activation_id',
      'attempt_id',
      'bead_id',
      'completed_at',
      'configured_model',
      'fallback_used',
      'model_override',
      'output',
      'participant_id',
      'pi_session_id',
      'requested_model',
      'resolved_model',
      'status',
      'thinking_level',
      'thinking_override',
      'validation',
    ]);
  });
});
