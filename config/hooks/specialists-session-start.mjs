#!/usr/bin/env node
// specialists-session-start — Claude Code SessionStart hook
// Injects specialists context at the start of every session:
//   • Active background jobs (if any)
//   • Available specialists list
//   • Key CLI commands reminder
//
// Installed by: specialists init
// Hook type: SessionStart
//
// NOT superseded by the substrate plugin's SessionStart hook, despite the earlier
// deprecation note (unitAI-aiwva.15). The two report DISJOINT state and neither can
// replace the other: this hook covers CLI background jobs (`sp run` child processes with
// a pid), the available-specialist registry and the command reference; the plugin hook
// covers native in-process activations from ~/.xtrm/state.db. Removing this one deletes
// CLI visibility entirely rather than de-duplicating anything.

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
lines.push('MCP tools (substrate plugin): specialist_dispatch, specialist_status, specialist_reply,');
lines.push('  specialist_resume, specialist_stop_activation, specialist_list. use_specialist is the');
lines.push('  deprecated foreground path — it runs a bead specialist_dispatch would refuse.');
lines.push('');

// ── 4. Hot tips (version-pinned, current sp release) ───────────────────────
const spVersion = readSpecialistsVersion();
lines.push(`## Specialists — Hot Tips (sp v${spVersion})`);
lines.push('');
lines.push('- `--bead` on edit-capable specialists auto-provisions worktree');
lines.push('- Reviewer enters with `--job <exec-job>`; `--worktree`/`--job` exclusive');
lines.push('- Merge is MANUAL: `git merge --no-ff feature/<bead>`. `sp merge`/`sp epic merge` are prohibited');
lines.push('- `sp ps`/`sp feed`/`sp result`');
lines.push('- `--keep-alive` required so reviewer/overthinker can be `sp resume`d');
lines.push('- Close keep-alive jobs explicitly with `sp stop <job-id>`; there is no finalize cascade');

// ── Output ─────────────────────────────────────────────────────────────────
if (lines.length === 0) process.exit(0);

process.stdout.write(JSON.stringify({
  type: 'inject',
  content: lines.join('\n'),
}) + '\n');
