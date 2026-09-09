// ISSUE: xtrm-wiy5n.4.11 — quarantined from the default test baseline.
// tests/unit/specialist/runner.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { SpecialistRunner } from '../../../src/specialist/runner.js';
import { HookEmitter } from '../../../src/specialist/hooks.js';
import { CircuitBreaker } from '../../../src/utils/circuitBreaker.js';
import { SessionKilledError } from '../../../src/pi/session.js';
import type { BeadsClient } from '../../../src/specialist/beads.js';

function makeMockSession() {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue(undefined),
    waitForDone: vi.fn().mockResolvedValue(undefined),
    getLastOutput: vi.fn().mockResolvedValue(JSON.stringify({
      summary: 'Done',
      status: 'success',
      issues_closed: [],
      issues_created: [],
      follow_ups: [],
      risks: [],
      verification: [],
    })),
    getState: vi.fn().mockResolvedValue(null),
    close: vi.fn().mockResolvedValue(undefined),
    executeBash: vi.fn().mockResolvedValue(''),
    kill: vi.fn(),
    meta: { backend: 'google-gemini-cli', model: 'gemini', sessionId: 'test-id', startedAt: new Date() },
  };
}

function makeLoader(
  executionOverrides: Record<string, unknown> = {},
  beadsIntegration = 'auto',
  promptOverrides: Record<string, unknown> = {},
  specialistOverrides: Record<string, unknown> = {},
) {
  return {
    get: vi.fn().mockResolvedValue({
      specialist: {
        metadata: { name: 'test-spec', version: '1.0.0' },
        execution: { model: 'gemini', timeout_ms: 5000, mode: 'tool', permission_required: 'READ_ONLY', ...executionOverrides },
        prompt: { task_template: 'Do $prompt', system: 'You are helpful.', ...promptOverrides },
        communication: undefined,
        capabilities: undefined,
        beads_integration: beadsIntegration,
        ...specialistOverrides,
      },
    }),
  } as any;
}

function createReviewerDiffRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-diff-'));
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email test@example.com', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name Test User', { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'tracked.txt'), 'base\n');
  execSync('git add tracked.txt', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m base', { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'tracked.txt'), 'base\nstaged\n');
  execSync('git add tracked.txt', { cwd: dir, stdio: 'pipe' });
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function createEmptyReviewerRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-empty-'));
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email test@example.com', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name Test User', { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'tracked.txt'), 'base\n');
  execSync('git add tracked.txt', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m base', { cwd: dir, stdio: 'pipe' });
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeBeadsClient(overrides: Partial<Record<string, unknown>> = {}): BeadsClient {
  return {
    isAvailable: vi.fn().mockReturnValue(true),
    createBead: vi.fn().mockReturnValue('specialists-test-1'),
    readBead: vi.fn(),
    addDependency: vi.fn(),
    closeBead: vi.fn(),
    auditBead: vi.fn(),
    updateBeadNotes: vi.fn(),
    getCompletedBlockers: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as BeadsClient;
}

describe('SpecialistRunner', () => {
  let mockSession: ReturnType<typeof makeMockSession>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = makeMockSession();
  });


  it('writes specialist.output_file without legacy job file output gate', async () => {
    const previousMode = process.env.SPECIALISTS_JOB_FILE_OUTPUT;
    process.env.SPECIALISTS_JOB_FILE_OUTPUT = 'off';
    const outputPath = join(mkdtempSync(join(tmpdir(), 'runner-output-file-')), 'test-result.md');
    try {
      const runner = new SpecialistRunner({
        loader: makeLoader({}, 'auto', {}, { output_file: outputPath }),
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: new CircuitBreaker(),
        sessionFactory: vi.fn().mockResolvedValue(mockSession),
      });

      await runner.run({ name: 'test-spec', prompt: 'analyze this' });

      expect(readFileSync(outputPath, 'utf-8')).toContain('"status":"success"');
    } finally {
      if (previousMode === undefined) delete process.env.SPECIALISTS_JOB_FILE_OUTPUT;
      else process.env.SPECIALISTS_JOB_FILE_OUTPUT = previousMode;
      rmSync(dirname(outputPath), { recursive: true, force: true });
    }
  });

  it('skips specialist.output_file when supervisor suppresses runner file output', async () => {
    const previousMode = process.env.SPECIALISTS_JOB_FILE_OUTPUT;
    process.env.SPECIALISTS_JOB_FILE_OUTPUT = 'on';
    const outputDir = mkdtempSync(join(tmpdir(), 'runner-output-file-'));
    const outputPath = join(outputDir, 'test-result.md');
    try {
      const runner = new SpecialistRunner({
        loader: makeLoader({}, 'auto', {}, { output_file: outputPath }),
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: new CircuitBreaker(),
        sessionFactory: vi.fn().mockResolvedValue(mockSession),
      });

      await runner.run({ name: 'test-spec', prompt: 'analyze this', suppressRunnerFileOutput: true });

      expect(existsSync(outputPath)).toBe(false);
    } finally {
      if (previousMode === undefined) delete process.env.SPECIALISTS_JOB_FILE_OUTPUT;
      else process.env.SPECIALISTS_JOB_FILE_OUTPUT = previousMode;
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('executes specialist and returns output', async () => {
    const runner = new SpecialistRunner({
      loader: makeLoader(),
      hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
      circuitBreaker: new CircuitBreaker(),
      sessionFactory: vi.fn().mockResolvedValue(mockSession),
    });
    const result = await runner.run({ name: 'test-spec', prompt: 'analyze this' });
    expect(JSON.parse(result.output).status).toBe('success');
    expect(result.backend).toBe('google-gemini-cli');
    expect(result.specialistVersion).toBe('1.0.0');
    expect(result.promptHash).toHaveLength(16);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('calls pi session lifecycle in order', async () => {
    const sessionFactory = vi.fn().mockResolvedValue(mockSession);
    const runner = new SpecialistRunner({
      loader: makeLoader(),
      hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
      circuitBreaker: new CircuitBreaker(),
      sessionFactory,
    });
    await runner.run({ name: 'test-spec', prompt: 'do thing' });
    expect(mockSession.start).toHaveBeenCalledOnce();
    const renderedTask = mockSession.prompt.mock.calls.at(-1)?.[0] as string;
    expect(renderedTask).toContain('Do do thing');
    expect(renderedTask).toContain('## MANDATORY_RULES');
    expect(mockSession.waitForDone).toHaveBeenCalledOnce();
    expect(mockSession.getLastOutput).toHaveBeenCalledOnce();
    expect(mockSession.close).toHaveBeenCalledOnce();
    expect(mockSession.kill).not.toHaveBeenCalled();
  });

  it('injects canonical mandatory rule body into prompt', async () => {
    const sessionFactory = vi.fn().mockResolvedValue(mockSession);
    const runner = new SpecialistRunner({
      loader: makeLoader({}, 'auto', {}, {
        mandatory_rules: { template_sets: ['git-workflow-safe'] },
      }),
      hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
      circuitBreaker: new CircuitBreaker(),
      sessionFactory,
    });

    await runner.run({ name: 'test-spec', prompt: 'do thing' });

    const renderedTask = mockSession.prompt.mock.calls.at(-1)?.[0] as string;
    expect(renderedTask).toContain('## MANDATORY_RULES');
  });

  it('reports mandatory_rule payload bytes per rendered section', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mandatory-rule-payload-'));
    try {
      mkdirSync(join(cwd, '.specialists', 'default', 'mandatory-rules'), { recursive: true });
      mkdirSync(join(cwd, 'config', 'mandatory-rules'), { recursive: true });
      writeFileSync(join(cwd, '.specialists', 'default', 'mandatory-rules', 'alpha.md'), '---\nrules:\n  - id: alpha-1\n    level: required\n    text: alpha rule\n---\n');
      writeFileSync(join(cwd, '.specialists', 'default', 'mandatory-rules', 'beta.md'), '---\nrules:\n  - id: beta-1\n    level: warn\n    text: beta rule is longer\n---\n');
      writeFileSync(join(cwd, 'config', 'mandatory-rules', 'index.json'), JSON.stringify({ default_template_sets: ['alpha', 'beta'] }));

      const payloadEvents: unknown[] = [];
      const runner = new SpecialistRunner({
        loader: makeLoader({}, 'never', {}, {
          mandatory_rules: { disable_default_globals: true },
        }),
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: new CircuitBreaker(),
        sessionFactory: vi.fn().mockResolvedValue(mockSession),
      });

      await runner.run({ name: 'test-spec', prompt: 'do thing', workingDirectory: cwd }, undefined, (type, details) => {
        if (type === 'payload_breakdown') payloadEvents.push(details);
      });

      const payloadSummary = JSON.parse((payloadEvents.at(0) as { summary: string }).summary) as { payload_breakdown: { components: Array<{ kind: string; name: string; bytes: number }>; totals: { bytes: number } } };
      const mandatoryRuleComponents = payloadSummary.payload_breakdown.components.filter(component => component.kind === 'mandatory_rule');
      expect(mandatoryRuleComponents.map(component => component.name)).toEqual(['alpha', 'beta']);
      expect(mandatoryRuleComponents.map(component => component.bytes)).toEqual([
        '### alpha\n- [required] alpha rule'.length,
        '### beta\n- [warn] beta rule is longer'.length,
      ]);
      expect(mandatoryRuleComponents.reduce((sum, component) => sum + component.bytes, 0)).toBe(payloadSummary.payload_breakdown.totals.bytes - payloadSummary.payload_breakdown.components.filter(component => component.kind !== 'mandatory_rule').reduce((sum, component) => sum + component.bytes, 0));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('reports only final injected mandatory sections with exact budget telemetry and digest', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mandatory-rule-budget-'));
    try {
      mkdirSync(join(cwd, 'config', 'mandatory-rules'), { recursive: true });
      writeFileSync(join(cwd, 'config', 'mandatory-rules', 'floor.md'), '---\nrules:\n  - id: floor-1\n    level: error\n    text: stay safe\n---\n');
      writeFileSync(join(cwd, 'config', 'mandatory-rules', 'oversized.md'), `---\nrules:\n  - id: optional-1\n    level: info\n    text: ${'x'.repeat(11000)}\n---\n`);
      writeFileSync(join(cwd, 'config', 'mandatory-rules', 'index.json'), JSON.stringify({
        required_template_sets: ['floor'],
        default_template_sets: ['oversized'],
      }));

      const events: Array<{ type: string; details: Record<string, unknown> }> = [];
      const runner = new SpecialistRunner({
        loader: makeLoader({}, 'never', {}, { mandatory_rules: { disable_default_globals: true } }),
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: new CircuitBreaker(),
        sessionFactory: vi.fn().mockResolvedValue(mockSession),
      });

      await runner.run({ name: 'test-spec', prompt: 'do thing', workingDirectory: cwd }, undefined, (type, details) => {
        events.push({ type, details });
      });

      const prompt = mockSession.prompt.mock.calls.at(-1)?.[0] as string;
      const injectedBlock = '## MANDATORY_RULES\n### floor\n- [error] stay safe';
      expect(prompt).toContain(injectedBlock);
      expect(prompt).not.toContain('### oversized');

      const metaEvent = events.find((event) => event.type === 'meta' && event.details.source === 'mandatory_rules_injection');
      expect(metaEvent).toBeDefined();
      expect(metaEvent?.details.data).toMatchObject({
        budget_limit: 2400,
        outcome: 'degraded',
        injected_section_ids: ['floor'],
        evicted_section_ids: ['oversized'],
        injected_tokens: Math.ceil(injectedBlock.length / 4),
        payload_digest: createHash('sha256').update(injectedBlock).digest('hex'),
      });

      const payloadEvent = events.find((event) => event.type === 'payload_breakdown');
      const payload = JSON.parse(payloadEvent?.details.summary as string) as {
        payload_breakdown: { components: Array<{ kind: string; name: string }> };
      };
      expect(payload.payload_breakdown.components.filter((item) => item.kind === 'mandatory_rule').map((item) => item.name)).toEqual(['floor']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('does not start a session when the MUST_KEEP floor exceeds the budget', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mandatory-rule-impossible-'));
    const sessionFactory = vi.fn().mockResolvedValue(mockSession);
    const events: Array<{ type: string; details: Record<string, unknown> }> = [];
    try {
      mkdirSync(join(cwd, 'config', 'mandatory-rules'), { recursive: true });
      writeFileSync(join(cwd, 'config', 'mandatory-rules', 'floor.md'), `---\nrules:\n  - id: floor-1\n    level: error\n    text: ${'x'.repeat(11000)}\n---\n`);
      writeFileSync(join(cwd, 'config', 'mandatory-rules', 'index.json'), JSON.stringify({ required_template_sets: ['floor'] }));
      const runner = new SpecialistRunner({
        loader: makeLoader({}, 'never', {}, { mandatory_rules: { disable_default_globals: true } }),
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: new CircuitBreaker(),
        sessionFactory,
      });

      await expect(runner.run({ name: 'test-spec', prompt: 'do thing', workingDirectory: cwd }, undefined, (type, details) => {
        events.push({ type, details });
      })).rejects.toMatchObject({
        outcome: 'impossible',
        budgetLimit: 2400,
        injectedSectionIds: [],
        evictedSectionIds: ['floor'],
      });
      expect(sessionFactory).not.toHaveBeenCalled();
      expect(mockSession.start).not.toHaveBeenCalled();
      const impossible = events.find((event) => event.type === 'meta' && event.details.source === 'mandatory_rules_injection');
      expect(impossible?.details.data).toMatchObject({
        budget_limit: 2400,
        outcome: 'impossible',
        injected_tokens: 0,
        injected_section_ids: [],
        evicted_section_ids: ['floor'],
        payload_digest: createHash('sha256').update('').digest('hex'),
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('passes execution.stall_timeout_ms through to PiAgentSession options', async () => {
    const sessionFactory = vi.fn().mockResolvedValue(mockSession);
    const runner = new SpecialistRunner({
      loader: makeLoader({ stall_timeout_ms: 1234 }),
      hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
      circuitBreaker: new CircuitBreaker(),
      sessionFactory,
    });

    await runner.run({ name: 'test-spec', prompt: 'do thing' });

    expect(sessionFactory).toHaveBeenCalledWith(expect.objectContaining({
      stallTimeoutMs: 1234,
    }));
  });

  it('passes execution.extensions opt-out to PiAgentSession, ignoring retired serena flag', async () => {
    const sessionFactory = vi.fn().mockResolvedValue(mockSession);
    const runner = new SpecialistRunner({
      loader: makeLoader({
        extensions: {
          serena: false,
          gitnexus: false,
          'npm:@jaggerxtrm/pi-service-knowledge@1.0.0': true,
          './local-extension': false,
        },
      }),
      hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
      circuitBreaker: new CircuitBreaker(),
      sessionFactory,
    });

    await runner.run({ name: 'test-spec', prompt: 'do thing' });

    expect(sessionFactory).toHaveBeenCalledWith(expect.objectContaining({
      excludeExtensions: ['pi-gitnexus'],
      extensionSources: ['npm:@jaggerxtrm/pi-service-knowledge@1.0.0'],
      offline: false,
    }));
  });

  it('uses staged diff when unstaged diff empty for reviewer startup', async () => {
    const repo = createReviewerDiffRepo();
    try {
      const sessionFactory = vi.fn().mockResolvedValue(mockSession);
      const runner = new SpecialistRunner({
        loader: {
          get: vi.fn().mockResolvedValue({
            specialist: {
              metadata: { name: 'reviewer', version: '1.0.0' },
              execution: { model: 'gemini', timeout_ms: 5000, mode: 'tool', permission_required: 'READ_ONLY' },
              prompt: { task_template: 'review $reviewed_job_id', system: 'You are reviewer.' },
              communication: undefined,
              capabilities: undefined,
              beads_integration: 'never',
            },
          }),
        } as any,
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: new CircuitBreaker(),
        sessionFactory,
      });

      await runner.run({
        name: 'reviewer',
        prompt: 'review this',
        reusedFromJobId: 'job-reviewed',
        workingDirectory: repo.dir,
      });

      const promptArg = mockSession.prompt.mock.calls.at(-1)?.[0] as string;
      // unitAI-i3u2e: an execution-only placeholder absent from the low-level
      // runner resolves to empty rather than leaking a literal `$name` to the model.
      expect(promptArg).not.toContain('$reviewed_job_id');
      expect(promptArg).toContain('## Reviewer Diff Context');
      expect(promptArg).toContain('Patch source:');
      expect(promptArg).toContain('staged diff');
      expect(promptArg).toContain('Diff stat:');
      expect(promptArg).toContain('tracked.txt');
      expect(promptArg).toContain('staged');
    } finally {
      repo.cleanup();
    }
  });

  it('warns and continues when reviewer patch sources all empty', async () => {
    const repo = createEmptyReviewerRepo();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const runner = new SpecialistRunner({
        loader: {
          get: vi.fn().mockResolvedValue({
            specialist: {
              metadata: { name: 'reviewer', version: '1.0.0' },
              execution: { model: 'gemini', timeout_ms: 5000, mode: 'tool', permission_required: 'READ_ONLY' },
              prompt: { task_template: 'review $reviewed_job_id', system: 'You are reviewer.' },
              communication: undefined,
              capabilities: undefined,
              beads_integration: 'never',
            },
          }),
        } as any,
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: new CircuitBreaker(),
        sessionFactory: vi.fn().mockResolvedValue(mockSession),
      });

      await runner.run({
        name: 'reviewer',
        prompt: 'review this',
        reusedFromJobId: 'job-reviewed',
        workingDirectory: repo.dir,
      });

      const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(warnings.some((w) => w.includes('Reviewer diff context unavailable'))).toBe(true);

      const promptArg = mockSession.prompt.mock.calls.at(-1)?.[0] as string;
      expect(promptArg).not.toContain('## Reviewer Diff Context');
    } finally {
      warnSpy.mockRestore();
      repo.cleanup();
    }
  });


  it('prefers injected diff context over git fallbacks for reviewer startup', async () => {
    const repo = createEmptyReviewerRepo();
    try {
      const sessionFactory = vi.fn().mockResolvedValue(mockSession);
      const runner = new SpecialistRunner({
        loader: {
          get: vi.fn().mockResolvedValue({
            specialist: {
              metadata: { name: 'reviewer', version: '1.0.0' },
              execution: { model: 'gemini', timeout_ms: 5000, mode: 'tool', permission_required: 'READ_ONLY' },
              prompt: { task_template: 'review $reviewed_job_id', system: 'You are reviewer.' },
              communication: undefined,
              capabilities: undefined,
              beads_integration: 'never',
            },
          }),
        } as any,
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: new CircuitBreaker(),
        sessionFactory,
      });

      await runner.run({
        name: 'reviewer',
        prompt: 'review this',
        reusedFromJobId: 'job-reviewed',
        workingDirectory: repo.dir,
        variables: {
          reviewed_job_id: 'job-reviewed',
          reviewer_diff_source: 'injected diff context',
          reviewer_diff_stat: ' tracked.txt | 1 +',
          reviewer_diff_files: 'tracked.txt',
          reviewer_diff_hunks: '### tracked.txt\n@@ -1 +1 @@\n-base\n+injected',
        },
      });

      const promptArg = mockSession.prompt.mock.calls.at(-1)?.[0] as string;
      expect(promptArg).toContain('Patch source:');
      expect(promptArg).toContain('injected diff context');
      expect(promptArg).toContain('tracked.txt');
      expect(promptArg).toContain('+injected');
    } finally {
      repo.cleanup();
    }
  });

  it('fails closed before session creation or fallback when the project tool catalog is malformed', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runner-invalid-tool-catalog-'));
    const sessionFactory = vi.fn().mockResolvedValue(mockSession);
    try {
      mkdirSync(join(cwd, '.specialists', 'catalog'), { recursive: true });
      writeFileSync(join(cwd, '.specialists', 'catalog', 'index.json'), '{ invalid json');
      const runner = new SpecialistRunner({
        loader: makeLoader({ fallback_models: ['qwen'] }),
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: new CircuitBreaker(),
        sessionFactory,
      });

      await expect(runner.run({ name: 'test-spec', prompt: 'do thing', workingDirectory: cwd, maxRetries: 3 }))
        .rejects.toMatchObject({ name: 'RuntimeToolCatalogResolutionError', code: 'runtime_tool_catalog_unavailable' });
      expect(sessionFactory).not.toHaveBeenCalled();
      expect(mockSession.start).not.toHaveBeenCalled();
      expect(mockSession.prompt).not.toHaveBeenCalled();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('injects resolved tool contract into prompt variables before launch', async () => {
    const sessionFactory = vi.fn().mockResolvedValue(mockSession);
    const runner = new SpecialistRunner({
      loader: makeLoader(
        { extensions: { gitnexus: false } },
        'auto',
        { task_template: 'Contract follows\n\n$resolved_tool_contract' },
      ),
      hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
      circuitBreaker: new CircuitBreaker(),
      sessionFactory,
    });

    await runner.run({ name: 'test-spec', prompt: 'do thing' });

    const promptArg = mockSession.prompt.mock.calls.at(-1)?.[0] as string;
    expect(promptArg).toContain('## Resolved Tool Contract');
    expect(promptArg).toContain('effective tier: READ_ONLY');
    expect(promptArg).toContain('gitnexus: disabled');
  });

  it('warns (not fails) for extension-provided required tools when sources are exposed', async () => {
    // unitAI-34pyf: with enabled extension sources the contract cannot
    // enumerate extension-registered tool names ahead of launch (they are
    // activated by the tool-policy extension at session_start), so a missing
    // required tool is a warning, not a hard error. Native requirements keep
    // failing hard.
    const runner = new SpecialistRunner({
      loader: makeLoader(
        { extensions: { gitnexus: false, '/tmp/extension-source': true } },
        'auto',
        {},
        { capabilities: { required_tools: ['probe_marker'] } },
      ),
      hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
      circuitBreaker: new CircuitBreaker(),
      sessionFactory: vi.fn().mockResolvedValue(mockSession),
    });

    await expect(runner.run({ name: 'test-spec', prompt: 'do thing' })).resolves.toBeTruthy();
  });

  it('fails fast when required tool is impossible under resolved runtime contract', async () => {
    const runner = new SpecialistRunner({
      loader: makeLoader(
        { extensions: { gitnexus: false } },
        'auto',
        {},
        { capabilities: { required_tools: ['gitnexus_query'] } },
      ),
      hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
      circuitBreaker: new CircuitBreaker(),
      sessionFactory: vi.fn().mockResolvedValue(mockSession),
    });

    await expect(runner.run({ name: 'test-spec', prompt: 'do thing' })).rejects.toThrow(
      'tool "gitnexus_query" missing from resolved runtime contract',
    );
  });

  it('injects markdown output contract when response_format=markdown', async () => {
    const sessionFactory = vi.fn().mockResolvedValue(mockSession);
    const runner = new SpecialistRunner({
      loader: makeLoader({ response_format: 'markdown', output_type: 'codegen' }),
      hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
      circuitBreaker: new CircuitBreaker(),
      sessionFactory,
    });

    await runner.run({ name: 'test-spec', prompt: 'do thing' });

    const sessionOptions = sessionFactory.mock.calls[0][0];
    expect(sessionOptions.systemPrompt).toContain('## Output Contract');
    expect(sessionOptions.systemPrompt).toContain('## Summary');
    expect(sessionOptions.systemPrompt).toContain('Output archetype: `codegen`');
  });

  it('injects JSON-only contract when response_format=json', async () => {
    const sessionFactory = vi.fn().mockResolvedValue(mockSession);
    const runner = new SpecialistRunner({
      loader: makeLoader({ response_format: 'json', output_type: 'review' }),
      hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
      circuitBreaker: new CircuitBreaker(),
      sessionFactory,
    });

    await runner.run({ name: 'test-spec', prompt: 'do thing' });

    const sessionOptions = sessionFactory.mock.calls[0][0];
    expect(sessionOptions.systemPrompt).toContain('Respond with a single valid JSON object only.');
    expect(sessionOptions.systemPrompt).toContain('Output archetype: `review`');
  });

  it('strips JSON fences for response_format=json outputs before returning', async () => {
    mockSession.getLastOutput.mockResolvedValueOnce('```json\n{"summary":"Done","status":"success","issues_closed":[],"issues_created":[],"follow_ups":[],"risks":[],"verification":[]}\n```');

    const runner = new SpecialistRunner({
      loader: makeLoader({ response_format: 'json' }),
      hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
      circuitBreaker: new CircuitBreaker(),
      sessionFactory: vi.fn().mockResolvedValue(mockSession),
    });

    const result = await runner.run({ name: 'test-spec', prompt: 'do thing' });

    expect(result.output.startsWith('```')).toBe(false);
    expect(JSON.parse(result.output).status).toBe('success');
  });

  it('does not inject output contract when response_format=text', async () => {
    const sessionFactory = vi.fn().mockResolvedValue(mockSession);
    const runner = new SpecialistRunner({
      loader: makeLoader({ response_format: 'text', output_type: 'analysis' }),
      hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
      circuitBreaker: new CircuitBreaker(),
      sessionFactory,
    });

    await runner.run({ name: 'test-spec', prompt: 'do thing' });

    const sessionOptions = sessionFactory.mock.calls[0][0];
    expect(sessionOptions.systemPrompt).not.toContain('## Output Contract');
  });

  it('toggles runtime injections off when execution.bare=true', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runner-bare-mode-'));
    try {
      mkdirSync(join(cwd, '.gitnexus'), { recursive: true });
      writeFileSync(join(cwd, '.gitnexus', 'meta.json'), JSON.stringify({ indexed: true }));

      const sessionFactory = vi.fn().mockResolvedValue(mockSession);
      const runner = new SpecialistRunner({
        loader: makeLoader(
          { response_format: 'markdown', output_type: 'codegen', bare: true },
          'auto',
          { system: 'Base system prompt.', task_template: 'Do $prompt' },
          {
            mandatory_rules: {
              template_sets: ['git-workflow-safe'],
              inline_rules: [{ id: 'bare-inline', level: 'error', text: 'Bare rule' }],
            },
          },
        ),
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: new CircuitBreaker(),
        sessionFactory,
      });

      await runner.run({
        name: 'reviewer',
        prompt: 'do thing',
        reusedFromJobId: 'job-reviewed',
        workingDirectory: cwd,
        variables: {
          reviewed_job_id: 'job-reviewed',
        },
      });

      const sessionOptions = sessionFactory.mock.calls[0][0];
      const renderedTask = mockSession.prompt.mock.calls.at(-1)?.[0] as string;
      expect(sessionOptions.systemPrompt).toContain('Base system prompt.');
      expect(sessionOptions.systemPrompt).not.toContain('Specialist Run Context');
      expect(sessionOptions.systemPrompt).not.toContain('Output Style (mandatory)');
      expect(sessionOptions.systemPrompt).not.toContain('MANDATORY: GitNexus Code Intelligence');
      expect(sessionOptions.systemPrompt).not.toContain('Beads Workflow Quick Rules');
      expect(sessionOptions.systemPrompt).not.toContain('Reviewer patch retrieval');
      expect(sessionOptions.systemPrompt).not.toContain('Output Contract');
      expect(renderedTask).not.toContain('## MANDATORY_RULES');
      expect(renderedTask).not.toContain('Bare rule');

      const defaultSession = makeMockSession();
      const defaultSessionFactory = vi.fn().mockResolvedValue(defaultSession);
      const defaultRunner = new SpecialistRunner({
        loader: makeLoader(
          { response_format: 'markdown', output_type: 'codegen' },
          'auto',
          { system: 'Base system prompt.', task_template: 'Do $prompt' },
          {
            mandatory_rules: {
              template_sets: ['git-workflow-safe'],
              inline_rules: [{ id: 'bare-inline', level: 'error', text: 'Bare rule' }],
            },
          },
        ),
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: new CircuitBreaker(),
        sessionFactory: defaultSessionFactory,
      });

      await defaultRunner.run({
        name: 'reviewer',
        prompt: 'do thing',
        reusedFromJobId: 'job-reviewed',
        workingDirectory: cwd,
        variables: {
          reviewed_job_id: 'job-reviewed',
        },
      });

      const defaultSessionOptions = defaultSessionFactory.mock.calls[0][0];
      const defaultRenderedTask = defaultSession.prompt.mock.calls.at(-1)?.[0] as string;
      expect(defaultSessionOptions.systemPrompt).toContain('Specialist Run Context');
      expect(defaultSessionOptions.systemPrompt).toContain('Output Style (mandatory)');
      expect(defaultSessionOptions.systemPrompt).toContain('MANDATORY: GitNexus Code Intelligence');
      expect(defaultSessionOptions.systemPrompt).not.toContain('Beads Workflow Quick Rules');
      expect(defaultSessionOptions.systemPrompt).toContain('Output Contract');
      expect(defaultRenderedTask).toContain('## MANDATORY_RULES');
      expect(defaultRenderedTask).toContain('Bare rule');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('warns when response_format=json output is not parseable JSON', async () => {
    mockSession.getLastOutput.mockResolvedValueOnce('not-json');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const runner = new SpecialistRunner({
      loader: makeLoader({ response_format: 'json' }),
      hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
      circuitBreaker: new CircuitBreaker(),
      sessionFactory: vi.fn().mockResolvedValue(mockSession),
    });

    await runner.run({ name: 'test-spec', prompt: 'do thing' });

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Strong warning: response_format=json but output is not valid JSON'));
    stderrSpy.mockRestore();
  });

  it('warns when markdown+output_schema omits machine-readable block', async () => {
    mockSession.getLastOutput.mockResolvedValueOnce('## Summary\nDone.');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const runner = new SpecialistRunner({
      loader: makeLoader(
        { response_format: 'markdown' },
        'auto',
        {
          output_schema: {
            type: 'object',
            properties: { status: { type: 'string' } },
            required: ['status'],
          },
        },
      ),
      hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
      circuitBreaker: new CircuitBreaker(),
      sessionFactory: vi.fn().mockResolvedValue(mockSession),
    });

    await runner.run({ name: 'test-spec', prompt: 'do thing' });

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('missing `## Machine-readable block` JSON fenced block'));
    stderrSpy.mockRestore();
  });

  it('defaults to keepAlive when execution.interactive=true', async () => {
    const onResumeReady = vi.fn();
    const runner = new SpecialistRunner({
      loader: makeLoader({ interactive: true }),
      hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
      circuitBreaker: new CircuitBreaker(),
      sessionFactory: vi.fn().mockResolvedValue(mockSession),
    });

    await runner.run({ name: 'test-spec', prompt: 'analyze this' }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, onResumeReady);

    expect(onResumeReady).toHaveBeenCalledOnce();
    expect(mockSession.close).not.toHaveBeenCalled();
  });

  it('respects noKeepAlive override when execution.interactive=true', async () => {
    const onResumeReady = vi.fn();
    const runner = new SpecialistRunner({
      loader: makeLoader({ interactive: true }),
      hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
      circuitBreaker: new CircuitBreaker(),
      sessionFactory: vi.fn().mockResolvedValue(mockSession),
    });

    await runner.run({ name: 'test-spec', prompt: 'analyze this', noKeepAlive: true }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, onResumeReady);

    expect(onResumeReady).not.toHaveBeenCalled();
    expect(mockSession.close).toHaveBeenCalledOnce();
  });

  it('returns correct backend even when kill() destroys meta', async () => {
    // Simulate kill() nullifying the meta property (the bug scenario)
    mockSession.kill = vi.fn().mockImplementation(() => {
      (mockSession as any).meta = null;
    });
    const runner = new SpecialistRunner({
      loader: makeLoader(),
      hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
      circuitBreaker: new CircuitBreaker(),
      sessionFactory: vi.fn().mockResolvedValue(mockSession),
    });
    const result = await runner.run({ name: 'test-spec', prompt: 'analyze this' });
    // backend must be the value captured BEFORE kill(), not undefined
    expect(result.backend).toBe('google-gemini-cli');
  });

  it('kills session even on error', async () => {
    mockSession.prompt.mockRejectedValueOnce(new Error('backend down'));
    const runner = new SpecialistRunner({
      loader: makeLoader(),
      hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
      circuitBreaker: new CircuitBreaker(),
      sessionFactory: vi.fn().mockResolvedValue(mockSession),
    });
    await expect(runner.run({ name: 'test-spec', prompt: 'fail' })).rejects.toThrow('backend down');
    expect(mockSession.kill).toHaveBeenCalledOnce();
  });

  it('retries transient failures and succeeds on a later attempt', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      mockSession.waitForDone
        .mockRejectedValueOnce(new Error('Specialist timed out after 5000ms'))
        .mockResolvedValueOnce(undefined);

      const runner = new SpecialistRunner({
        loader: makeLoader(),
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: new CircuitBreaker(),
        sessionFactory: vi.fn().mockResolvedValue(mockSession),
      });

      const result = await runner.run({ name: 'test-spec', prompt: 'go', maxRetries: 1 });

      expect(JSON.parse(result.output).status).toBe('success');
      expect(mockSession.prompt).toHaveBeenCalledTimes(2);
      expect(mockSession.waitForDone).toHaveBeenCalledTimes(2);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('does not retry auth errors even when retries are configured', async () => {
    mockSession.waitForDone.mockRejectedValueOnce(new Error('401 Unauthorized'));
    const runner = new SpecialistRunner({
      loader: makeLoader(),
      hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
      circuitBreaker: new CircuitBreaker(),
      sessionFactory: vi.fn().mockResolvedValue(mockSession),
    });

    await expect(runner.run({ name: 'test-spec', prompt: 'go', maxRetries: 3 })).rejects.toThrow('401 Unauthorized');
    expect(mockSession.prompt).toHaveBeenCalledTimes(1);
  });

  it('records circuit-breaker failure only once after final retry fails', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      mockSession.waitForDone.mockRejectedValue(new Error('Specialist timed out after 5000ms'));
      const cb = new CircuitBreaker({ failureThreshold: 2 });
      const recordFailure = vi.spyOn(cb, 'recordFailure');

      const runner = new SpecialistRunner({
        loader: makeLoader(),
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: cb,
        sessionFactory: vi.fn().mockResolvedValue(mockSession),
      });

      await expect(runner.run({ name: 'test-spec', prompt: 'go', maxRetries: 2 })).rejects.toThrow('Specialist timed out after 5000ms');

      expect(mockSession.prompt).toHaveBeenCalledTimes(3);
      expect(recordFailure).toHaveBeenCalledTimes(1);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('uses fallback backend when primary circuit is OPEN', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    cb.recordFailure('gemini');
    const sessionFactory = vi.fn().mockResolvedValue(mockSession);
    const runner = new SpecialistRunner({
      loader: makeLoader({ fallback_model: 'qwen' }),
      hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace2.jsonl' }),
      circuitBreaker: cb,
      sessionFactory,
    });
    const result = await runner.run({ name: 'test-spec', prompt: 'test' });
    expect(result.model).toBe('qwen');
  });

  it('walks fallback_models until available model and emits fallback_step events', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    cb.recordFailure('gemini');
    cb.recordFailure('qwen');
    const onEvent = vi.fn();
    const runner = new SpecialistRunner({
      loader: makeLoader({ fallback_model: 'legacy', fallback_models: ['qwen', 'anthropic'] }),
      hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace3.jsonl' }),
      circuitBreaker: cb,
      sessionFactory: vi.fn().mockResolvedValue(mockSession),
    });

    const result = await runner.run({ name: 'test-spec', prompt: 'test' }, undefined, onEvent);

    expect(result.model).toBe('anthropic');
    expect(onEvent).not.toHaveBeenCalledWith('fallback_step', expect.objectContaining({ model: 'gemini' }));
    expect(onEvent).toHaveBeenCalledWith('fallback_step', expect.objectContaining({
      model: 'qwen',
      data: expect.objectContaining({ error_class: 'transient', terminal: false }),
    }));
    expect(onEvent).toHaveBeenCalledWith('fallback_step', expect.objectContaining({
      model: 'anthropic',
      data: expect.objectContaining({ error_class: 'transient', terminal: false }),
    }));
  });

  it('walks fallback_models after transient model failure', async () => {
    const firstSession = makeMockSession();
    firstSession.waitForDone.mockRejectedValue(new Error('503 service unavailable'));
    const secondSession = makeMockSession();
    secondSession.meta = { ...secondSession.meta, model: 'qwen' };
    const sessionFactory = vi.fn()
      .mockResolvedValueOnce(firstSession)
      .mockResolvedValueOnce(secondSession);
    const onEvent = vi.fn();
    const runner = new SpecialistRunner({
      loader: makeLoader({ fallback_models: ['qwen'] }),
      hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace4.jsonl' }),
      circuitBreaker: new CircuitBreaker(),
      sessionFactory,
    });

    const result = await runner.run({ name: 'test-spec', prompt: 'test' }, undefined, onEvent);

    expect(sessionFactory).toHaveBeenCalledTimes(2);
    expect(sessionFactory.mock.calls[0][0].model).toBe('gemini');
    expect(sessionFactory.mock.calls[1][0].model).toBe('qwen');
    expect(result.model).toBe('qwen');
    expect(onEvent).toHaveBeenCalledWith('fallback_step', expect.objectContaining({
      model: 'qwen',
      data: expect.objectContaining({ attempt_n: 2, model_tried: 'qwen', error_class: 'transient', terminal: false }),
    }));
  });

  it('marks final fallback_step terminal when all fallback models fail transiently', async () => {
    const firstSession = makeMockSession();
    firstSession.waitForDone.mockRejectedValue(new Error('503 service unavailable'));
    const secondSession = makeMockSession();
    secondSession.waitForDone.mockRejectedValue(new Error('request timed out'));
    const sessionFactory = vi.fn()
      .mockResolvedValueOnce(firstSession)
      .mockResolvedValueOnce(secondSession);
    const onEvent = vi.fn();
    const runner = new SpecialistRunner({
      loader: makeLoader({ fallback_models: ['qwen'] }),
      hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace5.jsonl' }),
      circuitBreaker: new CircuitBreaker(),
      sessionFactory,
    });

    await expect(runner.run({ name: 'test-spec', prompt: 'test' }, undefined, onEvent)).rejects.toThrow('request timed out');

    expect(sessionFactory).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenCalledWith('fallback_step', expect.objectContaining({
      model: 'qwen',
      data: expect.objectContaining({ attempt_n: 2, model_tried: 'qwen', error_class: 'timeout', terminal: true }),
    }));
  });

  it('walks fallback_models after rate-limit / quota error and skips same-model retry', async () => {
    const firstSession = makeMockSession();
    firstSession.waitForDone.mockRejectedValue(new Error('ResourceExhausted: Worker local total request limit reached (10/10)'));
    const secondSession = makeMockSession();
    secondSession.meta = { ...secondSession.meta, model: 'qwen' };
    const sessionFactory = vi.fn()
      .mockResolvedValueOnce(firstSession)
      .mockResolvedValueOnce(secondSession);
    const onEvent = vi.fn();
    const runner = new SpecialistRunner({
      loader: makeLoader({ fallback_models: ['qwen'] }),
      hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace-ratelimit.jsonl' }),
      circuitBreaker: new CircuitBreaker(),
      sessionFactory,
    });

    const result = await runner.run({ name: 'test-spec', prompt: 'test' }, undefined, onEvent);

    expect(sessionFactory).toHaveBeenCalledTimes(2);
    expect(sessionFactory.mock.calls[0][0].model).toBe('gemini');
    expect(sessionFactory.mock.calls[1][0].model).toBe('qwen');
    expect(result.model).toBe('qwen');
    expect(firstSession.waitForDone).toHaveBeenCalledTimes(1); // no same-model retry
    expect(onEvent).not.toHaveBeenCalledWith('auto_retry');
    expect(onEvent).toHaveBeenCalledWith('fallback_step', expect.objectContaining({
      model: 'qwen',
      data: expect.objectContaining({ attempt_n: 2, model_tried: 'qwen', error_class: 'rate_limit', terminal: false }),
    }));
  });

  it('does not walk fallback_models after auth failure', async () => {
    const firstSession = makeMockSession();
    firstSession.waitForDone.mockRejectedValue(new Error('401 Unauthorized'));
    const sessionFactory = vi.fn().mockResolvedValue(firstSession);
    const onEvent = vi.fn();
    const runner = new SpecialistRunner({
      loader: makeLoader({ fallback_models: ['qwen'] }),
      hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace6.jsonl' }),
      circuitBreaker: new CircuitBreaker(),
      sessionFactory,
    });

    await expect(runner.run({ name: 'test-spec', prompt: 'test' }, undefined, onEvent)).rejects.toThrow('401 Unauthorized');

    expect(sessionFactory).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalledWith('fallback_step', expect.anything());
  });

  describe('beads integration', () => {
    it('creates bead and emits audit on success when always (closeBead delegated to Supervisor)', async () => {
      const beadsClient = makeBeadsClient();
      const runner = new SpecialistRunner({
        loader: makeLoader({}, 'always'),
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: new CircuitBreaker(),
        sessionFactory: vi.fn().mockResolvedValue(mockSession),
        beadsClient,
      });
      const result = await runner.run({ name: 'test-spec', prompt: 'go' });
      expect(beadsClient.createBead).toHaveBeenCalledWith('test-spec');
      // Supervisor calls closeBead AFTER updateBeadNotes — runner must NOT close on success
      expect(beadsClient.closeBead).not.toHaveBeenCalled();
      expect(beadsClient.auditBead).toHaveBeenCalledWith('specialists-test-1', 'test-spec', expect.any(String), 0);
      expect(result.beadId).toBe('specialists-test-1');
    });

    it('closes bead with ERROR status on run failure', async () => {
      mockSession.prompt.mockRejectedValueOnce(new Error('crash'));
      const beadsClient = makeBeadsClient();
      const runner = new SpecialistRunner({
        loader: makeLoader({}, 'always'),
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: new CircuitBreaker(),
        sessionFactory: vi.fn().mockResolvedValue(mockSession),
        beadsClient,
      });
      await expect(runner.run({ name: 'test-spec', prompt: 'go' })).rejects.toThrow('crash');
      expect(beadsClient.closeBead).toHaveBeenCalledWith('specialists-test-1', 'ERROR', expect.any(Number), expect.any(String));
      expect(beadsClient.auditBead).toHaveBeenCalledWith('specialists-test-1', 'test-spec', expect.any(String), 1);
    });

    it('skips bead when never', async () => {
      const beadsClient = makeBeadsClient();
      const runner = new SpecialistRunner({
        loader: makeLoader({}, 'never'),
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: new CircuitBreaker(),
        sessionFactory: vi.fn().mockResolvedValue(mockSession),
        beadsClient,
      });
      const result = await runner.run({ name: 'test-spec', prompt: 'go' });
      expect(beadsClient.createBead).not.toHaveBeenCalled();
      expect(result.beadId).toBeUndefined();
    });

    it('skips bead when auto and READ_ONLY', async () => {
      const beadsClient = makeBeadsClient();
      const runner = new SpecialistRunner({
        loader: makeLoader({ permission_required: 'READ_ONLY' }, 'auto'),
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: new CircuitBreaker(),
        sessionFactory: vi.fn().mockResolvedValue(mockSession),
        beadsClient,
      });
      const result = await runner.run({ name: 'test-spec', prompt: 'go' });
      expect(beadsClient.createBead).not.toHaveBeenCalled();
      expect(result.beadId).toBeUndefined();
    });

    it('creates bead when auto and MEDIUM permission', async () => {
      const beadsClient = makeBeadsClient();
      const runner = new SpecialistRunner({
        loader: makeLoader({ permission_required: 'MEDIUM' }, 'auto'),
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: new CircuitBreaker(),
        sessionFactory: vi.fn().mockResolvedValue(mockSession),
        beadsClient,
      });
      const result = await runner.run({ name: 'test-spec', prompt: 'go' });
      expect(beadsClient.createBead).toHaveBeenCalledWith('test-spec');
      expect(result.beadId).toBe('specialists-test-1');
    });

    it('uses input bead directly — no second tracking bead created', async () => {
      const beadsClient = makeBeadsClient();
      const runner = new SpecialistRunner({
        loader: makeLoader({ permission_required: 'MEDIUM' }, 'auto'),
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: new CircuitBreaker(),
        sessionFactory: vi.fn().mockResolvedValue(mockSession),
        beadsClient,
      });
      const result = await runner.run({ name: 'test-spec', prompt: 'go', inputBeadId: 'unitAI-55d' });
      expect(beadsClient.createBead).not.toHaveBeenCalled();
      expect(result.beadId).toBe('unitAI-55d');
    });

    it('exposes bead_context and bead_id template variables for bead runs', async () => {
      const loader = {
        get: vi.fn().mockResolvedValue({
          specialist: {
            metadata: { name: 'test-spec', version: '1.0.0' },
            execution: { model: 'gemini', timeout_ms: 5000, mode: 'tool', permission_required: 'READ_ONLY' },
            prompt: { task_template: 'Prompt=$prompt\nBead=$bead_context\nId=$bead_id', system: 'You are helpful.' },
            communication: undefined,
            capabilities: undefined,
            beads_integration: 'never',
          },
        }),
      } as any;
      const runner = new SpecialistRunner({
        loader,
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: new CircuitBreaker(),
        sessionFactory: vi.fn().mockResolvedValue(mockSession),
        beadsClient: makeBeadsClient({ readBead: vi.fn().mockReturnValue(null) }),
      });
      await runner.run({
        name: 'test-spec',
        prompt: '# Task: Refactor auth',
        inputBeadId: 'unitAI-55d',
      });
      const renderedTask = mockSession.prompt.mock.calls.at(-1)?.[0] as string;
      expect(renderedTask).toContain([
        'Prompt=# Task: Refactor auth',
        'Bead=# Task: Refactor auth',
        'Id=unitAI-55d',
      ].join('\n'));
      expect(renderedTask).toContain('## MANDATORY_RULES');
    });

    it('substitutes bead template variables in system prompt for bead runs', async () => {
      const sessionFactory = vi.fn().mockResolvedValue(mockSession);
      const runner = new SpecialistRunner({
        loader: makeLoader(
          {},
          'never',
          { system: 'Inspect bead $bead_id and task $prompt' },
        ),
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: new CircuitBreaker(),
        sessionFactory,
        beadsClient: makeBeadsClient({ readBead: vi.fn().mockReturnValue(null) }),
      });

      await runner.run({
        name: 'test-spec',
        prompt: '# Task: Refactor auth\nImprove token validation flow.',
        inputBeadId: 'unitAI-55d',
      });

      const sessionOptions = sessionFactory.mock.calls[0][0];
      expect(sessionOptions.systemPrompt).toContain('Inspect bead unitAI-55d and task # Task: Refactor auth\nImprove token validation flow.');
      expect(sessionOptions.systemPrompt).not.toContain('$bead_id');
      expect(sessionOptions.systemPrompt).not.toContain('$prompt');
    });

    it('renders bead_id placeholder as empty string for non-bead system prompts', async () => {
      const sessionFactory = vi.fn().mockResolvedValue(mockSession);
      const runner = new SpecialistRunner({
        loader: makeLoader({}, 'never', { system: 'bead=[$bead_id] prompt=$prompt' }),
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: new CircuitBreaker(),
        sessionFactory,
      });

      await runner.run({ name: 'test-spec', prompt: 'review docs' });

      const sessionOptions = sessionFactory.mock.calls[0][0];
      expect(sessionOptions.systemPrompt).toContain('bead=[] prompt=review docs');
      expect(sessionOptions.systemPrompt).not.toContain('$bead_id');
    });

    it('renders bead_id placeholder as empty string for non-bead task templates', async () => {
      const runner = new SpecialistRunner({
        loader: makeLoader({}, 'never', { task_template: 'bead=[$bead_id]\nprompt=$prompt' }),
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: new CircuitBreaker(),
        sessionFactory: vi.fn().mockResolvedValue(mockSession),
      });

      await runner.run({ name: 'test-spec', prompt: 'sync docs' });

      const renderedTask = mockSession.prompt.mock.calls.at(-1)?.[0] as string;
      expect(renderedTask).toContain('bead=[]');
      expect(renderedTask).toContain('prompt=sync docs');
      expect(renderedTask).not.toContain('$bead_id');
    });

    it.each([
      'reviewer',
      'explorer',
      'debugger',
      'sync-docs',
      'executor',
    ])('injects cwd/worktree boundary rule into bead task payload for %s', async specialistName => {
      // Mock BeadsClient so the test does not depend on `bd` being installed
      // or on `unitAI-55d` existing in the runtime beads DB. The Runtime
      // Boundary Rules block is only injected when input.bead is non-null,
      // and BeadsClient.readBead spawns real `bd show <id> --json` otherwise.
      const beadsClient = makeBeadsClient({
        readBead: vi.fn().mockReturnValue({
          id: 'unitAI-55d',
          title: 'inspect boundary behavior',
          description: 'test bead for boundary rule injection',
          status: 'in_progress',
        }),
      });
      const runner = new SpecialistRunner({
        loader: {
          get: vi.fn().mockResolvedValue({
            specialist: {
              metadata: { name: specialistName, version: '1.0.0' },
              execution: { model: 'gemini', timeout_ms: 5000, mode: 'tool', permission_required: 'READ_ONLY' },
              prompt: { task_template: 'Task: $prompt', system: 'You are helpful.' },
              communication: undefined,
              capabilities: undefined,
              beads_integration: 'never',
            },
          }),
        } as any,
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: new CircuitBreaker(),
        sessionFactory: vi.fn().mockResolvedValue(mockSession),
        beadsClient,
      });

      await runner.run({
        name: specialistName,
        prompt: 'inspect boundary behavior',
        inputBeadId: 'unitAI-55d',
        workingDirectory: '/repo/worktree',
        worktreeBoundary: '/repo/worktree',
      });

      const promptArg = mockSession.prompt.mock.calls.at(-1)?.[0] as string;
      expect(promptArg).toContain('## Runtime Boundary Rules');
      expect(promptArg).toContain('Current cwd: /repo/worktree');
      expect(promptArg).toContain('Assigned worktree boundary: /repo/worktree');
      expect(promptArg).toContain('Do NOT run `cd` outside the current cwd / assigned worktree.');
      expect(promptArg).toContain('Do NOT broad-search /home, repo root, or unrelated paths when evidence is missing.');
      expect(promptArg).toContain('If required evidence is missing inside the current scope, STOP immediately, report exactly what is missing, and ask for the artifact or clarification instead of widening search.');
    });

    it('injects reused lineage variables into task template context', async () => {
      const runner = new SpecialistRunner({
        loader: makeLoader(
          { permission_required: 'READ_ONLY' },
          'never',
          {
            task_template: 'reuse=$reused_from_job_id\nowner=$worktree_owner_job_id',
            system: 'You are helpful.',
          },
        ),
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: new CircuitBreaker(),
        sessionFactory: vi.fn().mockResolvedValue(mockSession),
        beadsClient: makeBeadsClient({ readBead: vi.fn().mockReturnValue(null) }),
      });

      await runner.run({
        name: 'test-spec',
        prompt: 'do thing',
        reusedFromJobId: 'job-reused-123',
        worktreeOwnerJobId: 'job-owner-999',
      });

      const renderedTask = mockSession.prompt.mock.calls.at(-1)?.[0] as string;
      expect(renderedTask).toContain('reuse=job-reused-123');
      expect(renderedTask).toContain('owner=job-owner-999');
      expect(renderedTask).not.toContain('$reused_from_job_id');
      expect(renderedTask).not.toContain('$worktree_owner_job_id');
    });

    it('injects reused lineage variables into system prompt template context', async () => {
      const sessionFactory = vi.fn().mockResolvedValue(mockSession);
      const runner = new SpecialistRunner({
        loader: makeLoader(
          { permission_required: 'READ_ONLY' },
          'never',
          {
            system: 'lineage reuse=$reused_from_job_id owner=$worktree_owner_job_id prompt=$prompt',
          },
        ),
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: new CircuitBreaker(),
        sessionFactory,
        beadsClient: makeBeadsClient({ readBead: vi.fn().mockReturnValue(null) }),
      });

      await runner.run({
        name: 'test-spec',
        prompt: 'review this run',
        reusedFromJobId: 'job-reused-abc',
        worktreeOwnerJobId: 'job-owner-def',
      });

      const sessionOptions = sessionFactory.mock.calls[0][0];
      expect(sessionOptions.systemPrompt).toContain('lineage reuse=job-reused-abc owner=job-owner-def prompt=review this run');
      expect(sessionOptions.systemPrompt).not.toContain('$reused_from_job_id');
      expect(sessionOptions.systemPrompt).not.toContain('$worktree_owner_job_id');
    });

    it('renders reviewed_job_id into reviewer lineage block so normal --job flow does not request manual id', async () => {
      const loader = {
        get: vi.fn().mockResolvedValue({
          specialist: {
            metadata: { name: 'reviewer', version: '1.0.0' },
            execution: { model: 'gemini', timeout_ms: 5000, mode: 'tool', permission_required: 'READ_ONLY' },
            prompt: {
              task_template: [
                'Audit run',
                'Resolved lineage input:',
                '- reviewed_job_id: $reviewed_job_id',
              ].join('\n'),
              system: 'You are reviewer.',
            },
            communication: undefined,
            capabilities: undefined,
            beads_integration: 'never',
          },
        }),
      } as any;
      const runner = new SpecialistRunner({
        loader,
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: new CircuitBreaker(),
        sessionFactory: vi.fn().mockResolvedValue(mockSession),
        beadsClient: makeBeadsClient({ readBead: vi.fn().mockReturnValue(null) }),
      });

      const repo = createEmptyReviewerRepo();
      try {
        await runner.run({
          name: 'reviewer',
          prompt: 'review this',
          variables: { reviewed_job_id: 'job-reviewed' },
          workingDirectory: repo.dir,
        });

        const renderedTask = mockSession.prompt.mock.calls.at(-1)?.[0] as string;
        expect(renderedTask).toContain('- reviewed_job_id: job-reviewed');
        expect(renderedTask).not.toContain('$reviewed_job_id');
        expect(renderedTask).not.toContain('Need reviewed_job_id');
      } finally {
        repo.cleanup();
      }
    });

    it('defines authoritative review context rules in reviewer config prompt', async () => {
      const reviewerConfigPath = join(process.cwd(), 'config/specialists/reviewer.specialist.json');
      const reviewerConfig = JSON.parse(readFileSync(reviewerConfigPath, 'utf8'));
      const systemPrompt = reviewerConfig?.specialist?.prompt?.system ?? '';
      expect(systemPrompt).toContain('## AUTHORITATIVE REVIEW CONTEXT');
      expect(systemPrompt).toContain('Evidence precedence for lineage, requirements, and evidence availability, highest to lowest');
      expect(systemPrompt).toContain('Missing local artifacts MUST NOT trigger FAIL by itself.');
      expect(systemPrompt).toContain('authoritative_lineage_present: yes|no');
      expect(systemPrompt).toContain('authoritative_result_present: yes|no');
      expect(systemPrompt).toContain('authoritative_diff_present: yes|no');
      expect(systemPrompt).toContain('local_lookup_status: success|partial|missing|not_attempted');
      expect(systemPrompt).toContain('contradiction_detected: yes|no');
      expect(systemPrompt).toContain('missing_required_injected_fields: []|[list]');
      expect(systemPrompt).toContain('limitation_note: <short note or none>');
      expect(systemPrompt).toContain('Required injected fields for authoritative traceability:');
      expect(systemPrompt).toContain('Local lookup failure with valid injected context => PARTIAL or PASS, never FAIL by itself.');
    });

    it('does not crash when createBead returns null', async () => {
      const beadsClient = makeBeadsClient({ createBead: vi.fn().mockReturnValue(null) });
      const runner = new SpecialistRunner({
        loader: makeLoader({}, 'always'),
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: new CircuitBreaker(),
        sessionFactory: vi.fn().mockResolvedValue(mockSession),
        beadsClient,
      });
      const result = await runner.run({ name: 'test-spec', prompt: 'go' });
      expect(JSON.parse(result.output).status).toBe('success');
      expect(result.beadId).toBeUndefined();
    });

    it('runs normally without beadsClient provided', async () => {
      const runner = new SpecialistRunner({
        loader: makeLoader({}, 'always'),
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: new CircuitBreaker(),
        sessionFactory: vi.fn().mockResolvedValue(mockSession),
      });
      const result = await runner.run({ name: 'test-spec', prompt: 'go' });
      expect(JSON.parse(result.output).status).toBe('success');
      expect(result.beadId).toBeUndefined();
    });
  });

  describe('cancellation via SessionKilledError', () => {
    it('does not record circuit-breaker failure when session is killed', async () => {
      mockSession.waitForDone.mockRejectedValueOnce(new SessionKilledError());
      const cb = new CircuitBreaker({ failureThreshold: 1 });
      const recordFailure = vi.spyOn(cb, 'recordFailure');
      const runner = new SpecialistRunner({
        loader: makeLoader(),
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: cb,
        sessionFactory: vi.fn().mockResolvedValue(mockSession),
      });
      await expect(runner.run({ name: 'test-spec', prompt: 'go' })).rejects.toBeInstanceOf(SessionKilledError);
      expect(recordFailure).not.toHaveBeenCalled();
      // Model should remain available (circuit NOT tripped)
      expect(cb.isAvailable('gemini')).toBe(true);
    });

    it('closes bead with CANCELLED status when session is killed', async () => {
      mockSession.waitForDone.mockRejectedValueOnce(new SessionKilledError());
      const beadsClient = makeBeadsClient();
      const runner = new SpecialistRunner({
        loader: makeLoader({}, 'always'),
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: new CircuitBreaker(),
        sessionFactory: vi.fn().mockResolvedValue(mockSession),
        beadsClient,
      });
      await expect(runner.run({ name: 'test-spec', prompt: 'go' })).rejects.toBeInstanceOf(SessionKilledError);
      expect(beadsClient.closeBead).toHaveBeenCalledWith('specialists-test-1', 'CANCELLED', expect.any(Number), expect.any(String));
    });

    it('records circuit-breaker failure for real backend errors (not kills)', async () => {
      mockSession.waitForDone.mockRejectedValueOnce(new Error('backend crash'));
      const cb = new CircuitBreaker({ failureThreshold: 1 });
      const recordFailure = vi.spyOn(cb, 'recordFailure');
      const runner = new SpecialistRunner({
        loader: makeLoader(),
        hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
        circuitBreaker: cb,
        sessionFactory: vi.fn().mockResolvedValue(mockSession),
      });
      await expect(runner.run({ name: 'test-spec', prompt: 'go' })).rejects.toThrow('backend crash');
      expect(recordFailure).toHaveBeenCalledOnce();
      expect(cb.isAvailable('gemini')).toBe(false);
    });
  });
});
