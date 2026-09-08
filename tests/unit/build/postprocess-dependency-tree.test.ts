import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { postprocessBuild } from '../../../scripts/postprocess-build.mjs';

/**
 * unitAI-rrdnt.41. Building inside a worktree whose node_modules is incomplete made bun resolve
 * the missing packages from the parent checkout and bake their paths into the bundle. It produced
 * NO error — the only signal was release-attestation failing, which reads as a defect in the
 * changed code until you diff dist against HEAD. Every lane in this epic rebuilds dist.
 *
 * The guard throws rather than stripping the comments, deliberately: a bundle assembled from two
 * dependency trees links against versions this checkout does not declare, and rewriting the paths
 * would hide that rather than fix it.
 */

let root: string;

async function build(indexSource: string) {
  await mkdir(path.join(root, 'dist', 'types'), { recursive: true });
  await writeFile(path.join(root, 'dist', 'index.js'), indexSource);
  return postprocessBuild(root);
}

beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'postprocess-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('postprocessBuild dependency-tree guard (unitAI-rrdnt.41)', () => {
  it('aborts the build when packages leaked in from a parent tree', async () => {
    await expect(build([
      '#!/usr/bin/env node',
      '// ../../../node_modules/zod/lib/index.js',
      '// ../../../node_modules/zod/lib/types.js',
    ].join('\n'))).rejects.toThrow(/build aborted/);
  });

  it('names every leaked package, not just the first', async () => {
    await expect(build([
      '#!/usr/bin/env node',
      '// ../../../node_modules/zod/lib/index.js',
      '// ../../../node_modules/@modelcontextprotocol/sdk/dist/index.js',
    ].join('\n'))).rejects.toThrow(/@modelcontextprotocol\/sdk/);
  });

  it('names the fix, because inferring it from a release-attestation diff is the actual defect', async () => {
    await expect(build('// ../../../node_modules/zod/lib/index.js'))
      .rejects.toThrow(/bun install/);
  });

  it("accepts ../node_modules, which is this repo's own dependencies seen from dist/", async () => {
    // dist/ is one level down, so a single ../ is the repo's own tree and is correct.
    await expect(build([
      '#!/usr/bin/env node',
      '// ../node_modules/zod/lib/index.js',
    ].join('\n'))).resolves.toBeUndefined();
  });

  it('still rewrites the CLI shebang once the bundle is clean', async () => {
    await build('#!/usr/bin/env node\nconsole.log(1);\n');
    expect(await readFile(path.join(root, 'dist', 'index.js'), 'utf8'))
      .toMatch(/^#!\/usr\/bin\/env bun/);
  });
});
