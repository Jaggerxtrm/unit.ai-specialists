import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildMandatoryRulesInjection } from '../../../src/specialist/mandatory-rules.js';
import { buildRequiredPlatformRulesInjection } from '../../../src/specialist/required-platform-rules.js';

const repoRoot = process.cwd();
const specialistsDir = join(repoRoot, 'config', 'specialists');

const retiredSkillTokens = [
  'test-planning',
  'using-nodes',
  'specialists-creator/SKILL.md',
  'default/xt-merge',
  'default/xt-debugging',
  'default/clean-code',
  'gitnexus-exploring',
  'gitnexus-impact-analysis',
  'default/find-docs',
  'default/deepwiki',
  'default/github-search',
  'default/last30days',
  'verified-audit',
  '.agents/skills/using-quality-gates',
  '.agents/skills/clean-code',
];

const readSpec = (name: string) => JSON.parse(readFileSync(join(specialistsDir, `${name}.specialist.json`), 'utf8'));

describe('skills-v4 default specialist wiring', () => {
  it('contains no retired v3 skill references in package specialist configs', () => {
    const files = readdirSync(specialistsDir).filter((name) => name.endsWith('.specialist.json')).sort();
    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(specialistsDir, file), 'utf8');
      for (const token of retiredSkillTokens) if (text.includes(token)) violations.push(`${file}: ${token}`);
    }
    expect(violations).toEqual([]);
  });

  it('wires v4 umbrellas to specialists that materially depend on them', () => {
    expect(readSpec('planner').specialist.skills.paths).toEqual(['planning']);
    expect(readSpec('chain-coordinator').specialist.skills.paths).toEqual(['using-specialists']);
    expect(readSpec('node-coordinator').specialist.skills.paths).toEqual(['using-specialists']);
    expect(readSpec('specialists-creator').specialist.skills.paths).toEqual(['using-specialists']);
    expect(readSpec('debugger').specialist.skills.paths).toEqual(['engineering-quality', 'gitnexus']);
    expect(readSpec('explorer').specialist.skills.paths).toEqual(['gitnexus']);
    expect(readSpec('seconder').specialist.skills.paths).toEqual(['engineering-quality', 'gitnexus']);
    expect(readSpec('test-engineer').specialist.skills.paths).toEqual(['planning', 'engineering-quality']);
    expect(readSpec('researcher').specialist.skills.paths).toEqual(['~/.xtrm/skills/optional/research-methods/research/SKILL.md']);
    expect(readSpec('security-auditor').specialist.skills.paths).toEqual([
      '~/.xtrm/skills/optional/security-ops/security-ops/SKILL.md',
      '~/.xtrm/skills/optional/research-methods/research/SKILL.md',
    ]);
    expect(readSpec('sync-docs').specialist.skills.paths).toEqual(['~/.xtrm/skills/optional/xtrm-maintenance/sync-docs/']);
    expect(readSpec('service-knowledge-sync').specialist.skills.paths).toEqual(['service-knowledge', 'gitnexus']);
    expect(readSpec('reviewer').specialist.skills.paths).toEqual(['engineering-quality', 'gitnexus']);
    expect(readSpec('xt-merge').specialist.skills.paths).toEqual([]);
  });

  it('keeps the fleet boundary required even when ordinary global quick rules are disabled', () => {
    const injection = buildMandatoryRulesInjection({
      cwd: repoRoot,
      specialist: { mandatory_rules: { disable_default_globals: true, template_sets: [] } },
    });
    expect(injection.globalsDisabled).toBe(true);
    expect(injection.setsLoaded).toContain('core-session-boundary');
    expect(injection.block).toContain('one worker in XTRM');
    expect(injection.block).toContain('PROBLEM/SUCCESS/SCOPE/NON_GOALS/CONSTRAINTS/VALIDATION/OUTPUT');
    expect(injection.block).toContain('service-knowledge');
    expect(injection.block).toContain('bd memories');
    expect(injection.block).toContain('ast-grep');
    expect(injection.block).toContain('python-kernel');
    expect(injection.block).toContain('route through its references');
  });

  it('reduces bare mode to required platform rules only across both runners', () => {
    const injection = buildRequiredPlatformRulesInjection(repoRoot, 2400);
    expect(injection.setsLoaded).toEqual(['core-session-boundary']);
    expect(injection.block).toContain('core-session-boundary');
    expect(injection.block).not.toContain('git-workflow-safe');
    expect(injection.block).not.toContain('workflow-quick-rules');
    // runner.ts delegates system-prompt assembly (incl. bare mode) to system-prompt.ts
    // (unitAI-rrdnt.3) — that's where buildRequiredPlatformRulesBlock is now wired.
    for (const path of ['src/specialist/system-prompt.ts', 'src/specialist/script-runner.ts']) {
      expect(readFileSync(join(repoRoot, path), 'utf8')).toContain('buildRequiredPlatformRulesBlock');
    }
  });
});
