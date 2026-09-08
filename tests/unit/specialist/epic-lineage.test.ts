import { describe, it, expect } from 'vitest';
import {
  buildBeadContext,
  collectEpicAncestors,
  type BeadRecord,
} from '../../../src/specialist/beads.js';
import { renderTaskPrompt } from '../../../src/specialist/task-prompt.js';

const CHILD: BeadRecord = {
  id: 'unitAI-child',
  title: 'Child task',
  description: 'Child body.',
  parent: 'unitAI-epic',
};

const EPIC: BeadRecord = {
  id: 'unitAI-epic',
  title: 'Parent epic',
  description: 'Epic goal and success criteria.',
  notes: 'Epic notes.',
  parent: 'unitAI-grand',
};

const GRAND: BeadRecord = {
  id: 'unitAI-grand',
  title: 'Grand epic',
  description: 'Grand goal.',
};

function readBead(id: string): BeadRecord | null {
  return { 'unitAI-epic': EPIC, 'unitAI-grand': GRAND }[id] ?? null;
}

const SPECIALIST = {
  metadata: { name: 't' },
  execution: { bare: true },
  prompt: { task_template: '$prompt' },
} as never;

describe('collectEpicAncestors', () => {
  it('depth=1 returns the immediate parent', () => {
    expect(collectEpicAncestors(readBead, CHILD, 1)).toEqual([EPIC]);
  });

  it('depth=2 returns parent and grandparent', () => {
    expect(collectEpicAncestors(readBead, CHILD, 2)).toEqual([EPIC, GRAND]);
  });

  it('no depth returns nothing', () => {
    expect(collectEpicAncestors(readBead, CHILD, undefined)).toEqual([]);
  });

  it('stops silently at an unreadable parent', () => {
    expect(() =>
      collectEpicAncestors(() => null, CHILD, 2),
    ).not.toThrow();
    expect(collectEpicAncestors(() => null, CHILD, 2)).toEqual([]);
  });

  it('stops silently at a throwing readBead', () => {
    const throwing = () => { throw new Error('bd down'); };
    expect(collectEpicAncestors(throwing, CHILD, 2)).toEqual([]);
  });

  it('stops at a parentless ancestor within depth', () => {
    expect(collectEpicAncestors(readBead, EPIC, 2)).toEqual([GRAND]);
  });
});

describe('buildBeadContext epic lineage', () => {
  it('renders the parent contract as ## Epic lineage', () => {
    const context = buildBeadContext(CHILD, [], [EPIC]);
    expect(context).toContain('## Epic lineage');
    expect(context).toContain('### Parent epic (unitAI-epic)');
    expect(context).toContain('Epic goal and success criteria.');
    expect(context).toContain('Epic notes.');
  });

  it('no ancestors means no lineage section, byte-identical to baseline', () => {
    expect(buildBeadContext(CHILD, [], [])).toBe(buildBeadContext(CHILD));
    expect(buildBeadContext(CHILD)).not.toContain('## Epic lineage');
  });
});

describe('renderTaskPrompt epicAncestors', () => {
  function render(epicAncestors?: BeadRecord[]) {
    return renderTaskPrompt({
      specialist: SPECIALIST,
      cwd: '/r',
      beadId: CHILD.id,
      bead: CHILD,
      ...(epicAncestors === undefined ? {} : { epicAncestors }),
    }).initial_prompt;
  }

  it('depth=1 injects the parent contract', () => {
    const prompt = render([EPIC]);
    expect(prompt).toContain('## Epic lineage');
    expect(prompt).toContain('### Parent epic (unitAI-epic)');
  });

  it('depth=2 injects the grandparent too', () => {
    const prompt = render([EPIC, GRAND]);
    expect(prompt).toContain('### Parent epic (unitAI-epic)');
    expect(prompt).toContain('### Grand epic (unitAI-grand)');
  });

  it('omitted epicAncestors leaves the prompt byte-identical to baseline', () => {
    expect(render(undefined)).toBe(render([]));
    expect(render(undefined)).not.toContain('## Epic lineage');
  });
});
