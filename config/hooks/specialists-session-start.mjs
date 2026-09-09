#!/usr/bin/env node
// DEPRECATED (Wave E1, bead unitAI-aiwva.2): superseded by the Substrate plugin hook
// plugins/substrate/scripts/session-start.mjs, which reads Substrate state instead of
// scanning <cwd>/.specialists/jobs. The plugin hook is authoritative where installed.
// Removal tracked in bead unitAI-aiwva.15. Do not extend this file.
// specialists-session-start — Claude Code SessionStart hook
// Injects specialists context at the start of every session:
//   • Active background jobs (if any)
//   • Available specialists list
//   • Key CLI commands reminder
//
// Installed by: specialists init
// Hook type: SessionStart

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const cwd     = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const HOME    = homedir();
const jobsDir = join(cwd, '.specialists', 'jobs');
const lines   = [];

// Resolve specialists package version for hot-tips header.
function readSpecialistsVersion() {
  // Walk up from this hook's location looking for package.json with name=@jaggerxtrm/specialists or name=specialists.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const j = JSON.parse(readFileSync(pkg, 'utf-8'));
        if (j?.name && j.name.includes('specialists')) return j.version ?? 'unknown';
      } catch { /* skip */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'unknown';
}

// ── 1. Active background jobs ──────────────────────────────────────────────
if (existsSync(jobsDir)) {
  let entries = [];
  try { entries = readdirSync(jobsDir); } catch { /* ignore */ }

  const activeJobs = [];
  for (const jobId of entries) {
    const statusPath = join(jobsDir, jobId, 'status.json');
    if (!existsSync(statusPath)) continue;
    try {
      const s = JSON.parse(readFileSync(statusPath, 'utf-8'));
      if (s.status === 'running' || s.status === 'starting') {
        const elapsed = s.elapsed_s !== undefined ? ` (${s.elapsed_s}s)` : '';
        activeJobs.push(
          `  • ${s.specialist ?? jobId}  [${s.status}]${elapsed}  →  specialists result ${jobId}`
        );
      }
    } catch { /* malformed status.json */ }
  }

  if (activeJobs.length > 0) {
    lines.push('## Specialists — Active Background Jobs');
    lines.push('');
    lines.push(...activeJobs);
    lines.push('');
    lines.push('Use `specialists feed <job-id> --follow` to stream events, or `specialists result <job-id>` when done.');
    lines.push('');
  }
}

// ── 2. Available specialists (read YAML dirs directly) ────────────────────
function readSpecialistNames(dir) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.specialist.yaml'))
      .map(f => f.replace('.specialist.yaml', ''));
  } catch {
    return [];
  }
}

const projectNames = readSpecialistNames(join(cwd, 'specialists'));
const userNames    = readSpecialistNames(join(HOME, '.agents', 'specialists'));

// Merge, deduplicate, sort
const allNames = [...new Set([...projectNames, ...userNames])].sort();

if (allNames.length > 0) {
  lines.push('## Specialists — Available');
  lines.push('');
  if (projectNames.length > 0) {
    lines.push(`project (${projectNames.length}): ${projectNames.join(', ')}`);
  }
  if (userNames.length > 0) {
    // Only show user-scope names not already in project
    const extraUser = userNames.filter(n => !projectNames.includes(n));
    if (extraUser.length > 0) {
      lines.push(`user    (${extraUser.length}): ${extraUser.join(', ')}`);
    }
  }
  lines.push('');
}

// ── 3. Key commands reminder ───────────────────────────────────────────────
lines.push('## Specialists — Session Quick Reference');
lines.push('');
lines.push('```');
lines.push('specialists list                                   # discover available specialists');
lines.push('specialists run <name> --prompt "..."              # run foreground (streams output)');
lines.push('specialists run <name> --prompt "..."              # run; job ID prints on stderr');
lines.push('specialists feed <job-id> --follow                 # tail live events');
lines.push('specialists result <job-id>                        # read final output');
lines.push('specialists status                                 # system health');
lines.push('specialists doctor                                 # troubleshoot issues');
lines.push('```');
lines.push('');
lines.push('MCP tools: use_specialist (foreground only)');
lines.push('');

// ── 4. Hot tips (version-pinned, current sp release) ───────────────────────
const spVersion = readSpecialistsVersion();
lines.push(`## Specialists — Hot Tips (sp v${spVersion})`);
lines.push('');
lines.push('- `--bead` on edit-capable specialists auto-provisions worktree');
lines.push('- Reviewer enters with `--job <exec-job>`; `--worktree`/`--job` exclusive');
lines.push('- `sp epic merge <epic>` for epic chains; `sp merge <chain>` for standalone');
lines.push('- `sp ps`/`sp feed`/`sp result`');
lines.push('- `--keep-alive` required so reviewer/overthinker can be `sp resume`d');
lines.push('- `sp merge` fails after `sp stop` cleans status.json — see unitAI-ofjvj');

// ── Output ─────────────────────────────────────────────────────────────────
if (lines.length === 0) process.exit(0);

process.stdout.write(JSON.stringify({
  type: 'inject',
  content: lines.join('\n'),
}) + '\n');
