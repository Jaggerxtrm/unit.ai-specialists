// tests/unit/pi/session.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { mapSpecialistBackend, getProviderArgs } from '../../../src/pi/backendMap.js';

// ── Mock node:child_process before importing session ──────────────────────────
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));

import { execFileSync, spawn } from 'node:child_process';
import { PiAgentSession, StallTimeoutError, applyExtensionToolPolicyGate, deduplicateExtensionSources, resolveExecutionExtensionSelection, resolveRuntimeToolContract, validateWriteToolPathAgainstBoundary } from '../../../src/pi/session.js';
import { __resetPiExtensionsPythonKernelPathCacheForTest } from '../../../src/pi/python-kernel-extension.js';
import { getExtensionToolPolicyExtensionPath, NATIVE_TOOLS_ENV_KEY } from '../../../src/pi/extension-tool-policy-extension.js';

const mockSpawn = spawn as ReturnType<typeof vi.fn>;
const mockExecFileSync = execFileSync as ReturnType<typeof vi.fn>;

// ── backendMap tests (pre-existing) ──────────────────────────────────────────
describe('backendMap', () => {
  it('maps gemini to google-gemini-cli', () => {
    expect(mapSpecialistBackend('gemini')).toBe('google-gemini-cli');
    expect(mapSpecialistBackend('google')).toBe('google-gemini-cli');
  });
  it('maps qwen to openai', () => {
    expect(mapSpecialistBackend('qwen')).toBe('openai');
  });
  it('maps claude/anthropic to anthropic', () => {
    expect(mapSpecialistBackend('claude')).toBe('anthropic');
    expect(mapSpecialistBackend('anthropic')).toBe('anthropic');
  });
  it('passes through unknown backends', () => {
    expect(mapSpecialistBackend('groq')).toBe('groq');
    expect(mapSpecialistBackend('openrouter')).toBe('openrouter');
  });
  it('returns --api-key args for qwen', () => {
    const args = getProviderArgs('qwen');
    expect(args).toContain('--api-key');
  });
  it('returns empty args for gemini', () => {
    expect(getProviderArgs('gemini')).toHaveLength(0);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a fresh fake ChildProcess and wire it up to mockSpawn. */
function makeFakeProc() {
  const stdoutHandlers: Record<string, Function> = {};
  const stderrHandlers: Record<string, Function> = {};
  const procHandlers: Record<string, Function> = {};

  const stdin = {
    write: vi.fn().mockImplementation((_data: any, cb?: any) => { cb?.(); return true; }),
    end: vi.fn(),
    writable: true,
  };

  const stdout = {
    on: vi.fn().mockImplementation((evt: string, h: Function) => {
      stdoutHandlers[evt] = h;
    }),
  };

  const stderr = {
    on: vi.fn().mockImplementation((evt: string, h: Function) => {
      stderrHandlers[evt] = h;
    }),
  };

  const proc = {
    stdin,
    stdout,
    stderr,
    on: vi.fn().mockImplementation((evt: string, h: Function) => {
      procHandlers[evt] = h;
    }),
    kill: vi.fn(),
  };

  mockSpawn.mockReturnValue(proc);

  return { proc, stdin, stdout, stderr, stdoutHandlers, stderrHandlers, procHandlers };
}

// ── Protocol event injection helper ──────────────────────────────────────────

/** Emit a single NDJSON line into the session as if pi wrote it to stdout. */
function emitLine(fake: ReturnType<typeof makeFakeProc>, obj: object) {
  fake.stdoutHandlers['data']?.(Buffer.from(JSON.stringify(obj) + '\n'));
}

function getToolsArg(args: readonly string[]): string | undefined {
  const toolsIdx = args.indexOf('--tools');
  return toolsIdx >= 0 ? args[toolsIdx + 1] : undefined;
}

async function withNpmGlobal<T>(setup: (npmGlobalDir: string) => void, run: (npmGlobalDir: string) => Promise<T>): Promise<T> {
  const npmGlobalDir = mkdtempSync(join(tmpdir(), 'pi-npm-global-'));
  const prevGlobalDir = process.env.PI_NPM_GLOBAL_DIR;
  try {
    setup(npmGlobalDir);
    process.env.PI_NPM_GLOBAL_DIR = npmGlobalDir;
    return await run(npmGlobalDir);
  } finally {
    if (prevGlobalDir === undefined) delete process.env.PI_NPM_GLOBAL_DIR;
    else process.env.PI_NPM_GLOBAL_DIR = prevGlobalDir;
    rmSync(npmGlobalDir, { recursive: true, force: true });
  }
}

async function withGitnexusInstall<T>(version: string, run: (npmGlobalDir: string) => Promise<T>): Promise<T> {
  return withNpmGlobal(npmGlobalDir => {
    mkdirSync(join(npmGlobalDir, 'pi-gitnexus'), { recursive: true });
    writeFileSync(join(npmGlobalDir, 'pi-gitnexus', 'package.json'), JSON.stringify({ name: 'pi-gitnexus', version }));
  }, run);
}

async function withPiExtensionPaths<T>(paths: readonly string[], run: () => Promise<T>): Promise<T> {
  const createdPaths = paths.filter((path) => !existsSync(path));
  try {
    for (const path of createdPaths) mkdirSync(path, { recursive: true });
    return await run();
  } finally {
    for (const path of createdPaths) rmSync(path, { recursive: true, force: true });
  }
}


// ── RPC protocol parsing tests ────────────────────────────────────────────────

describe('resolveExecutionExtensionSelection', () => {
  it('preserves source order, filters legacy keys, and disables offline for remote sources', () => {
    expect(resolveExecutionExtensionSelection({
      serena: false,
      gitnexus: false,
      'npm:@jaggerxtrm/pi-service-knowledge@1.0.0': true,
      './local-extension': true,
      'https://example.test/ext': true,
      disabled: false,
    })).toEqual({
      excludeExtensions: ['pi-gitnexus'],
      extensionSources: ['npm:@jaggerxtrm/pi-service-knowledge@1.0.0', './local-extension', 'https://example.test/ext'],
      offline: false,
    });
  });

  it('keeps offline when only local sources are enabled', () => {
    expect(resolveExecutionExtensionSelection({ './local-extension': true })).toEqual({
      excludeExtensions: [],
      extensionSources: ['./local-extension'],
      offline: true,
    });
  });
});

describe('validateWriteToolPathAgainstBoundary', () => {
  const boundary = '/tmp/worktrees/elhl';

  it('rejects absolute path outside boundary for edit/write/multiEdit/notebookEdit', () => {
    const outsidePath = '/tmp/main-repo/src/file.ts';
    const expectedError = `Path '${outsidePath}' is outside worktree boundary ('${resolve(boundary)}'). Use a relative path or a path within the worktree.`;

    for (const tool of ['edit', 'write', 'multiEdit']) {
      expect(validateWriteToolPathAgainstBoundary(tool, { path: outsidePath }, boundary)).toBe(expectedError);
    }

    expect(validateWriteToolPathAgainstBoundary('notebookEdit', { file_path: outsidePath }, boundary)).toBe(expectedError);
  });

  it('allows absolute path inside boundary for edit/write/multiEdit/notebookEdit', () => {
    const insidePath = `${resolve(boundary)}/src/file.ts`;

    for (const tool of ['edit', 'write', 'multiEdit']) {
      expect(validateWriteToolPathAgainstBoundary(tool, { path: insidePath }, boundary)).toBeUndefined();
    }

    expect(validateWriteToolPathAgainstBoundary('notebookEdit', { file_path: insidePath }, boundary)).toBeUndefined();
  });

  it('allows relative paths for edit/write/multiEdit/notebookEdit', () => {
    for (const tool of ['edit', 'write', 'multiEdit']) {
      expect(validateWriteToolPathAgainstBoundary(tool, { path: 'src/file.ts' }, boundary)).toBeUndefined();
    }

    expect(validateWriteToolPathAgainstBoundary('notebookEdit', { file_path: 'notes/example.ipynb' }, boundary)).toBeUndefined();
  });

  it('allows all paths when worktreeBoundary is undefined (backward compatibility)', () => {
    expect(validateWriteToolPathAgainstBoundary('edit', { path: '/tmp/main-repo/src/file.ts' }, undefined)).toBeUndefined();
    expect(validateWriteToolPathAgainstBoundary('write', { path: '/tmp/main-repo/src/file.ts' }, undefined)).toBeUndefined();
    expect(validateWriteToolPathAgainstBoundary('multiEdit', { path: '/tmp/main-repo/src/file.ts' }, undefined)).toBeUndefined();
    expect(validateWriteToolPathAgainstBoundary('notebookEdit', { file_path: '/tmp/main-repo/notebooks/nb.ipynb' }, undefined)).toBeUndefined();
  });
});

describe('_handleEvent — RPC protocol parsing', () => {
  let fake: ReturnType<typeof makeFakeProc>;

  beforeEach(() => {
    vi.clearAllMocks();
    fake = makeFakeProc();
  });

  it('thinking_delta nested in message_update calls onThinking', async () => {
    const onThinking = vi.fn();
    const session = await PiAgentSession.create({ model: 'gemini', onThinking });
    await session.start();

    emitLine(fake, {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm...' },
    });

    expect(onThinking).toHaveBeenCalledOnce();
    expect(onThinking).toHaveBeenCalledWith('hmm...');
  });

  it('top-level thinking_delta does NOT call onThinking', async () => {
    const onThinking = vi.fn();
    const session = await PiAgentSession.create({ model: 'gemini', onThinking });
    await session.start();

    emitLine(fake, { type: 'thinking_delta', delta: 'should be ignored' });

    expect(onThinking).not.toHaveBeenCalled();
  });

  it('thinking_start nested in message_update fires onEvent("thinking")', async () => {
    const onEvent = vi.fn();
    const session = await PiAgentSession.create({ model: 'gemini', onEvent });
    await session.start();

    emitLine(fake, {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_start' },
    });

    expect(onEvent).toHaveBeenCalledWith('thinking', { charCount: 0 });
  });

  it('toolcall_start nested in message_update calls onToolStart and onEvent("toolcall")', async () => {
    const onToolStart = vi.fn();
    const onEvent = vi.fn();
    const session = await PiAgentSession.create({ model: 'gemini', onToolStart, onEvent });
    await session.start();

    emitLine(fake, {
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_start', name: 'bash' },
    });

    expect(onToolStart).toHaveBeenCalledOnce();
    expect(onToolStart).toHaveBeenCalledWith('bash');
    expect(onEvent).toHaveBeenCalledWith('toolcall');
  });

  it('top-level toolcall_start does NOT call onToolStart or onEvent("toolcall")', async () => {
    const onToolStart = vi.fn();
    const onEvent = vi.fn();
    const session = await PiAgentSession.create({ model: 'gemini', onToolStart, onEvent });
    await session.start();

    emitLine(fake, { type: 'toolcall_start', name: 'bash' });

    expect(onToolStart).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalledWith('toolcall');
  });

  it('agent_end fires onEvent("agent_end"), not onEvent("done")', async () => {
    const onEvent = vi.fn();
    const session = await PiAgentSession.create({ model: 'gemini', onEvent });
    await session.start();

    emitLine(fake, { type: 'agent_end', messages: [] });

    expect(onEvent).toHaveBeenCalledWith('agent_end');
    expect(onEvent).not.toHaveBeenCalledWith('done');
  });

  it('assistantMessageEvent.done fires onEvent("message_done")', async () => {
    const onEvent = vi.fn();
    const session = await PiAgentSession.create({ model: 'gemini', onEvent });
    await session.start();

    emitLine(fake, {
      type: 'message_update',
      assistantMessageEvent: { type: 'done', stopReason: 'stop' },
    });

    expect(onEvent).toHaveBeenCalledWith('message_done');
  });

  it('assistantMessageEvent.done emits finish_reason metric', async () => {
    const onMetric = vi.fn();
    const session = await PiAgentSession.create({ model: 'gemini', onMetric });
    await session.start();

    emitLine(fake, {
      type: 'message_update',
      assistantMessageEvent: { type: 'done', stopReason: 'length' },
    });

    expect(onMetric).toHaveBeenCalledWith({
      type: 'finish_reason',
      finish_reason: 'length',
      source: 'message_done',
    });
  });

  it('assistantMessageEvent.error emits api_error metric', async () => {
    const onMetric = vi.fn();
    const session = await PiAgentSession.create({ model: 'gemini', onMetric });
    await session.start();

    emitLine(fake, {
      type: 'message_update',
      assistantMessageEvent: { type: 'error', error: 'You have hit your ChatGPT usage limit' },
    });

    expect(onMetric).toHaveBeenCalledWith({
      type: 'api_error',
      source: 'rpc',
      errorMessage: 'You have hit your ChatGPT usage limit',
    });
  });

  it('stderr api errors emit api_error metric at agent_end', async () => {
    const onMetric = vi.fn();
    const session = await PiAgentSession.create({ model: 'gemini', onMetric });
    await session.start();

    fake.stderrHandlers['data']?.(Buffer.from('You have hit your ChatGPT usage limit\n'));

    emitLine(fake, { type: 'agent_end', messages: [] });

    expect(onMetric).toHaveBeenCalledWith({
      type: 'api_error',
      source: 'stderr',
      errorMessage: 'You have hit your ChatGPT usage limit',
    });
  });

  it('text_delta nested in message_update calls onToken and onEvent("text")', async () => {
    const onToken = vi.fn();
    const onEvent = vi.fn();
    const session = await PiAgentSession.create({ model: 'gemini', onToken, onEvent });
    await session.start();

    emitLine(fake, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    });

    expect(onToken).toHaveBeenCalledWith('hello');
    expect(onEvent).toHaveBeenCalledWith('text', { charCount: 5, content: 'hello' });
  });

  it('message_end assistant forwards full message text content', async () => {
    const onEvent = vi.fn();
    const session = await PiAgentSession.create({ model: 'gemini', onEvent });
    await session.start();

    emitLine(fake, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'First line\n' },
          { type: 'text', text: 'Second line' },
          { type: 'toolCall', text: 'ignored' },
        ],
      },
    });

    expect(onEvent).toHaveBeenCalledWith('message_end_assistant', {
      content: 'First line\nSecond line',
      charCount: 22,
    });
  });

  it('agent_end forwards last assistant text content', async () => {
    const onEvent = vi.fn();
    const session = await PiAgentSession.create({ model: 'gemini', onEvent });
    await session.start();

    emitLine(fake, {
      type: 'agent_end',
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] },
      ],
    });

    expect(onEvent).toHaveBeenCalledWith('agent_end', {
      content: 'final answer',
      charCount: 12,
    });
  });

  it('tool_execution_end passes undefined resultRaw when result is not an object', async () => {
    const onToolEnd = vi.fn();
    const session = await PiAgentSession.create({ model: 'gemini', onToolEnd });
    await session.start();

    emitLine(fake, {
      type: 'tool_execution_end',
      toolName: 'bash',
      isError: false,
      result: 'plain text result',
    });

    expect(onToolEnd).toHaveBeenCalledWith('bash', false, undefined, undefined, undefined);
  });
});

// ── PiAgentSession behaviour tests ───────────────────────────────────────────
describe('PiAgentSession', () => {
  let fake: ReturnType<typeof makeFakeProc>;
  // The resolver's hard-deny of native fs tools is gated on probeExtensionHealth(),
  // which looks for globally installed pi-gitnexus. Without a stub global dir
  // these tests pass on a developer box and fail on a clean CI runner. Pin the
  // probe to a fixture so the outcome does not depend on what the machine
  // happens to have installed. pi-serena-tools is also materialized so the
  // negative assertions below prove it is ignored even when installed.
  let npmGlobalDir: string;
  let prevGlobalDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    fake = makeFakeProc();
    npmGlobalDir = mkdtempSync(join(tmpdir(), 'pi-npm-global-installed-'));
    for (const pkg of ['pi-gitnexus', 'pi-serena-tools']) {
      mkdirSync(join(npmGlobalDir, pkg), { recursive: true });
      writeFileSync(join(npmGlobalDir, pkg, 'package.json'), JSON.stringify({ name: pkg, version: '0.0.0' }));
    }
    prevGlobalDir = process.env.PI_NPM_GLOBAL_DIR;
    process.env.PI_NPM_GLOBAL_DIR = npmGlobalDir;
  });

  afterEach(() => {
    if (prevGlobalDir === undefined) delete process.env.PI_NPM_GLOBAL_DIR;
    else process.env.PI_NPM_GLOBAL_DIR = prevGlobalDir;
    rmSync(npmGlobalDir, { recursive: true, force: true });
  });

  it('pins spawn cwd to an absolute current working directory by default', async () => {
    const session = await PiAgentSession.create({ model: 'gemini' });
    await session.start();

    const spawnOptions = mockSpawn.mock.calls[0][2] as { cwd?: string };
    expect(spawnOptions.cwd).toBe(resolve(process.cwd()));
  });

  it('resolves provided relative cwd to an absolute path at spawn time', async () => {
    const session = await PiAgentSession.create({ model: 'gemini', cwd: '.' });
    await session.start();

    const spawnOptions = mockSpawn.mock.calls[0][2] as { cwd?: string };
    expect(spawnOptions.cwd).toBe(resolve('.'));
  });


  it('never spawns serena-pool or injects SERENA_MCP_PORT, even when the pool module is installed', async () => {
    const npmGlobalDir = mkdtempSync(join(tmpdir(), 'pi-npm-global-'));
    const serenaPoolPath = join(npmGlobalDir, '@jaggerxtrm', 'pi-extensions', 'extensions', 'serena-pool', 'index.ts');
    const prevGlobalDir = process.env.PI_NPM_GLOBAL_DIR;
    // Isolate from operator environments that already carry a foreign pool port:
    // env passthrough is by design, the session itself must never set the port.
    const prevSerenaPort = process.env.SERENA_MCP_PORT;
    delete process.env.SERENA_MCP_PORT;
    try {
      mkdirSync(join(npmGlobalDir, '@jaggerxtrm', 'pi-extensions', 'extensions', 'serena-pool'), { recursive: true });
      writeFileSync(serenaPoolPath, 'export async function ensureSerenaForRoot() { return 41234; }');
      process.env.PI_NPM_GLOBAL_DIR = npmGlobalDir;

      const session = await PiAgentSession.create({
        model: 'gemini',
        cwd: '/tmp/project',
        env: { SERENA_TEST_ENV: 'visible-to-hook' },
      });
      await session.start();

      // No helper subprocess is spawned for Serena and no port is injected.
      expect(mockExecFileSync).not.toHaveBeenCalled();
      const spawnOptions = mockSpawn.mock.calls[0][2] as { env?: NodeJS.ProcessEnv };
      expect(spawnOptions.env).not.toHaveProperty('SERENA_MCP_PORT');
      // Caller-provided env still flows through untouched.
      expect(spawnOptions.env).toEqual(expect.objectContaining({ SERENA_TEST_ENV: 'visible-to-hook' }));
    } finally {
      if (prevGlobalDir === undefined) delete process.env.PI_NPM_GLOBAL_DIR;
      else process.env.PI_NPM_GLOBAL_DIR = prevGlobalDir;
      if (prevSerenaPort === undefined) delete process.env.SERENA_MCP_PORT;
      else process.env.SERENA_MCP_PORT = prevSerenaPort;
      rmSync(npmGlobalDir, { recursive: true, force: true });
    }
  });

  it('starts package runner RPC sessions with Pi isolation flags', async () => {
    const session = await PiAgentSession.create({ model: 'gemini' });
    await session.start();

    const args: string[] = mockSpawn.mock.calls[0][1];
    expect(args).toEqual(expect.arrayContaining([
      '--offline',
      '--no-context-files',
      '--no-prompt-templates',
      '--no-themes',
    ]));
    expect(args.indexOf('--offline')).toBeGreaterThan(args.indexOf('--no-session'));
    expect(args.indexOf('--no-context-files')).toBeGreaterThan(args.indexOf('--offline'));
    expect(args.indexOf('--no-prompt-templates')).toBeGreaterThan(args.indexOf('--no-context-files'));
    expect(args.indexOf('--no-themes')).toBeGreaterThan(args.indexOf('--no-prompt-templates'));
  });

  it('omits retired service-skills injection even when directory exists', async () => {
    const homeDir = homedir();
    await withPiExtensionPaths([
      join(homeDir, '.pi', 'agent', 'extensions', 'quality-gates'),
      join(homeDir, '.pi', 'agent', 'extensions', 'service-skills'),
      join(homeDir, '.pi', 'agent', 'extensions', 'caveman'),
    ], async () => {
      const session = await PiAgentSession.create({
        model: 'gemini',
        permissionLevel: 'MEDIUM',
        extensionSources: ['npm:@jaggerxtrm/pi-service-knowledge@1.0.0', './local-extension'],
        offline: false,
      });
      await session.start();

      const args: string[] = mockSpawn.mock.calls[0][1];
      expect(args).not.toContain('--offline');
      const extensionPairs = args
        .map((arg, index) => (arg === '-e' ? args[index + 1] : null))
        .filter((value): value is string => Boolean(value));
      expect(extensionPairs).toContain(join(homeDir, '.pi', 'agent', 'extensions', 'quality-gates'));
      expect(extensionPairs).toContain(join(homeDir, '.pi', 'agent', 'extensions', 'caveman'));
      expect(extensionPairs).not.toContain(join(homeDir, '.pi', 'agent', 'extensions', 'service-skills'));
      expect(extensionPairs).toEqual(expect.arrayContaining([
        'npm:@jaggerxtrm/pi-service-knowledge@1.0.0',
        './local-extension',
      ]));
    });
  });

  it('keeps package runner system prompt appended instead of replacing Pi system prompt', async () => {
    const session = await PiAgentSession.create({ model: 'gemini', systemPrompt: 'specialist instructions' });
    await session.start();

    const args: string[] = mockSpawn.mock.calls.find(([, callArgs]) => (callArgs as string[]).includes('--append-system-prompt'))?.[1] as string[];
    expect(args).toBeDefined();
    expect(args).toContain('--append-system-prompt');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('specialist instructions');
    expect(args).not.toContain('--system-prompt');
  });

  it('uses --system-prompt when package runner systemPromptMode is replace', async () => {
    const session = await PiAgentSession.create({
      model: 'gemini',
      systemPrompt: 'specialist instructions',
      systemPromptMode: 'replace',
    });
    await session.start();

    const args: string[] = mockSpawn.mock.calls.find(([, callArgs]) => (callArgs as string[]).includes('--system-prompt'))?.[1] as string[];
    expect(args).toBeDefined();
    expect(args).toContain('--system-prompt');
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('specialist instructions');
    expect(args).not.toContain('--append-system-prompt');
  });

  it('prompt() does NOT close stdin', async () => {
    const session = await PiAgentSession.create({ model: 'gemini' });
    await session.start();
    const promptP = session.prompt('do the thing');
    emitLine(fake, { type: 'response', id: 1, success: true });
    await promptP;
    expect(fake.stdin.end).not.toHaveBeenCalled();
  });

  it('waitForDone(100) rejects with timeout error when agent_end never fires', async () => {
    const session = await PiAgentSession.create({ model: 'gemini' });
    await session.start();
    await expect(session.waitForDone(100)).rejects.toThrow(/timed out after 100ms/i);
  });

  it('stall timeout kills stalled session and rejects with StallTimeoutError', async () => {
    vi.useFakeTimers();
    try {
      const session = await PiAgentSession.create({ model: 'gemini', stallTimeoutMs: 50 });
      await session.start();
      const promptP = session.prompt('do work');
      emitLine(fake, { type: 'response', id: 1, success: true });
      await promptP;

      const done = session.waitForDone().catch((err) => err);
      await vi.advanceTimersByTimeAsync(60);

      const err = await done;
      expect(err).toBeInstanceOf(StallTimeoutError);
      expect(fake.proc.kill).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stall timeout resets when activity arrives', async () => {
    vi.useFakeTimers();
    try {
      const session = await PiAgentSession.create({ model: 'gemini', stallTimeoutMs: 50 });
      await session.start();
      const promptP = session.prompt('do work');
      emitLine(fake, { type: 'response', id: 1, success: true });
      await promptP;

      await vi.advanceTimersByTimeAsync(40);
      emitLine(fake, { type: 'turn_start' });
      await vi.advanceTimersByTimeAsync(40);
      expect(fake.proc.kill).not.toHaveBeenCalled();

      emitLine(fake, { type: 'agent_end', messages: [] });
      await expect(session.waitForDone()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('extends stall timeout for bash test commands', async () => {
    vi.useFakeTimers();
    try {
      const session = await PiAgentSession.create({
        model: 'gemini',
        stallTimeoutMs: 50,
        testCommandStallTimeoutMs: 200,
      });
      await session.start();
      const promptP = session.prompt('run tests');
      emitLine(fake, { type: 'response', id: 1, success: true });
      await promptP;

      emitLine(fake, {
        type: 'tool_execution_start',
        toolName: 'bash',
        toolCallId: 'tool-1',
        args: { command: 'bun --bun vitest run tests/unit/cli/run.test.ts' },
      });

      await vi.advanceTimersByTimeAsync(60);
      expect(fake.proc.kill).not.toHaveBeenCalled();

      const done = session.waitForDone().catch((err) => err);
      await vi.advanceTimersByTimeAsync(150);
      const err = await done;
      expect(err).toBeInstanceOf(StallTimeoutError);
      expect(fake.proc.kill).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores base stall timeout after bash test command ends', async () => {
    vi.useFakeTimers();
    try {
      const session = await PiAgentSession.create({
        model: 'gemini',
        stallTimeoutMs: 50,
        testCommandStallTimeoutMs: 200,
      });
      await session.start();
      const promptP = session.prompt('run tests');
      emitLine(fake, { type: 'response', id: 1, success: true });
      await promptP;

      emitLine(fake, {
        type: 'tool_execution_start',
        toolName: 'bash',
        toolCallId: 'tool-1',
        args: { command: 'npm test -- --runInBand' },
      });
      await vi.advanceTimersByTimeAsync(40);
      emitLine(fake, {
        type: 'tool_execution_end',
        toolName: 'bash',
        toolCallId: 'tool-1',
        isError: false,
        result: { content: [] },
      });

      const done = session.waitForDone().catch((err) => err);
      await vi.advanceTimersByTimeAsync(60);
      const err = await done;
      expect(err).toBeInstanceOf(StallTimeoutError);
      expect(fake.proc.kill).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('close clears stall watchdog timer', async () => {
    vi.useFakeTimers();
    try {
      const session = await PiAgentSession.create({ model: 'gemini', stallTimeoutMs: 50 });
      await session.start();
      const promptP = session.prompt('do work');
      emitLine(fake, { type: 'response', id: 1, success: true });
      await promptP;

      const closePromise = session.close();
      fake.procHandlers['close']?.(0);
      await closePromise;

      await vi.advanceTimersByTimeAsync(100);
      expect(fake.proc.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('close() calls stdin.end() and resolves when process exits', async () => {
    const session = await PiAgentSession.create({ model: 'gemini' });
    await session.start();

    const closePromise = session.close();

    // stdin.end() must be called synchronously when close() runs
    expect(fake.stdin.end).toHaveBeenCalled();

    // Simulate the OS closing the process (code 0)
    fake.procHandlers['close']?.(0);

    // close() should now resolve (no throw)
    await expect(closePromise).resolves.toBeUndefined();
  });

  it('resolver is default-on and LOW parity keeps native read', async () => {
    await withGitnexusInstall('0.6.1', async () => {
      const session = await PiAgentSession.create({ model: 'gemini', permissionLevel: 'LOW' });
      await session.start();

      const resolvedTools = getToolsArg(mockSpawn.mock.calls[0][1] as string[]);
      expect(resolvedTools).toBeDefined();
      expect(resolvedTools).toContain('gitnexus_query');
      expect(resolvedTools).toContain('bash');
      expect(resolvedTools).not.toMatch(/serena/i);
      const resolvedToolNames = resolvedTools.split(',');
      expect(resolvedToolNames).toContain('read');
      expect(resolvedToolNames).not.toContain('grep');
      expect(resolvedToolNames).not.toContain('find');
      expect(resolvedToolNames).not.toContain('ls');
    });
  });

  it('emits resolved --tools before injecting healthy GitNexus extension', async () => {
    await withGitnexusInstall('0.6.1', async npmGlobalDir => {
      const session = await PiAgentSession.create({ model: 'gemini', permissionLevel: 'LOW' });
      await session.start();

      const args: string[] = mockSpawn.mock.calls[0][1];
      const toolsIndex = args.indexOf('--tools');
      const extensionIndex = args.indexOf(join(npmGlobalDir, 'pi-gitnexus'));
      expect(toolsIndex).toBeGreaterThan(-1);
      expect(extensionIndex).toBeGreaterThan(toolsIndex);
      expect(getToolsArg(args)?.split(',')).toEqual(expect.arrayContaining(['read', 'bash', 'gitnexus_query']));
    });
  });

  it('loads exact GitNexus packagePath from available resolved tool contract', async () => {
    await withNpmGlobal(npmGlobalDir => {
      mkdirSync(join(npmGlobalDir, 'pi-gitnexus'), { recursive: true });
      writeFileSync(join(npmGlobalDir, 'pi-gitnexus', 'package.json'), JSON.stringify({ name: 'pi-gitnexus', version: '0.6.1' }));
      mkdirSync(join(npmGlobalDir, 'contract-gitnexus'), { recursive: true });
      writeFileSync(join(npmGlobalDir, 'contract-gitnexus', 'package.json'), JSON.stringify({ name: 'contract-gitnexus', version: '0.6.1' }));
    }, async npmGlobalDir => {
      const contractPackagePath = join(npmGlobalDir, 'contract-gitnexus');
      const session = await PiAgentSession.create({
        model: 'gemini',
        resolvedToolContract: {
          effectiveTier: 'LOW',
          toolsFlag: 'read,bash,gitnexus_query',
          toolsList: ['read', 'bash', 'gitnexus_query'],
          nativeTools: ['read', 'bash'],
          extensionTools: ['gitnexus_query'],
          deniedNativeTools: [],
          deniedNativesMode: 'soft',
          preferenceSignals: [],
          downgradeReasons: [],
          warnings: [],
          extensions: {
            gitnexus: {
              status: 'available',
              packageName: 'contract-gitnexus',
              packagePath: contractPackagePath,
              activeTools: ['gitnexus_query'],
            },
          },
        },
      });
      await session.start();

      const args: string[] = mockSpawn.mock.calls[0][1];
      expect(args).toContain(contractPackagePath);
      expect(args).not.toContain(join(npmGlobalDir, 'pi-gitnexus'));
      expect(getToolsArg(args)).toBe('read,bash,gitnexus_query');
    });
  });

  it('resolveRuntimeToolContract reports healthy extension state and exact --tools contract', async () => {
    await withGitnexusInstall('0.6.1', async () => {
      const contract = resolveRuntimeToolContract({ level: 'READ_ONLY' });
      expect(contract?.toolsFlag.split(',')).toEqual(expect.arrayContaining(['read', 'gitnexus_query', 'gitnexus_context']));
      expect(contract?.toolsFlag.split(',')).not.toContain('grep');
      expect(contract?.extensions.gitnexus?.status).toBe('available');
    });
  });

  it('resolveRuntimeToolContract reports disabled special case for bare-style opt-out', async () => {
    await withGitnexusInstall('0.6.1', async () => {
      const contract = resolveRuntimeToolContract({ level: 'READ_ONLY', excludeExtensions: ['pi-gitnexus'] });
      expect(contract?.toolsFlag).toBe('read,grep,find,ls');
      expect(contract?.extensions.gitnexus?.status).toBe('disabled');
      expect(contract?.downgradeReasons).toEqual(['restored native fallback for grep,find,ls due to disabled']);
    });
  });

  describe('extension tool exposure (unitAI-34pyf)', () => {
    /** Hermetic local extension source dir (no catalog involvement). */
    function makeExtensionDir(): { dir: string; cleanup: () => void } {
      const dir = mkdtempSync(join(tmpdir(), 'pi-ext-src-'));
      writeFileSync(join(dir, 'index.mjs'), 'export default function () {}\n');
      return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    }

    it('keeps the strict --tools allowlist when no extension source is enabled', () => {
      const contract = resolveRuntimeToolContract({ level: 'READ_ONLY' });
      expect(contract?.exposedExtensionSources).toEqual([]);
      expect(contract?.toolsFlag?.split(',')).toEqual(expect.arrayContaining(['read', 'grep', 'find', 'ls']));
    });

    it('lists exposed sources and preserves granted natives in the contract', () => {
      const { dir, cleanup } = makeExtensionDir();
      try {
        const contract = resolveRuntimeToolContract({ level: 'READ_ONLY', extensionSources: [dir] });
        expect(contract?.exposedExtensionSources).toEqual([dir]);
        // Native allowlist unchanged: read,grep,find,ls stay the granted set
        // (gitnexus not installed here, so hard deny cannot strip search).
        expect(contract?.nativeTools).toEqual(['read', 'grep', 'find', 'ls']);
      } finally {
        cleanup();
      }
    });

    it('emits the policy gate (--no-builtin-tools + policy -e last + bounded env) at spawn', async () => {
      const { dir, cleanup } = makeExtensionDir();
      try {
        const session = await PiAgentSession.create({
          model: 'gemini',
          permissionLevel: 'MEDIUM',
          extensionSources: [dir],
        });
        await session.start();
        const args: string[] = mockSpawn.mock.calls[0][1];
        // Strict allowlist is NOT passed (it would suppress extension tools);
        // the policy gate replaces it for sourced sessions.
        expect(args.indexOf('--tools')).toBe(-1);
        expect(args).toContain('--no-builtin-tools');
        const policyPath = getExtensionToolPolicyExtensionPath();
        expect(policyPath).toBeTruthy();
        expect(args[args.length - 1]).toBe(policyPath); // policy -e pair is LAST
        expect(args[args.length - 2]).toBe('-e');
        expect(args).toContain(dir); // configured source still -e'd
        // Bounded env channel carries exactly the granted natives.
        const spawnOptions = mockSpawn.mock.calls[0][2];
        expect(spawnOptions.env[NATIVE_TOOLS_ENV_KEY]).toBe('read,grep,find,ls,bash,edit');
      } finally {
        cleanup();
      }
    });

    it('passes hard-denied search tools out of the native allowlist channel', async () => {
      await withGitnexusInstall('0.6.1', async () => {
        const { dir, cleanup } = makeExtensionDir();
        try {
          const session = await PiAgentSession.create({
            model: 'gemini',
            permissionLevel: 'READ_ONLY',
            extensionSources: [dir],
          });
          await session.start();
          const spawnOptions = mockSpawn.mock.calls[0][2];
          expect(spawnOptions.env[NATIVE_TOOLS_ENV_KEY]).toBe('read');
          const args: string[] = mockSpawn.mock.calls[0][1];
          expect(args).toContain('--no-builtin-tools');
          expect(args.indexOf('--tools')).toBe(-1);
        } finally {
          cleanup();
        }
      });
    });

    it('forwards malformed sources as -e so Pi surfaces the load failure', async () => {
      const session = await PiAgentSession.create({
        model: 'gemini',
        permissionLevel: 'READ_ONLY',
        extensionSources: ['/nonexistent/missing-extension'],
      });
      await session.start();
      const args: string[] = mockSpawn.mock.calls[0][1];
      expect(args).toContain('/nonexistent/missing-extension');
      // The policy extension still loads after it; the session fails loudly
      // when Pi reports "Failed to load extension" for the bad source.
      const policyPath = getExtensionToolPolicyExtensionPath();
      expect(args[args.length - 1]).toBe(policyPath);
    });

    it('aborts launch when the policy artifact is missing and sources are exposed (hard fail)', async () => {
      // Simulate a broken installation: the bundled policy extension is
      // unresolvable. Launch must abort — never warn-and-continue with
      // --no-builtin-tools and no policy (which would leave extension tools
      // active without the granted native gate).
      vi.resetModules();
      vi.doMock('../../../src/pi/extension-tool-policy-extension.js', () => ({
        getExtensionToolPolicyExtensionPath: () => null,
        NATIVE_TOOLS_ENV_KEY: 'PI_SPECIALIST_ALLOWED_NATIVE_TOOLS',
      }));
      try {
        const { PiAgentSession: ReloadedSession } = await import('../../../src/pi/session.js');
        const session = await ReloadedSession.create({
          model: 'gemini',
          permissionLevel: 'READ_ONLY',
          extensionSources: ['/tmp/extension-source'],
        });
        await expect(session.start()).rejects.toThrow(/policy extension not found/);
        // No spawn is ever attempted for the broken gate.
        expect(mockSpawn).not.toHaveBeenCalled();
      } finally {
        vi.doUnmock('../../../src/pi/extension-tool-policy-extension.js');
        vi.resetModules();
      }
    });
  });

  it('suppresses GitNexus with unhealthy package metadata before --tools emission', async () => {
    await withNpmGlobal(npmGlobalDir => {
      mkdirSync(join(npmGlobalDir, 'pi-gitnexus'), { recursive: true });
      writeFileSync(join(npmGlobalDir, 'pi-gitnexus', 'package.json'), JSON.stringify({ name: 'pi-gitnexus' }));
    }, async npmGlobalDir => {
      const session = await PiAgentSession.create({ model: 'gemini', permissionLevel: 'LOW' });
      await session.start();

      const args: string[] = mockSpawn.mock.calls[0][1];
      expect(getToolsArg(args)?.split(',')).toEqual(['read', 'grep', 'find', 'ls', 'bash']);
      expect(args).not.toContain(join(npmGlobalDir, 'pi-gitnexus'));
    });
  });

  it('resolver LOW path keeps native read + GitNexus parity without Serena tools', async () => {
    await withGitnexusInstall('0.6.1', async () => {
      const session = await PiAgentSession.create({ model: 'gemini', permissionLevel: 'LOW' });
      await session.start();

      const args: string[] = mockSpawn.mock.calls[0][1];
      const toolsIdx = args.indexOf('--tools');
      expect(toolsIdx).toBeGreaterThan(-1);
      const tools = args[toolsIdx + 1].split(',');
      expect(tools).toEqual(expect.arrayContaining(['read', 'bash']));
      expect(tools).not.toContain('grep');
      expect(tools).not.toContain('find');
      expect(tools).not.toContain('ls');
      expect(tools).toEqual(expect.arrayContaining(['gitnexus_query', 'gitnexus_context', 'gitnexus_impact']));
      for (const tool of tools) {
        expect(tool).not.toMatch(/serena/i);
      }
      expect(tools).not.toContain('find_symbol');
      expect(tools).not.toContain('read_file');
      expect(tools).not.toContain('execute_shell_command');
      expect(tools).not.toContain('write');
    });
  });

  it("resolver READ_ONLY path honors explorer override and keeps native read", async () => {
    await withGitnexusInstall('0.6.1', async () => {
      const session = await PiAgentSession.create({
        model: 'gemini',
        permissionLevel: 'READ_ONLY',
        specialistName: 'explorer',
        specialistPermissions: {
          READ_ONLY: {
            denied_natives_when_extension: ['grep', 'find', 'ls'],
            denied_natives_mode: 'hard',
          },
        },
      });
      await session.start();

      const args: string[] = mockSpawn.mock.calls[0][1];
      const toolsIdx = args.indexOf('--tools');
      expect(toolsIdx).toBeGreaterThan(-1);
      const tools = args[toolsIdx + 1].split(',');
      expect(tools).toContain('gitnexus_query');
      expect(tools).toContain('read');
      expect(tools).not.toContain('grep');
      expect(tools).not.toContain('find');
      expect(tools).not.toContain('ls');
      expect(tools).not.toContain('find_file');
      expect(tools).not.toContain('search_for_pattern');
    });
  });

  it("mapPermissionToTools('HIGH') includes built-in write, native read, and GitNexus mutating tools, no Serena", async () => {
    await withGitnexusInstall('0.6.1', async () => {
      const session = await PiAgentSession.create({ model: 'gemini', permissionLevel: 'HIGH' });
      await session.start();

      const args: string[] = mockSpawn.mock.calls[0][1];
      const toolsIdx = args.indexOf('--tools');
      expect(toolsIdx).toBeGreaterThan(-1);
      const tools = args[toolsIdx + 1].split(',');
      expect(tools).toEqual(expect.arrayContaining(['read', 'bash', 'edit', 'write']));
      expect(tools).not.toContain('grep');
      expect(tools).not.toContain('find');
      expect(tools).not.toContain('ls');
      expect(tools).toEqual(expect.arrayContaining(['gitnexus_query', 'gitnexus_rename', 'gitnexus_cypher']));
      for (const tool of tools) {
        expect(tool).not.toMatch(/serena/i);
      }
      expect(tools).not.toContain('read_file');
      expect(tools).not.toContain('create_text_file');
      expect(tools).not.toContain('execute_shell_command');
    });
  });

  it('skips GitNexus when runtime contract is missing even if package is installed', async () => {
    const npmGlobalDir = mkdtempSync(join(tmpdir(), 'pi-npm-global-'));
    const prevGlobalDir = process.env.PI_NPM_GLOBAL_DIR;
    try {
      mkdirSync(join(npmGlobalDir, 'pi-gitnexus'), { recursive: true });
      writeFileSync(join(npmGlobalDir, 'pi-gitnexus', 'package.json'), JSON.stringify({ name: 'pi-gitnexus', version: '0.6.1' }));
      mkdirSync(join(npmGlobalDir, 'pi-serena-tools'), { recursive: true });
      process.env.PI_NPM_GLOBAL_DIR = npmGlobalDir;

      const session = await PiAgentSession.create({ model: 'gemini' });
      await session.start();

      const args: string[] = mockSpawn.mock.calls[0][1];
      expect(args).not.toContain(join(npmGlobalDir, 'pi-gitnexus'));
      expect(args).not.toContain(join(npmGlobalDir, 'pi-serena-tools'));
      expect(args.join(' ')).not.toMatch(/serena/i);
      expect(getToolsArg(args)).toBeUndefined();
    } finally {
      if (prevGlobalDir === undefined) delete process.env.PI_NPM_GLOBAL_DIR;
      else process.env.PI_NPM_GLOBAL_DIR = prevGlobalDir;
      rmSync(npmGlobalDir, { recursive: true, force: true });
    }
  });

  it('skips excluded npm extensions', async () => {
    const npmGlobalDir = mkdtempSync(join(tmpdir(), 'pi-npm-global-'));
    const prevGlobalDir = process.env.PI_NPM_GLOBAL_DIR;
    try {
      mkdirSync(join(npmGlobalDir, 'pi-gitnexus'), { recursive: true });
      writeFileSync(join(npmGlobalDir, 'pi-gitnexus', 'package.json'), JSON.stringify({ name: 'pi-gitnexus', version: '0.6.1' }));
      mkdirSync(join(npmGlobalDir, 'pi-serena-tools'), { recursive: true });
      process.env.PI_NPM_GLOBAL_DIR = npmGlobalDir;

      const session = await PiAgentSession.create({
        model: 'gemini',
        permissionLevel: 'LOW',
        // Legacy opt-out names remain accepted in the option; they simply have
        // no Serena extension to exclude anymore.
        excludeExtensions: ['pi-serena-tools', 'pi-gitnexus'],
      });
      await session.start();

      const args: string[] = mockSpawn.mock.calls[0][1];
      expect(args).not.toContain(join(npmGlobalDir, 'pi-gitnexus'));
      expect(args).not.toContain(join(npmGlobalDir, 'pi-serena-tools'));
      expect(args.join(' ')).not.toMatch(/serena/i);
      const tools = getToolsArg(args)?.split(',') ?? [];
      expect(tools).toEqual(expect.arrayContaining(['read', 'grep', 'find', 'ls', 'bash']));
      expect(tools).not.toContain('gitnexus_query');
    } finally {
      if (prevGlobalDir === undefined) delete process.env.PI_NPM_GLOBAL_DIR;
      else process.env.PI_NPM_GLOBAL_DIR = prevGlobalDir;
      rmSync(npmGlobalDir, { recursive: true, force: true });
    }
  });

  it('restores native fallbacks and suppresses GitNexus tools on catalog mismatch before --tools emission', async () => {
    const npmGlobalDir = mkdtempSync(join(tmpdir(), 'pi-npm-global-'));
    const prevGlobalDir = process.env.PI_NPM_GLOBAL_DIR;
    try {
      mkdirSync(join(npmGlobalDir, 'pi-gitnexus'), { recursive: true });
      writeFileSync(join(npmGlobalDir, 'pi-gitnexus', 'package.json'), JSON.stringify({ name: 'pi-gitnexus', version: '9.9.9' }));
      process.env.PI_NPM_GLOBAL_DIR = npmGlobalDir;

      const session = await PiAgentSession.create({ model: 'gemini', permissionLevel: 'LOW' });
      await session.start();

      const tools = getToolsArg(mockSpawn.mock.calls[0][1] as string[])?.split(',') ?? [];
      expect(tools).toEqual(expect.arrayContaining(['read', 'grep', 'find', 'ls', 'bash']));
      expect(tools).not.toContain('gitnexus_query');
    } finally {
      if (prevGlobalDir === undefined) delete process.env.PI_NPM_GLOBAL_DIR;
      else process.env.PI_NPM_GLOBAL_DIR = prevGlobalDir;
      rmSync(npmGlobalDir, { recursive: true, force: true });
    }
  });
});

// ── ID-mapped concurrent RPC dispatch tests ───────────────────────────────────
describe('sendCommand — concurrent dispatch', () => {
  let fake: ReturnType<typeof makeFakeProc>;

  beforeEach(() => {
    vi.clearAllMocks();
    fake = makeFakeProc();
  });

  it('concurrent sendCommand calls each get a unique id and resolve independently', async () => {
    const session = await PiAgentSession.create({ model: 'gemini' });
    await session.start();

    // Start two prompts concurrently (they won't complete until we emit responses)
    const p1 = session.prompt('first task');
    const p2 = session.prompt('second task');

    // Responses arrive out of order — id=2 resolves before id=1
    emitLine(fake, { type: 'response', id: 2, success: true });
    emitLine(fake, { type: 'response', id: 1, success: true });

    await Promise.all([p1, p2]);

    // Both writes contain their respective id fields
    const writes = fake.stdin.write.mock.calls.map((c: any[]) => JSON.parse(c[0]));
    const ids = writes.map((w: any) => w.id);
    expect(ids).toContain(1);
    expect(ids).toContain(2);
  });

  it('prompt() throws when response.success === false', async () => {
    const session = await PiAgentSession.create({ model: 'gemini' });
    await session.start();

    const p = session.prompt('bad task');
    emitLine(fake, { type: 'response', id: 1, success: false, error: 'already streaming' });

    await expect(p).rejects.toThrow('already streaming');
  });

  it('steer() throws when response.success === false', async () => {
    const session = await PiAgentSession.create({ model: 'gemini' });
    await session.start();

    const p = session.steer('redirect');
    emitLine(fake, { type: 'response', id: 1, success: false, error: 'steer rejected' });

    await expect(p).rejects.toThrow('steer rejected');
  });

  it('sendCommand rejects with timeout error when no response arrives', async () => {
    vi.useFakeTimers();
    try {
      const session = await PiAgentSession.create({ model: 'gemini' });
      await session.start();

      const p = session.prompt('task').catch((e) => e);
      await vi.advanceTimersByTimeAsync(11_000);
      await vi.runOnlyPendingTimersAsync();
      const err = await p;
      expect(err.message).toMatch(/RPC timeout/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects pending RPC immediately when child exits before responding (unitAI-u5xjk)', async () => {
    vi.useFakeTimers();
    try {
      const session = await PiAgentSession.create({ model: 'gemini' });
      await session.start();

      // Cold npm:/git: source resolution failure shape: the child exits with
      // the actionable npm error on stderr before answering command id=1.
      const p = session.prompt('task').catch((e) => e);
      fake.stderrHandlers['data']?.(Buffer.from('npm error: failed to resolve npm:pi-ast-grep\n'));
      fake.procHandlers['close']?.(1);

      // Fail-fast: rejected on child close, not after the 30s command timer.
      await vi.advanceTimersByTimeAsync(100);
      const err = await p;
      expect(err.message).toMatch(/pi process exited with code 1 before responding to RPC command/);
      expect(err.message).toContain('npm error: failed to resolve npm:pi-ast-grep');
    } finally {
      vi.useRealTimers();
    }
  });

  it('kill() rejects all pending RPC requests', async () => {
    const session = await PiAgentSession.create({ model: 'gemini' });
    await session.start();

    const p = session.prompt('task').catch((e) => e);
    session.kill();
    const err = await p;
    expect(err.message).toMatch(/killed/i);
  });

  it('stderr is accumulated and accessible via getStderr()', async () => {
    const session = await PiAgentSession.create({ model: 'gemini' });
    await session.start();

    fake.stderrHandlers['data']?.(Buffer.from('warning: something\n'));
    fake.stderrHandlers['data']?.(Buffer.from('error: details\n'));

    expect(session.getStderr()).toBe('warning: something\nerror: details\n');
  });

  it('getStderr() returns empty string when no stderr emitted', async () => {
    const session = await PiAgentSession.create({ model: 'gemini' });
    await session.start();
    expect(session.getStderr()).toBe('');
  });

  it('captures token usage metrics from agent_end payloads', async () => {
    const session = await PiAgentSession.create({ model: 'gemini' });
    await session.start();

    emitLine(fake, {
      type: 'agent_end',
      usage: {
        input_tokens: 10,
        output_tokens: 15,
        total_tokens: 25,
      },
      messages: [],
    });

    const metrics = session.getMetrics();
    expect(metrics.token_usage?.total_tokens).toBe(25);
    expect(metrics.token_usage?.input_tokens).toBe(10);
    expect(metrics.token_usage?.output_tokens).toBe(15);
  });

  it('captures token usage from assistant message usage format in turn_end and agent_end', async () => {
    const session = await PiAgentSession.create({ model: 'gemini' });
    await session.start();

    emitLine(fake, {
      type: 'turn_end',
      message: {
        role: 'assistant',
        usage: {
          input: 21,
          output: 13,
          cacheRead: 5,
          cacheWrite: 2,
          reasoning_tokens: 7,
          tool_tokens: 3,
        },
      },
    });

    emitLine(fake, {
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [], usage: { input: 30, output: 20 } }],
    });

    const metrics = session.getMetrics();
    expect(metrics.token_usage?.input_tokens).toBe(30);
    expect(metrics.token_usage?.output_tokens).toBe(20);
    expect(metrics.token_usage?.cache_read_tokens).toBe(5);
    expect(metrics.token_usage?.cache_creation_tokens).toBe(2);
    expect(metrics.token_usage?.total_tokens).toBe(50);
    expect(metrics.token_usage?.reasoning_tokens).toBe(7);
    expect(metrics.token_usage?.tool_tokens).toBe(3);
    expect(metrics.token_usage?.usage_source).toBe('provider_usage');
  });

  it('auto_compaction_start and auto_compaction_end both fire onEvent("auto_compaction")', async () => {
    const onEvent = vi.fn();
    const session = await PiAgentSession.create({ model: 'gemini', onEvent });
    await session.start();

    emitLine(fake, { type: 'auto_compaction_start' });
    emitLine(fake, { type: 'auto_compaction_end' });

    const calls = onEvent.mock.calls.map((c: any[]) => c[0]);
    expect(calls.filter((t: string) => t === 'auto_compaction_start')).toHaveLength(1);
    expect(calls.filter((t: string) => t === 'auto_compaction_end')).toHaveLength(1);
  });

  it('auto_retry_start and auto_retry_end both fire onEvent("auto_retry")', async () => {
    const onEvent = vi.fn();
    const session = await PiAgentSession.create({ model: 'gemini', onEvent });
    await session.start();

    emitLine(fake, { type: 'auto_retry_start' });
    emitLine(fake, { type: 'auto_retry_end' });

    const calls = onEvent.mock.calls.map((c: any[]) => c[0]);
    expect(calls.filter((t: string) => t === 'auto_retry_start')).toHaveLength(1);
    expect(calls.filter((t: string) => t === 'auto_retry_end')).toHaveLength(1);
  });
});

// ── ID dispatch edge cases ─────────────────────────────────────────────────────
describe('sendCommand — ID dispatch edge cases', () => {
  let fake: ReturnType<typeof makeFakeProc>;

  beforeEach(() => {
    vi.clearAllMocks();
    fake = makeFakeProc();
  });

  it('response with unknown ID is ignored — no crash', async () => {
    const session = await PiAgentSession.create({ model: 'gemini' });
    await session.start();

    // No pending request with id=999 — must not throw
    expect(() => {
      emitLine(fake, { type: 'response', id: 999, success: true });
    }).not.toThrow();
  });

  it('steer() resolves when pi responds with success=true', async () => {
    const session = await PiAgentSession.create({ model: 'gemini' });
    await session.start();

    const p = session.steer('redirect please');
    emitLine(fake, { type: 'response', id: 1, success: true });

    await expect(p).resolves.toBeUndefined();
  });

  it('non-timed-out concurrent request resolves despite sibling timeout', async () => {
    vi.useFakeTimers();
    try {
      const session = await PiAgentSession.create({ model: 'gemini' });
      await session.start();

      // p1 will time out (id=1), p2 resolves before the timeout
      const p1 = session.prompt('first').catch((e) => e);
      const p2 = session.prompt('second');

      // Respond to p2 immediately — it should be done before the timeout fires
      emitLine(fake, { type: 'response', id: 2, success: true });
      await expect(p2).resolves.toBeUndefined();

      // Advance past the 10s default timeout — only p1 should have timed out
      await vi.advanceTimersByTimeAsync(11_000);
      await vi.runOnlyPendingTimersAsync();
      const err1 = await p1;
      expect(err1.message).toMatch(/RPC timeout/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('timed-out request is cleaned from the pending map (late response causes no crash)', async () => {
    vi.useFakeTimers();
    try {
      const session = await PiAgentSession.create({ model: 'gemini' });
      await session.start();

      const p = session.prompt('task').catch((e) => e);
      await vi.advanceTimersByTimeAsync(11_000);
      await vi.runOnlyPendingTimersAsync();
      await p; // request has already rejected

      // Emit a response for the now-deleted entry — must not crash or double-resolve
      expect(() => {
        emitLine(fake, { type: 'response', id: 1, success: true });
      }).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('malformed JSONL line is silently skipped — no crash', async () => {
    const session = await PiAgentSession.create({ model: 'gemini' });
    await session.start();

    expect(() => {
      fake.stdoutHandlers['data']?.(Buffer.from('not valid json\n'));
    }).not.toThrow();
  });

  it('unknown event type is silently ignored — no crash', async () => {
    const onEvent = vi.fn();
    const session = await PiAgentSession.create({ model: 'gemini', onEvent });
    await session.start();

    expect(() => {
      emitLine(fake, { type: 'completely_unknown_event_xyz', payload: 42 });
    }).not.toThrow();

    // onEvent must not have been called with the unknown type
    expect(onEvent).not.toHaveBeenCalledWith('completely_unknown_event_xyz');
  });
});

// ── kill() behaviour ──────────────────────────────────────────────────────────
describe('kill()', () => {
  let fake: ReturnType<typeof makeFakeProc>;

  beforeEach(() => {
    vi.clearAllMocks();
    fake = makeFakeProc();
  });

  it('sends {type:"abort"} to stdin before calling proc.kill()', async () => {
    const session = await PiAgentSession.create({ model: 'gemini' });
    await session.start();

    const callOrder: string[] = [];
    fake.stdin.write.mockImplementation((_data: any, cb?: any) => {
      callOrder.push('write');
      cb?.();
      return true;
    });
    fake.proc.kill.mockImplementation(() => { callOrder.push('kill'); });

    session.kill();

    expect(callOrder).toEqual(['write', 'kill']);
    const writtenPayload = JSON.parse(fake.stdin.write.mock.calls[0][0]);
    expect(writtenPayload).toMatchObject({ type: 'abort' });
  });

  it('is idempotent — second call is a no-op', async () => {
    const session = await PiAgentSession.create({ model: 'gemini' });
    await session.start();

    session.kill();
    expect(() => session.kill()).not.toThrow();
    // proc.kill should only have been called once
    expect(fake.proc.kill).toHaveBeenCalledOnce();
  });

  it('kill() completes even when stdin write throws', async () => {
    const session = await PiAgentSession.create({ model: 'gemini' });
    await session.start();

    fake.stdin.write.mockImplementation(() => { throw new Error('pipe broken'); });

    expect(() => session.kill()).not.toThrow();
    expect(fake.proc.kill).toHaveBeenCalledOnce();
  });

  it('process close while requests are pending — pending requests are rejected by kill()', async () => {
    const session = await PiAgentSession.create({ model: 'gemini' });
    await session.start();

    const p = session.prompt('task').catch((e) => e);

    // Simulate the process dying abruptly via kill()
    session.kill();

    const err = await p;
    expect(err.message).toMatch(/killed/i);
  });
});

// ── python-kernel double-load dedup (unitAI-il2io) ────────────────────────────
describe('deduplicateExtensionSources (unitAI-il2io)', () => {
  it('drops a directory-form duplicate of the managed python-kernel file copy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'py-kernel-dir-'));
    try {
      const extDir = join(dir, 'extensions', 'python-kernel');
      mkdirSync(extDir, { recursive: true });
      const indexFile = join(extDir, 'index.ts');
      writeFileSync(indexFile, 'export default function () {}\n');
      const { kept, dropped } = deduplicateExtensionSources([indexFile], [extDir]);
      expect(kept).toEqual([]);
      expect(dropped).toEqual([{ dropped: extDir, keptAs: indexFile }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops exact duplicate strings and keeps distinct plus remote sources', () => {
    const { kept, dropped } = deduplicateExtensionSources(
      ['/ext/managed'],
      ['/ext/managed', '/ext/other', 'npm:@scope/pkg@1.0.0', 'npm:@scope/pkg@1.0.0'],
    );
    expect(kept).toEqual(['/ext/other', 'npm:@scope/pkg@1.0.0']);
    expect(dropped.map((d) => d.dropped)).toEqual(['/ext/managed', 'npm:@scope/pkg@1.0.0']);
  });

  it('drops a symlinked dev-checkout duplicate of the managed copy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'py-kernel-link-'));
    try {
      const managedDir = join(dir, 'managed', 'extensions', 'python-kernel');
      mkdirSync(managedDir, { recursive: true });
      const managedIndex = join(managedDir, 'index.ts');
      writeFileSync(managedIndex, 'export default function () {}\n');
      const devLink = join(dir, 'dev-python-kernel');
      symlinkSync(managedDir, devLink);
      const { kept, dropped } = deduplicateExtensionSources([managedIndex], [devLink]);
      expect(kept).toEqual([]);
      expect(dropped).toEqual([{ dropped: devLink, keptAs: managedIndex }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('start() forwards the managed python-kernel once and logs the dropped dev copy', async () => {
    vi.clearAllMocks();
    const npmGlobalDir = mkdtempSync(join(tmpdir(), 'pi-npm-global-pykernel-'));
    const prevGlobalDir = process.env.PI_NPM_GLOBAL_DIR;
    const fake = makeFakeProc();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true as unknown as boolean);
    try {
      const managedDir = join(npmGlobalDir, '@jaggerxtrm', 'pi-extensions', 'extensions', 'python-kernel');
      mkdirSync(managedDir, { recursive: true });
      const managedIndex = join(managedDir, 'index.ts');
      writeFileSync(managedIndex, 'export default function () {}\n');
      const devDir = mkdtempSync(join(tmpdir(), 'py-kernel-dev-'));
      try {
        const devExtDir = join(devDir, 'python-kernel');
        mkdirSync(devExtDir, { recursive: true });
        writeFileSync(join(devExtDir, 'index.ts'), 'export default function () {}\n');
        // Distinct dev copy (different inode): same tool, different path.
        // Unit-level identity differs here; the spawn-level assertion below
        // covers the same-file/symlink case via a linked dev path.
        const linkedDev = join(devDir, 'linked-python-kernel');
        symlinkSync(managedDir, linkedDev);

        process.env.PI_NPM_GLOBAL_DIR = npmGlobalDir;
        __resetPiExtensionsPythonKernelPathCacheForTest();

        const session = await PiAgentSession.create({
          model: 'gemini',
          permissionLevel: 'MEDIUM',
          extensionSources: [linkedDev, 'npm:@jaggerxtrm/pi-service-knowledge@1.0.0'],
        });
        await session.start();

        const args: string[] = mockSpawn.mock.calls[0][1];
        const extensionPairs = args
          .map((arg, index) => (arg === '-e' ? args[index + 1] : null))
          .filter((value): value is string => Boolean(value));
        expect(extensionPairs).toContain(managedIndex);
        expect(extensionPairs).not.toContain(linkedDev);
        expect(extensionPairs).toContain('npm:@jaggerxtrm/pi-service-knowledge@1.0.0');
        const logged = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
        expect(logged).toContain('DEDUP');
        expect(logged).toContain(linkedDev);
        expect(logged).toContain(managedIndex);
        expect(fake).toBeDefined();
      } finally {
        rmSync(devDir, { recursive: true, force: true });
      }
    } finally {
      stderrSpy.mockRestore();
      __resetPiExtensionsPythonKernelPathCacheForTest();
      if (prevGlobalDir === undefined) delete process.env.PI_NPM_GLOBAL_DIR;
      else process.env.PI_NPM_GLOBAL_DIR = prevGlobalDir;
      rmSync(npmGlobalDir, { recursive: true, force: true });
    }
  });
});
