import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SpecialistSchema } from '../../../src/specialist/schema.js';

const configPath = resolve(process.cwd(), 'config/specialists/researcher.specialist.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const researcher = SpecialistSchema.parse(config).specialist;

const currentTools = [
  'web_search_exa',
  'web_fetch_exa',
  'web_search_advanced_exa',
  'agent_run',
];

const retiredTools = [
  'deep_researcher_start',
  'crawling_exa',
  'get_code_context_exa',
];

describe('researcher Exa integration', () => {
  it('loads the managed MCP adapter explicitly for isolated Specialist sessions', () => {
    expect(researcher.execution.extensions?.['npm:pi-mcp-adapter']).toBe(true);
    expect(researcher.capabilities?.external_commands ?? []).toEqual([]);
    expect(researcher.capabilities?.required_tools ?? []).toEqual([]);
  });

  it('teaches the current Exa tools and rejects retired tool names', () => {
    const prompt = `${researcher.prompt.system ?? ''}\n${researcher.prompt.task_template}`;
    for (const tool of currentTools) expect(prompt).toContain(tool);
    for (const tool of retiredTools) expect(prompt).not.toContain(tool);
    expect(prompt).toContain('local GitNexus');
    expect(prompt).toContain('official/current documentation');
    expect(prompt).toContain('Search ranking is candidate discovery, not truth');
  });

  it('watches both the research umbrella and Exa routing reference', () => {
    expect(researcher.skills?.paths).toContain(
      '~/.xtrm/skills/optional/research-methods/research/SKILL.md',
    );
    expect(researcher.validation?.files_to_watch).toEqual(expect.arrayContaining([
      '~/.xtrm/skills/optional/research-methods/research/SKILL.md',
      '~/.xtrm/skills/optional/research-methods/research/references/exa.md',
    ]));
  });

  it('declares the no-MCP-server boundary explicitly (unitAI-s46da)', () => {
    // No definition-side MCP config path exists: the adapter extension only
    // registers pi's --mcp-config flag; no config value is wired per-role,
    // so 0 MCP servers is the expected state, not a silent failure.
    expect(researcher.execution).not.toHaveProperty('mcp_config');
    expect(researcher.execution).not.toHaveProperty('mcpConfig');
    // required_tools stays empty so pre-run validation passes when Exa tools are absent.
    expect(researcher.capabilities?.required_tools ?? []).toEqual([]);
    // The prompt must teach the 0-server fallback instead of assuming the tools.
    expect(researcher.prompt.system ?? '').toContain('no MCP servers');
    expect(researcher.prompt.system ?? '').toContain('live official sources');
  });
});
