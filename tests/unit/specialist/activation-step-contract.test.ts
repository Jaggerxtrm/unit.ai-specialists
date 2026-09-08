import { describe, it, expect } from 'vitest';
import { compileStepContract } from '../../../src/activation/step-contract.js';
import type { BeadRecord } from '../../../src/specialist/beads.js';

/**
 * PRD §15 / Phase 4. The contract bounds one activation and is derived, not durable.
 * The assertions that matter are that each field comes from the section it claims to
 * come from, and that compilation creates nothing.
 */

const BEAD: BeadRecord & { revision?: number } = {
  id: 'unitAI-x1',
  title: 'Investigate the flake',
  status: 'open',
  revision: 7,
  description: [
    'PROBLEM', 'The suite flakes under load.', '',
    'SUCCESS', 'The flake is explained.', '',
    'SCOPE', 'Reproduce and diagnose. Do not fix.', '',
    'NON_GOALS', '- Does not change CI config', '- Does not fix the flake', '',
    'CONSTRAINTS', '1. Read-only.', '2. No network.', '',
    'VALIDATION', '- A written root cause', '- A reproduction command', '',
    'OUTPUT', 'A findings note.', '',
    'SCRUTINY', 'MEDIUM — diagnosis only.',
  ].join('\n'),
  dependencies: [{ id: 'unitAI-x0' }] as never,
};

describe('compileStepContract', () => {
  const contract = compileStepContract({
    bead: BEAD,
    specialist: 'debugger',
    responseFormat: 'markdown',
    now: () => 1_700_000_000_000,
  });

  it('roots the contract in the Bead, never a synthetic id', () => {
    expect(contract.rootWorkRef).toBe('unitAI-x1');
  });

  it('narrows the mandate to SUCCESS bounded by SCOPE', () => {
    expect(contract.mandate).toContain('The flake is explained.');
    expect(contract.mandate).toContain('Reproduce and diagnose. Do not fix.');
    // The PROBLEM statement is context, not a mandate — it says what is wrong, not what
    // this activation is asked to do.
    expect(contract.mandate).not.toContain('The suite flakes under load.');
  });

  it('carries the Bead and its blockers as evidence inputs', () => {
    expect(contract.inputs).toEqual([
      { kind: 'bead', ref: 'unitAI-x1', title: 'Investigate the flake' },
      { kind: 'blocker', ref: 'unitAI-x0' },
    ]);
  });

  it('takes outputs from OUTPUT and the format from the Specialist, not the Bead', () => {
    expect(contract.outputs).toEqual([{ description: 'A findings note.', format: 'markdown' }]);
  });

  it('keeps the boundary in nonGoals only, so scope has one source of truth', () => {
    expect(contract.scope).toEqual({ inScope: 'Reproduce and diagnose. Do not fix.' });
    expect(contract.nonGoals).toEqual(['Does not change CI config', 'Does not fix the flake']);
  });

  it('strips bullets and numbering from list sections', () => {
    expect(contract.constraints).toEqual(['Read-only.', 'No network.']);
    expect(contract.validation).toEqual([
      { description: 'A written root cause' },
      { description: 'A reproduction command' },
    ]);
  });

  it('records provenance including the Bead revision it compiled from', () => {
    expect(contract.provenance).toEqual({
      specialist: 'debugger',
      generatedAt: 1_700_000_000_000,
      sourceBeadRevision: '7',
    });
  });

  it('is reproducible — the same inputs compile to the same contract', () => {
    const again = compileStepContract({
      bead: BEAD,
      specialist: 'debugger',
      responseFormat: 'markdown',
      now: () => 1_700_000_000_000,
    });
    expect(again).toEqual(contract);
  });

  it('stays total on a Bead missing sections rather than aborting an admitted activation', () => {
    const thin = compileStepContract({
      bead: { id: 'unitAI-x2', title: 'thin', description: 'PROBLEM\nsomething' },
      specialist: 'researcher',
      now: () => 1,
    });

    expect(thin.rootWorkRef).toBe('unitAI-x2');
    expect(thin.mandate).toBe('');
    expect(thin.nonGoals).toEqual([]);
    expect(thin.constraints).toBeUndefined();
    expect(thin.validation).toBeUndefined();
    expect(thin.provenance.sourceBeadRevision).toBeUndefined();
  });

  it('omits the format when the Specialist declares none', () => {
    const plain = compileStepContract({ bead: BEAD, specialist: 'researcher', now: () => 1 });
    expect(plain.outputs).toEqual([{ description: 'A findings note.' }]);
  });
});
