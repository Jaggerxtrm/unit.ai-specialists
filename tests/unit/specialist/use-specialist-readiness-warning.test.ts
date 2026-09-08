import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createUseSpecialistTool } from '../../../src/tools/specialist/use_specialist.tool.js';
import * as beads from '../../../src/specialist/beads.js';

/**
 * unitAI-rrdnt.42. specialist_dispatch refuses a Bead the gate rejects; use_specialist did not
 * check at all, so an operator blocked by the gate had a working bypass and no indication they
 * had taken it. A gate with a silent bypass trains people to use the bypass.
 *
 * The chosen resolution is WARN, not refuse: this tool predates the gate and is in active use,
 * so refusing outright breaks callers whose Beads were never written to the contract. The
 * warning must ride the RESULT, because a log nobody reads reproduces the original defect.
 */

const CONTRACT = [
  'PROBLEM', 'p', '', 'SUCCESS', 's', '', 'SCOPE', 'sc', '', 'NON_GOALS', 'n', '',
  'CONSTRAINTS', 'c', '', 'VALIDATION', 'v', '', 'OUTPUT', 'o', '', 'SCRUTINY', 'LOW',
].join('\n');

function toolWith(description: string) {
  vi.spyOn(beads, 'BeadsClient').mockImplementation(function (this: any) {
    this.readBead = () => ({ id: 'ISSUE-1', title: 't', status: 'open', description });
    return this;
  } as never);
  const runner = { run: vi.fn(async () => ({ status: 'ok', output: 'done' })) };
  return { tool: createUseSpecialistTool(runner as never), runner };
}

describe('use_specialist bead readiness warning (unitAI-rrdnt.42)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('warns in the RESULT when the bead would be refused by specialist_dispatch', async () => {
    const { tool, runner } = toolWith('just some prose, no sections at all');
    const result = await tool.execute({ name: 'explorer', bead_id: 'ISSUE-1' } as never);

    // It still ran — refusing would break callers whose beads predate the contract.
    expect(runner.run).toHaveBeenCalledOnce();
    // And the caller is told, in the payload they actually read.
    expect((result as any).readiness_warning).toMatch(/would be REFUSED by specialist_dispatch/);
    expect((result as any).readiness_warning).toMatch(/missing:/);
  });

  it('adds no warning when the bead satisfies the same gate specialist_dispatch uses', async () => {
    const { tool, runner } = toolWith(CONTRACT);
    const result = await tool.execute({ name: 'explorer', bead_id: 'ISSUE-1' } as never);

    expect(runner.run).toHaveBeenCalledOnce();
    expect((result as any).readiness_warning).toBeUndefined();
  });

  it('does not gate a prompt-only call, which has no bead to judge', async () => {
    const { tool, runner } = toolWith(CONTRACT);
    const result = await tool.execute({ name: 'explorer', prompt: 'do a thing' } as never);

    expect(runner.run).toHaveBeenCalledOnce();
    expect((result as any).readiness_warning).toBeUndefined();
  });
});
