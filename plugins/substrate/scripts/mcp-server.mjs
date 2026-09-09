#!/usr/bin/env node
// Substrate plugin MCP launcher.
//
// Exists for one reason: the runtime entrypoint is dist/index.js inside the
// @jaggerxtrm/specialists package, whose position relative to CLAUDE_PLUGIN_ROOT differs
// between an npm install and a --plugin-dir checkout. Resolve, then import. No argv:
// the entrypoint starts MCP server mode (SDK v2, strict 2026-07-28) when given no
// subcommand.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

function resolveRuntime() {
  try {
    return require.resolve('@jaggerxtrm/specialists');
  } catch {
    // In-package layout: plugins/substrate/scripts/ -> ../../../dist/index.js
    const local = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
    if (existsSync(local)) return local;
  }
  return null;
}

const entry = resolveRuntime();
if (!entry) {
  console.error(
    'substrate plugin: cannot locate the specialists runtime (Bun runtime required).\n' +
      'Install Bun from https://bun.sh (tested with bun 1.3.14), then ' +
      'install @jaggerxtrm/specialists, or run the plugin from a built checkout ' +
      '(bun run build) so dist/index.js exists.',
  );
  process.exit(1);
}

await import(entry);
