import { chmod, lstat, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_SHEBANG = '#!/usr/bin/env node';
const BUN_SHEBANG = '#!/usr/bin/env bun';

function isWithinRoot(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolveContainedPath(rootPath, candidatePath) {
  const entry = await lstat(candidatePath);
  if (entry.isSymbolicLink()) {
    throw new Error(`refusing to follow symlink: ${candidatePath}`);
  }

  const candidateRealPath = await realpath(candidatePath);
  if (!isWithinRoot(rootPath, candidateRealPath)) {
    throw new Error(`path escapes root: ${candidatePath}`);
  }

  return candidateRealPath;
}

async function resolveContainedRegularFile(rootPath, candidatePath) {
  const candidateRealPath = await resolveContainedPath(rootPath, candidatePath);
  const fileStatus = await stat(candidateRealPath);
  if (!fileStatus.isFile()) {
    throw new Error(`expected regular file: ${candidatePath}`);
  }

  return { candidateRealPath, fileStatus };
}

async function resolveContainedDirectoryRoot(lexicalPath, ...parentRealPaths) {
  const entry = await lstat(lexicalPath);
  if (entry.isSymbolicLink()) {
    throw new Error(`refusing to follow symlink: ${lexicalPath}`);
  }
  if (!entry.isDirectory()) {
    throw new Error(`expected directory: ${lexicalPath}`);
  }
  const realPath = await realpath(lexicalPath);
  for (const parentRealPath of parentRealPaths) {
    if (!isWithinRoot(parentRealPath, realPath)) {
      throw new Error(`path escapes root: ${lexicalPath}`);
    }
  }
  return realPath;
}

async function rewriteCliShebang(distRootPath) {
  const cliPath = path.join(distRootPath, 'index.js');
  const { candidateRealPath, fileStatus } = await resolveContainedRegularFile(distRootPath, cliPath);
  const cliSource = await readFile(candidateRealPath, 'utf8');
  const normalizedSource = cliSource.startsWith(NODE_SHEBANG)
    ? BUN_SHEBANG + cliSource.slice(NODE_SHEBANG.length)
    : cliSource;

  if (normalizedSource !== cliSource) {
    await writeFile(candidateRealPath, normalizedSource);
  }

  await chmod(candidateRealPath, fileStatus.mode | 0o111);
}

async function normalizeDeclarationFile(distTypesRootPath, declarationPath) {
  const { candidateRealPath } = await resolveContainedRegularFile(distTypesRootPath, declarationPath);
  const source = await readFile(candidateRealPath, 'utf8');
  const normalized = source.replace(/[\t ]+$/gm, '');

  if (normalized !== source) {
    await writeFile(candidateRealPath, normalized);
  }
}

async function walkDeclarations(distTypesRootPath, currentPath = distTypesRootPath) {
  const currentRealPath = await resolveContainedPath(distTypesRootPath, currentPath);
  const entries = await readdir(currentRealPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(currentRealPath, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`refusing to follow symlink: ${entryPath}`);
    }
    if (entry.isDirectory()) {
      await walkDeclarations(distTypesRootPath, entryPath);
      continue;
    }
    if (!entry.name.endsWith('.d.ts')) {
      continue;
    }
    await normalizeDeclarationFile(distTypesRootPath, entryPath);
  }
}

/**
 * Bundles are emitted into `dist/`, so a comment naming `../node_modules/...` resolves to this
 * repo's own dependencies and is fine. TWO OR MORE levels up escapes the repo entirely — which
 * is what happens when a build runs inside an .xtrm worktree whose node_modules is incomplete:
 * bun silently resolves the missing packages from the parent checkout and bakes their paths in.
 */
const ESCAPED_DEPENDENCY_PATH = /(?:\.\.\/){2,}node_modules\/((?:@[^/\s'"`]+\/)?[^/\s'"`]+)/g;

/**
 * Fail the build when the bundle was assembled from more than one node_modules tree.
 *
 * unitAI-rrdnt.41: this corruption produced NO error. The only signal was
 * tests/integration/release-attestation.test.ts failing, which reads as a defect in the changed
 * code until you diff dist against HEAD. Every lane in this epic rebuilds dist, so every lane
 * could hit it, and the lane that hit it committed the result.
 *
 * This throws rather than stripping the comments deliberately. A bundle assembled from two
 * different dependency trees is not cosmetically wrong — the packages it linked against are not
 * the ones declared here. Rewriting the paths would hide that instead of fixing it.
 */
async function assertBundleUsesOneDependencyTree(distRootPath) {
  const leaked = new Map();

  for (const bundleName of ['index.js', 'lib.js']) {
    const bundlePath = path.join(distRootPath, bundleName);
    let source;
    try {
      const { candidateRealPath } = await resolveContainedRegularFile(distRootPath, bundlePath);
      source = await readFile(candidateRealPath, 'utf8');
    } catch {
      continue; // not every build emits every bundle
    }
    for (const match of source.matchAll(ESCAPED_DEPENDENCY_PATH)) {
      const packageName = match[1];
      leaked.set(packageName, (leaked.get(packageName) ?? 0) + 1);
    }
  }

  if (leaked.size === 0) return;

  const named = [...leaked.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([packageName, count]) => `  ${packageName} (${count} reference${count === 1 ? '' : 's'})`)
    .join('\n');

  throw new Error(
    'build aborted: the bundle was linked against dependencies from OUTSIDE this checkout.\n\n'
    + 'These packages resolved to a parent node_modules tree:\n' + named + '\n\n'
    + 'This happens when building inside a worktree whose dependencies were never installed —\n'
    + 'bun resolves what is missing from the parent checkout and bakes those paths into dist.\n'
    + 'The bundle is wrong, not just untidy: it links against versions this checkout does not declare.\n\n'
    + 'Fix: run `bun install` in THIS directory, then build again.\n'
    + '(unitAI-rrdnt.41)',
  );
}

export async function postprocessBuild(projectRootPath = process.cwd()) {
  const rootRealPath = await realpath(projectRootPath);
  const distLexicalPath = path.join(rootRealPath, 'dist');
  const distRealPath = await resolveContainedDirectoryRoot(distLexicalPath, rootRealPath);
  const distTypesLexicalPath = path.join(distLexicalPath, 'types');
  const distTypesRealPath = await resolveContainedDirectoryRoot(
    distTypesLexicalPath,
    rootRealPath,
    distRealPath,
  );
  await assertBundleUsesOneDependencyTree(distRealPath);
  await rewriteCliShebang(distRealPath);
  await walkDeclarations(distTypesRealPath);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await postprocessBuild().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
