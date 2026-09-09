// src/cli/init.ts

import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  ensureObservabilityDbFile,
  ensureGitignoreHasObservabilityDbEntries,
  isPathInsideJobsDirectory,
  resolveObservabilityDbLocation,
} from '../specialist/observability-db.js';
import { createObservabilitySqliteClientAtPath } from '../specialist/observability-sqlite.js';
import { resolveCanonicalAssetDir } from '../specialist/canonical-asset-resolver.js';
import { SpecialistLoader } from '../specialist/loader.js';
import {
  buildGlobalUserConfigTemplate,
  getGlobalUserConfigPath,
  mergeGlobalUserConfig,
  readGlobalUserConfig,
  writeGlobalUserConfig,
} from '../specialist/global-config.js';

// ── ANSI helpers ───────────────────────────────────────────────────────────────
const bold   = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green  = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim    = (s: string) => `\x1b[2m${s}\x1b[0m`;

function ok(msg: string)   { console.log(`  ${green('✓')} ${msg}`); }
function skip(msg: string) { console.log(`  ${yellow('○')} ${msg}`); }
function warn(msg: string) { console.warn(`  ${yellow('!')} ${msg}`); }

function isInstalled(bin: string): boolean {
  return spawnSync('which', [bin], { encoding: 'utf8', timeout: 2000 }).status === 0;
}

function assertXtrmPrerequisites(cwd: string): void {
  const hasXtrmDir = existsSync(join(cwd, '.xtrm'));
  const hasXtCli = isInstalled('xt');

  if (hasXtrmDir && hasXtCli) return;

  if (!hasXtCli) {
    console.error('specialists init: missing xt CLI.');
    console.error('1. Install xtrm-tools globally: npm install -g xtrm-tools');
    console.error('2. Run xt install');
    console.error('3. Run xt init in this repo');
    console.error('4. Verify xt is available: xt --version');
    process.exit(1);
  }

  if (!hasXtrmDir) {
    console.error('specialists init: missing .xtrm/ in this repo.');
    console.error('1. Run xt init in this repo');
    console.error('2. Verify xt is available: xt --version');
    process.exit(1);
  }
}

function warnMissingOptionalPrerequisites(): void {
  const optionalTools: ReadonlyArray<{ name: string; install: string }> = [
    { name: 'pi', install: 'npm install -g @earendil-works/pi-coding-agent' },
    { name: 'bd', install: 'npm install -g @jaggerxtrm/beads' },
    { name: 'sp', install: 'npm install -g @jaggerxtrm/specialists' },
  ];

  const missingTools = optionalTools.filter(tool => !isInstalled(tool.name));
  if (missingTools.length === 0) return;

  warn('Optional CLI prerequisites are missing. Init will continue, but workflow commands may fail:');
  for (const tool of missingTools) {
    warn(`${tool.name}: install via ${tool.install}`);
  }
}

const AGENTS_BLOCK = `
<!-- specialists:start -->
## Specialists

Use CLI commands via Bash to run and monitor specialists:

Core specialist commands (CLI-first in pi):
- \`specialists list\`
- \`specialists run <name> --bead <id>\`
- \`specialists run <name> --prompt "..."\`
- \`specialists feed -f\` / \`specialists feed <job-id>\`
- \`specialists result <job-id>\`
- \`specialists resume <job-id> "next task"\` (for keep-alive jobs in waiting)
- \`specialists stop <job-id>\`

For background specialists in pi, prefer the process extension:
- \`process start\`, \`process list\`, \`process output\`, \`process logs\`, \`process kill\`, \`process clear\`
- TUI: \`/ps\`, \`/ps:pin\`, \`/ps:logs\`, \`/ps:kill\`, \`/ps:clear\`, \`/ps:dock\`, \`/ps:settings\`

Canonical tracked flow:
1. Create/claim bead issue
2. Run specialist with \`--bead <id>\` (for long work, launch via \`process start\`)
3. Observe progress (\`process output\` / \`process logs\` or \`specialists feed\`)
4. Read final output (\`specialists result <job-id>\`)
5. Close/update bead with outcome

Add custom specialists to \`.specialists/user/\` to extend defaults.
<!-- specialists:end -->
`.trimStart();


const AGENTS_MARKER = '## Specialists';
const GITIGNORE_ENTRIES = [
  '.specialists/jobs/',
  '.specialists/ready/',
  '.specialists/db/*.db',
  '.specialists/db/*.db-wal',
  '.specialists/db/*.db-shm',
];
const MCP_FILE = '.mcp.json';
const MCP_SERVER_NAME = 'specialists';
const MCP_SERVER_CONFIG = { command: 'specialists', args: [] };

function loadJson(path: string, fallback: Record<string, unknown>): Record<string, any> {
  if (!existsSync(path)) return structuredClone(fallback);
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, any>;
  } catch {
    return structuredClone(fallback);
  }
}

function saveJson(path: string, value: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

function writeGlobalOverridesGuide(configPath: string): string | null {
  const docsDir = resolveCanonicalAssetDir('../docs');
  const sourcePath = docsDir ? join(docsDir, 'overrides-guide.md') : null;

  if (!sourcePath || !existsSync(sourcePath)) {
    warn('global overrides guide not found in package; see docs/overrides-guide.md on GitHub');
    return null;
  }

  const targetPath = join(dirname(configPath), 'overrides-guide.md');
  copyFileSync(sourcePath, targetPath);
  return targetPath;
}


/**
 * Move legacy nested specialist files from .specialists/<scope>/specialists/
 * to the flattened .specialists/<scope>/ layout.
 */
function migrateLegacySpecialists(cwd: string, scope: 'default' | 'user'): void {
  const sourceDir = join(cwd, '.specialists', scope, 'specialists');
  if (!existsSync(sourceDir)) return;

  const targetDir = join(cwd, '.specialists', scope);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  const files = readdirSync(sourceDir).filter(
    f => f.endsWith('.specialist.json') || f.endsWith('.specialist.json'),
  );
  if (files.length === 0) return;

  let moved = 0;
  let skipped = 0;

  for (const file of files) {
    const src = join(sourceDir, file);
    const dest = join(targetDir, file);

    if (existsSync(dest)) {
      skipped++;
      continue;
    }

    renameSync(src, dest);
    moved++;
  }

  if (moved > 0) {
    ok(`migrated ${moved} specialist${moved === 1 ? '' : 's'} from .specialists/${scope}/specialists/ to .specialists/${scope}/`);
  }
  if (skipped > 0) {
    skip(`${skipped} legacy specialist${skipped === 1 ? '' : 's'} already exist in .specialists/${scope}/ (not moved)`);
  }
}

/**
 * Copy canonical specialists to .specialists/default/.
 * Repo mirror only; package config stays upstream source.
 */
function copyCanonicalSpecialists(cwd: string): void {
  const sourceDir = resolveCanonicalAssetDir('specialists');

  if (!sourceDir) {
    skip('no canonical specialists found in package');
    return;
  }

  const targetDir = join(cwd, '.specialists', 'default');
  const files = readdirSync(sourceDir).filter(f => f.endsWith('.specialist.json'));

  if (files.length === 0) {
    skip('no specialist files found in package');
    return;
  }

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  let copied = 0;
  let refreshed = 0;

  for (const file of files) {
    const src = join(sourceDir, file);
    const dest = join(targetDir, file);

    if (existsSync(dest)) {
      copyFileSync(src, dest);
      refreshed++;
    } else {
      copyFileSync(src, dest);
      copied++;
    }
  }

  if (copied > 0) {
    ok(`copied ${copied} canonical specialist${copied === 1 ? '' : 's'} to .specialists/default/`);
  }
  if (refreshed > 0) {
    ok(`re-synced ${refreshed} canonical specialist${refreshed === 1 ? '' : 's'} in .specialists/default/`);
  }
}

/**
 * Copy canonical mandatory-rules to .specialists/default/mandatory-rules/.
 * Repo mirror only; package config stays upstream source.
 */
function copyCanonicalMandatoryRules(cwd: string): void {
  const sourceDir = resolveCanonicalAssetDir('mandatory-rules');

  if (!sourceDir) {
    skip('no canonical mandatory-rules found in package');
    return;
  }

  const targetDir = join(cwd, '.specialists', 'default', 'mandatory-rules');
  const files = readdirSync(sourceDir).filter(f => f.endsWith('.md') || f.endsWith('.json'));

  if (files.length === 0) {
    skip('no mandatory-rules files found in package');
    return;
  }

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  let copied = 0;
  let refreshed = 0;

  for (const file of files) {
    const src = join(sourceDir, file);
    const dest = join(targetDir, file);

    if (existsSync(dest)) {
      copyFileSync(src, dest);
      refreshed++;
    } else {
      copyFileSync(src, dest);
      copied++;
    }
  }

  if (copied > 0) {
    ok(`copied ${copied} mandatory-rule${copied === 1 ? '' : 's'} to .specialists/default/mandatory-rules/`);
  }
  if (refreshed > 0) {
    ok(`re-synced ${refreshed} mandatory-rule${refreshed === 1 ? '' : 's'} in .specialists/default/mandatory-rules/`);
  }
}

/**
 * Copy canonical node configs to .specialists/default/nodes/.
 * Repo mirror only; package config stays upstream source.
 */
function copyCanonicalNodeConfigs(cwd: string): void {
  const sourceDir = resolveCanonicalAssetDir('nodes');

  if (!sourceDir) {
    skip('no canonical node configs found in package');
    return;
  }

  const targetDir = join(cwd, '.specialists', 'default', 'nodes');
  const files = readdirSync(sourceDir).filter(f => f.endsWith('.node.json'));

  if (files.length === 0) {
    skip('no node config files found in package');
    return;
  }

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  let copied = 0;
  let refreshed = 0;

  for (const file of files) {
    const src = join(sourceDir, file);
    const dest = join(targetDir, file);

    if (existsSync(dest)) {
      copyFileSync(src, dest);
      refreshed++;
    } else {
      copyFileSync(src, dest);
      copied++;
    }
  }

  if (copied > 0) {
    ok(`copied ${copied} canonical node config${copied === 1 ? '' : 's'} to .specialists/default/nodes/`);
  }
  if (refreshed > 0) {
    ok(`re-synced ${refreshed} canonical node config${refreshed === 1 ? '' : 's'} in .specialists/default/nodes/`);
  }
}

/**
 * Install canonical specialists hooks to .xtrm/hooks/specialists/
 * and expose .claude/hooks/* entries as symlinks into .xtrm/hooks/.
 */
function installProjectHooks(cwd: string): void {
  const sourceDir = resolveCanonicalAssetDir('hooks');

  if (!sourceDir) {
    skip('no canonical hooks found in package');
    return;
  }

  const xtrmHooksDir = join(cwd, '.xtrm', 'hooks');
  const targetDir = join(xtrmHooksDir, 'specialists');
  const claudeHooksDir = join(cwd, '.claude', 'hooks');
  const hooks = readdirSync(sourceDir).filter(f => f.endsWith('.mjs'));

  if (hooks.length === 0) {
    skip('no hook files found in package');
    return;
  }

  mkdirSync(targetDir, { recursive: true });
  mkdirSync(claudeHooksDir, { recursive: true });

  let copied = 0;
  let skippedCopies = 0;
  let linked = 0;
  let rewiredLinks = 0;
  let skippedLinks = 0;

  for (const file of hooks) {
    const src = join(sourceDir, file);
    const xtrmDest = join(targetDir, file);

    if (existsSync(xtrmDest)) {
      skippedCopies++;
    } else {
      copyFileSync(src, xtrmDest);
      copied++;
    }

    const claudeHookPath = join(claudeHooksDir, file);
    const relativeTarget = `../../.xtrm/hooks/specialists/${file}`;
    if (existsSync(claudeHookPath)) {
      const stats = lstatSync(claudeHookPath);
      if (!stats.isSymbolicLink()) {
        unlinkSync(claudeHookPath);
        symlinkSync(relativeTarget, claudeHookPath);
        rewiredLinks++;
        continue;
      }

      const currentTarget = resolve(dirname(claudeHookPath), readlinkSync(claudeHookPath));
      if (currentTarget !== xtrmDest) {
        unlinkSync(claudeHookPath);
        symlinkSync(relativeTarget, claudeHookPath);
        rewiredLinks++;
        continue;
      }

      skippedLinks++;
      continue;
    }

    symlinkSync(relativeTarget, claudeHookPath);
    linked++;
  }

  if (copied > 0) ok(`installed ${copied} hook${copied === 1 ? '' : 's'} to .xtrm/hooks/specialists/`);
  if (skippedCopies > 0) skip(`${skippedCopies} hook${skippedCopies === 1 ? '' : 's'} already exist in .xtrm/hooks/specialists/ (not overwritten)`);
  if (linked > 0) ok(`linked ${linked} hook${linked === 1 ? '' : 's'} in .claude/hooks/ -> .xtrm/hooks/specialists/`);
  if (rewiredLinks > 0) ok(`rewired ${rewiredLinks} legacy hook${rewiredLinks === 1 ? '' : 's'} in .claude/hooks/ -> .xtrm/hooks/specialists/`);
  if (skippedLinks > 0) skip(`${skippedLinks} hook${skippedLinks === 1 ? '' : 's'} already present in .claude/hooks/ (left unchanged)`);
}

/**
 * Wire hooks in .claude/settings.json
 */
function ensureProjectHookWiring(cwd: string): void {
  const settingsPath = join(cwd, '.claude', 'settings.json');
  
  // Ensure .claude directory exists
  const settingsDir = join(cwd, '.claude');
  if (!existsSync(settingsDir)) {
    mkdirSync(settingsDir, { recursive: true });
  }

  const settings = loadJson(settingsPath, {}) as Record<string, unknown>;
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
  }
  const hooksObj = settings.hooks as Record<string, any[]>;
  let changed = false;

  // Clean up stale top-level hook keys from previous buggy versions
  for (const event of ['UserPromptSubmit', 'PostToolUse', 'SessionStart']) {
    if (Array.isArray((settings as any)[event])) {
      delete (settings as any)[event];
      changed = true;
    }
  }

  // Helper to add hook inside settings.hooks (Claude Code's expected format)
  function addHook(event: string, command: string): void {
    const eventList = hooksObj[event] ?? [];
    hooksObj[event] = eventList;

    const alreadyWired = eventList.some((entry: any) =>
      entry?.hooks?.some?.((h: any) => h?.command === command)
    );

    if (!alreadyWired) {
      eventList.push({ matcher: '', hooks: [{ type: 'command', command }] });
      changed = true;
    }
  }

  // Wire hooks with symlinked .claude/hooks/ paths
  addHook('SessionStart', 'node .claude/hooks/specialists-session-start.mjs');

  if (changed) {
    saveJson(settingsPath, settings);
    ok('wired specialists hooks in .claude/settings.json');
  } else {
    skip('.claude/settings.json already has specialists hooks');
  }
}

/**
 * Ensure .claude/skills and .pi/skills are symlinks to flattened .xtrm active skill root.
 * Creates the symlink if missing (e.g. on a fresh repo where xt install hasn't wired skill roots yet).
 */
function ensureRootSymlink(rootPath: string, expectedTargetPath: string): void {
  if (!existsSync(rootPath)) {
    mkdirSync(dirname(rootPath), { recursive: true });
    const relTarget = relative(dirname(rootPath), expectedTargetPath);
    symlinkSync(relTarget, rootPath);
    ok(`created ${basename(dirname(rootPath))}/${basename(rootPath)} → ${relTarget}`);
    return;
  }

  const stats = lstatSync(rootPath);
  if (!stats.isSymbolicLink()) {
    throw new Error(`${rootPath} must be a symlink to ${expectedTargetPath}. Aborting.`);
  }

  const linkTarget = readlinkSync(rootPath);
  const resolvedTarget = resolve(dirname(rootPath), linkTarget);
  const resolvedExpected = resolve(expectedTargetPath);
  if (resolvedTarget === resolvedExpected) {
    return;
  }

  const legacyTargets = [
    resolve(expectedTargetPath, 'claude'),
    resolve(expectedTargetPath, 'pi'),
  ];

  if (legacyTargets.includes(resolvedTarget)) {
    unlinkSync(rootPath);
    const relTarget = relative(dirname(rootPath), expectedTargetPath);
    symlinkSync(relTarget, rootPath);
    ok(`rewired ${basename(dirname(rootPath))}/${basename(rootPath)} → ${relTarget}`);
    return;
  }

  throw new Error(`${rootPath} points to ${linkTarget}, expected ${expectedTargetPath}. Aborting.`);
}

function ensureActiveSkillSymlink(defaultSkillPath: string, activeLinkPath: string): void {
  let stats;
  try {
    stats = lstatSync(activeLinkPath);
  } catch (error) {
    const fileError = error as NodeJS.ErrnoException;
    if (fileError.code === 'ENOENT') {
      const relativeTarget = `../default/${basename(defaultSkillPath)}`;
      symlinkSync(relativeTarget, activeLinkPath, 'dir');
      return;
    }
    throw error;
  }

  if (!stats.isSymbolicLink()) {
    throw new Error(`${activeLinkPath} already exists and is not a symlink.`);
  }

  const currentTarget = resolve(dirname(activeLinkPath), readlinkSync(activeLinkPath));
  if (currentTarget !== resolve(defaultSkillPath)) {
    throw new Error(`${activeLinkPath} points to an unexpected target.`);
  }
}

/**
 * Sync canonical skills into .xtrm skill roots and wire active symlinks.
 */
function installProjectSkills(cwd: string, syncSkills: boolean): void {
  const xtrmRoot = join(cwd, '.xtrm');
  if (!existsSync(xtrmRoot)) {
    throw new Error('.xtrm/ is missing. Install xtrm first, then run specialists init.');
  }

  const sourceDir = resolveCanonicalAssetDir('skills');
  if (!sourceDir) {
    skip('no canonical skills found in package');
    return;
  }

  const skills = readdirSync(sourceDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  if (skills.length === 0) {
    skip('no skill directories found in package');
    return;
  }

  const defaultRoot = join(cwd, '.xtrm', 'skills', 'default');
  const activeRoot = join(cwd, '.xtrm', 'skills', 'active');

  mkdirSync(defaultRoot, { recursive: true });
  mkdirSync(activeRoot, { recursive: true });

  ensureRootSymlink(join(cwd, '.claude', 'skills'), activeRoot);
  ensureRootSymlink(join(cwd, '.pi', 'skills'), activeRoot);

  let copied = 0;
  let refreshed = 0;
  let pruned = 0;

  if (syncSkills) {
    const currentSkills = new Set(skills);
    for (const entry of readdirSync(defaultRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || currentSkills.has(entry.name)) continue;

      const retiredDefaultPath = join(defaultRoot, entry.name);
      const retiredActivePath = join(activeRoot, entry.name);
      try {
        if (lstatSync(retiredActivePath).isSymbolicLink()
          && resolve(dirname(retiredActivePath), readlinkSync(retiredActivePath)) === resolve(retiredDefaultPath)) {
          unlinkSync(retiredActivePath);
        }
      } catch {
        // Missing or user-owned active entries are left alone.
      }
      rmSync(retiredDefaultPath, { recursive: true, force: true });
      pruned++;
    }
  }

  for (const skill of skills) {
    const src = join(sourceDir, skill);
    const defaultSkillPath = join(defaultRoot, skill);

    if (existsSync(defaultSkillPath)) {
      if (syncSkills) {
        cpSync(src, defaultSkillPath, { recursive: true, force: true });
        refreshed++;
      }
    } else {
      cpSync(src, defaultSkillPath, { recursive: true });
      copied++;
    }

    ensureActiveSkillSymlink(defaultSkillPath, join(activeRoot, skill));
  }

  if (copied > 0) ok(`copied ${copied} skill${copied === 1 ? '' : 's'} to .xtrm/skills/default/`);
  if (refreshed > 0) ok(`re-synced ${refreshed} skill${refreshed === 1 ? '' : 's'} in .xtrm/skills/default/`);
  if (pruned > 0) ok(`pruned ${pruned} retired managed skill${pruned === 1 ? '' : 's'}`);
  ok('verified active skill symlinks in .xtrm/skills/active/');
}

/**
 * Create .specialists/default/ and .specialists/user/ directories.
 * Safe to call always — creates empty dirs only, never writes YAML.
 */
function createSpecialistsDirs(cwd: string): void {
  const defaultDir = join(cwd, '.specialists', 'default');
  const userDir = join(cwd, '.specialists', 'user');

  let created = 0;
  for (const dir of [defaultDir, userDir]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      created++;
    }
  }

  if (created > 0) {
    ok('created .specialists/default/ and .specialists/user/');
  }
}

/**
 * Create runtime directories (jobs, ready)
 */
function createRuntimeDirs(cwd: string): void {
  const runtimeDirs = [
    join(cwd, '.specialists', 'jobs'),
    join(cwd, '.specialists', 'ready'),
  ];

  let created = 0;
  for (const dir of runtimeDirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      created++;
    }
  }

  if (created > 0) {
    ok('created .specialists/jobs/ and .specialists/ready/');
  }
}

function ensureProjectMcp(cwd: string): void {
  const mcpPath = join(cwd, MCP_FILE);
  const mcp = loadJson(mcpPath, { mcpServers: {} });
  mcp.mcpServers ??= {};

  const existing = mcp.mcpServers[MCP_SERVER_NAME];
  if (
    existing &&
    existing.command === MCP_SERVER_CONFIG.command &&
    Array.isArray(existing.args) &&
    existing.args.length === MCP_SERVER_CONFIG.args.length
  ) {
    skip('.mcp.json already registers specialists');
    return;
  }

  mcp.mcpServers[MCP_SERVER_NAME] = MCP_SERVER_CONFIG;
  saveJson(mcpPath, mcp);
  ok('registered specialists in project .mcp.json');
}

function ensureGitignore(cwd: string): void {
  const gitignorePath = join(cwd, '.gitignore');
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';
  
  let added = 0;
  const lines = existing.split('\n');
  
  for (const entry of GITIGNORE_ENTRIES) {
    if (!lines.includes(entry)) {
      lines.push(entry);
      added++;
    }
  }
  
  if (added > 0) {
    writeFileSync(gitignorePath, lines.join('\n') + '\n', 'utf-8');
    ok('added .specialists/jobs/ and .specialists/ready/ to .gitignore');
  } else {
    skip('.gitignore already has runtime entries');
  }
}

/**
 * Initialize the observability SQLite database if it doesn't already exist.
 * Uses exclusive-create (wx flag) internally — safe to call on every init,
 * will never overwrite or reset an existing database.
 */
function ensureObservabilityDb(cwd: string): void {
  const location = resolveObservabilityDbLocation(cwd);

  if (isPathInsideJobsDirectory(location.dbPath, location.gitRoot)) {
    skip('observability DB path resolves inside jobs directory — skipped');
    return;
  }

  const alreadyExists = existsSync(location.dbPath);
  if (alreadyExists) {
    skip('observability database already exists (not touched)');
    return;
  }

  const { created } = ensureObservabilityDbFile(location);
  if (!created) {
    skip('observability database already exists (not touched)');
    return;
  }

  // Initialize schema at the resolved path.
  const client = createObservabilitySqliteClientAtPath(location.dbPath);
  if (client) {
    client.close();
    ok('created observability database (.specialists/db/observability.db)');
  } else {
    ok('created observability database file (schema init deferred — sqlite3/bun not available)');
  }

  ensureGitignoreHasObservabilityDbEntries(location.gitRoot);
}

function extractSpecialistsBlockSpan(existing: string): { start: number; end: number } | null {
  const start = existing.indexOf('<!-- specialists:start -->');
  if (start === -1) return null;

  const endMarker = '<!-- specialists:end -->';
  const endMarkerIndex = existing.indexOf(endMarker, start);
  if (endMarkerIndex === -1) return null;

  return { start, end: endMarkerIndex + endMarker.length };
}

function ensureAgentsMd(cwd: string): void {
  const agentsPath = join(cwd, 'AGENTS.md');
  if (!existsSync(agentsPath)) {
    writeFileSync(agentsPath, AGENTS_BLOCK, 'utf-8');
    ok('created AGENTS.md with Specialists section');
    return;
  }

  const existing = readFileSync(agentsPath, 'utf-8');
  const span = extractSpecialistsBlockSpan(existing);
  if (span) {
    const next = existing.slice(0, span.start) + AGENTS_BLOCK + existing.slice(span.end);
    if (next === existing) {
      skip('AGENTS.md already has Specialists section');
      return;
    }
    writeFileSync(agentsPath, next, 'utf-8');
    ok('updated Specialists section in AGENTS.md');
    return;
  }

  if (existing.includes(AGENTS_MARKER)) {
    const markerIndex = existing.indexOf(AGENTS_MARKER);
    const nextH2Match = /^## /m.exec(existing.slice(markerIndex + AGENTS_MARKER.length));
    const nextH2Index = nextH2Match ? markerIndex + AGENTS_MARKER.length + nextH2Match.index : existing.length;
    const next = existing.slice(0, markerIndex).trimEnd() + '\n\n' + AGENTS_BLOCK + (nextH2Index < existing.length ? '\n' + existing.slice(nextH2Index) : '');
    writeFileSync(agentsPath, next, 'utf-8');
    ok('migrated Specialists section in AGENTS.md');
    return;
  }

  writeFileSync(agentsPath, existing.trimEnd() + '\n\n' + AGENTS_BLOCK, 'utf-8');
  ok('appended Specialists section to AGENTS.md');
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function hasHookCommand(settings: Record<string, unknown>, eventName: string, command: string): boolean {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object') return false;
  const eventEntries = (hooks as Record<string, unknown>)[eventName];
  if (!Array.isArray(eventEntries)) return false;

  return eventEntries.some(entry => {
    if (!entry || typeof entry !== 'object') return false;
    const hookItems = (entry as Record<string, unknown>).hooks;
    if (!Array.isArray(hookItems)) return false;

    return hookItems.some(hook => {
      if (!hook || typeof hook !== 'object') return false;
      return (hook as Record<string, unknown>).command === command;
    });
  });
}

function validateInitPostconditions(cwd: string): ReadonlyArray<string> {
  const warnings: string[] = [];

  const xtrmHooksDir = join(cwd, '.xtrm', 'hooks', 'specialists');
  const xtrmHookFiles = existsSync(xtrmHooksDir)
    ? readdirSync(xtrmHooksDir).filter(file => file.endsWith('.mjs'))
    : [];
  if (xtrmHookFiles.length === 0) {
    warnings.push('.xtrm/hooks/specialists/ is missing or has no .mjs hooks');
  }

  const claudeHooksDir = join(cwd, '.claude', 'hooks');
  for (const hookFile of xtrmHookFiles) {
    const claudeHookPath = join(claudeHooksDir, hookFile);
    if (!existsSync(claudeHookPath)) {
      warnings.push(`.claude/hooks/${hookFile} is missing`);
      continue;
    }

    const stats = lstatSync(claudeHookPath);
    if (!stats.isSymbolicLink()) {
      warnings.push(`.claude/hooks/${hookFile} is not a symlink`);
      continue;
    }

    const expectedTarget = resolve(xtrmHooksDir, hookFile);
    const resolvedTarget = resolve(dirname(claudeHookPath), readlinkSync(claudeHookPath));
    if (resolvedTarget !== expectedTarget) {
      warnings.push(`.claude/hooks/${hookFile} points to unexpected target`);
    }
  }

  const settings = readJsonObject(join(cwd, '.claude', 'settings.json'));
  const requiredHookWiring: ReadonlyArray<{ event: string; command: string }> = [
    { event: 'SessionStart', command: 'node .claude/hooks/specialists-session-start.mjs' },
  ];

  for (const hook of requiredHookWiring) {
    if (!hasHookCommand(settings, hook.event, hook.command)) {
      warnings.push(`.claude/settings.json missing hook wiring: ${hook.event} -> ${hook.command}`);
    }
  }

  const mcp = readJsonObject(join(cwd, '.mcp.json'));
  const mcpServers = mcp.mcpServers;
  const specialistsServer =
    mcpServers && typeof mcpServers === 'object'
      ? (mcpServers as Record<string, unknown>).specialists
      : undefined;
  if (!specialistsServer || typeof specialistsServer !== 'object') {
    warnings.push('.mcp.json missing mcpServers.specialists registration');
  }

  const runtimeDirs = [join(cwd, '.specialists', 'jobs'), join(cwd, '.specialists', 'ready')];
  for (const runtimeDir of runtimeDirs) {
    if (!existsSync(runtimeDir)) {
      warnings.push(`${relative(cwd, runtimeDir)} is missing`);
    }
  }

  const defaultSkillsRoot = join(cwd, '.xtrm', 'skills', 'default');
  const defaultSkills = existsSync(defaultSkillsRoot)
    ? readdirSync(defaultSkillsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory())
    : [];
  if (defaultSkills.length === 0) {
    warnings.push('.xtrm/skills/default/ is missing or has no skill directories');
  }

  const rootSymlinks: ReadonlyArray<{ linkPath: string; expectedTarget: string }> = [
    {
      linkPath: join(cwd, '.claude', 'skills'),
      expectedTarget: join(cwd, '.xtrm', 'skills', 'active'),
    },
    {
      linkPath: join(cwd, '.pi', 'skills'),
      expectedTarget: join(cwd, '.xtrm', 'skills', 'active'),
    },
  ];

  for (const symlink of rootSymlinks) {
    if (!existsSync(symlink.linkPath)) {
      warnings.push(`${relative(cwd, symlink.linkPath)} is missing`);
      continue;
    }

    const stats = lstatSync(symlink.linkPath);
    if (!stats.isSymbolicLink()) {
      warnings.push(`${relative(cwd, symlink.linkPath)} is not a symlink`);
      continue;
    }

    const resolvedTarget = resolve(dirname(symlink.linkPath), readlinkSync(symlink.linkPath));
    if (resolvedTarget !== resolve(symlink.expectedTarget)) {
      warnings.push(`${relative(cwd, symlink.linkPath)} points to an unexpected target`);
    }
  }

  return warnings;
}

export interface InitOptions {
  /** Deprecated alias: keep only for intentional pin/bootstrap compatibility. */
  syncDefaults?: boolean;
  /** When true, overwrite canonical skills in .xtrm/skills/default/ and refresh active symlinks only. */
  syncSkills?: boolean;
  /** Skip xtrm prerequisites (.xtrm dir + xt CLI). Useful for CI/testing. */
  noXtrmCheck?: boolean;
  /** When true, manage the global ~/.config/specialists/user.json override layer instead of bootstrapping a project. */
  global?: boolean;
}

/**
 * Generate / extend the global ~/.config/specialists/user.json override layer.
 * Idempotent: seeds every shipped specialist with null/[] defaults on first run;
 * on re-run extends with newly-shipped specialists and fills missing override
 * fields WITHOUT clobbering user-filled values. Removed specialists stay in the
 * file and are surfaced in stdout (no JSON comments — doctor flags them).
 */
export async function runGlobal(): Promise<void> {
  console.log(`\n${bold('specialists init --global')}\n`);

  const loader = new SpecialistLoader();
  const specialists = await loader.list();
  const shippedNames = specialists.map(spec => spec.name).sort();
  const template = buildGlobalUserConfigTemplate(shippedNames);

  const location = getGlobalUserConfigPath();
  const existing = readGlobalUserConfig(location);

  let guidePath: string | null = null;

  if (existing) {
    const result = mergeGlobalUserConfig(
      existing as Record<string, unknown>,
      template,
    );
    writeGlobalUserConfig(location, result.config);
    guidePath = writeGlobalOverridesGuide(location.path);

    ok(`using global config at ${location.path} (${location.source})`);
    if (result.added.length > 0) {
      ok(`added ${result.added.length} new specialist${result.added.length === 1 ? '' : 's'}: ${result.added.join(', ')}`);
    } else {
      skip('no new specialists to add');
    }
    if (result.extended.length > 0) {
      ok(`preserved ${result.extended.length} existing specialist${result.extended.length === 1 ? '' : 's'} (user values kept)`);
    }
    for (const removedName of result.removed) {
      warn(`${removedName} is no longer shipped but kept in file (remove manually if unwanted)`);
    }
  } else {
    writeGlobalUserConfig(location, template);
    guidePath = writeGlobalOverridesGuide(location.path);
    ok(`created global config at ${location.path} (${location.source})`);
    ok(`seeded ${shippedNames.length} specialist${shippedNames.length === 1 ? '' : 's'} with inherit defaults`);
  }

  if (guidePath) {
    ok(`wrote overrides guide at ${guidePath}`);
  }

  console.log(`\n${bold('Done!')}\n`);
  console.log(`  ${dim('Override reference:')} ${yellow(guidePath ?? './overrides-guide.md')}`);
  console.log(`  ${dim('Edit override fields with:')}`);
  console.log(`  ${yellow('specialists edit --global <name>.execution.model <value>')}`);
  console.log(`  ${yellow('specialists edit --global')} ${dim('# open in $EDITOR')}\n`);
  console.log(`  ${dim('Common override hints:')}`);
  console.log(`  ${dim('• for extension opt-out, set')} ${yellow('<name>.execution.extensions.gitnexus false')}`);
  console.log(`  ${dim('• for trusted custom extension sources, set')} ${yellow('<name>.execution.extensions."npm:@scope/pkg" true')}`);
  console.log(`  ${dim('• for system prompt composition, set')} ${yellow('<name>.prompt.system_prompt_mode append|replace')}`);
  console.log(`  ${dim('• for fallback chains, set')} ${yellow('<name>.execution.fallback_models ["provider/model", "provider/model"]')}`);
  console.log(`  ${dim('• for preset refs, set model/fallback entries to')} ${yellow('@preset/cheap')} ${dim('(or medium, power)')}`);
  console.log(`  ${dim('• for per-specialist mandatory rule sets, set')} ${yellow('<name>.mandatory_rules.template_sets ["git-workflow-safe", ...]')}`);
  console.log(`  ${dim('    (null inherits the shipped sets, [] selects no specialist-specific sets; index required/default sets always load)')}\n`);
}

export async function run(opts: InitOptions = {}): Promise<void> {
  if (opts.global) {
    return runGlobal();
  }

  const cwd = process.cwd();

  const forceInit = process.env.SPECIALISTS_INIT_FORCE === '1';
  const inAgentSession =
    !forceInit && (
      !process.stdin.isTTY ||
      !!process.env.SPECIALISTS_TMUX_SESSION ||
      !!process.env.SPECIALISTS_JOB_ID ||
      !!process.env.PI_SESSION_ID ||
      !!process.env.PI_RPC_SOCKET
    );

  if (inAgentSession) {
    console.error('specialists init requires an interactive terminal. This is a user-only bootstrap command — do not invoke from scripts or agent sessions.');
    process.exit(1);
  }

  console.log(`\n${bold('specialists init')}\n`);

  const { syncDefaults = false, syncSkills = false, noXtrmCheck = false } = opts;

  if (!noXtrmCheck) {
    assertXtrmPrerequisites(cwd);
  }

  warnMissingOptionalPrerequisites();

  // ── 1. Create .specialists/ structure ─────────────────────────────────────
  if (syncDefaults) {
    warn('--sync-defaults is deprecated. This creates drift debt; use sp pin <id> for intentional pins.');
    migrateLegacySpecialists(cwd, 'default');
    copyCanonicalSpecialists(cwd);
    copyCanonicalMandatoryRules(cwd);
    copyCanonicalNodeConfigs(cwd);
  } else {
    skip('.specialists/default/ not synced (package canonical by default; use sp pin <id> for intentional pins)');
  }

  migrateLegacySpecialists(cwd, 'user');
  createSpecialistsDirs(cwd);
  createRuntimeDirs(cwd);

  // ── 2. Update .gitignore (only runtime dirs) ──────────────────────────────
  ensureGitignore(cwd);

  // ── 3. Scaffold AGENTS.md ─────────────────────────────────────────────────
  ensureAgentsMd(cwd);

  // ── 4. Register MCP at project scope ──────────────────────────────────────
  ensureProjectMcp(cwd);

  // ── 5. Install hooks via .xtrm/hooks/specialists and .claude symlinks ────
  installProjectHooks(cwd);
  ensureProjectHookWiring(cwd);

  // ── 6. Install skills via .xtrm default + active symlink roots ────────────
  installProjectSkills(cwd, syncSkills);

  // ── 7. Initialize observability database (never overwrites existing) ──────
  ensureObservabilityDb(cwd);

  const postconditionWarnings = validateInitPostconditions(cwd);
  if (postconditionWarnings.length > 0) {
    warn('Init completed with postcondition warnings:');
    for (const warningMessage of postconditionWarnings) {
      warn(warningMessage);
    }
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  console.log(`\n${bold('Done!')}\n`);
  console.log(`  ${dim('Project-local installation:')}`);
  console.log(`  .xtrm/hooks/specialists/ ${dim('# canonical specialists hooks')}`);
  console.log(`  .claude/hooks/            ${dim('# symlinks -> .xtrm/hooks/specialists')}`);
  console.log(`  .claude/settings.json     ${dim('# hook wiring')}`);
  console.log(`  .xtrm/skills/default/  ${dim('# canonical skills')}`);
  console.log(`  .xtrm/skills/active/   ${dim('# flattened active skill root')}`);
  console.log(`  .claude/skills/        ${dim('# symlink -> .xtrm/skills/active')}`);
  console.log(`  .pi/skills/            ${dim('# symlink -> .xtrm/skills/active')}`);
  console.log('');
  console.log(`  ${dim('.specialists/ structure:')}`);
  console.log(`  .specialists/`);
  console.log(`  ├── default/           ${dim('# intentional pins only; package canonical by default')}`)
  console.log(`  ├── user/              ${dim('# your custom specialists')}`);
  console.log(`  ├── db/                ${dim('# observability SQLite (gitignored)')}`);
  console.log(`  ├── jobs/              ${dim('# runtime (gitignored)')}`);
  console.log(`  └── ready/             ${dim('# runtime (gitignored)')}`);
  console.log(`\n  ${dim('Next steps:')}`);
  console.log(`  1. Run ${yellow('specialists list')} to see available specialists`);
  console.log(`  2. Add custom specialists to ${yellow('.specialists/user/')}`);
  console.log(`  3. Restart Claude Code or pi to pick up changes\n`);
}