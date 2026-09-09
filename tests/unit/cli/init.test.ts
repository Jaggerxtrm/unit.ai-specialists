// ISSUE: xtrm-wiy5n.4.11 — quarantined from the default test baseline.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync, lstatSync, readlinkSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { InitOptions } from '../../../src/cli/init.js';
async function importInitModule() {
  return import('../../../src/cli/init.js');
}
async function setupXtrmStructure(cwd: string) {
  const { mkdirSync, symlinkSync, existsSync: exists } = await import('node:fs');
  mkdirSync(join(cwd, '.xtrm', 'skills', 'active'), { recursive: true });
  mkdirSync(join(cwd, '.xtrm', 'skills', 'default'), { recursive: true });
  mkdirSync(join(cwd, '.xtrm', 'hooks'), { recursive: true });
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  mkdirSync(join(cwd, '.pi'), { recursive: true });
  if (!exists(join(cwd, '.claude', 'skills'))) {
    symlinkSync(join(cwd, '.xtrm', 'skills', 'active'), join(cwd, '.claude', 'skills'));
  }
  if (!exists(join(cwd, '.pi', 'skills'))) {
    symlinkSync(join(cwd, '.xtrm', 'skills', 'active'), join(cwd, '.pi', 'skills'));
  }
}
async function runInit(cwd: string, opts: InitOptions = {}) {
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  delete process.env.SPECIALISTS_TMUX_SESSION;
  delete process.env.SPECIALISTS_JOB_ID;
  delete process.env.PI_SESSION_ID;
  delete process.env.PI_RPC_SOCKET;
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  await setupXtrmStructure(cwd);
  const { run } = await importInitModule();
  await run({ noXtrmCheck: true, ...opts });
}
describe('init CLI — run()', () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'specialists-init-test-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });
  it('creates .specialists/ directory structure', async () => {
    await runInit(tempDir);
    expect(existsSync(join(tempDir, '.specialists'))).toBe(true);
    expect(existsSync(join(tempDir, '.specialists', 'default'))).toBe(true);
    expect(existsSync(join(tempDir, '.specialists', 'user'))).toBe(true);
  });
  it('creates AGENTS.md with Specialists section when file does not exist', async () => {
    await runInit(tempDir);
    const content = await readFile(join(tempDir, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('## Specialists');
    expect(content).toContain('specialists run <name> --bead <id>');
  });
  it('appends Specialists section to existing AGENTS.md without marker', async () => {
    const existing = '# My Project\n\nSome existing content.\n';
    await writeFile(join(tempDir, 'AGENTS.md'), existing, 'utf-8');
    await runInit(tempDir);
    const content = await readFile(join(tempDir, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('# My Project');
    expect(content).toContain('## Specialists');
  });
  it('does not duplicate Specialists section on second run', async () => {
    await runInit(tempDir);
    await runInit(tempDir);
    const content = await readFile(join(tempDir, 'AGENTS.md'), 'utf-8');
    const count = (content.match(/## Specialists/g) ?? []).length;
    expect(count).toBe(1);
  });
  it('does not overwrite existing AGENTS.md that already has ## Specialists', async () => {
    const existing = '# Project\n\n## Specialists\n\nCustom text here.\n';
    await writeFile(join(tempDir, 'AGENTS.md'), existing, 'utf-8');
    await runInit(tempDir);
    const content = await readFile(join(tempDir, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('Custom text here.');
    expect((content.match(/## Specialists/g) ?? []).length).toBe(1);
  });
  it('creates project .mcp.json with specialists registration', async () => {
    await runInit(tempDir);
    const content = JSON.parse(await readFile(join(tempDir, '.mcp.json'), 'utf-8'));
    expect(content).toEqual({
      mcpServers: {
        specialists: {
          command: 'specialists',
          args: [],
        },
      },
    });
  });
  it('preserves existing MCP servers when registering specialists', async () => {
    await writeFile(join(tempDir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        other: { command: 'other-server', args: ['--json'] },
      },
    }, null, 2));
    await runInit(tempDir);
    const content = JSON.parse(await readFile(join(tempDir, '.mcp.json'), 'utf-8'));
    expect(content.mcpServers.other).toEqual({ command: 'other-server', args: ['--json'] });
    expect(content.mcpServers.specialists).toEqual({ command: 'specialists', args: [] });
  });
  it('does not rewrite specialists MCP config on second run', async () => {
    await runInit(tempDir);
    const first = await readFile(join(tempDir, '.mcp.json'), 'utf-8');
    await runInit(tempDir);
    const second = await readFile(join(tempDir, '.mcp.json'), 'utf-8');
    expect(second).toBe(first);
  });
  it('does NOT copy canonical specialists without --sync-defaults', async () => {
    await runInit(tempDir);
    const specialistsDir = join(tempDir, '.specialists', 'default');
    const files = await readdir(specialistsDir).catch(() => []);
    const yamlFiles = files.filter(f => f.endsWith('.specialist.json'));
    expect(yamlFiles.length).toBe(0);
  });
  it('copies canonical specialists, mandatory-rules, and nodes to .specialists/default/ when --sync-defaults', async () => {
    await runInit(tempDir, { syncDefaults: true });

    const specialistsDir = join(tempDir, '.specialists', 'default');
    const specialistFiles = await readdir(specialistsDir).catch(() => []);
    const yamlFiles = specialistFiles.filter(f => f.endsWith('.specialist.json'));

    const mandatoryRulesDir = join(tempDir, '.specialists', 'default', 'mandatory-rules');
    const mandatoryRuleFiles = await readdir(mandatoryRulesDir).catch(() => []);

    const nodesDir = join(tempDir, '.specialists', 'default', 'nodes');
    const nodeFiles = await readdir(nodesDir).catch(() => []);

    expect(yamlFiles.length).toBeGreaterThan(0);
    expect(yamlFiles).toContain('debugger.specialist.json');
    expect(yamlFiles).toContain('explorer.specialist.json');
    expect(yamlFiles).toContain('overthinker.specialist.json');
    expect(mandatoryRuleFiles).toContain('core-session-boundary.md');
    expect(mandatoryRuleFiles).toContain('git-workflow-safe.md');
    expect(nodeFiles).toContain('research.node.json');
  });
  it('migrates legacy nested specialists directories to flattened layout', async () => {
    const legacyDefaultDir = join(tempDir, '.specialists', 'default', 'specialists');
    const legacyUserDir = join(tempDir, '.specialists', 'user', 'specialists');
    await mkdir(legacyDefaultDir, { recursive: true });
    await mkdir(legacyUserDir, { recursive: true });
    const legacyDefaultPath = join(legacyDefaultDir, 'legacy-default.specialist.json');
    const legacyUserPath = join(legacyUserDir, 'legacy-user.specialist.json');
    await writeFile(legacyDefaultPath, `specialist:\n  metadata:\n    name: legacy-default\n    version: 1.0.0\n    description: legacy\n    category: test\n  execution:\n    model: test-model\n  prompt:\n    task_template: test\n`);
    await writeFile(legacyUserPath, `specialist:\n  metadata:\n    name: legacy-user\n    version: 1.0.0\n    description: legacy\n    category: test\n  execution:\n    model: test-model\n  prompt:\n    task_template: test\n`);
    // default migration only runs with --sync-defaults; user migration always runs
    await runInit(tempDir, { syncDefaults: true });
    expect(existsSync(join(tempDir, '.specialists', 'default', 'legacy-default.specialist.json'))).toBe(true);
    expect(existsSync(join(tempDir, '.specialists', 'user', 'legacy-user.specialist.json'))).toBe(true);
    expect(existsSync(legacyDefaultPath)).toBe(false);
    expect(existsSync(legacyUserPath)).toBe(false);
  });
  it('re-syncs existing canonical specialist files when --sync-defaults', async () => {
    const specialistsDir = join(tempDir, '.specialists', 'default');
    await mkdir(specialistsDir, { recursive: true });
    const staleContent = `specialist:
  metadata:
    name: debugger
    version: 99.0.0
    description: "Stale debugger"
    category: test
  execution:
    model: test-model
  prompt:
    task_template: "stale"
`;
    await writeFile(join(specialistsDir, 'debugger.specialist.json'), staleContent, 'utf-8');

    await runInit(tempDir, { syncDefaults: true });

    const content = await readFile(join(specialistsDir, 'debugger.specialist.json'), 'utf-8');
    expect(content).not.toContain('99.0.0');
    expect(content).not.toContain('Stale debugger');
    expect(content).toContain('"name": "debugger"');
  });

  it('re-syncs existing canonical mandatory-rules and node config files when --sync-defaults', async () => {
    const mandatoryRulesDir = join(tempDir, '.specialists', 'default', 'mandatory-rules');
    const nodesDir = join(tempDir, '.specialists', 'default', 'nodes');
    await mkdir(mandatoryRulesDir, { recursive: true });
    await mkdir(nodesDir, { recursive: true });
    await writeFile(join(mandatoryRulesDir, 'core-session-boundary.md'), 'stale rule', 'utf-8');
    await writeFile(join(nodesDir, 'research.node.json'), '{"stale":true}', 'utf-8');

    await runInit(tempDir, { syncDefaults: true });

    const ruleContent = await readFile(join(mandatoryRulesDir, 'core-session-boundary.md'), 'utf-8');
    const nodeContent = await readFile(join(nodesDir, 'research.node.json'), 'utf-8');
    expect(ruleContent).not.toContain('stale rule');
    expect(ruleContent).toContain('core-session-boundary');
    expect(nodeContent).not.toContain('"stale":true');
    expect(nodeContent).toContain('"name"');
  });
  it('plain init never touches .specialists/default/ even when PI_SESSION_ID is set', async () => {
    const specialistsDir = join(tempDir, '.specialists', 'default');
    await mkdir(specialistsDir, { recursive: true });
    await writeFile(join(specialistsDir, 'custom.specialist.json'), 'custom', 'utf-8');
    process.env.PI_SESSION_ID = 'pi-session-test';
    await runInit(tempDir); // no syncDefaults — always safe
    delete process.env.PI_SESSION_ID;
    const files = await readdir(specialistsDir);
    expect(files).toEqual(['custom.specialist.json']); // no additions
  });
  it('installs specialists hooks to .xtrm/hooks/specialists/ and symlinks .claude/hooks/', async () => {
    await runInit(tempDir);
    const xtrmHooksDir = join(tempDir, '.xtrm', 'hooks', 'specialists');
    const xtrmHooks = await readdir(xtrmHooksDir).catch(() => []);
    expect(xtrmHooks).not.toContain('specialists-complete.mjs');
    expect(xtrmHooks).toContain('specialists-session-start.mjs');
    expect(xtrmHooks).not.toContain('specialists-memory-cache-sync.mjs');
    const claudeHookPath = join(tempDir, '.claude', 'hooks', 'specialists-session-start.mjs');
    expect(lstatSync(claudeHookPath).isSymbolicLink()).toBe(true);
    const resolvedTarget = join(dirname(claudeHookPath), readlinkSync(claudeHookPath));
    expect(resolvedTarget).toBe(join(tempDir, '.xtrm', 'hooks', 'specialists', 'specialists-session-start.mjs'));
  });
  it('wires hooks in .claude/settings.json with symlinked .claude/hooks paths', async () => {
    await runInit(tempDir);
    const settingsPath = join(tempDir, '.claude', 'settings.json');
    const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.SessionStart).toBeDefined();
    const sessionStartCommands = settings.hooks.SessionStart.flatMap((entry: any) => entry.hooks.map((hook: any) => hook.command));
    expect(sessionStartCommands).toContain('node .claude/hooks/specialists-session-start.mjs');
    const submitCommands = (settings.hooks.UserPromptSubmit ?? []).flatMap((entry: any) => entry.hooks.map((hook: any) => hook.command));
    const postToolUseCommands = (settings.hooks.PostToolUse ?? []).flatMap((entry: any) => entry.hooks.map((hook: any) => hook.command));
    expect(submitCommands).not.toContain('node .claude/hooks/specialists-complete.mjs');
    expect(postToolUseCommands).not.toContain('node .claude/hooks/specialists-complete.mjs');
    expect(postToolUseCommands).not.toContain('node .claude/hooks/specialists-memory-cache-sync.mjs');
  });
  it('installs skills to .claude/skills/ (project-local for Claude)', async () => {
    await runInit(tempDir);
    const skillsDir = join(tempDir, '.claude', 'skills');
    const dirs = await readdir(skillsDir).catch(() => []);
    
    expect(dirs.length).toBeGreaterThan(0);
    expect(dirs).toContain('specialists-creator');
    expect(dirs).toContain('using-specialists');
  });
  it('installs skills to .pi/skills/ (project-local for pi)', async () => {
    await runInit(tempDir);
    const skillsDir = join(tempDir, '.pi', 'skills');
    const dirs = await readdir(skillsDir).catch(() => []);
    
    expect(dirs.length).toBeGreaterThan(0);
    expect(dirs).toContain('specialists-creator');
    expect(dirs).toContain('using-specialists');
  });
  it('prunes retired managed skills during --sync-skills without removing user-owned active content', async () => {
    await setupXtrmStructure(tempDir);
    const defaultRoot = join(tempDir, '.xtrm', 'skills', 'default');
    const activeRoot = join(tempDir, '.xtrm', 'skills', 'active');
    const retiredName = 'using-specialists-v3';
    await mkdir(join(defaultRoot, retiredName));
    await writeFile(join(defaultRoot, retiredName, 'SKILL.md'), 'retired');
    symlinkSync(`../default/${retiredName}`, join(activeRoot, retiredName), 'dir');

    const userOwnedName = 'manual-legacy';
    await mkdir(join(defaultRoot, userOwnedName));
    await writeFile(join(defaultRoot, userOwnedName, 'SKILL.md'), 'retired');
    await mkdir(join(activeRoot, userOwnedName));
    await writeFile(join(activeRoot, userOwnedName, 'SKILL.md'), 'user-owned');

    await runInit(tempDir, { syncSkills: true });

    expect(existsSync(join(defaultRoot, retiredName))).toBe(false);
    expect(existsSync(join(activeRoot, retiredName))).toBe(false);
    expect(existsSync(join(defaultRoot, userOwnedName))).toBe(false);
    expect(await readFile(join(activeRoot, userOwnedName, 'SKILL.md'), 'utf-8')).toBe('user-owned');
    expect(existsSync(join(defaultRoot, 'using-specialists'))).toBe(true);
  });
  it('creates user specialists directory for custom assets', async () => {
    await runInit(tempDir);
    expect(existsSync(join(tempDir, '.specialists', 'user'))).toBe(true);
  });
  it('creates runtime directories (jobs, ready)', async () => {
    await runInit(tempDir);
    expect(existsSync(join(tempDir, '.specialists', 'jobs'))).toBe(true);
    expect(existsSync(join(tempDir, '.specialists', 'ready'))).toBe(true);
  });
  it('adds runtime dirs and observability db artifacts to .gitignore', async () => {
    await runInit(tempDir);
    const gitignore = await readFile(join(tempDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.specialists/jobs/');
    expect(gitignore).toContain('.specialists/ready/');
    expect(gitignore).toContain('.specialists/db/*.db');
    expect(gitignore).toContain('.specialists/db/*.db-wal');
    expect(gitignore).toContain('.specialists/db/*.db-shm');
  });
  it('does not overwrite existing .xtrm hook files', async () => {
    const hooksDir = join(tempDir, '.xtrm', 'hooks', 'specialists');
    await mkdir(hooksDir, { recursive: true });
    await writeFile(join(hooksDir, 'specialists-session-start.mjs'), '// custom hook', 'utf-8');
    await runInit(tempDir);
    const content = await readFile(join(hooksDir, 'specialists-session-start.mjs'), 'utf-8');
    expect(content).toBe('// custom hook');
  });
  it('does not install skills to .specialists/default/skills/ (deprecated location)', async () => {
    await runInit(tempDir);
    // Skills should NOT be in .specialists/default/skills/
    const oldSkillsDir = join(tempDir, '.specialists', 'default', 'skills');
    expect(existsSync(oldSkillsDir)).toBe(false);
  });
  it('does not install hooks to .specialists/default/hooks/ (deprecated location)', async () => {
    await runInit(tempDir);
    // Hooks should NOT be in .specialists/default/hooks/
    const oldHooksDir = join(tempDir, '.specialists', 'default', 'hooks');
    expect(existsSync(oldHooksDir)).toBe(false);
  });
  it('rewires copied legacy hook files in .claude/hooks to canonical symlinks', async () => {
    const hooksDir = join(tempDir, '.claude', 'hooks');
    await mkdir(hooksDir, { recursive: true });
    await writeFile(join(hooksDir, 'specialists-session-start.mjs'), '// stale copy', 'utf-8');
    await runInit(tempDir);
    const hookPath = join(hooksDir, 'specialists-session-start.mjs');
    expect(lstatSync(hookPath).isSymbolicLink()).toBe(true);
    const resolvedTarget = join(dirname(hookPath), readlinkSync(hookPath));
    expect(resolvedTarget).toBe(join(tempDir, '.xtrm', 'hooks', 'specialists', 'specialists-session-start.mjs'));
  });
  it('does not attempt memory FTS sync during init (retired)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runInit(tempDir);
    const output = warnSpy.mock.calls.map(call => String(call[0] ?? '')).join('\n');
    expect(output).not.toContain('memories FTS cache sync failed during init');
  });
});