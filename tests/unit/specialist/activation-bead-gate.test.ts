import { describe, it, expect } from 'vitest';
import { evaluateBeadReadiness, extractPurposeExcerpt, extractSections, PURPOSE_EXCERPT_MAX, REQUIRED_SECTIONS } from '../../../src/activation/bead-gate.js';
import { NativeActivationHost } from '../../../src/activation/native-host.js';
import { DispatchRejectedError } from '../../../src/activation/types.js';
import type { PiSdk, PiAgentSessionLike } from '../../../src/activation/pi-sdk.js';

/**
 * PRD Phase 3. The gate's job is to refuse a Bead that is not a usable task contract
 * BEFORE a model turn is spent guessing at the scope it does not carry — and to say
 * exactly what is missing, because "bad bead" is not an actionable refusal.
 */

const NO_STATE = { readContractState: () => undefined };

function contract(overrides: Partial<Record<string, string>> = {}, extra = 'SCRUTINY\nLOW — routine.') {
  const bodies: Record<string, string> = {
    PROBLEM: 'The thing is unclear.',
    SUCCESS: 'The thing is clear.',
    SCOPE: 'Investigate the thing.',
    NON_GOALS: 'Does not fix the thing.',
    CONSTRAINTS: 'Read-only.',
    VALIDATION: 'A written finding.',
    OUTPUT: 'A finding.',
    ...overrides,
  };
  const lines: string[] = [];
  for (const section of REQUIRED_SECTIONS) {
    lines.push(section, bodies[section] ?? '', '');
  }
  lines.push(extra);
  return { id: 'ISSUE-1', title: 'A task', status: 'open', description: lines.join('\n') };
}

describe('evaluateBeadReadiness', () => {
  it('admits a complete 7-section contract with a SCRUTINY level', () => {
    expect(evaluateBeadReadiness(contract(), NO_STATE)).toEqual({ ok: true });
  });

  it('names every missing section rather than reporting a generic bad bead', () => {
    const bead = { id: 'ISSUE-1', title: 'A task', status: 'open', description: 'PROBLEM\nx\n\nSUCCESS\ny' };
    const result = evaluateBeadReadiness(bead, NO_STATE);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(['SCOPE', 'NON_GOALS', 'CONSTRAINTS', 'VALIDATION', 'OUTPUT']);
  });

  it('treats a heading with no body as missing — an empty section is not a contract', () => {
    const result = evaluateBeadReadiness(contract({ CONSTRAINTS: '' }), NO_STATE);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(['CONSTRAINTS']);
  });

  it('accepts headings decorated as markdown, bold, or colon-terminated', () => {
    const decorated = REQUIRED_SECTIONS.map(s => `## **${s}:**\nbody for ${s}\n`).join('\n');
    const bead = { id: 'ISSUE-1', title: 'A task', status: 'open', description: `${decorated}\nSCRUTINY: HIGH` };

    expect(evaluateBeadReadiness(bead, NO_STATE)).toEqual({ ok: true });
  });

  it('does not count a section name that only appears inside prose', () => {
    const bead = contract({ SCOPE: 'This mentions CONSTRAINTS and OUTPUT in a sentence.' });
    bead.description = bead.description
      .replace(/^CONSTRAINTS$/m, '')
      .replace(/^OUTPUT$/m, '');

    const result = evaluateBeadReadiness(bead, NO_STATE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(expect.arrayContaining(['CONSTRAINTS', 'OUTPUT']));
  });

  it('requires a SCRUTINY level', () => {
    const result = evaluateBeadReadiness(contract({}, ''), NO_STATE);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('SCRUTINY');
    expect(result.missing).toEqual(['SCRUTINY']);
  });

  it('refuses a bead explicitly marked contract=draft even when its sections are complete', () => {
    const result = evaluateBeadReadiness(contract(), { readContractState: () => 'draft' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('draft');
  });

  it('does not treat an ABSENT contract state as draft — most beads predate the marker', () => {
    expect(evaluateBeadReadiness(contract(), { readContractState: () => undefined })).toEqual({ ok: true });
  });

  it('refuses a closed bead, which is dead scope rather than work', () => {
    const bead = { ...contract(), status: 'closed' };
    const result = evaluateBeadReadiness(bead, NO_STATE);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('closed');
  });
});

describe('NativeActivationHost — bead gate admission', () => {
  function hostWith(bead: unknown, created: { count: number }) {
    const session = { sessionId: 's1', messages: [], isIdle: true } as unknown as PiAgentSessionLike;
    const sdk: PiSdk = {
      createAgentSession: async () => { created.count += 1; return { session }; },
      ModelRuntime: { create: async () => ({ hasConfiguredAuth: () => true }) },
      resolveModelScopeWithDiagnostics: () => ({
        scopedModels: [{ model: { id: 'test-model', provider: 'testprov' } }],
        diagnostics: [],
      }),
      defineTool: (d) => d,
    };
    const events: string[] = [];
    const host = new NativeActivationHost({
      beadGate: NO_STATE,
      loader: { get: async () => ({
        specialist: {
          metadata: { name: 'researcher', version: '1.0.0', description: 'd', category: 'c' },
          execution: { model: 'testprov/test-model', permission_required: 'READ_ONLY', response_format: 'text', output_type: 'research', bare: false },
          prompt: { system: 'You are the researcher.', task_template: 'Do: {{bead_id}}' },
        },
      }) } as never,
      beadsClient: { readBead: () => bead } as never,
      loadSdk: async () => sdk,
      forensics: { emit: (e) => { events.push(e.name); } },
      cwd: process.cwd(),
    });
    return { host, events };
  }

  it('refuses an incomplete bead before any AgentSession exists, and records the refusal', async () => {
    const created = { count: 0 };
    const { host, events } = hostWith({ id: 'ISSUE-1', title: 'thin', status: 'open', description: 'PROBLEM\nx' }, created);

    const error = await host.start({
      specialist: 'researcher',
      beadId: 'ISSUE-1',
      requestedByParticipantId: 'coordinator:test',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DispatchRejectedError);
    const rejection = error as DispatchRejectedError;
    expect(rejection.reason).toBe('bead_contract_incomplete');
    expect(rejection.message).toContain('SUCCESS');
    expect(rejection.message).toContain('AgentSession:\n  not created');

    // The whole point of admitting before creating: no session, and forensic evidence.
    expect(created.count).toBe(0);
    expect(events).toContain('activation_rejected');
    expect(events).not.toContain('activation_admitted');
  });

  it('admits a complete contract', async () => {
    const created = { count: 0 };
    const { host, events } = hostWith(contract(), created);

    await host.start({
      specialist: 'researcher',
      beadId: 'ISSUE-1',
      requestedByParticipantId: 'coordinator:test',
    }).catch(() => undefined);

    expect(events).toContain('activation_admitted');
  });

  // ── Same-line section headers (unitAI-rrdnt.54) ─────────────────────────────
  //
  // `PROBLEM: text` used to normalise to `PROBLEM:_TEXT`, match no heading, and leave
  // extractSections returning an EMPTY map — so the gate refused a complete contract and
  // reported every section missing. The reason pointed away from the cause, which is the
  // expensive part: a caller reading "missing: PROBLEM" about a description containing
  // PROBLEM has nowhere to go.

  const INLINE_CONTRACT = [
    'PROBLEM: the thing is broken',
    'SUCCESS: it works',
    'SCRUTINY: LOW',
    'SCOPE: one file',
    'NON_GOALS: nothing else',
    'CONSTRAINTS: read only',
    'VALIDATION: tests pass',
    'OUTPUT: a sentence',
  ].join('\n');

  it('parses same-line "SECTION: body" headers and keeps the body', () => {
    const sections = extractSections(INLINE_CONTRACT);

    for (const name of REQUIRED_SECTIONS) {
      expect(sections.has(name), `${name} not parsed from the inline form`).toBe(true);
      // Capturing the text after the colon is the whole point. Dropping it would turn
      // "missing" into "declared but empty", which this parser deliberately distinguishes.
      expect(sections.get(name), `${name} parsed but its body was discarded`).not.toBe('');
    }
    expect(sections.get('PROBLEM')).toBe('the thing is broken');
    expect(sections.get('OUTPUT')).toBe('a sentence');
  });

  it('admits a contract written entirely in the same-line form', () => {
    const bead = { id: 'ISSUE-1', title: 'A task', status: 'open', description: INLINE_CONTRACT };
    expect(evaluateBeadReadiness(bead, NO_STATE)).toEqual({ ok: true });
  });

  it('still treats a section name inside prose as prose, not a heading', () => {
    // A heading has to head something. Widening the parser must not let any line that
    // happens to contain a section name and a colon silently end the previous section.
    const sections = extractSections([
      'PROBLEM',
      'we must decide whether to log OUTPUT: below or above the fold',
      'SUCCESS',
      'decided',
    ].join('\n'));

    expect([...sections.keys()]).toEqual(['PROBLEM', 'SUCCESS']);
    expect(sections.get('PROBLEM')).toContain('OUTPUT: below');
  });

  it('leaves the bare-heading form byte-identical', () => {
    const bare = 'PROBLEM\nthe thing is broken\n\nSUCCESS\nit works\n';
    expect([...extractSections(bare).entries()]).toEqual([
      ['PROBLEM', 'the thing is broken'],
      ['SUCCESS', 'it works'],
    ]);
  });
});

describe('extractPurposeExcerpt (unitAI-uvg4j)', () => {
  it('takes the first meaningful line of SCOPE', () => {
    expect(extractPurposeExcerpt(contract({ SCOPE: '\n  researching activation transport\nsecond line' }).description))
      .toBe('researching activation transport');
  });

  it('falls back to SUCCESS when SCOPE is blank', () => {
    const description = ['SCOPE', '', 'SUCCESS', 'activation transport works'].join('\n');
    expect(extractPurposeExcerpt(description)).toBe('activation transport works');
  });

  it('collapses whitespace to a single line bounded at PURPOSE_EXCERPT_MAX', () => {
    const long = `word  ${'x '.repeat(100)}`;
    const excerpt = extractPurposeExcerpt(contract({ SCOPE: long }).description)!;
    expect(excerpt).not.toContain('\n');
    expect(excerpt).not.toMatch(/  /);
    expect(excerpt.length).toBeLessThanOrEqual(PURPOSE_EXCERPT_MAX);
  });

  it('returns undefined rather than fabricating when both sections are empty', () => {
    expect(extractPurposeExcerpt('PROBLEM\nx')).toBeUndefined();
    expect(extractPurposeExcerpt('')).toBeUndefined();
  });

  it('captures the excerpt on the snapshot once at dispatch', async () => {
    const created = { count: 0 };
    const bead = contract({ SCOPE: 'researching activation transport\nsecond line' });
    const loader = { get: async () => ({
      specialist: {
        metadata: { name: 'researcher', version: '1.0.0', description: 'd', category: 'c' },
        execution: { model: 'testprov/test-model', permission_required: 'READ_ONLY', response_format: 'text', output_type: 'research', bare: false },
        prompt: { system: 'You are the researcher.', task_template: 'Do: {{bead_id}}' },
      },
    }) } as never;
    const session = {
      sessionId: 's1', messages: [], isIdle: true,
      async prompt() {}, async steer() {}, async followUp() {}, async abort() {},
      dispose() {},
      subscribe() { return () => undefined; },
      getActiveToolNames: () => [] as string[],
      setActiveToolsByName() {},
      async waitForIdle() {},
    } as unknown as PiAgentSessionLike;
    const sdk: PiSdk = {
      createAgentSession: async () => { created.count += 1; return { session }; },
      ModelRuntime: { create: async () => ({ hasConfiguredAuth: () => true }) },
      resolveModelScopeWithDiagnostics: () => ({
        scopedModels: [{ model: { id: 'test-model', provider: 'testprov' } }],
        diagnostics: [],
      }),
      defineTool: (d) => d,
    };
    const host = new NativeActivationHost({
      beadGate: NO_STATE,
      loader,
      beadsClient: { readBead: () => bead } as never,
      loadSdk: async () => sdk,
      forensics: { emit: () => {} },
      cwd: process.cwd(),
    });
    const handle = await host.start({ specialist: 'researcher', beadId: 'ISSUE-1', requestedByParticipantId: 'coordinator:test' });
    expect(host.inspect(handle.activationId)?.purpose).toBe('researching activation transport');
  });
});
