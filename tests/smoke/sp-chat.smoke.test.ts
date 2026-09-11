// ISSUE: xtrm-wiy5n.4.11 — quarantined from the default test baseline.
import { afterAll, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const transcriptDir = mkdtempSync(join(tmpdir(), 'sp-chat-smoke-'));
const createdBeads = new Set<string>();
const createdJobs = new Set<string>();

afterAll(() => {
  for (const jobId of createdJobs) {
    try {
      spawnSync('bun', ['run', join(repoRoot, 'src/index.ts'), 'stop', jobId], {
        cwd: repoRoot,
        stdio: 'ignore',
        env: { ...process.env, NO_COLOR: '1' },
      });
    } catch {}
  }
  for (const beadId of createdBeads) {
    try {
      spawnSync('bd', ['close', beadId, '-r', 'smoke cleanup'], {
        cwd: repoRoot,
        stdio: 'ignore',
        env: { ...process.env, NO_COLOR: '1' },
      });
    } catch {}
  }
  try {
    rmSync(transcriptDir, { recursive: true, force: true });
  } catch {}
}, 30000);

function runCli(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('bun', ['run', join(repoRoot, 'src/index.ts'), ...args], {
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', rejectRun);
    child.once('close', (status) => resolveRun({ status: status ?? 1, stdout, stderr }));
  });
}

function createBead(title: string): string {
  const result = spawnSync('bd', ['create', title, '-t', 'task', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  expect(result.status).toBe(0);
  const parsed = JSON.parse(result.stdout.trim()) as { id?: string } | Array<{ id?: string }>;
  const beadId = Array.isArray(parsed) ? parsed[0]?.id : parsed.id;
  if (!beadId) throw new Error(`bd create returned no bead id: ${result.stdout}`);
  createdBeads.add(beadId);
  return beadId;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function readTranscript(path: string): string {
  return readFileSync(path, 'utf8');
}

function extractJobId(text: string, beadId: string): string | null {
  const beadMarker = `"bead_id":"${beadId}"`;
  const beadIndex = text.indexOf(beadMarker);
  if (beadIndex < 0) return null;
  const jobMatch = text.slice(Math.max(0, beadIndex - 2000), beadIndex + 2000).match(/"job_id":"([^"]+)"/);
  return jobMatch?.[1] ?? null;
}

function findJobIdForBead(beadId: string): string | null {
  const result = spawnSync('bun', ['run', join(repoRoot, 'src/index.ts'), 'ps', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  expect(result.status).toBe(0);
  const jobId = extractJobId(result.stdout, beadId);
  if (jobId) createdJobs.add(jobId);
  return jobId;
}

function rememberOpenBeadsByTitle(title: string): void {
  const result = spawnSync('bd', ['list', '--status=open', '--json', '--limit', '0'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  if (result.status !== 0) return;
  const rows = JSON.parse(result.stdout || '[]') as Array<{ id?: string; title?: string }>;
  for (const row of rows) {
    if (row.id && row.title === title) createdBeads.add(row.id);
  }
}

async function runChatSmoke(options: { beadId: string; preload?: string }): Promise<{ exitCode: number; output: string; transcript: string }> {
  const transcriptPath = join(transcriptDir, `sp-chat-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
  const command = [
    'bun',
    ...(options.preload ? ['--preload', options.preload] : []),
    join(repoRoot, 'src/index.ts'),
    'chat',
    'reviewer',
    '--bead',
    options.beadId,
  ].join(' ');

  const session = spawn('script', ['-qfec', command, transcriptPath], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', TERM: 'xterm-256color' },
  });

  let combined = '';
  session.stdout.setEncoding('utf8');
  session.stderr.setEncoding('utf8');
  session.stdout.on('data', (chunk) => {
    combined += chunk;
  });
  session.stderr.on('data', (chunk) => {
    combined += chunk;
  });
  const closed = new Promise<number>((resolveExit) => {
    session.once('close', (code) => resolveExit(code ?? 1));
  });

  await wait(1500);
  session.stdin.write('hello from smoke\n');
  await wait(1000);
  session.stdin.write('/notes hello\n');
  await wait(1000);
  session.stdin.write('\u0003');
  session.kill('SIGINT');

  const exitCode = await Promise.race([
    closed,
    wait(8000).then(() => 124),
  ]);
  const transcript = readTranscript(transcriptPath);
  return { exitCode, output: `${combined}\n${transcript}`, transcript };
}

async function runChatSmokeWithoutBead(prompt: string): Promise<{ exitCode: number; output: string; transcript: string }> {
  const transcriptPath = join(transcriptDir, `sp-chat-ephemeral-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
  const command = [
    'bun',
    join(repoRoot, 'src/index.ts'),
    'chat',
    'reviewer',
    '--prompt',
    prompt,
  ].join(' ');

  const session = spawn('script', ['-qfec', command, transcriptPath], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', TERM: 'xterm-256color' },
  });

  let combined = '';
  session.stdout.setEncoding('utf8');
  session.stderr.setEncoding('utf8');
  session.stdout.on('data', (chunk) => {
    combined += chunk;
  });
  session.stderr.on('data', (chunk) => {
    combined += chunk;
  });
  const closed = new Promise<number>((resolveExit) => {
    session.once('close', (code) => resolveExit(code ?? 1));
  });

  await wait(1500);
  session.stdin.write('hello from smoke\n');
  await wait(1000);
  session.stdin.write('\u0003');
  session.kill('SIGINT');

  const exitCode = await Promise.race([
    closed,
    wait(8000).then(() => 124),
  ]);
  const transcript = readTranscript(transcriptPath);
  const output = `${combined}\n${transcript}`;
  const ephemeralMatch = output.match(/ephemeral bead .*?\((unitAI-[^)]+)\)/);
  if (ephemeralMatch?.[1]) createdBeads.add(ephemeralMatch[1]);
  rememberOpenBeadsByTitle(prompt.slice(0, 60));
  return { exitCode, output, transcript };
}

test('sp chat reviewer smoke', async () => {
  const beadId = createBead(`unitAI-smoke-${Date.now()}`);
  const result = await runChatSmoke({ beadId });

  expect(result.exitCode).toBe(0);
  expect(result.output).toContain(beadId);
  expect(result.output).not.toContain('chat: launching reviewer');
  expect(result.output).not.toContain('stderr:');
  expect(result.output).not.toContain('assistant:');
  expect(result.output).not.toContain('Running reviewer');
  expect(result.output).not.toContain('[job started:');
  expect(result.output).toMatch(/> (?:\x1b_pi:c\x07)?\x1b\[7m/);
  expect(result.output).toMatch(/\x1b\[\?2026[hl]|\x1b\[\?25[hl]/);

  const bead = spawnSync('bd', ['show', beadId], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  expect(bead.status).toBe(0);
}, 30000);

test('sp chat reviewer smoke without bead', async () => {
  const prompt = 'test prompt for ephemeral bead';
  const expectedTitle = prompt.slice(0, 60);
  const result = await runChatSmokeWithoutBead(prompt);

  expect(result.exitCode).toBe(0);
  expect(result.output).toContain(expectedTitle);
  expect(result.output).not.toContain('chat: ephemeral bead');
}, 30000);

test('sp chat cleanup still fires on induced TUI crash', async () => {
  const beadId = createBead(`unitAI-smoke-crash-${Date.now()}`);
  const preloadPath = join(transcriptDir, 'chat-crash.preload.ts');
  writeFileSync(preloadPath, `
import { ChatStatus } from ${JSON.stringify(join(repoRoot, 'src/cli/chat/status.js'))};
const original = ChatStatus.prototype.render;
ChatStatus.prototype.render = function renderCrash(width: number): string {
  if (width > 0) throw new Error('intentional smoke crash');
  return original.call(this, width);
};
`);

  const result = await runChatSmoke({ beadId, preload: preloadPath });
  expect([0, 1]).toContain(result.exitCode);

  const bead = spawnSync('bd', ['show', beadId], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  expect(bead.status).toBe(0);
}, 30000);
