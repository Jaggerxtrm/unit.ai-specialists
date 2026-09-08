import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, sep, resolve as resolvePath } from 'node:path';

const OBSERVABILITY_DB_FILENAME = 'observability.db';
const DEFAULT_DB_DIRECTORY_RELATIVE_TO_GIT_ROOT = ['.specialists', 'db'] as const;
export const OBSERVABILITY_SCHEMA_VERSION = 15;

export interface ObservabilityDbLocation {
  gitRoot: string;
  dbDirectory: string;
  dbPath: string;
  dbWalPath: string;
  dbShmPath: string;
  source: 'git-root' | 'xdg-data-home';
}

function resolveGitRootFrom(cwd: string): string {
  const commonDirResult = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  if (commonDirResult.status === 0) {
    const commonDir = commonDirResult.stdout.trim();
    if (commonDir.length > 0 && commonDir.endsWith(`${sep}.git`)) {
      return commonDir.slice(0, -4);
    }
  }

  const fallbackResult = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  if (fallbackResult.status !== 0) return cwd;

  const gitRoot = fallbackResult.stdout.trim();
  return gitRoot.length > 0 ? gitRoot : cwd;
}

function resolveDbDirectory(gitRoot: string): { directory: string; source: ObservabilityDbLocation['source'] } {
  const xdgDataHome = process.env.XDG_DATA_HOME?.trim();
  if (xdgDataHome) {
    return { directory: join(xdgDataHome, 'specialists'), source: 'xdg-data-home' };
  }

  return {
    directory: join(gitRoot, ...DEFAULT_DB_DIRECTORY_RELATIVE_TO_GIT_ROOT),
    source: 'git-root',
  };
}

/**
 * Test-only relocation of the repository's own store.
 *
 * When `SPECIALISTS_FORBID_DB_DIR` names a directory and resolution lands on it, the
 * location is moved to `SPECIALISTS_FALLBACK_DB_DIR` instead. This exists because a test
 * run once migrated the repository's authoritative forensic store in place
 * (unitAI-rrdnt.16): the git-root fallback is correct for production and catastrophic for
 * a test that happens to run with the repository as its cwd.
 *
 * Relocation is targeted, never global. Forcing XDG_DATA_HOME for the whole suite was
 * tried first and is wrong — tests that build their own temp repository expect git-root
 * resolution INSIDE it, so a global override puts the writer and the reader of one test on
 * different databases. Redirecting only the forbidden directory leaves every legitimate
 * pattern untouched, and both halves of a test still resolve identically.
 *
 * Production sets neither variable, so its behaviour is unchanged.
 */
function relocateIfForbidden(directory: string): string {
  const forbidden = process.env.SPECIALISTS_FORBID_DB_DIR?.trim();
  const fallback = process.env.SPECIALISTS_FALLBACK_DB_DIR?.trim();
  if (!forbidden || !fallback) return directory;
  return resolvePath(directory) === resolvePath(forbidden) ? fallback : directory;
}

export function resolveObservabilityDbLocation(cwd: string = process.cwd()): ObservabilityDbLocation {
  const gitRoot = resolveGitRootFrom(cwd);
  const resolved = resolveDbDirectory(gitRoot);
  const directory = relocateIfForbidden(resolved.directory);
  const dbPath = join(directory, OBSERVABILITY_DB_FILENAME);

  return {
    gitRoot,
    dbDirectory: directory,
    dbPath,
    dbWalPath: `${dbPath}-wal`,
    dbShmPath: `${dbPath}-shm`,
    source: resolved.source,
  };
}

export function ensureObservabilityDbFile(location: ObservabilityDbLocation): { created: boolean } {
  mkdirSync(location.dbDirectory, { recursive: true });

  const alreadyExists = existsSync(location.dbPath);
  if (alreadyExists) {
    chmodSync(location.dbPath, 0o644);
  }

  return { created: !alreadyExists };
}

export function ensureGitignoreHasObservabilityDbEntries(gitRoot: string): { changed: boolean } {
  const gitignorePath = join(gitRoot, '.gitignore');
  const requiredEntries = [
    '.specialists/db/*.db',
    '.specialists/db/*.db-wal',
    '.specialists/db/*.db-shm',
  ];

  const existing = existsSync(gitignorePath)
    ? readFileSync(gitignorePath, 'utf-8')
    : '';

  const existingLines = new Set(existing.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
  const missingEntries = requiredEntries.filter(entry => !existingLines.has(entry));

  if (missingEntries.length === 0) {
    return { changed: false };
  }

  const needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n');
  const prefix = needsLeadingNewline ? '\n' : '';
  const sectionHeader = existing.includes('# Specialists observability database') ? '' : '# Specialists observability database\n';
  const block = `${prefix}${sectionHeader}${missingEntries.join('\n')}\n`;
  writeFileSync(gitignorePath, `${existing}${block}`, 'utf-8');

  return { changed: true };
}

function hasSqlite3Binary(): boolean {
  const result = spawnSync('which', ['sqlite3'], { stdio: 'ignore' });
  return result.status === 0;
}

export function isObservabilityDbInitialized(location: ObservabilityDbLocation): boolean {
  if (!existsSync(location.dbPath) || !hasSqlite3Binary()) return false;

  const tableCheckResult = spawnSync('sqlite3', ['-json', location.dbPath, "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version') AS has_schema_version_table;"], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  if (tableCheckResult.status !== 0) return false;

  try {
    const tableCheckRows = JSON.parse(tableCheckResult.stdout.trim()) as Array<{ has_schema_version_table?: number }>;
    if (tableCheckRows[0]?.has_schema_version_table !== 1) return false;
  } catch {
    return false;
  }

  const versionCheckResult = spawnSync('sqlite3', ['-json', location.dbPath, `SELECT EXISTS(SELECT 1 FROM schema_version WHERE version = ${OBSERVABILITY_SCHEMA_VERSION}) AS has_expected_schema_version;`], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  if (versionCheckResult.status !== 0) return false;

  try {
    const versionCheckRows = JSON.parse(versionCheckResult.stdout.trim()) as Array<{ has_expected_schema_version?: number }>;
    return versionCheckRows[0]?.has_expected_schema_version === 1;
  } catch {
    return false;
  }
}

export function isPathInsideJobsDirectory(pathToCheck: string, gitRoot: string): boolean {
  const jobsDirPrefix = `${join(gitRoot, '.specialists', 'jobs')}${sep}`;
  return pathToCheck.startsWith(jobsDirPrefix);
}
