// src/tools/specialist/use_specialist.tool.ts
import * as z from 'zod';
import type { SpecialistRunner } from '../../specialist/runner.js';
import { BeadsClient, buildBeadContext } from '../../specialist/beads.js';
import { evaluateBeadReadiness } from '../../activation/bead-gate.js';

export const useSpecialistSchema = z.object({
  name: z.string().describe('Specialist identifier (e.g. codebase-explorer)'),
  prompt: z.string().optional().describe('The task or question for the specialist'),
  bead_id: z.string().optional().describe('Use an existing bead as the specialist prompt'),
  variables: z.record(z.string()).optional().describe('Additional $variable substitutions'),
  backend_override: z.string().optional().describe('Force a specific backend (gemini, qwen, anthropic)'),
  autonomy_level: z.enum(['READ_ONLY', 'LOW', 'MEDIUM', 'HIGH']).optional().describe('Override permission level for this invocation'),
  context_depth: z.number().min(0).max(10).optional().describe('Depth of blocker context injection (0 = none, 1 = immediate blockers, etc.)'),
}).refine((input) => Boolean(input.prompt?.trim() || input.bead_id), {
  message: 'Either prompt or bead_id is required',
  path: ['prompt'],
});

export function createUseSpecialistTool(runner: SpecialistRunner) {
  return {
    name: 'use_specialist' as const,
    description:
      'Run a specialist synchronously and wait for the result. ' +
      'Full lifecycle: load → agents.md → pi session → output. ' +
      'Response includes output, model, durationMs, and beadId (string | undefined). ' +
      'beadId is set when the specialist\'s beads_integration policy triggered bead creation ' +
      '(default: auto — creates for LOW/MEDIUM/HIGH permission, skips for READ_ONLY). ' +
      'If beadId is present, use `bd update <beadId> --notes` to attach findings or ' +
      '`bd remember` to persist key discoveries for future sessions. ' +
      'When bead_id is provided, the source bead becomes the specialist prompt and the tracking bead links back to it. ' +
      'Use context_depth to inject outputs from completed blocking dependencies (depth 1 = immediate blockers, 2 = include their blockers too). '+
      'A bead_id that specialist_dispatch would REFUSE (draft, closed, or missing a contract section) still runs here, but the result carries a readiness_warning naming what is missing. '+
      'That divergence is deprecated: prefer specialist_dispatch for contract-gated work.',
    inputSchema: useSpecialistSchema,
    async execute(input: z.infer<typeof useSpecialistSchema>, onProgress?: (msg: string) => void) {
      let prompt = input.prompt?.trim() ?? '';
      let variables = input.variables;
      let readinessWarning: string | undefined;

      if (input.bead_id) {
        const beadsClient = new BeadsClient();
        const bead = beadsClient.readBead(input.bead_id);
        if (!bead) {
          return {
            status: 'error' as const,
            error: `Unable to read bead '${input.bead_id}' via bd show --json`,
          };
        }
        // Same gate specialist_dispatch runs, same function — a second readiness check would
        // let the two surfaces disagree about admission, which is the defect, not the fix.
        const readiness = evaluateBeadReadiness(bead);
        if (!readiness.ok) {
          readinessWarning =
            `bead '${input.bead_id}' would be REFUSED by specialist_dispatch: ${readiness.reason}`
            + (readiness.missing.length > 0 ? ` (missing: ${readiness.missing.join(', ')})` : '')
            + '. use_specialist ran it anyway because it predates the bead gate. This divergence is'
            + ' deprecated — promote the bead and use specialist_dispatch.';
        }

        const beadContext = buildBeadContext(bead);
        prompt = beadContext;
        variables = {
          ...(input.variables ?? {}),
          bead_context: beadContext,
          bead_id: input.bead_id,
        };
      }

      const result = await runner.run({
        name: input.name,
        prompt,
        variables,
        backendOverride: input.backend_override,
        autonomyLevel: input.autonomy_level,
        specialistName: input.name,
        specialistPermissions: undefined,
        inputBeadId: input.bead_id,
      }, onProgress);

      // WARN, do not refuse (unitAI-rrdnt.42). specialist_dispatch refuses a Bead this gate
      // rejects; this tool predates the gate and is in active use, so refusing outright would
      // break callers whose Beads were never written to the contract. The warning rides the
      // RESULT rather than a log, because the whole defect being fixed is that an operator
      // took the ungated path without any indication they had taken it.
      return readinessWarning ? { ...result, readiness_warning: readinessWarning } : result;
    },
  };
}
