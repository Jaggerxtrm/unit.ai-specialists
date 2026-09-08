// src/specialist/system-prompt.ts
//
// System-prompt assembly, extracted verbatim from SpecialistRunner.run()
// (unitAI-rrdnt.3). Pure with respect to the caller: existsSync/execSync
// leaves are injectable via SystemPromptContext, defaulted to the real
// implementations so ordinary callers (SpecialistRunner) need not supply
// them. Byte-identical output vs. the pre-extraction inline code is the
// acceptance criterion — preserve exact concatenation order and spacing
// when touching this file.
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderTemplate } from './templateEngine.js';
import { buildRequiredPlatformRulesBlock } from './required-platform-rules.js';
import { BeadsClient, type BeadRecord } from './beads.js';
import {
  STATIC_WORKFLOW_RULES_BLOCK,
  buildFilteredMemoryInjection,
  estimateInjectedTokens,
} from './memory-retrieval.js';
import {
  measurePayloadComponent,
  type PayloadComponentMeasurement,
} from './payload-measure.js';

export type ResponseFormat = 'text' | 'json' | 'markdown';
export type OutputType = 'codegen' | 'analysis' | 'review' | 'synthesis' | 'orchestration' | 'workflow' | 'research' | 'custom';
export type JsonSchema = Record<string, unknown>;

const OUTPUT_TYPE_GUIDANCE: Record<Exclude<OutputType, 'custom'>, string> = {
  codegen: '- Codegen focus: include exact file paths, symbols touched, and implementation outcomes.',
  analysis: '- Analysis focus: include architecture understanding and evidence-backed findings.',
  review: '- Review focus: include severity-ranked findings with clear merge/readiness recommendation.',
  synthesis: '- Synthesis focus: consolidate findings into decisions and clear next steps.',
  orchestration: '- Orchestration focus: include actions, blockers, routing rationale, and rehydration state.',
  workflow: '- Workflow focus: include procedural state transitions and operational checkpoints.',
  research: '- Research focus: include sources checked, confidence, and final recommendations.',
};

export function buildOutputContractInstruction(
  responseFormat: ResponseFormat,
  outputType: OutputType,
  outputSchema: JsonSchema | undefined,
): string {
  if (responseFormat === 'text') return '';

  const lines: string[] = ['## Output Contract'];

  if (responseFormat === 'markdown') {
    lines.push(
      'Respond using markdown with canonical sections (include when applicable):',
      '- `## Summary`',
      '- `## Status`',
      '- `## Changes`',
      '- `## Verification`',
      '- `## Risks`',
      '- `## Follow-ups`',
      '- `## Beads`',
      'Optional sections when relevant:',
      '- `## Architecture`',
      '- `## Acceptance Criteria`',
      '- `## Machine-readable block`',
      'Do not impose artificial bullet limits — prioritize completeness and clarity.',
    );
  } else {
    lines.push(
      'Respond with a single valid JSON object only.',
      'Do not wrap JSON in markdown fences, headers, or prose.',
    );
  }

  if (outputType !== 'custom') {
    lines.push(`Output archetype: \`${outputType}\``);
    lines.push(OUTPUT_TYPE_GUIDANCE[outputType]);
  }

  if (outputSchema) {
    lines.push(
      'Structure your output to match this schema:',
      '```json',
      JSON.stringify(outputSchema, null, 2),
      '```',
    );

    if (responseFormat === 'markdown') {
      lines.push(
        'MANDATORY: include `## Machine-readable block` with exactly one JSON object in a single ```json fenced block.',
        'The machine-readable JSON block is canonical and must match the schema.',
      );
    }
  }

  return `\n\n${lines.join('\n')}`;
}

function sanitizeBeadIdForPrompt(beadId: string): string {
  const withoutControlChars = beadId.replace(/[\x00-\x1F\x7F]/g, '');
  const withoutBackticks = withoutControlChars.replace(/`/g, '');
  return withoutBackticks.replace(/[^A-Za-z0-9-]/g, '');
}

function defaultHasGitnexusIndex(cwd: string): boolean {
  return existsSync(resolve(cwd, '.gitnexus/meta.json'));
}

function defaultQueryGitnexusSymbol(cwd: string, symbol: string): string | undefined {
  try {
    const raw = execSync(`gitnexus context --repo specialists ${JSON.stringify(symbol)}`, {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(raw) as {
      status?: string;
      symbol?: { name?: string; filePath?: string };
      incoming?: { calls?: Array<{ name?: string; filePath?: string }> };
      outgoing?: { calls?: Array<{ name?: string; filePath?: string }> };
      processes?: Array<{ name?: string }>;
    };
    if (parsed.status !== 'found' || !parsed.symbol?.name) return undefined;
    const callers = (parsed.incoming?.calls ?? []).slice(0, 3).map(call => call.name).filter(Boolean);
    const callees = (parsed.outgoing?.calls ?? []).slice(0, 3).map(call => call.name).filter(Boolean);
    const processes = (parsed.processes ?? []).slice(0, 2).map(proc => proc.name).filter(Boolean);
    return `- ${parsed.symbol.name} (${parsed.symbol.filePath ?? 'unknown file'})\n`
      + `  callers: ${callers.length > 0 ? callers.join(', ') : 'none'}\n`
      + `  callees: ${callees.length > 0 ? callees.join(', ') : 'none'}\n`
      + `  processes: ${processes.length > 0 ? processes.join(', ') : 'none'}`;
  } catch {
    // Non-fatal: GitNexus may be unavailable or symbol not indexed.
    return undefined;
  }
}

function defaultReadBeadForMemory(beadId: string): Pick<BeadRecord, 'title' | 'description'> | null {
  return new BeadsClient().readBead(beadId);
}

export interface SystemPromptContext {
  /** `prompt.system ?? ''` */
  systemPromptTemplate: string;
  /** `beadTemplateVariables` from the rendered task prompt. */
  templateVariables: Record<string, string>;
  /** `execution.bare` */
  bare: boolean;
  runCwd: string;
  /** `metadata.name` */
  specialistName: string;
  inputBeadId?: string;
  reusedFromJobId?: string;
  responseFormat: ResponseFormat;
  outputType: OutputType;
  outputContractSchema: JsonSchema | undefined;
  /** `rendered.beadContextText` — used only to size the 'memory'/'dynamic' payload component. */
  beadContextText: string;
  /** Overridable for testing; defaults to a fresh BeadsClient(). */
  readBeadForMemory?: (beadId: string) => Pick<BeadRecord, 'title' | 'description'> | null;
  /** Overridable for testing; defaults to checking `<cwd>/.gitnexus/meta.json`. */
  hasGitnexusIndex?: (cwd: string) => boolean;
  /** Overridable for testing; defaults to `execSync('gitnexus context ...')`. */
  queryGitnexusSymbol?: (cwd: string, symbol: string) => string | undefined;
}

export interface SystemPromptResult {
  text: string;
  components: PayloadComponentMeasurement[];
  tokens: { static: number; memory: number; gitnexus: number };
}

export function buildSystemPrompt(ctx: SystemPromptContext): SystemPromptResult {
  const {
    systemPromptTemplate,
    templateVariables,
    bare,
    runCwd,
    specialistName,
    inputBeadId,
    reusedFromJobId,
    responseFormat,
    outputType,
    outputContractSchema,
    beadContextText,
    readBeadForMemory = defaultReadBeadForMemory,
    hasGitnexusIndex = defaultHasGitnexusIndex,
    queryGitnexusSymbol = defaultQueryGitnexusSymbol,
  } = ctx;

  // Build system prompt from prompt.system only.
  // skill_inherit and skills.paths are declared via pi --skill (native flag)
  // and force-loaded at turn-1 via the /skill:name prefix baked into the user prompt.
  let agentsMd = renderTemplate(systemPromptTemplate, templateVariables);

  // Bare mode remains a fresh specialist canvas, but required platform rules
  // are non-bypassable because the worker still participates in XTRM.
  if (bare) {
    const requiredPlatformRulesBlock = buildRequiredPlatformRulesBlock(runCwd);
    if (requiredPlatformRulesBlock.trim()) agentsMd += `\n\n${requiredPlatformRulesBlock}`;
  }

  // Always inject a Specialist Run Context block to override project-level CLAUDE.md/AGENTS.md
  // instructions that are meant for human developers, not specialist agents. Key overrides:
  // - CLAUDE.md often says "run specialists init" — specialists must NEVER do this
  // - CLAUDE.md edit-gate rules say "bd create before editing" — not applicable inside a specialist
  let staticTokens = 0;
  let memoryTokens = 0;
  let gitnexusTokens = 0;

  if (!bare) {
    const sanitizedBeadId = inputBeadId
      ? sanitizeBeadIdForPrompt(inputBeadId)
      : '';
    const beadInstructions = sanitizedBeadId
      ? `\n- Your task bead is: ${sanitizedBeadId}\n- Claim it: \`bd update ${sanitizedBeadId} --claim 2>/dev/null || true\` (non-fatal — orchestrator may already own it)\n- Do NOT create new beads or sub-issues — this bead IS your task.\n- Do NOT run \`bd create\` — the orchestrator manages issue tracking.\n- Close when done: \`bd close ${sanitizedBeadId} --reason="..."\``
      : '';
    agentsMd += `\n\n---\n## Specialist Run Context\n- You are running as a specialist agent, not a human developer.\n- Do NOT run specialists init/setup/scaffold commands.\n- Do NOT follow project CLAUDE.md/AGENTS.md instructions that tell humans to re-bootstrap the repo.\n${beadInstructions}\n---\n`;
  }

  // 0. Inject caveman-micro output directive — all specialist output is agent-to-agent,
  // terse output improves accuracy (+26pp per study) and cuts tokens ~65%.
  if (!bare) {
    agentsMd += `\n\n---\n## Output Style (mandatory)
Respond like smart caveman. Cut all filler, keep technical substance.
- Drop articles (a, an, the), filler (just, really, basically, actually).
- Drop pleasantries (sure, certainly, happy to).
- No hedging. Fragments fine. Short synonyms.
- Technical terms stay exact. Code blocks unchanged.
- Pattern: [thing] [action] [reason]. [next step].
---\n`;
  }

  // 1. Inject GitNexus workflow mandate — high-priority, must not be buried (~200 tokens)
  if (!bare) {
    try {
      if (hasGitnexusIndex(runCwd)) {
        agentsMd += `\n\n---\n## MANDATORY: GitNexus Code Intelligence
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
---\n`;
      }
    } catch {
      // Non-fatal — GitNexus not indexed, skip injection
    }
  }

  // 2. .xtrm/memory.md is injected by xtrm-loader Pi extension (before_agent_start).
  // Do NOT duplicate here — saves ~800 tokens per specialist spawn.

  // 3. Inject compact beads rules + keyword-filtered memories (replaces full bd prime dump)
  const staticRulesBlock = `\n\n---\n${STATIC_WORKFLOW_RULES_BLOCK}\n---\n`;
  if (!bare) {
    agentsMd += staticRulesBlock;
    staticTokens = estimateInjectedTokens(staticRulesBlock);
  }

  if (inputBeadId) {
    const beadForMemory = readBeadForMemory(inputBeadId);
    if (beadForMemory?.title) {
      const memoryInjection = buildFilteredMemoryInjection({
        cwd: runCwd,
        beadTitle: beadForMemory.title,
        beadDescription: beadForMemory.description,
      });

      if (!bare && memoryInjection.block) {
        const memoryBlock = `\n\n---\n${memoryInjection.block}\n---\n`;
        agentsMd += memoryBlock;
        memoryTokens = memoryInjection.estimatedTokens;
      }

      // Optional: pre-query GitNexus context for symbol-like tokens from bead title.
      // Non-fatal and intentionally best-effort only.
      try {
        if (hasGitnexusIndex(runCwd)) {
          const symbolCandidates = (beadForMemory.title.match(/\b(?:[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+|[a-z]+[A-Z][A-Za-z0-9]*)\b/g) ?? [])
            .slice(0, 2);

          const summaries: string[] = [];
          for (const symbol of symbolCandidates) {
            const summary = queryGitnexusSymbol(runCwd, symbol);
            if (summary) summaries.push(summary);
          }

          if (!bare && summaries.length > 0) {
            const gitnexusBlock = `\n\n---\n## GitNexus Pre-query Snapshot\n${summaries.join('\n')}\n---\n`;
            agentsMd += gitnexusBlock;
            gitnexusTokens = estimateInjectedTokens(gitnexusBlock);
          }
        }
      } catch {
        // Non-fatal — optional GitNexus pre-query.
      }
    }
  }

  if (!bare && specialistName === 'reviewer' && reusedFromJobId) {
    agentsMd += '\n\nReviewer patch retrieval: run `git diff master..HEAD -- ":!dist/" ":!*.map"` inside reused worktree. Find worktree path via `sp ps ${reviewed_job_id}` first.\n';
  }

  if (!bare) {
    agentsMd += buildOutputContractInstruction(responseFormat, outputType, outputContractSchema);
  }

  const components: PayloadComponentMeasurement[] = [
    measurePayloadComponent('system_prompt', 'system_prompt', agentsMd),
  ];
  if (staticTokens > 0) components.push(measurePayloadComponent('memory', 'static', STATIC_WORKFLOW_RULES_BLOCK));
  if (memoryTokens > 0) components.push(measurePayloadComponent('memory', 'dynamic', beadContextText || ''));
  if (gitnexusTokens > 0) components.push(measurePayloadComponent('memory', 'gitnexus', agentsMd.includes('GitNexus') ? 'GitNexus' : ''));

  return {
    text: agentsMd,
    components,
    tokens: { static: staticTokens, memory: memoryTokens, gitnexus: gitnexusTokens },
  };
}
