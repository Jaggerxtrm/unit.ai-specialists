// src/tools/specialist/specialist_list.tool.ts
//
// MCP mirror of the Pi `specialist_list` registry tool
// (config/pi-extensions/specialist-subagents/index.mjs). MCP coordinators get the
// same registry awareness Pi coordinators have: one compact line per specialist
// by default, with a dispatchability verdict per row.
//
// Loader stays authoritative: listing uses `loader.list()` and per-row detail
// uses `loader.get()`. Dispatchability reuses the shared admission checks
// imported from lib — never reimplemented here.
import * as z from 'zod';
import { resolveModelChain, resolveRuntimeToolContract, validateBeforeRun } from '../../lib.js';
import type { SpecialistLoader, SpecialistSummary } from '../../specialist/loader.js';
import type { Specialist } from '../../specialist/schema.js';

export const specialistListSchema = z.object({
  name: z.string().optional().describe('Return the full record for this one specialist instead of the compact list.'),
  detail: z
    .enum(['compact', 'full'])
    .optional()
    .describe('"compact" (default) is one line each; "full" returns every field for every specialist.'),
});

const WRITE_TIERS = new Set(['MEDIUM', 'HIGH']);

const NATIVE_ONLY_NOTE = 'Dispatch through specialist_dispatch. Do not shell out to the specialists CLI.';

function specialistSummaryView(summary: SpecialistSummary) {
  return {
    name: summary.name,
    category: summary.category,
    description: summary.description,
    scope: summary.scope,
    source: summary.source,
    version: summary.version,
    permission_required: summary.permission_required,
  };
}

function shortReason(reason: unknown): string {
  const text = String(reason ?? '').trim();
  if (!text) return text;
  const firstSentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
  const chosen = firstSentence.length > 0 && firstSentence.length <= 120 ? firstSentence : text;
  return chosen.length <= 120 ? chosen : `${chosen.slice(0, 117)}...`;
}

/**
 * The SAME admission checks the host runs: model chain, resolved tool
 * contract, and preflight. A specialist whose checks pass is dispatchable on
 * the native runtime; `reason` explains the rest.
 */
async function dispatchability(spec: Specialist): Promise<{ dispatchable: boolean; reason?: string }> {
  const execution = spec.specialist.execution;
  const tier = execution.permission_required ?? 'READ_ONLY';
  const modelChain = resolveModelChain(execution);
  if (modelChain.length === 0) {
    return { dispatchable: false, reason: 'no configured model — pass model_override at dispatch' };
  }
  let toolContract;
  try {
    toolContract = resolveRuntimeToolContract({
      level: tier,
      specialistName: spec.specialist.metadata.name,
      specialistPermissions: spec.specialist.permissions,
      cwd: process.cwd(),
    });
  } catch (error) {
    return { dispatchable: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!toolContract || toolContract.toolsList.length === 0) {
    return { dispatchable: false, reason: 'empty tool contract for tier' };
  }
  try {
    validateBeforeRun(spec, tier, toolContract);
  } catch (error) {
    return { dispatchable: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { dispatchable: true };
}

type RegistryRow = ReturnType<typeof specialistSummaryView> & {
  access: 'write' | 'read';
  dispatchable?: boolean;
  reason?: string;
};

export function createSpecialistListTool(loader: SpecialistLoader) {
  return {
    name: 'specialist_list' as const,
    description:
      'List the resolved Specialist registry after repo and user layer overrides. ' +
      'Returns a COMPACT line per specialist by default — name, permission tier, ' +
      'category, and a reason only where the native runtime cannot dispatch it. ' +
      'Pass `name` for one specialist\'s full record including its description, or ' +
      'detail:"full" for every field of every specialist (large — prefer `name`). ' +
      'Write-capable tiers (MEDIUM/HIGH) still need the workspace lease at dispatch ' +
      'time.',
    inputSchema: specialistListSchema,
    async execute(input: z.infer<typeof specialistListSchema>) {
      const summaries = await loader.list();
      const rows: RegistryRow[] = [];
      for (const summary of summaries) {
        const row: RegistryRow = {
          ...specialistSummaryView(summary),
          access: WRITE_TIERS.has(summary.permission_required ?? 'READ_ONLY') ? 'write' : 'read',
        };
        // loader.get throws for specialists with no configured model — that IS the
        // undispatchable signal (the host rejects them with no_model_configured),
        // not a listing failure.
        let spec: Specialist | null = null;
        try {
          spec = await loader.get(summary.name);
        } catch (error) {
          row.dispatchable = false;
          row.reason = error instanceof Error ? error.message : String(error);
        }
        if (spec) {
          const capability = await dispatchability(spec);
          row.dispatchable = capability.dispatchable;
          if (capability.reason) row.reason = capability.reason;
        }
        rows.push(row);
      }
      const wanted = input.name;
      if (wanted) {
        const one = rows.find((r) => r.name === wanted);
        return one
          ? { specialist: one, note: NATIVE_ONLY_NOTE }
          : {
              error: `Unknown specialist: ${wanted}`,
              known: rows.map((r) => r.name),
              note: NATIVE_ONLY_NOTE,
            };
      }

      if (input.detail === 'full') {
        return { specialists: rows, detail: 'full', note: NATIVE_ONLY_NOTE };
      }

      const compact = rows.map((r) => ({
        name: r.name,
        tier: r.permission_required ?? 'READ_ONLY',
        access: r.access,
        ...(r.category ? { category: r.category } : {}),
        dispatchable: r.dispatchable !== false,
        ...(r.dispatchable === false ? { reason: shortReason(r.reason) } : {}),
      }));
      const undispatchable = compact.filter((r) => r.dispatchable === false).length;
      return {
        specialists: compact,
        count: compact.length,
        undispatchable,
        detail: 'compact',
        note: 'Pass name=<specialist> for one full record, or detail="full" for everything. ' + NATIVE_ONLY_NOTE,
      };
    },
  };
}
