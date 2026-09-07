/**
 * Live smoke for the Claude Code MCP activation surface — bead unitAI-rrdnt.33.
 *
 * The unit tests in tests/unit/specialist/activation-mcp-tools.test.ts prove the tools
 * call the real host through the real gates, with the Pi SDK faked. That leaves the two
 * claims this phase actually exists to make unobserved:
 *
 *   AV — Claude Code launches a real Pi Specialist without `sp run`;
 *   AW — it does so without a separate terminal or `xt` session.
 *
 * Neither is provable in-process. "No `sp` was spawned" is a claim about the SYSTEM, and a
 * `vi.mock` of `spawn` proves only that this test's module graph did not call the function
 * it replaced. So this file drives the REAL built server (`dist/index.js`) over a REAL
 * stdio MCP client — which is exactly the arrangement Claude Code itself uses, hence AW —
 * and asserts against `/proc`: every transitive descendant of the server process is
 * enumerated while the Specialist is mid-turn, and none of them may be the legacy CLI.
 *
 * This epic has now been wrong four times about claims that passed inspection and were
 * falsified by a live probe (the procStart format, the receipt premise, a delivery
 * boundary, and the unwired workspace lease). The process table is the evidence.
 *
 * Gated on SPECIALISTS_LIVE_SMOKE=1 because it makes a real model call. It also needs the
 * build to be current and two real Beads — one dispatchable, one marked contract=draft:
 *
 *   bun run build
 *   SPECIALISTS_LIVE_SMOKE=1 \
 *   SPECIALISTS_MCP_PROBE_READY_BEAD=<a complete 7-section bead> \
 *   SPECIALISTS_MCP_PROBE_DRAFT_BEAD=<a bead with contract=draft> \
 *   SPECIALISTS_MCP_PROBE_MODEL=<provider/model> \
 *     bun --bun vitest run tests/integration/activation/mcp-activation.live.test.ts
 *
 * Both Beads must be OPEN. A closed Bead is dead scope, so the gate refuses it with
 * "bead is closed and is not dispatchable" — correct behaviour that reads as a broken
 * dispatch path if you reuse a probe Bead you closed after an earlier run. Mint fresh
 * ones rather than reopening old ones.
 *
 * The specialist must have a resolvable model. `explorer` has `execution.model: null`,
 * which is why SPECIALISTS_MCP_PROBE_MODEL is required rather than optional; without it
 * the dispatch is refused with `no_model_configured`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = resolve(import.meta.dirname, '../../..');
const runLive = process.env.SPECIALISTS_LIVE_SMOKE === '1';
const readyBead = process.env.SPECIALISTS_MCP_PROBE_READY_BEAD ?? '';
const draftBead = process.env.SPECIALISTS_MCP_PROBE_DRAFT_BEAD ?? '';
const probeModel = process.env.SPECIALISTS_MCP_PROBE_MODEL ?? '';
const SPECIALIST = 'explorer';

interface ProcRow { pid: number; ppid: number; comm: string; cmdline: string }

/** Every live process with its parent, comm and full cmdline. `/proc` is the authority. */
function procTable(): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf-8');
      // `comm` may contain spaces and parentheses, so ppid is located from the LAST ')'.
      const close = stat.lastIndexOf(')');
      const comm = stat.slice(stat.indexOf('(') + 1, close);
      const ppid = Number(stat.slice(close + 2).split(' ')[1]);
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim();
      rows.push({ pid: Number(entry), ppid, comm, cmdline });
    } catch {
      // Raced with the process exiting. A pid that vanished cannot be an sp child we care
      // about, because the assertion below is over a window sampled repeatedly.
    }
  }
  return rows;
}

/** Transitive descendants of a pid at this instant. */
function descendants(rootPid: number): ProcRow[] {
  const byParent = new Map<number, ProcRow[]>();
  for (const row of procTable()) {
    const siblings = byParent.get(row.ppid);
    if (siblings) siblings.push(row); else byParent.set(row.ppid, [row]);
  }
  const out: ProcRow[] = [];
  const stack = [rootPid];
  while (stack.length > 0) {
    for (const child of byParent.get(stack.pop() as number) ?? []) {
      out.push(child);
      stack.push(child.pid);
    }
  }
  return out;
}

/** A descendant that is the legacy CLI — precisely what the native path must not create. */
function legacyCliProcesses(rows: ProcRow[]): ProcRow[] {
  return rows.filter(r =>
    r.comm === 'sp' ||
    r.comm === 'specialists' ||
    /\bsp\s+run\b/.test(r.cmdline) ||
    /\bspecialists\s+run\b/.test(r.cmdline) ||
    /dist[/\\]index\.js\s+run\b/.test(r.cmdline));
}

function textOf(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

describe.skipIf(!runLive)('MCP activation surface — live', () => {
  let client: Client;
  let transport: StdioClientTransport;
  let serverPid: number;

  beforeAll(async () => {
    expect(readyBead, 'SPECIALISTS_MCP_PROBE_READY_BEAD is required').not.toBe('');
    expect(draftBead, 'SPECIALISTS_MCP_PROBE_DRAFT_BEAD is required').not.toBe('');
    expect(probeModel, 'SPECIALISTS_MCP_PROBE_MODEL is required').not.toBe('');
    expect(existsSync(join(repoRoot, 'dist', 'index.js')), 'run `bun run build` first').toBe(true);

    // The server is started exactly as an MCP client starts it: a stdio child with no
    // subcommand. Nothing about this arrangement involves a terminal or an `xt` session,
    // which is the whole of acceptance AW.
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(repoRoot, 'dist', 'index.js')],
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: '1' },
      stderr: 'pipe',
    });
    client = new Client({ name: 'phase13-live-probe', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    serverPid = transport.pid as number;
    expect(serverPid, 'no server pid — cannot assert on the process table').toBeGreaterThan(0);
  }, 60_000);

  afterAll(async () => {
    await client?.close().catch(() => { /* the process is going away regardless */ });
  });

  it('exposes the activation surface over MCP', async () => {
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining([
      'specialist_dispatch', 'specialist_reply', 'specialist_status', 'specialist_stop_activation',
    ]));
  });

  it('VALIDATION 2 — refuses a draft-contract Bead, and spawns nothing doing it', async () => {
    const out = textOf(await client.callTool({
      name: 'specialist_dispatch',
      arguments: { specialist: SPECIALIST, bead_id: draftBead, model_override: probeModel },
    }));

    expect(out.status).toBe('rejected');
    expect(String(out.reason)).toContain('AgentSession:\n  not created');
    expect(legacyCliProcesses(descendants(serverPid))).toEqual([]);
  }, 60_000);

  it('acceptance AZ — Claude sets the model override through the same runtime, and the runtime reports it back', async () => {
    // Every dispatch in this file already passes `model_override`, because `explorer` has
    // `execution.model: null`. That EXERCISES the override; it asserts nothing about it.
    // Acceptance AZ is the second claim — that the runtime honoured what Claude asked for
    // and can say so — and it is the one no test made until bead unitAI-rrdnt.35.
    const dispatched = textOf(await client.callTool({
      name: 'specialist_dispatch',
      arguments: { specialist: SPECIALIST, bead_id: readyBead, model_override: probeModel },
    }));
    expect(dispatched.status, JSON.stringify(dispatched)).toBe('dispatched');

    const status = textOf(await client.callTool({ name: 'specialist_status', arguments: {} }));
    const found = (status.activations as Array<Record<string, unknown>>)
      .find(a => a.activation_id === dispatched.activation_id);
    expect(found, `activation absent from specialist_status: ${JSON.stringify(status.activations)}`).toBeDefined();

    expect(found?.model_override).toBe(true);
    expect(found?.requested_model).toBe(probeModel);
    expect(String(found?.resolved_model)).toContain(probeModel.split('/').pop());

    // State, not presence. An override reported on an activation that died at admission
    // proves nothing — a pi_session_id exists only once a real AgentSession was created,
    // and `failed` here is a failed probe, not a pass.
    expect(
      found?.pi_session_id,
      `no Pi session: the override was recorded but nothing ran. ${JSON.stringify(found)}`,
    ).toBeTruthy();
    expect(
      found?.state,
      `activation failed during the AZ probe: ${JSON.stringify(found)}`,
    ).not.toBe('failed');
    console.log('[live] AZ observed activation:', JSON.stringify(found));

    const stopped = textOf(await client.callTool({
      name: 'specialist_stop_activation',
      arguments: { activation_id: String(dispatched.activation_id), reason: 'AZ probe complete' },
    }));
    expect(stopped.status).toBe('stopped');
  }, 120_000);

  it('VALIDATION 1 and 4 — dispatches a real Specialist with no sp process, and status reflects it', async () => {
    // Sample the process table continuously across the dispatch, so the assertion covers
    // the window in which a child would exist rather than one instant after admission.
    let peak: ProcRow[] = [];
    const watcher = setInterval(() => {
      const now = descendants(serverPid);
      if (now.length > peak.length) peak = now;
    }, 25);

    try {
      const dispatched = textOf(await client.callTool({
        name: 'specialist_dispatch',
        arguments: { specialist: SPECIALIST, bead_id: readyBead, model_override: probeModel },
      }));

      expect(dispatched.status, JSON.stringify(dispatched)).toBe('dispatched');
      expect(String(dispatched.activation_id)).toMatch(/^act:/);

      // Let the child hold a real turn, so the sampler observes it working.
      await new Promise(r => setTimeout(r, 4000));
      const during = descendants(serverPid);
      if (during.length > peak.length) peak = during;

      // AV, asserted against the process table.
      expect(
        legacyCliProcesses(peak),
        `sp-like descendants observed: ${JSON.stringify(peak)}`,
      ).toEqual([]);

      const status = textOf(await client.callTool({ name: 'specialist_status', arguments: {} }));
      const activations = status.activations as Array<Record<string, unknown>>;
      const found = activations.find(a => a.activation_id === dispatched.activation_id);

      expect(found, `activation absent from specialist_status: ${JSON.stringify(activations)}`).toBeDefined();
      expect(found?.bead_id).toBe(readyBead);
      expect(found?.specialist).toBe(SPECIALIST);
      expect(found?.access).toBe('read');

      // Without these two, the test above would pass for an activation that was admitted
      // and then died — "no sp process was spawned" is trivially true of a Specialist that
      // never ran, and that is not the claim. A pi_session_id exists only once a real
      // AgentSession was created, and a `failed` state is a failed live probe, not a pass.
      expect(
        found?.pi_session_id,
        `no Pi session: the activation was admitted but never started. ${JSON.stringify(found)}`,
      ).toBeTruthy();
      expect(
        found?.state,
        `activation failed during the live probe: ${JSON.stringify(found)}`,
      ).not.toBe('failed');
      console.log('[live] observed activation:', JSON.stringify(found));
      // Constant format string, values as arguments: a template literal in the first
      // position trips semgrep's format-string rule (sg.run/7Y5R). Nothing here is
      // attacker-controlled, but the rule is cheap to satisfy and arguing with it in a
      // baseline would cost more than complying.
      console.log('[live] peak descendants of server pid:', serverPid,
        peak.map(r => `${r.comm}(${r.pid})`).join(', ') || 'none');

      const stopped = textOf(await client.callTool({
        name: 'specialist_stop_activation',
        arguments: { activation_id: String(dispatched.activation_id), reason: 'live probe complete' },
      }));
      expect(stopped.status).toBe('stopped');
    } finally {
      clearInterval(watcher);
    }
  }, 180_000);
});
