import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Wave E1 path discipline (substrate plugin design §6): plugin-owned paths must
 * be ${CLAUDE_PLUGIN_ROOT}-rooted, the §B forbidden substrings must not appear,
 * and .mcp.json must carry no env block (design §5 correction).
 */
const PLUGIN_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'plugins',
  'substrate',
);

function read(rel: string): string {
  return readFileSync(join(PLUGIN_ROOT, rel), 'utf-8');
}

const JSON_FILES = ['hooks/hooks.json', '.mcp.json'];
const SCRIPT_FILES = [
  'scripts/mcp-server.mjs',
  'scripts/session-start.mjs',
  'scripts/precompact.mjs',
];

describe('substrate plugin path discipline', () => {
  it('registers every plugin-owned entrypoint through ${CLAUDE_PLUGIN_ROOT}', () => {
    const hooks = read('hooks/hooks.json');
    expect(hooks).toContain('${CLAUDE_PLUGIN_ROOT}/scripts/session-start.mjs');
    expect(hooks).toContain('${CLAUDE_PLUGIN_ROOT}/scripts/precompact.mjs');
    expect(read('.mcp.json')).toContain('${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs');
  });

  it('contains none of the forbidden path substrings', () => {
    const forbidden = [
      'CLAUDE_PROJECT_DIR}/packages', // §B named anti-pattern
      'packages/substrate/integrations', // repo-checkout-relative layout
      'process.cwd()', // cwd fallback for plugin-owned assets
      '"./scripts/', // relative hook/MCP entrypoints
      "'./scripts/",
    ];
    for (const rel of [...JSON_FILES, ...SCRIPT_FILES]) {
      const text = read(rel);
      for (const bad of forbidden) {
        expect(text, `${rel} contains forbidden ${bad}`).not.toContain(bad);
      }
    }
  });

  it('.mcp.json declares no env key', () => {
    const parsed: unknown = JSON.parse(read('.mcp.json'));
    const keys: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          keys.push(k);
          walk(v);
        }
      }
    };
    walk(parsed);
    expect(keys).not.toContain('env');
  });

  it('pins the Bun runtime for the MCP server and every hook command', () => {
    const mcp = JSON.parse(read('.mcp.json')) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(mcp.mcpServers.substrate.command).toBe('bun');
    const hooks = JSON.parse(read('hooks/hooks.json')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command?: string }> }>>;
    };
    const commands: string[] = [];
    for (const entries of Object.values(hooks.hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          if (hook.command) commands.push(hook.command);
        }
      }
    }
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command.startsWith('bun '), `hook command pins bun: ${command}`).toBe(true);
    }
  });
});
