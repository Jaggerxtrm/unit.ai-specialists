import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { renderTaskPrompt } from '../../../src/specialist/task-prompt.js';
import type { BeadRecord } from '../../../src/specialist/beads.js';

// unitAI-i3u2e: a complete initial user prompt must never hand the model a
// literal `$name` placeholder. Sweeps every shipped task_template AND the
// roleless render-bead template through the real assembly seam and asserts no
// unresolved placeholder survives.
const LEAK_RE = /\$[a-zA-Z_][a-zA-Z0-9_]*/;

const BEAD: BeadRecord = {
  id: 'unitAI-i3u2e',
  title: 'render-task must not emit unresolved template placeholders',
  description: 'PROBLEM: execution-only variables leak unresolved template placeholders.',
} as BeadRecord;

const base = { cwd: '/repo', beadId: BEAD.id, bead: BEAD, completedBlockers: [] };

// Every shipped specialist config with a task_template, in a stable order.
function shippedTemplates(): Array<{ name: string; template: string }> {
  return readdirSync('config/specialists')
    .filter((f) => f.endsWith('.specialist.json'))
    .sort()
    .map((f) => {
      const spec = JSON.parse(readFileSync(`config/specialists/${f}`, 'utf-8')).specialist;
      return { name: spec.metadata?.name ?? f, template: spec.prompt?.task_template ?? '' };
    });
}

describe('placeholder hygiene across every shipped task_template', () => {
  const templates = shippedTemplates();
  expect(templates.length).toBeGreaterThanOrEqual(24); // guard: sweep must not silently shrink (24 after intentional memory-processor retirement)

  for (const { name, template } of templates) {
    it(`renders ${name} with zero unresolved $name placeholders`, () => {
      // bare skips MANDATORY_RULES / execution hook so the assertion isolates the
      // template's own placeholder hygiene, not repo rule injection.
      const spec = { metadata: { name }, execution: { bare: true }, prompt: { task_template: template } };
      const out = renderTaskPrompt({ ...base, specialist: spec as never });
      const leaked = out.initial_prompt.match(LEAK_RE);
      expect(leaked ?? []).toEqual([]);
    });
  }
});

describe('render-bead placeholder hygiene', () => {
  it('the roleless $prompt template renders the bead verbatim with no leak', () => {
    const spec = {
      metadata: { name: 'roleless' },
      execution: { bare: false },
      prompt: { task_template: '$prompt' },
    };
    const out = renderTaskPrompt({ ...base, specialist: spec as never });
    expect(out.initial_prompt).toContain(BEAD.title);
    expect(out.initial_prompt.match(LEAK_RE) ?? []).toEqual([]);
  });
});