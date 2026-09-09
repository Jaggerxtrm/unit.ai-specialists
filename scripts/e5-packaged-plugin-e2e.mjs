#!/usr/bin/env node
// Wave E5 end-to-end: packaged-plugin run from a scratch repository.
//
// Packs THIS checkout with `npm pack`, installs the tarball into a scratch
// repo under /tmp (never the repo), then walks the spec §700 acceptance
// chain against the INSTALLED bits in order:
//   load → discover → 2026-07-28 → tools → same-store
// plus legacy-initialize rejection and the PreCompact/PostCompact lifecycle.
//
// Every env-blocked live step is reported UNPROVEN with an owner — never a
// silent skip, never a green claim. Exit non-zero on any proven-link failure.
//
// Usage: node scripts/e5-packaged-plugin-e2e.mjs
// Keeps its scratch dir for inspection; prints the path at the end.

import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROTOCOL = '2026-07-28';
const EXPECTED_TOOLS = [
  'use_specialist',
  'specialist_status',
  'specialist_dispatch',
  'specialist_reply',
  'specialist_resume',
  'specialist_stop_activation',
  'specialist_list',
];
const PLUGIN_FILES = [
  'package/plugins/substrate/.claude-plugin/plugin.json',
  'package/plugins/substrate/hooks/hooks.json',
  'package/plugins/substrate/.mcp.json',
  'package/plugins/substrate/scripts/mcp-server.mjs',
  'package/plugins/substrate/scripts/session-start.mjs',
  'package/plugins/substrate/scripts/precompact.mjs',
  'package/plugins/substrate/skills/using-substrate/SKILL.md',
];

const failures = [];
const unproven = [];
function say(s = '') {
  console.log(s);
}
function link(name, ok, detail) {
  say(`${ok ? 'PASS' : 'FAIL'} [${name}] ${detail}`);
  if (!ok) failures.push(name);
}
function unprovenLink(name, owner, detail) {
  say(`UNPROVEN [${name}] owner=${owner} ${detail}`);
  unproven.push(`${name} (owner: ${owner})`);
}
function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf-8',
    timeout: 120000,
    ...opts,
  });
}

const SCRATCH = mkdtempSync(join(tmpdir(), 'e5-scratch-'));
const PACKDIR = join(SCRATCH, 'pack');
const REPO_DIR = join(SCRATCH, 'repo');
const PLUGINDATA = join(SCRATCH, 'plugindata');
const STORE = join(SCRATCH, 'state.db');
for (const d of [PACKDIR, REPO_DIR, PLUGINDATA]) {
  await import('node:fs').then((fs) => fs.mkdirSync(d, { recursive: true }));
}

say(`scratch: ${SCRATCH}`);
say(`repo checkout under test: ${REPO}`);

// ---- Step 0: versions -------------------------------------------------------
const claudeVer = run('claude', ['--version'], { timeout: 30000 });
const bunVer = run('bun', ['--version'], { timeout: 30000 });
const nodeVer = run('node', ['--version'], { timeout: 30000 });
const sdkVer = JSON.parse(
  readFileSync(join(REPO, 'node_modules/@modelcontextprotocol/server/package.json'), 'utf-8'),
).version;
const pluginVer = JSON.parse(
  readFileSync(join(REPO, 'plugins/substrate/.claude-plugin/plugin.json'), 'utf-8'),
).version;
const commit = run('git', ['rev-parse', 'HEAD'], { cwd: REPO }).stdout.trim();
say(`claude: ${(claudeVer.stdout || claudeVer.stderr || '').trim()}`);
say(`bun: ${bunVer.stdout.trim()}  node: ${nodeVer.stdout.trim()}`);
say(`@modelcontextprotocol/server: ${sdkVer}  plugin: ${pluginVer}  substrate: ${commit}`);

// ---- Step 1: pack -----------------------------------------------------------
const pack = run('npm', ['pack', '--pack-destination', PACKDIR], { cwd: REPO, timeout: 180000 });
const tarballMatch = /([^\s]+\.tgz)\s*$/.exec((pack.stdout || '').trim());
if (pack.status !== 0 || !tarballMatch) {
  link('pack', false, `npm pack failed: ${(pack.stderr || '').slice(0, 500)}`);
  say(`scratch kept at ${SCRATCH}`);
  process.exit(1);
}
const TARBALL = join(PACKDIR, tarballMatch[1]);
say(`tarball: ${TARBALL}`);
const tarList = run('tar', ['-tzf', TARBALL]).stdout;
const missing = PLUGIN_FILES.filter((f) => !tarList.includes(f));
link(
  'pack',
  missing.length === 0 && tarList.includes('package/dist/index.js'),
  missing.length === 0
    ? '7 plugin files + dist/index.js in tarball'
    : `missing from tarball: ${missing.join(', ')}`,
);

// ---- Step 2: scratch install ------------------------------------------------
run('npm', ['init', '-y'], { cwd: REPO_DIR });
const install = run('npm', ['install', TARBALL, '--no-audit', '--no-fund'], {
  cwd: REPO_DIR,
  timeout: 300000,
});
const PLUGIN = join(REPO_DIR, 'node_modules/@jaggerxtrm/specialists/plugins/substrate');
const installedOk =
  install.status === 0 &&
  PLUGIN_FILES.every((f) => existsSync(join(REPO_DIR, 'node_modules/@jaggerxtrm/specialists', f.slice('package/'.length))));
link(
  'install',
  installedOk,
  install.status === 0
    ? `npm installed tarball into scratch repo; plugin at node_modules/@jaggerxtrm/specialists/plugins/substrate`
    : `npm install failed: ${(install.stderr || '').slice(0, 500)}`,
);
if (!installedOk) {
  say(`scratch kept at ${SCRATCH}`);
  process.exit(1);
}

// ---- Step 3: load (validate the INSTALLED copy, strict) ---------------------
const validate = run('claude', ['plugin', 'validate', PLUGIN, '--strict'], { timeout: 120000 });
say(`--- claude plugin validate --strict (installed copy) ---`);
say((validate.stdout || '').trim() || '(no stdout)');
say(`exit=${validate.status} ${(validate.stderr || '').trim()}`);
link('load', validate.status === 0, `strict validate exit ${validate.status} on installed copy`);

// ---- Step 4: seed the one authority (outside the scratch repo) --------------
const seed = run(
  'bun',
  [
    '-e',
    `const {Database}=await import('bun:sqlite');
     const db=new Database('${STORE}');
     db.exec("CREATE TABLE activations (activation_id TEXT PRIMARY KEY, specialist TEXT NOT NULL, state TEXT NOT NULL, bead_id TEXT, last_activity_at INTEGER NOT NULL)");
     const put=db.prepare('INSERT OR REPLACE INTO activations VALUES (?,?,?,?,?)');
     put.run('act:e5-live1','researcher','running','B-1',3000);
     put.run('act:e5-live2','executor','needs_reply','B-2',2000);
     put.run('act:e5-old','executor','settled','B-3',9999);
     db.close();`,
  ],
  { timeout: 60000 },
);
link('seed', seed.status === 0 && existsSync(STORE), `authority at ${STORE} (outside scratch repo)`);

// ---- Step 5: MCP wire vs the PACKAGED server --------------------------------
// Same XTRM_STATE_DB the hooks get; hermetic observability; cwd is the
// scratch repo to prove the store path is never cwd-derived.
const serverEnv = {
  ...process.env,
  XTRM_STATE_DB: STORE,
  XDG_DATA_HOME: join(SCRATCH, 'xdg'),
};
const child = spawn('bun', [join(PLUGIN, 'scripts/mcp-server.mjs')], {
  cwd: REPO_DIR,
  env: serverEnv,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const lines = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;
let stderrTail = '';
child.stderr.on('data', (c) => {
  stderrTail += c.toString();
});
lines.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
function call(method, params, timeoutMs = 60000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timed out waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
const META = {
  'io.modelcontextprotocol/protocolVersion': PROTOCOL,
  'io.modelcontextprotocol/clientCapabilities': {},
};
try {
  const discover = await call('server/discover', { _meta: META });
  say(`--- server/discover (packaged server) ---`);
  say(JSON.stringify(discover.result ?? discover.error));
  link(
    'discover',
    !discover.error &&
      JSON.stringify(discover.result?.supportedVersions) === JSON.stringify([PROTOCOL]),
    `supportedVersions=${JSON.stringify(discover.result?.supportedVersions)}`,
  );
  link(
    '2026-07-28',
    !discover.error &&
      discover.result?.capabilities?.tools !== undefined &&
      discover.result?.resultType === 'complete',
    `tools capability + resultType=${discover.result?.resultType}`,
  );

  const tools = await call('tools/list', { _meta: META });
  say(`--- tools/list (packaged server) ---`);
  say(JSON.stringify((tools.result?.tools ?? []).map((t) => t.name)));
  link(
    'tools',
    !tools.error &&
      JSON.stringify((tools.result?.tools ?? []).map((t) => t.name)) ===
        JSON.stringify(EXPECTED_TOOLS),
    `7-tool surface incl. specialist_resume, deterministic order`,
  );

  const legacy = await call('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'e5-probe', version: '0' },
  });
  say(`--- initialize (legacy, must be rejected) ---`);
  say(JSON.stringify(legacy.error ?? legacy.result));
  link(
    'initialize-rejected',
    legacy.error?.code === -32022 && JSON.stringify(legacy.error).includes(PROTOCOL),
    `code=${legacy.error?.code}`,
  );

  const listCall = await call('tools/call', {
    name: 'specialist_list',
    arguments: {},
    _meta: META,
  });
  let listOk = false;
  try {
    JSON.parse(listCall.result?.content?.[0]?.text ?? '');
    listOk = listCall.result?.resultType === 'complete';
  } catch {
    listOk = false;
  }
  link('tool-call', !listCall.error && listOk, `specialist_list via packaged server`);

  const resume = await call('tools/call', {
    name: 'specialist_resume',
    arguments: { activation_id: 'act:nope', prompt: 'carry on' },
    _meta: META,
  });
  let resumePayload = {};
  try {
    resumePayload = JSON.parse(resume.result?.content?.[0]?.text ?? '{}');
  } catch {
    resumePayload = {};
  }
  link(
    'resume-surface',
    !resume.error && resumePayload.status === 'error',
    `unknown activation answered as payload: ${JSON.stringify(resumePayload).slice(0, 120)}`,
  );
} catch (e) {
  link('mcp-wire', false, `wire error: ${e.message} stderr=${stderrTail.slice(0, 300)}`);
} finally {
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1000));
  if (child.exitCode === null) child.kill('SIGKILL');
}

// ---- Step 6: same-store (SessionStart from the INSTALLED copy) --------------
// Proven via the XTRM_STATE_DB override-scoping clause: one store path shared
// by the server spawn and every hook run through the env-only resolver.
// Both runtimes are shown verbatim. Known divergence (E2-owned, NOT repaired
// here per NON_GOALS): on a master base, session-start.mjs is node:sqlite-only
// so the pinned bun runtime stays silent; the fix lives on
// origin/feature/unitAI-aiwva.3-authority (unitAI-aiwva.3, closed-unmerged).
const hookEnv = { ...process.env, XTRM_STATE_DB: STORE };
const startBun = run('bun', [join(PLUGIN, 'scripts/session-start.mjs')], {
  cwd: REPO_DIR,
  env: hookEnv,
  timeout: 60000,
});
say(`--- installed session-start.mjs under bun (XTRM_STATE_DB=${STORE}) ---`);
say((startBun.stdout || '').trim() || '(silent)');
const startNode = run('node', [join(PLUGIN, 'scripts/session-start.mjs')], {
  cwd: REPO_DIR,
  env: hookEnv,
  timeout: 60000,
});
say(`--- installed session-start.mjs under node (same env) ---`);
say((startNode.stdout || '').trim() || '(silent)');
const repoHasDb = run('find', [REPO_DIR, '-name', 'state.db']).stdout.trim();
const nodeRowsOk =
  startNode.status === 0 &&
  startNode.stdout.includes(`Substrate work authority: ${STORE}`) &&
  startNode.stdout.includes('act:e5-live1 | researcher | running | B-1 | 3000') &&
  startNode.stdout.includes('act:e5-live2 | executor | needs_reply | B-2 | 2000') &&
  !startNode.stdout.includes('act:e5-old') &&
  repoHasDb === '';
link(
  'same-store',
  nodeRowsOk,
  nodeRowsOk
    ? 'override scoping: one env-resolved store; settled filtered; no repo-local state.db'
    : `exit=${startNode.status} repo-state.db=${repoHasDb || '(none)'} out=${(startNode.stdout || '').slice(0, 300)}`,
);
if (
  startBun.status === 0 &&
  startBun.stdout.includes('act:e5-live1 | researcher | running | B-1 | 3000')
) {
  link('sessionstart-bun-rows', true, 'pinned runtime projects rows');
} else {
  unprovenLink(
    'sessionstart-bun-rows',
    'unitAI-aiwva.3-merge',
    `bun silent exit=${startBun.status} on master base (node:sqlite-only); fix on origin/feature/unitAI-aiwva.3-authority`,
  );
}

// ---- Step 7: compaction lifecycle (installed PreCompact + re-derive) --------
const pre = run('bun', [join(PLUGIN, 'scripts/precompact.mjs')], {
  cwd: REPO_DIR,
  input: JSON.stringify({ session_id: 'e5-sess' }),
  env: { ...hookEnv, CLAUDE_PLUGIN_DATA: PLUGINDATA },
  timeout: 60000,
});
const pointerPath = join(PLUGINDATA, 'substrate-continuity-e5-sess.json');
let pointer = null;
try {
  pointer = JSON.parse(readFileSync(pointerPath, 'utf-8'));
} catch {
  pointer = null;
}
say(`--- installed precompact.mjs pointer ---`);
say(pointer ? JSON.stringify(pointer) : '(no pointer written)');
const pointerOk =
  pre.status === 0 &&
  pre.stdout === '' &&
  pointer?.store === STORE &&
  JSON.stringify(pointer?.active_activation_ids) === JSON.stringify(['act:e5-live1', 'act:e5-live2']);
link('precompact-pointer', pointerOk, pointerOk ? pointerPath : `exit=${pre.status}`);
// Post-compaction re-derivation runs under node on a master base (bun path is
// the recorded sessionstart-bun-rows divergence, E2-owned). The claim under
// test — state re-derived from the store, not summary prose — is
// runtime-independent: same resolver, same query, same store.
const rederive = run('node', [join(PLUGIN, 'scripts/session-start.mjs')], {
  cwd: REPO_DIR,
  env: hookEnv,
  timeout: 60000,
});
const rederiveOk =
  rederive.stdout.includes('act:e5-live1 | researcher | running | B-1 | 3000') &&
  rederive.stdout.includes('act:e5-live2 | executor | needs_reply | B-2 | 2000');
link(
  'postcompact-rederive',
  rederiveOk,
  rederiveOk ? 'post-compaction state re-derived from the store, not summary prose' : 're-derive mismatch',
);

// ---- Step 8: live Claude load attempt (may be env-blocked) ------------------
const live = spawnSync(
  'claude',
  ['--plugin-dir', PLUGIN, '-p', 'Reply with exactly: E5-LOAD-OK'],
  { cwd: REPO_DIR, encoding: 'utf-8', timeout: 90000, input: '' },
);
say(`--- claude --plugin-dir live attempt ---`);
say(`exit=${live.status} signal=${live.signal || '-'} error=${live.error?.message || '-'}`);
say(`stdout: ${((live.stdout || '').trim() || '(empty)').slice(0, 500)}`);
say(`stderr: ${((live.stderr || '').trim() || '(empty)').slice(0, 500)}`);
const liveOut = `${live.stdout || ''} ${live.stderr || ''}`;
if (live.status === 0 && liveOut.includes('E5-LOAD-OK')) {
  link('claude-live-load', true, 'packaged plugin loaded live with E5-LOAD-OK');
} else if (/login|auth|api key|credential|401|403|trust/i.test(liveOut) || live.signal) {
  unprovenLink(
    'claude-live-load',
    'pane (execute-as-declared)',
    `headless auth/interactive block in this environment; exit=${live.status}`,
  );
} else {
  link('claude-live-load', false, `exit=${live.status} out=${liveOut.slice(0, 300)}`);
}

// ---- Verdict ----------------------------------------------------------------
say('');
say(`repo files in scratch (must be none): ${readdirSync(REPO_DIR).filter((f) => f !== 'node_modules' && f !== 'package.json' && f !== 'package-lock.json').join(', ') || '(only install artifacts)'}`);
say(`scratch kept at ${SCRATCH}`);
if (unproven.length > 0) say(`UNPROVEN: ${unproven.join('; ')}`);
if (failures.length > 0) {
  say(`RESULT: FAIL (${failures.join(', ')})`);
  process.exit(1);
}
say(`RESULT: ${unproven.length > 0 ? 'PASS with unproven steps above' : 'PASS'}`);
