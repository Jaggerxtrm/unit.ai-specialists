import { describe, it, expect } from 'vitest';
import { renderRejection } from '../../../src/activation/rejection.js';
import { describeBuildIdentity } from '../../../src/activation/build-identity.js';
import { DispatchRejectedError } from '../../../src/activation/types.js';
import { createSpecialistDispatchTool } from '../../../src/tools/specialist/activation.tool.js';
import type { NativeActivationHost } from '../../../src/activation/native-host.js';

/**
 * Shared refusal renderer (unitAI-t2kol.4). Pure given explicit ids — no
 * filesystem reads. The before/after payloads mirror design §2 (unitAI-t2kol.3 notes).
 */

const FRESH_BUILD = describeBuildIdentity('aaaabbbbcccc', 'aaaabbbbcccc');
const STALE_BUILD = describeBuildIdentity('aaaabbbbcccc', 'ddddffff0000');

describe('renderRejection', () => {
  it('keeps the bead-draft envelope and attaches build (today\'s shape + build)', () => {
    const detail = {
      specialist: 'codebase-explorer',
      beadId: 'bd-1',
      note: 'bead contract is marked draft — promote it with `bd set-state <id> contract=ready` first',
    };
    expect(renderRejection({ reason: 'bead_contract_incomplete', detail }, FRESH_BUILD)).toEqual({
      status: 'rejected',
      reason: 'bead_contract_incomplete',
      detail,
      build: FRESH_BUILD,
    });
  });

  it('promotes missing top-level without stripping it from detail', () => {
    const missing = ['PROBLEM', 'SCRUTINY'];
    const detail = { specialist: 'codebase-explorer', beadId: 'bd-1', note: 'x', missing };
    const out = renderRejection({ reason: 'bead_contract_incomplete', detail, missing }, FRESH_BUILD);
    expect(out.missing).toEqual(missing);
    // Never removed from detail where the host put it.
    expect(out.detail).toEqual(detail);
  });

  it('renders the inline-incomplete shape with no detail envelope', () => {
    expect(
      renderRejection({ reason: 'bead is not a usable task contract: ...', missing: ['PROBLEM'] }, FRESH_BUILD),
    ).toEqual({
      status: 'rejected',
      reason: 'bead is not a usable task contract: ...',
      missing: ['PROBLEM'],
      build: FRESH_BUILD,
    });
  });

  it('omits build, detail and missing when absent or empty', () => {
    expect(renderRejection({ reason: 'bead_unreadable' })).toEqual({
      status: 'rejected',
      reason: 'bead_unreadable',
    });
    expect(renderRejection({ reason: 'x', missing: [] }, undefined)).not.toHaveProperty('missing');
  });

  it('a stale build reads as stale, never as a broken contract', () => {
    expect(STALE_BUILD).toContain('rebuilt after');
    const out = renderRejection({ reason: 'bead_contract_incomplete' }, STALE_BUILD);
    expect(out.build).toContain('module loaded aaaabbbbcccc, file on disk ddddffff0000');
  });
});

describe('MCP dispatch refusal adoption (unitAI-t2kol.4)', () => {
  function toolWith(start: () => Promise<never>) {
    const host = { start, inspect: () => undefined };
    return createSpecialistDispatchTool(() => host as unknown as NativeActivationHost);
  }

  it('a draft-bead refusal keeps detail.note and carries a build block', async () => {
    const error = new DispatchRejectedError('bead_contract_incomplete', {
      specialist: 'codebase-explorer',
      beadId: 'bd-1',
      note: 'bead contract is marked draft — promote it first',
    });
    const tool = toolWith(async () => { throw error; });
    const out = await tool.execute({ specialist: 'codebase-explorer', bead_id: 'bd-1' }) as Record<string, unknown>;
    expect(out.status).toBe('rejected');
    // Reason strings byte-identical to today: the host's rendered message, not the code.
    expect(out.reason).toBe(error.message);
    expect(out.detail).toEqual(error.detail);
    expect(out.detail).toMatchObject({ note: expect.stringContaining('draft') });
    expect(out).not.toHaveProperty('missing');
    expect(typeof out.build).toBe('string');
    expect(out.build as string).toContain('build: ');
  });

  it('an incomplete-bead refusal promotes missing top-level and keeps the envelope', async () => {
    const error = new DispatchRejectedError('bead_contract_incomplete', {
      specialist: 'codebase-explorer',
      beadId: 'bd-1',
      note: 'bead is not a usable task contract',
      missing: ['PROBLEM', 'SCRUTINY'],
    });
    const tool = toolWith(async () => { throw error; });
    const out = await tool.execute({ specialist: 'codebase-explorer', bead_id: 'bd-1' }) as Record<string, unknown>;
    expect(out.status).toBe('rejected');
    expect(out.missing).toEqual(['PROBLEM', 'SCRUTINY']);
    expect(out.detail).toEqual(error.detail);
    expect(typeof out.build).toBe('string');
  });
});
