/**
 * Live smoke for NativeActivationHost — bead unitAI-rrdnt.11.
 *
 * unitAI-rrdnt.5 proved the host's STRUCTURE against injected doubles: a stub loader, a
 * stub SDK, a fake forensic sink. That leaves three claims asserted but not observed —
 * PRD acceptance A (a repo override changes the native child through the real
 * SpecialistLoader), a real model turn, and a real row in the real `observability.db`.
 * This file closes that gap by running the actual thing.
 *
 * Gated on SPECIALISTS_LIVE_SMOKE=1 because it needs provider credentials and makes a
 * network call. It skips cleanly rather than failing when they are absent — a red suite on
 * a laptop with no model auth teaches nobody anything.
 *
 *   SPECIALISTS_LIVE_SMOKE=1 \
 *   SPECIALISTS_LIVE_SMOKE_MODEL=<provider/model> \
 *   SPECIALISTS_LIVE_SMOKE_MODEL_ALT=<a different provider/model> \
 *     bun --bun vitest run tests/integration/activation/native-activation.live.test.ts
 *
 * MODEL_ALT must be SOLVENT, not merely resolvable: the Phase 11 acceptance C case (bead
 * unitAI-rrdnt.35) asks it to serve a real turn, because "the override resolved" and "the
 * child ran on the override" are different claims and only the second one is acceptance C.
 * Acceptance A below still only requires it to resolve. Acceptance A needs two distinct real models because `prompt.system` is a BLOCKED override field (schema.ts) and
 * `execution.model` is the observable field a repo layer is actually permitted to change.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { NativeActivationHost } from '../../../src/activation/native-host.js';
import { createActivationForensicSink } from '../../../src/activation/forensic-sink.js';
import { createObservabilitySqliteClientAtPath } from '../../../src/specialist/observability-sqlite.js';
import { SpecialistLoader } from '../../../src/specialist/loader.js';

const repoRoot = resolve(import.meta.dirname, '../../..');
const runLive = process.env.SPECIALISTS_LIVE_SMOKE === '1';
const baseModel = process.env.SPECIALISTS_LIVE_SMOKE_MODEL ?? '';
const altModel = process.env.SPECIALISTS_LIVE_SMOKE_MODEL_ALT ?? '';

const SPECIALIST = 'live-smoke-reader';
const ASKING_SPECIALIST = 'live-smoke-asker';

/**
 * The documented query for "what did this activation do?". One store, one table — a
 * native activation is answerable exactly like a legacy `sp run` one.
 */
const FORENSIC_QUERY =
  "SELECT event_name FROM specialist_forensic_events WHERE job_id = ? AND event_family = 'activation' ORDER BY seq ASC";

function run(command: string, args: string[], cwd: string) {
  return spawnSync(command, args, { cwd, encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1' } });
}

function specialistSpec(model: string) {
  return {
    specialist: {
      metadata: {
        name: SPECIALIST,
        version: '1.0.0',
        description: 'Live smoke reader for native activation. Not for dispatch.',
        category: 'template',
        tags: ['live-smoke'],
      },
      execution: {
        bare: true,
        mode: 'tool',
        model,
        fallback_model: null,
        timeout_ms: 120000,
        max_retries: 0,
        interactive: false,
        response_format: 'text',
        output_type: 'synthesis',
        permission_required: 'READ_ONLY',
        extensions: { gitnexus: false },
      },
      prompt: {
        system: 'You are a smoke-test probe. Answer in one short sentence and stop. Run no commands.',
        system_prompt_mode: 'replace',
        task_template: '$prompt',
      },
      skills: { paths: [], scripts: [] },
      capabilities: { required_tools: [], external_commands: [] },
      validation: { files_to_watch: [], stale_threshold_days: 30 },
      stall_detection: {},
      mandatory_rules: { template_sets: [] },
      beads_integration: 'auto',
      beads_write_notes: false,
    },
  };
}


/**
 * A specialist whose contract makes asking the ONLY way to finish.
 *
 * The system prompt withholds a fact the task requires and names the tool that supplies
 * it. A probe that merely *may* ask will usually guess instead, and the test would then
 * pass or fail on model temperament rather than on the runtime.
 */
function askingSpecialistSpec(model: string) {
  const spec = specialistSpec(model);
  spec.specialist.metadata.name = ASKING_SPECIALIST;
  spec.specialist.metadata.description = 'Live smoke asker for native activation. Not for dispatch.';
  spec.specialist.prompt.system = [
    'You are a smoke-test probe.',
    'You must report the coordinator\'s chosen deployment colour.',
    'You do NOT know it and you cannot derive it. Run no commands.',
    'Call the ask_coordinator tool with the question, wait for the answer,',
    'then reply with exactly the colour you were given and stop.',
  ].join(' ');
  return spec;
}

/** Every live `*.db` file under a directory. WAL/SHM sidecars are not `.db` and do not count. */
function findDatabases(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        walk(full);
      } else if (entry.name.endsWith('.db') && statSync(full).size > 0) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found;
}

/**
 * Sample the OS process table for descendants of this process named `pi`.
 *
 * The unit suite proves no-subprocess by mocking `node:child_process`, which only proves
 * the host does not call the mocked binding. This proves it at the level that actually
 * matters: no `pi` ever appears in our process tree. Sampling (rather than a single check)
 * is required because a spawned child would be short-lived.
 */
function watchForPiDescendants(rootPid: number): { stop: () => string[] } {
  const seen: string[] = [];

  const sample = () => {
    const ps = spawnSync('ps', ['-eo', 'pid=,ppid=,comm='], { encoding: 'utf-8' });
    if (ps.status !== 0 || !ps.stdout) return;

    const children = new Map<number, Array<{ pid: number; comm: string }>>();
    for (const line of ps.stdout.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) continue;
      const [, pid, ppid, comm] = match;
      const bucket = children.get(Number(ppid)) ?? [];
      bucket.push({ pid: Number(pid), comm: comm.trim() });
      children.set(Number(ppid), bucket);
    }

    const queue = [rootPid];
    while (queue.length > 0) {
      const current = queue.shift() as number;
      for (const child of children.get(current) ?? []) {
        if (child.comm === 'pi') seen.push(`${child.pid} ${child.comm}`);
        queue.push(child.pid);
      }
    }
  };

  const timer = setInterval(sample, 100);
  sample();
  return {
    stop: () => {
      clearInterval(timer);
      sample();
      return seen;
    },
  };
}

/**
 * Read one activation's forensic rows back out of the real store.
 *
 * Shelled out through `bun -e` rather than opened in-process, deliberately: the claim
 * being tested is that an operator can answer "what did this activation run on?" from
 * `observability.db` with nothing but the file, and an in-process handle would prove a
 * weaker thing.
 */
function queryEvents(
  dbPath: string,
  cwd: string,
  activationId: string,
): Array<{ event_name: string; event_json: string }> {
  const sql =
    "SELECT event_name, event_json FROM specialist_forensic_events " +
    "WHERE job_id = ? AND event_family = 'activation' ORDER BY seq ASC";
  const query = run('bun', [
    '-e',
    [
      "import { Database } from 'bun:sqlite';",
      `const db = new Database(${JSON.stringify(dbPath)});`,
      `console.log(JSON.stringify(db.query(${JSON.stringify(sql)}).all(${JSON.stringify(activationId)})));`,
    ].join(' '),
  ], cwd);
  expect(query.status, query.stderr).toBe(0);
  return JSON.parse(query.stdout.trim());
}

/** The `body` of the single `activation_admitted` row for an activation. */
function admittedEventBody(dbPath: string, cwd: string, activationId: string): Record<string, unknown> {
  const admitted = queryEvents(dbPath, cwd, activationId)
    .filter(row => row.event_name === 'activation.activation_admitted');
  expect(admitted, 'no activation_admitted row was written').toHaveLength(1);
  return JSON.parse(admitted[0].event_json).body as Record<string, unknown>;
}

/** The `body` of the LAST `activation_resumed` row for an activation. */
function resumedEventBody(dbPath: string, cwd: string, activationId: string): Record<string, unknown> {
  const resumed = queryEvents(dbPath, cwd, activationId)
    .filter(row => row.event_name === 'activation.activation_resumed');
  expect(resumed.length, 'no activation_resumed row was written').toBeGreaterThan(0);
  return JSON.parse(resumed[resumed.length - 1].event_json).body as Record<string, unknown>;
}

/**
 * The most recent rejection in the store, with the count of sessions its activation
 * reached.
 *
 * `startedEvents` is the load-bearing half: a refusal that happened AFTER an AgentSession
 * was created is a different and much worse defect than no refusal at all, and only the
 * absence of `activation_started` under the same job_id tells the two apart.
 */
function latestRejection(dbPath: string, cwd: string): {
  reason?: string;
  requestedModel?: string;
  startedEvents: number;
} {
  const sql =
    "SELECT job_id, event_json FROM specialist_forensic_events " +
    "WHERE event_name = 'activation.activation_rejected' ORDER BY id DESC LIMIT 1";
  const query = run('bun', [
    '-e',
    [
      "import { Database } from 'bun:sqlite';",
      `const db = new Database(${JSON.stringify(dbPath)});`,
      `const row = db.query(${JSON.stringify(sql)}).get();`,
      'if (!row) { console.log("null"); } else {',
      "const started = db.query(\"SELECT COUNT(*) AS n FROM specialist_forensic_events WHERE job_id = ? AND event_name = 'activation.activation_started'\").get(row.job_id);",
      'console.log(JSON.stringify({ event_json: row.event_json, started: started.n })); }',
    ].join(' '),
  ], cwd);
  expect(query.status, query.stderr).toBe(0);
  const parsed = JSON.parse(query.stdout.trim());
  expect(parsed, 'no activation_rejected row was written').not.toBeNull();
  const body = JSON.parse(parsed.event_json).body as Record<string, unknown>;
  return {
    reason: body.reason as string | undefined,
    requestedModel: body.requestedModel as string | undefined,
    startedEvents: parsed.started as number,
  };
}

/**
 * A content hash of every Specialist config layer the loader can read.
 *
 * Acceptance F is "config is not mutated", and the only honest way to assert that is on
 * bytes. A re-read that returns the same model would also pass if an activation had
 * rewritten the file to the value it happened to want.
 */
function configFingerprint(root: string): Record<string, string> {
  const fingerprint: Record<string, string> = {};
  const layers = [join(root, 'config', 'specialists'), join(root, '.specialists', 'specialists')];
  for (const layer of layers) {
    let entries: string[];
    try {
      entries = readdirSync(layer).sort();
    } catch {
      continue; // A layer that does not exist is not a mutation.
    }
    for (const entry of entries) {
      const full = join(layer, entry);
      if (!statSync(full).isFile()) continue;
      fingerprint[full] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  }
  return fingerprint;
}

describe('live smoke: native Specialist activation', () => {
  let tempRepo = '';
  let dbPath = '';
  let beadId = '';
  let host: NativeActivationHost;

  beforeAll(async () => {
    if (!runLive) return;
    expect(baseModel, 'SPECIALISTS_LIVE_SMOKE_MODEL is required for the live smoke').not.toBe('');

    tempRepo = await mkdtemp(join(tmpdir(), 'native-activation-live-'));
    // A real git root, so resolveObservabilityDbLocation places a real observability.db
    // here instead of writing into the project's own store.
    expect(run('git', ['init', '-q'], tempRepo).status).toBe(0);
    await writeFile(join(tempRepo, 'README.md'), 'native activation live smoke\n');

    await mkdir(join(tempRepo, 'config', 'specialists'), { recursive: true });
    await writeFile(
      join(tempRepo, 'config', 'specialists', `${SPECIALIST}.specialist.json`),
      JSON.stringify(specialistSpec(baseModel), null, 2),
    );
    await writeFile(
      join(tempRepo, 'config', 'specialists', `${ASKING_SPECIALIST}.specialist.json`),
      JSON.stringify(askingSpecialistSpec(baseModel), null, 2),
    );

    dbPath = join(tempRepo, '.specialists', 'db', 'observability.db');
    const observability = createObservabilitySqliteClientAtPath(dbPath);
    expect(observability, 'observability.db could not be opened').not.toBeNull();

    host = new NativeActivationHost({
      cwd: tempRepo,
      forensics: createActivationForensicSink(observability),
    });

    // The Phase 3 bead gate refuses anything that is not a complete task contract, so the
    // throwaway probe bead carries all seven sections and a SCRUTINY level.
    const probeContract = [
      'PROBLEM', 'The native activation host has no observed live run.', '',
      'SUCCESS', 'One short model turn completes in-process.', '',
      'SCOPE', 'Reply with one short sentence confirming you are running, then stop.', '',
      'NON_GOALS', 'No file edits. No commands. No further work.', '',
      'CONSTRAINTS', 'Read-only. One sentence.', '',
      'VALIDATION', 'A non-empty assistant reply.', '',
      'OUTPUT', 'One sentence.', '',
      'SCRUTINY', 'LOW — throwaway smoke probe.',
    ].join('\n');

    const create = run('bd', [
      'create', '--title=native activation live smoke probe', '--type=task',
      `--description=${probeContract}`,
    ], repoRoot);
    expect(create.status).toBe(0);
    beadId = create.stdout.match(/unitAI-[a-z0-9.]+/)?.[0] ?? '';
    expect(beadId).toMatch(/^unitAI-/);
  }, 120_000);

  afterAll(async () => {
    if (beadId) {
      run('bd', ['kv', 'set', `memory-acked:${beadId}`, 'nothing novel:throwaway live-smoke probe bead'], repoRoot);
      run('bd', ['close', beadId, '--reason=native activation live smoke complete'], repoRoot);
    }
    if (tempRepo) await rm(tempRepo, { recursive: true, force: true });
  });

  it.skipIf(!runLive)(
    'acceptance B: with no override the child runs the effective configured model, and the turn completes',
    async () => {
      const watcher = watchForPiDescendants(process.pid);

      const handle = await host.start({
        specialist: SPECIALIST,
        beadId,
        requestedByParticipantId: 'coordinator:live-smoke',
      });

      expect(handle.access).toBe('read');
      expect(handle.resolvedModel).toContain(baseModel.split('/').pop());

      const result = await handle.result;
      const piProcesses = watcher.stop();

      expect(result.status, `activation failed: ${result.validation.errors?.join('; ')}`).toBe('completed');
      expect(String(result.output).trim().length).toBeGreaterThan(0);
      expect(result.modelOverride).toBe(false);

      // Acceptance: no `pi` binary was ever a descendant of this process.
      expect(piProcesses).toEqual([]);

      // Acceptance AJ/AP: the run is answerable from the real observability.db, and no
      // second telemetry database was created anywhere in the workspace.
      const query = run('bun', [
        '-e',
        [
          "import { Database } from 'bun:sqlite';",
          `const db = new Database(${JSON.stringify(dbPath)});`,
          `const rows = db.query(${JSON.stringify(FORENSIC_QUERY)}).all(${JSON.stringify(handle.activationId)});`,
          'console.log(JSON.stringify(rows.map(r => r.event_name)));',
        ].join(' '),
      ], tempRepo);
      expect(query.status, query.stderr).toBe(0);

      const events = JSON.parse(query.stdout.trim()) as string[];
      expect(events).toContain('activation.activation_admitted');
      expect(events).toContain('activation.activation_started');
      expect(events).toContain('activation.activation_completed');

      expect(findDatabases(tempRepo)).toEqual([dbPath]);

      await host.stop(handle.activationId, 'live smoke complete');
    },
    180_000,
  );

  it.skipIf(!runLive || !altModel)(
    'acceptance A: a repo .specialists/user override changes the native child through the real loader',
    async () => {
      // `prompt.system` is deliberately included and deliberately NOT expected to apply:
      // it is a BLOCKED override field, and a repo layer silently gaining control of a
      // child's system prompt is the failure that allowlist exists to prevent.
      const override = specialistSpec(altModel);
      override.specialist.prompt.system = 'OVERRIDDEN SYSTEM PROMPT — must not take effect.';

      await mkdir(join(tempRepo, '.specialists', 'user'), { recursive: true });
      await writeFile(
        join(tempRepo, '.specialists', 'user', `${SPECIALIST}.specialist.json`),
        JSON.stringify(override, null, 2),
      );

      const overridden = new NativeActivationHost({
        cwd: tempRepo,
        forensics: createActivationForensicSink(createObservabilitySqliteClientAtPath(dbPath)),
      });

      const handle = await overridden.start({
        specialist: SPECIALIST,
        beadId,
        requestedByParticipantId: 'coordinator:live-smoke',
      });

      // The override changed the child: the session was created against the repo layer's
      // model, not the package layer's, resolved through the real three-layer loader.
      //
      // This case deliberately does NOT await a completed turn. The override model only
      // has to RESOLVE; requiring it to also be a solvent, reachable provider would make
      // the case fail for billing reasons that say nothing about the loader. The live
      // turn is proven once, in acceptance B.
      expect(handle.resolvedModel).toContain(altModel.split('/').pop());
      expect(handle.resolvedModel).not.toContain(baseModel.split('/').pop());

      const snapshot = overridden.inspect(handle.activationId);
      expect(snapshot?.configuredModel).toContain(altModel.split('/').pop());
      expect(snapshot?.piSessionId, 'no AgentSession was created for the overridden child').toBeTruthy();

      // The blocked field did not propagate: the child keeps the package layer's system
      // prompt even though the repo layer asked to replace it.
      const resolved = await new SpecialistLoader({ projectDir: tempRepo }).get(SPECIALIST);
      expect(resolved.specialist.prompt.system).not.toContain('OVERRIDDEN SYSTEM PROMPT');
      expect(resolved.specialist.execution.model).toBe(altModel);

      await overridden.stop(handle.activationId, 'live smoke complete');
      await handle.result.catch(() => undefined);
    },
    180_000,
  );

  it.skipIf(!runLive)(
    'acceptance AX: a real Specialist asks, the coordinator answers, and the SAME session resumes',
    async () => {
      // The distinction this proves is the one that separates a clarification from a
      // restart, and it is invisible to a naive "did it get the answer" check: a design
      // that ended the turn and replayed the answer into a fresh session would also produce
      // the right final string, having destroyed the child's context to do it. What makes
      // the resume real is that the answer arrives as the RESULT OF A TOOL CALL the model
      // is still sitting inside — so `pi_session_id` cannot change across the ask.
      const handle = await host.start({
        specialist: ASKING_SPECIALIST,
        beadId,
        requestedByParticipantId: 'coordinator:live-smoke',
      });

      // Wait for the child to reach the ask rather than for a fixed delay: a sleep long
      // enough for a slow model is a sleep that hides a fast failure.
      const deadline = Date.now() + 120_000;
      let outstanding = host.pendingAsks();
      while (outstanding.length === 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
        outstanding = host.pendingAsks();
      }

      expect(
        outstanding,
        'the child never asked — it guessed, or the ask tool was not in its contract',
      ).toHaveLength(1);

      const [ask] = outstanding;
      expect(ask.message.kind).toBe('question');
      expect(ask.message.activationId).toBe(handle.activationId);
      // No receipt exists on any transport here, so `pending` is the honest state.
      expect(ask.delivery).toBe('pending');

      const sessionBeforeAnswer = host.snapshot(handle.activationId)?.piSessionId;
      expect(sessionBeforeAnswer).toBeTruthy();

      const replied = await host.answer(ask.message.messageId, 'chartreuse');
      expect(replied?.inReplyTo).toBe(ask.message.messageId);

      const result = await handle.result;

      expect(result.status, `activation failed: ${result.validation.errors?.join('; ')}`).toBe('completed');
      // The child used the answer it was given, so the reply reached it in-context.
      expect(String(result.output).toLowerCase()).toContain('chartreuse');

      // THE assertion: same session across the ask. A restart would allocate a new id.
      expect(host.snapshot(handle.activationId)?.piSessionId).toBe(sessionBeforeAnswer);
      expect(host.pendingAsks()).toHaveLength(0);

      await host.stop(handle.activationId, 'live AX smoke complete');
    },
    240_000,
  );

  /**
   * PRD acceptance C, D, E, F and the bead's VALIDATION 1-4 — bead unitAI-rrdnt.35.
   *
   * The override path is asserted against what the RUNTIME reports, never against the
   * arguments handed to it. Every silent-drop defect this epic has produced was invisible
   * to the second kind of assertion, because the arguments were always correct.
   *
   * ALT is asked to serve a real turn here, unlike in acceptance A above: "the override
   * was resolved" and "the child ran on the override" are different claims, and only the
   * second one is acceptance C. A run that dies on provider billing looks exactly like a
   * runtime defect, so every failure message below carries the provider's own error text.
   */
  it.skipIf(!runLive || !altModel)(
    'acceptance C/E and VALIDATION 1: an explicit override runs the child on the requested model and is recorded requested-vs-resolved',
    async () => {
      const before = configFingerprint(tempRepo);

      const handle = await host.start({
        specialist: SPECIALIST,
        beadId,
        modelOverride: altModel,
        requestedByParticipantId: 'coordinator:live-smoke',
      });

      // Acceptance C's second half: Specialist policy is unchanged by an override. A
      // reader stays a reader; the override buys a model, not a capability.
      expect(handle.access).toBe('read');
      expect(handle.resolvedModel).toContain(altModel.split('/').pop());
      expect(handle.resolvedModel).not.toContain(baseModel.split('/').pop());

      const admitted = host.snapshot(handle.activationId);
      expect(admitted?.modelOverride).toBe(true);
      expect(admitted?.requestedModel).toBe(altModel);
      // The configured model is retained alongside, which is what makes "ran on something
      // other than what the Specialist configures" answerable at all.
      expect(admitted?.configuredModel).toContain(baseModel.split('/').pop());

      const result = await handle.result;
      expect(
        result.status,
        `override activation failed — provider error: ${result.validation.errors?.join('; ')}`,
      ).toBe('completed');
      expect(String(result.output).trim().length).toBeGreaterThan(0);
      expect(result.modelOverride).toBe(true);
      expect(result.requestedModel).toBe(altModel);
      // Acceptance D's contract seen from the success side: nothing was substituted.
      expect(result.fallbackUsed).toBe(false);

      // Acceptance E / VALIDATION 1 — the record, not the object. Read back out of the
      // real observability.db, because a snapshot in memory is not forensics.
      const body = admittedEventBody(dbPath, tempRepo, handle.activationId);
      expect(body.requested_model).toBe(altModel);
      expect(body.resolved_model).toBe(admitted?.resolvedModel);
      expect(body.configured_model).toContain(baseModel.split('/').pop());
      expect(body.model_override).toBe(true);

      // VALIDATION 4 / acceptance F, first half: config is byte-identical across an
      // activation that overrode it.
      expect(configFingerprint(tempRepo)).toEqual(before);

      await host.stop(handle.activationId, 'live smoke complete');
    },
    240_000,
  );

  it.skipIf(!runLive)(
    'acceptance D and VALIDATION 2: an unavailable override is refused by name, before any session exists',
    async () => {
      const bogus = 'nowhere-at-all/no-such-model-9e1a';

      // The refusal must name what was asked for. A refusal that says only "model
      // unavailable" sends the operator to look for the wrong model.
      await expect(host.start({
        specialist: SPECIALIST,
        beadId,
        modelOverride: bogus,
        requestedByParticipantId: 'coordinator:live-smoke',
      })).rejects.toThrow(bogus);

      // And it must be a refusal, not a substitution: no activation reached a session.
      // Asserting on the absence of `activation_started` is the only evidence that
      // distinguishes "refused before creation" from "created and then failed".
      const rejected = latestRejection(dbPath, tempRepo);
      expect(rejected.reason).toBe('model_unavailable');
      expect(rejected.requestedModel).toBe(bogus);
      expect(rejected.startedEvents, 'a session was created for a refused model').toBe(0);
    },
    120_000,
  );

  it.skipIf(!runLive || !altModel)(
    'acceptance F and VALIDATION 4: the next activation with no override returns to the configured model',
    async () => {
      const before = configFingerprint(tempRepo);

      const handle = await host.start({
        specialist: SPECIALIST,
        beadId,
        requestedByParticipantId: 'coordinator:live-smoke',
      });

      // The preceding override changed nothing durable, so this run is back on base.
      expect(handle.resolvedModel).toContain(baseModel.split('/').pop());
      expect(handle.resolvedModel).not.toContain(altModel.split('/').pop());

      const snapshot = host.snapshot(handle.activationId);
      expect(snapshot?.modelOverride).toBe(false);
      // VALIDATION 1's "including when they are equal" case: requested is still recorded.
      expect(snapshot?.requestedModel).toContain(baseModel.split('/').pop());

      const body = admittedEventBody(dbPath, tempRepo, handle.activationId);
      expect(body.requested_model).toBe(snapshot?.requestedModel);
      expect(body.model_override).toBe(false);

      expect(configFingerprint(tempRepo)).toEqual(before);

      await host.stop(handle.activationId, 'live smoke complete');
      await handle.result.catch(() => undefined);
    },
    240_000,
  );

  it.skipIf(!runLive || !altModel)(
    'VALIDATION 3: an override survives a resume and the new attempt carries it',
    async () => {
      // NOTE: `NativeActivationHost.resume()` is reachable from no coordinator surface at
      // the time of writing — no MCP tool and no CLI calls it (bead unitAI-rrdnt.35 notes).
      // This case therefore proves the host API, not an operator path, and says so rather
      // than letting a green test imply reachability it does not have.
      const handle = await host.start({
        specialist: SPECIALIST,
        beadId,
        modelOverride: altModel,
        requestedByParticipantId: 'coordinator:live-smoke',
      });

      const first = await handle.result;
      expect(
        first.status,
        `override activation failed — provider error: ${first.validation.errors?.join('; ')}`,
      ).toBe('completed');
      expect(handle.attemptId).toMatch(/:1$/);

      const resumed = await host.resume(handle.activationId, 'Reply with one more short sentence, then stop.');

      // A resume advances the attempt under the SAME activation, and the override rides
      // with it — it was never written anywhere it could be lost.
      expect(resumed.activationId).toBe(handle.activationId);
      expect(resumed.attemptId).toMatch(/:2$/);
      expect(resumed.attemptId).not.toBe(handle.attemptId);
      expect(resumed.resolvedModel).toContain(altModel.split('/').pop());

      const second = await resumed.result;
      expect(
        second.status,
        `resumed attempt failed — provider error: ${second.validation.errors?.join('; ')}`,
      ).toBe('completed');
      expect(second.attemptId).toBe(resumed.attemptId);
      expect(second.modelOverride).toBe(true);
      expect(second.requestedModel).toBe(altModel);

      // Attributed to the NEW attempt in the record, not only in memory.
      const resumedRow = resumedEventBody(dbPath, tempRepo, handle.activationId);
      expect(resumedRow.attempt_id).toBe(resumed.attemptId);
      expect(resumedRow.requested_model).toBe(altModel);
      expect(resumedRow.model_override).toBe(true);

      await host.stop(handle.activationId, 'live smoke complete');
    },
    360_000,
  );

});
