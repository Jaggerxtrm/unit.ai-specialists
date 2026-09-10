#!/usr/bin/env node
// Substrate plugin MCP launcher.
//
// Resolves the runtime that ships WITH this plugin, then imports it. No argv: the
// entrypoint starts MCP server mode when given no subcommand.
//
// Local-first is load-bearing, not a style choice. `../../../dist/index.js` is correct in
// BOTH supported layouts — a --plugin-dir checkout (repo/plugins/substrate/scripts) and an
// npm install (node_modules/@jaggerxtrm/specialists/plugins/substrate/scripts) — so the
// plugin's own build is always the right answer. Asking the package name first is what
// broke: under bun, `require.resolve('@jaggerxtrm/specialists')` from a plugin directory
// with no local node_modules resolves into bun's GLOBAL INSTALL CACHE
// (~/.bun/install/cache/@jaggerxtrm/specialists@<ver>/dist/index.js), silently serving a
// stale published runtime whose tool surface predates this plugin (unitAI-aiwva.2).
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

function resolveRuntime() {
  // The runtime shipped alongside this plugin, in both supported layouts.
  const local = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
  if (existsSync(local)) return local;
  // Only when the plugin is installed apart from its runtime.
  try {
    return require.resolve('@jaggerxtrm/specialists');
  } catch {
    return null;
  }
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
