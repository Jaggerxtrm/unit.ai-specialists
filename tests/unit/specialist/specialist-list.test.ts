import { describe, it, expect, vi } from 'vitest';

/**
 * MCP mirror of the Pi `specialist_list` registry tool (unitAI-t2kol.6).
 *
 * Mirrors the Pi reference logic (config/pi-extensions/specialist-subagents):
 * a `loader.get` throw is per-row undispatchable signal, never a listing
 * failure; `name=` unknown returns an error plus known names; compact rows
 * carry no `description`; full rows carry every field; every answer ends with
 * the native-only dispatch note.
 */
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      throw new Error(`specialist_list must not spawn a subprocess; got spawn(${String(args[0])})`);
    },
  };
});

import { createSpecialistListTool } from '../../../src/tools/specialist/specialist_list.tool.js';
import type { SpecialistLoader, SpecialistSummary } from '../../../src/specialist/loader.js';
import type { Specialist } from '../../../src/specialist/schema.js';

const NATIVE_ONLY_TAIL = 'Do not shell out to the specialists CLI.';

function summary(overrides: Partial<SpecialistSummary> & { name: string }): SpecialistSummary {
  return {
    description: `${overrides.name} description`,
    category: 'test',
    version: '1.0.0',
    model: 'test-model',
    permission_required: 'READ_ONLY',
    interactive: false,
    skills: [],
    scripts: [],
    mandatoryRuleTemplateSets: [],
    scope: 'package',
    source: 'package-fallback',
    filePath: `/specs/${overrides.name}.specialist.json`,
    ...overrides,
  };
}

function spec(name: string, permission_required = 'READ_ONLY'): Specialist {
  return {
    specialist: {
      metadata: { name, version: '1.0.0', description: `${name} description`, category: 'test' },
      execution: { model: 'test-model', permission_required },
      prompt: { task_template: 'Do $prompt' },
    },
  } as unknown as Specialist;
}

function fakeLoader(): SpecialistLoader {
  const summaries = [
    summary({ name: 'good' }),
    summary({ name: 'writer', permission_required: 'MEDIUM' }),
    summary({ name: 'bare', model: '' }),
  ];
  return {
    list: async () => summaries,
    get: async (name: string) => {
      if (name === 'bare') throw new Error(`specialist 'bare' has no model configured.`);
      return spec(name, name === 'writer' ? 'MEDIUM' : 'READ_ONLY');
    },
  } as unknown as SpecialistLoader;
}

describe('specialist_list tool', () => {
  it('compact default strips description but keeps reason on undispatchable rows', async () => {
    const tool = createSpecialistListTool(fakeLoader());
    const out = (await tool.execute({})) as {
      specialists: Array<Record<string, unknown>>;
      count: number;
      undispatchable: number;
      detail: string;
      note: string;
    };
    expect(out.detail).toBe('compact');
    expect(out.count).toBe(3);
    expect(out.undispatchable).toBe(1);
    for (const row of out.specialists) expect(row).not.toHaveProperty('description');
    const bare = out.specialists.find((r) => r.name === 'bare');
    expect(bare?.dispatchable).toBe(false);
    expect(typeof bare?.reason).toBe('string');
    expect(out.note.endsWith(NATIVE_ONLY_TAIL)).toBe(true);
  });

  it('a loader.get throw is a row verdict, not a listing failure', async () => {
    const tool = createSpecialistListTool(fakeLoader());
    const out = (await tool.execute({ detail: 'full' })) as {
      specialists: Array<Record<string, unknown>>;
    };
    const bare = out.specialists.find((r) => r.name === 'bare');
    expect(bare?.dispatchable).toBe(false);
    expect(String(bare?.reason)).toContain('no model');
  });

  it('name= unknown returns an error plus known names', async () => {
    const tool = createSpecialistListTool(fakeLoader());
    const out = (await tool.execute({ name: 'nope' })) as {
      error: string;
      known: string[];
      note: string;
    };
    expect(out.error).toContain('Unknown specialist: nope');
    expect(out.known).toEqual(['good', 'writer', 'bare']);
    expect(out.note.endsWith(NATIVE_ONLY_TAIL)).toBe(true);
  });

  it('name= known returns the full record with scope/source provenance', async () => {
    const tool = createSpecialistListTool(fakeLoader());
    const out = (await tool.execute({ name: 'good' })) as {
      specialist: Record<string, unknown>;
      note: string;
    };
    expect(out.specialist.name).toBe('good');
    expect(out.specialist.description).toBe('good description');
    expect(out.specialist.scope).toBe('package');
    expect(out.specialist.source).toBe('package-fallback');
    expect(out.specialist.dispatchable).toBe(true);
    expect(out.note.endsWith(NATIVE_ONLY_TAIL)).toBe(true);
  });

  it('detail full carries every field including access tier mapping', async () => {
    const tool = createSpecialistListTool(fakeLoader());
    const out = (await tool.execute({ detail: 'full' })) as {
      specialists: Array<Record<string, unknown>>;
      detail: string;
      note: string;
    };
    expect(out.detail).toBe('full');
    for (const row of out.specialists) {
      for (const field of ['name', 'category', 'description', 'scope', 'source', 'version', 'permission_required', 'access', 'dispatchable']) {
        expect(row, `row ${String(row.name)}`).toHaveProperty(field);
      }
    }
    expect(out.specialists.find((r) => r.name === 'writer')?.access).toBe('write');
    expect(out.specialists.find((r) => r.name === 'good')?.access).toBe('read');
    expect(out.note.endsWith(NATIVE_ONLY_TAIL)).toBe(true);
  });
});
