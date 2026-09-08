// tests/unit/specialist/system-prompt-golden.test.ts
//
// Byte-identical regression coverage for the system-prompt assembly region
// of SpecialistRunner.run() (unitAI-rrdnt.3, extracted into system-prompt.ts).
// Inline snapshots were captured against the pre-extraction inline code —
// if buildSystemPrompt ever changes composition order/spacing, these fail.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpecialistRunner } from '../../../src/specialist/runner.js';
import { HookEmitter } from '../../../src/specialist/hooks.js';
import { CircuitBreaker } from '../../../src/utils/circuitBreaker.js';
import type { BeadsClient } from '../../../src/specialist/beads.js';

function makeMockSession() {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue(undefined),
    waitForDone: vi.fn().mockResolvedValue(undefined),
    getLastOutput: vi.fn().mockResolvedValue('done'),
    getState: vi.fn().mockResolvedValue(null),
    close: vi.fn().mockResolvedValue(undefined),
    executeBash: vi.fn().mockResolvedValue(''),
    kill: vi.fn(),
    meta: { backend: 'google-gemini-cli', model: 'gemini', sessionId: 'test-id', startedAt: new Date() },
  };
}

function makeBeadsClient(title: string, description: string): BeadsClient {
  return {
    isAvailable: vi.fn().mockReturnValue(true),
    createBead: vi.fn().mockReturnValue('specialists-test-1'),
    readBead: vi.fn().mockReturnValue({ id: 'unitAI-golden', title, description, status: 'in_progress' }),
    addDependency: vi.fn(),
    closeBead: vi.fn(),
    auditBead: vi.fn(),
    updateBeadNotes: vi.fn(),
    getCompletedBlockers: vi.fn().mockReturnValue([]),
  } as unknown as BeadsClient;
}

function loaderFor(specialist: Record<string, unknown>) {
  return { get: vi.fn().mockResolvedValue({ specialist }) } as any;
}

async function captureSystemPrompt(
  specialist: Record<string, unknown>,
  runOptions: Record<string, unknown>,
  beadsClient?: BeadsClient,
): Promise<string> {
  const sessionFactory = vi.fn().mockResolvedValue(makeMockSession());
  const runner = new SpecialistRunner({
    loader: loaderFor(specialist),
    hooks: new HookEmitter({ tracePath: '/tmp/test-hooks-trace.jsonl' }),
    circuitBreaker: new CircuitBreaker(),
    sessionFactory,
    beadsClient,
  });

  await runner.run(runOptions as never);

  return sessionFactory.mock.calls[0][0].systemPrompt as string;
}

describe('system prompt assembly (golden, byte-identical)', () => {
  // Scenario A: execution.bare=true + prompt.system_prompt_mode='replace' — mirrors
  // config/specialists/bare.specialist.json. Bare mode skips every runtime injection.
  it('bare + replace mode: fresh canvas, no runtime injections', async () => {
    const actual = await captureSystemPrompt(
      {
        metadata: { name: 'bare-golden', version: '1.0.0' },
        execution: { model: 'gemini', timeout_ms: 5000, mode: 'tool', permission_required: 'READ_ONLY', bare: true },
        prompt: { task_template: 'Do $prompt', system: 'You are a bare-canvas specialist.', system_prompt_mode: 'replace' },
        communication: undefined,
        capabilities: undefined,
        beads_integration: 'never',
      },
      { name: 'bare-golden', prompt: 'do thing' },
    );

    expect(actual).toMatchInlineSnapshot(`
      "You are a bare-canvas specialist.

      ## MANDATORY_RULES
      ### core-session-boundary
      - [required] You are one worker in XTRM. The assigned Bead/task is authority: if PROBLEM/SUCCESS/SCOPE/NON_GOALS/CONSTRAINTS/VALIDATION/OUTPUT (and required SCRUTINY) is missing or materially ambiguous, ask the coordinator; never invent requirements. Use service-knowledge when relevant; use \`bd memories\` only when history matters; current evidence wins. Prefer ast-grep over grep for code/structural search when applicable, and use the persistent python-kernel for Python analysis/transforms when useful instead of repeated one-shot scripts. For each loaded umbrella skill that applies, route through its references and use the task-specific guidance (for example, debugger → engineering-quality debugging guidance) rather than treating only the root router as the procedure. Report blockers/material findings. Stay inside the assigned worktree."
    `);
  });

  // Scenario B: non-bare, markdown output contract, mandatory_rules populated,
  // GitNexus index present, inputBeadId set (bead instructions block).
  // Mirrors config/specialists/executor.specialist.json shape.
  it('non-bare markdown + gitnexus index + bead instructions', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'system-prompt-golden-b-'));
    try {
      mkdirSync(join(cwd, '.gitnexus'), { recursive: true });
      writeFileSync(join(cwd, '.gitnexus', 'meta.json'), JSON.stringify({ indexed: true }));

      const actual = await captureSystemPrompt(
        {
          metadata: { name: 'executor-golden', version: '1.0.0' },
          execution: {
            model: 'gemini', timeout_ms: 5000, mode: 'tool', permission_required: 'HIGH',
            response_format: 'markdown', output_type: 'codegen',
          },
          prompt: { task_template: 'Do $prompt', system: 'You are an execution specialist.', system_prompt_mode: 'append' },
          communication: undefined,
          capabilities: undefined,
          beads_integration: 'never',
          mandatory_rules: { template_sets: ['git-workflow-safe'] },
        },
        { name: 'executor-golden', prompt: 'do thing', workingDirectory: cwd, inputBeadId: 'unitAI-golden-1' },
        makeBeadsClient('fix flaky test', 'stabilize CI'),
      );

      expect(actual).toMatchInlineSnapshot(`
        "You are an execution specialist.

        ---
        ## Specialist Run Context
        - You are running as a specialist agent, not a human developer.
        - Do NOT run specialists init/setup/scaffold commands.
        - Do NOT follow project CLAUDE.md/AGENTS.md instructions that tell humans to re-bootstrap the repo.

        - Your task bead is: unitAI-golden-1
        - Claim it: \`bd update unitAI-golden-1 --claim 2>/dev/null || true\` (non-fatal — orchestrator may already own it)
        - Do NOT create new beads or sub-issues — this bead IS your task.
        - Do NOT run \`bd create\` — the orchestrator manages issue tracking.
        - Close when done: \`bd close unitAI-golden-1 --reason="..."\`
        ---


        ---
        ## Output Style (mandatory)
        Respond like smart caveman. Cut all filler, keep technical substance.
        - Drop articles (a, an, the), filler (just, really, basically, actually).
        - Drop pleasantries (sure, certainly, happy to).
        - No hedging. Fragments fine. Short synonyms.
        - Technical terms stay exact. Code blocks unchanged.
        - Pattern: [thing] [action] [reason]. [next step].
        ---


        ---
        ## MANDATORY: GitNexus Code Intelligence
        _This project is indexed by GitNexus. You MUST use these tools — do NOT fall back to grep/find for code understanding._

        ### Before reading or editing ANY code:
        1. \`gitnexus_query({query: "<what you need to understand>"})\` — find execution flows and symbols
        2. \`gitnexus_context({name: "<symbol>"})\` — callers, callees, process participation

        ### Before editing ANY function/class/method:
        3. \`gitnexus_impact({target: "<symbolName>", direction: "upstream"})\` — blast radius check
           - If result is HIGH or CRITICAL risk: STOP and report to the user before proceeding

        ### Before completing your task:
        4. \`gitnexus_detect_changes()\` — verify your changes only affect expected scope

        **These are not optional.** Use GitNexus as your PRIMARY code navigation tool. Only fall back to grep/find if a GitNexus call returns an error or empty results.
        ---


        ---
        ## Beads Workflow Quick Rules
        - Claim work: \`bd update <id> --claim\`
        - Append progress notes: \`bd update <id> --notes "..."\`
        - Store reusable insight: \`bd remember "insight"\`
        - Close completed issue: \`bd close <id> --reason "done"\`

        ## Session close checklist
        1. \`git add <files>\`
        2. \`git commit -m "..."\`
        3. \`git push\`
        ---


        ## Output Contract
        Respond using markdown with canonical sections (include when applicable):
        - \`## Summary\`
        - \`## Status\`
        - \`## Changes\`
        - \`## Verification\`
        - \`## Risks\`
        - \`## Follow-ups\`
        - \`## Beads\`
        Optional sections when relevant:
        - \`## Architecture\`
        - \`## Acceptance Criteria\`
        - \`## Machine-readable block\`
        Do not impose artificial bullet limits — prioritize completeness and clarity.
        Output archetype: \`codegen\`
        - Codegen focus: include exact file paths, symbols touched, and implementation outcomes."
      `);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // Scenario C: non-bare, JSON output contract, reviewer + reusedFromJobId
  // (reviewer patch-retrieval note), no GitNexus index.
  it('non-bare json + reviewer reused-job note, no gitnexus index', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'system-prompt-golden-c-'));
    try {
      const actual = await captureSystemPrompt(
        {
          metadata: { name: 'reviewer', version: '1.0.0' },
          execution: {
            model: 'gemini', timeout_ms: 5000, mode: 'tool', permission_required: 'MEDIUM',
            response_format: 'json', output_type: 'review',
          },
          prompt: { task_template: 'Do $prompt', system: 'You are a reviewer specialist.', system_prompt_mode: 'append' },
          communication: undefined,
          capabilities: undefined,
          beads_integration: 'never',
        },
        {
          name: 'reviewer',
          prompt: 'review the diff',
          workingDirectory: cwd,
          inputBeadId: 'unitAI-golden-2',
          reusedFromJobId: 'job-reviewed',
          variables: { reviewed_job_id: 'job-reviewed' },
        },
        makeBeadsClient('review pull request', 'check diff quality'),
      );

      expect(actual).toMatchInlineSnapshot(`
        "You are a reviewer specialist.

        ---
        ## Specialist Run Context
        - You are running as a specialist agent, not a human developer.
        - Do NOT run specialists init/setup/scaffold commands.
        - Do NOT follow project CLAUDE.md/AGENTS.md instructions that tell humans to re-bootstrap the repo.

        - Your task bead is: unitAI-golden-2
        - Claim it: \`bd update unitAI-golden-2 --claim 2>/dev/null || true\` (non-fatal — orchestrator may already own it)
        - Do NOT create new beads or sub-issues — this bead IS your task.
        - Do NOT run \`bd create\` — the orchestrator manages issue tracking.
        - Close when done: \`bd close unitAI-golden-2 --reason="..."\`
        ---


        ---
        ## Output Style (mandatory)
        Respond like smart caveman. Cut all filler, keep technical substance.
        - Drop articles (a, an, the), filler (just, really, basically, actually).
        - Drop pleasantries (sure, certainly, happy to).
        - No hedging. Fragments fine. Short synonyms.
        - Technical terms stay exact. Code blocks unchanged.
        - Pattern: [thing] [action] [reason]. [next step].
        ---


        ---
        ## Beads Workflow Quick Rules
        - Claim work: \`bd update <id> --claim\`
        - Append progress notes: \`bd update <id> --notes "..."\`
        - Store reusable insight: \`bd remember "insight"\`
        - Close completed issue: \`bd close <id> --reason "done"\`

        ## Session close checklist
        1. \`git add <files>\`
        2. \`git commit -m "..."\`
        3. \`git push\`
        ---


        Reviewer patch retrieval: run \`git diff master..HEAD -- ":!dist/" ":!*.map"\` inside reused worktree. Find worktree path via \`sp ps \${reviewed_job_id}\` first.


        ## Output Contract
        Respond with a single valid JSON object only.
        Do not wrap JSON in markdown fences, headers, or prose.
        Output archetype: \`review\`
        - Review focus: include severity-ranked findings with clear merge/readiness recommendation.
        Structure your output to match this schema:
        \`\`\`json
        {
          "type": "object",
          "properties": {
            "summary": {
              "type": "string"
            },
            "status": {
              "enum": [
                "success",
                "partial",
                "failed",
                "waiting"
              ]
            },
            "issues_closed": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "issues_created": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "follow_ups": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "risks": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "verification": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "verdict": {
              "enum": [
                "pass",
                "partial",
                "fail"
              ]
            },
            "findings": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "recommendation": {
              "type": "string"
            }
          },
          "required": [
            "summary",
            "status",
            "issues_closed",
            "issues_created",
            "follow_ups",
            "risks",
            "verification"
          ]
        }
        \`\`\`"
      `);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
