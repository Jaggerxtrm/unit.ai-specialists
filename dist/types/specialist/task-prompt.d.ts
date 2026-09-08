import { buildMandatoryRulesInjection } from './mandatory-rules.js';
import { type BeadRecord } from './beads.js';
import { type PayloadComponentMeasurement } from './payload-measure.js';
import type { Specialist } from './schema.js';
export declare const MANDATORY_RULES_TOKEN_LIMIT = 2400;
/**
 * A task_template referenced a `$name` that no caller provides and that is not a
 * known execution-only placeholder. Fail loud: a complete initial prompt is the
 * renderer's contract, and a silent literal `$name` handed to the model is a leak.
 */
export declare class TemplatePlaceholderError extends Error {
    readonly unresolved: string[];
    constructor(unresolved: string[]);
}
export type Surface = 'pi' | 'claude' | 'codex';
/**
 * Derive a skill's invocation name from its declared path.
 *   `.../<name>/SKILL.md` → `<name>` (folder-based skill)
 *   `.../<name>.md`       → `<name>` (bare-file skill)
 *   anything else         → basename verbatim
 */
export declare function deriveSkillName(path: string): string;
/**
 * Turn-1 deterministic skill-load block (unitAI-qeguh).
 * Empty string when the specialist declares no skills — caller must NOT prepend anything.
 * Dedup by derived name, preserving skills.paths JSON declaration order.
 * Pi uses `/skill:<name>` commands separated by spaces; Claude uses `/<name>`
 * commands separated by newlines; native Codex (K3, unitAI-e67up.2) uses
 * `$<name>` references separated by spaces. Names come from the loader-validated
 * skill paths. The codex surface is experimental until K5 promotion
 * (GATE-IFACE has already passed).
 */
export declare function buildSkillPrefix(specialist: Specialist['specialist'], surface: Surface): string;
export declare function buildBeadBoundaryInstruction(cwd: string, worktreeBoundary?: string): string;
export interface TaskPromptInput {
    /** Effective specialist config (post loader precedence + preset resolution). */
    specialist: Specialist['specialist'];
    cwd: string;
    /** Present for tracked runs; absent for `sp run --prompt`. */
    beadId?: string;
    bead?: BeadRecord | null;
    completedBlockers?: BeadRecord[];
    /** Up-walk ancestors (immediate parent first). Empty/absent = no lineage section. */
    epicAncestors?: BeadRecord[];
    /**
     * Prompt used when no bead context is available — either no `beadId`, or a
     * `beadId` that could not be read. Lazy so callers only pay for it on that path.
     */
    fallbackPrompt?: () => string;
    /** Execution-only: stdout of pre-phase scripts. Empty for read-only rendering. */
    preScriptOutput?: string;
    variables?: Record<string, string>;
    reusedFromJobId?: string;
    worktreeOwnerJobId?: string;
    gitnexusSummary?: string;
    worktreeBoundary?: string;
    /**
     * Execution-only hook (reviewer git-diff context). `sp run` passes it; the
     * read-only renderer does not, which is the one classified task-side
     * difference between the two surfaces.
     */
    appendExecutionContext?: (task: string, cwd: string, variables: Record<string, string>) => string;
    /**
     * Turn-1 skill-load surface (unitAI-qeguh). Defaults to 'pi' — sp run is pi-only;
     * xt claude --role passes 'claude' via `sp render-task --surface claude`, and the
     * native Codex launcher (K3, experimental until K5 promotion) passes 'codex'.
     */
    surface?: Surface;
}
export interface TaskPromptResult {
    initial_prompt: string;
    prompt_hash: string;
    /** task_template + bead_context measurements, in `sp run` push order. */
    taskTemplateComponent: PayloadComponentMeasurement;
    beadContextOwn: PayloadComponentMeasurement | null;
    beadContextParent: PayloadComponentMeasurement | null;
    beadContextBlockers: PayloadComponentMeasurement[];
    mandatoryRules: ReturnType<typeof buildMandatoryRulesInjection> | null;
    mandatoryRulesBlock: string;
    /**
     * Non-null when mandatory-rule resolution failed. `sp run` warns and continues
     * (historical behavior); the read-only renderer treats this as fatal so an
     * interactive coordinator can never launch silently missing its rules.
     */
    mandatoryRulesError: string | null;
    /** Fully-resolved variable map, after bead/lineage overlays. */
    variables: Record<string, string>;
    /** Variable map `sp run` uses to render `prompt.system`. Not used by the renderer. */
    beadTemplateVariables: Record<string, string>;
    /** Raw bead context, before the boundary instruction is appended. */
    beadContextText: string;
    resolvedPrompt: string;
    /** Turn-1 skill-load prefix; empty string when specialist declares no skills. */
    skillPrefix: string;
}
/**
 * The single task-side prompt assembly used by BOTH `sp run` and the read-only
 * interactive-role renderer (`sp render-task`). It never executes anything and
 * never touches `prompt.system` — system-prompt assembly stays with the caller.
 *
 * Order is the `sp run` contract and must not drift:
 *   task_template (with bead + dependency context) → MANDATORY_RULES → execution-only context → hash.
 */
export declare function renderTaskPrompt(input: TaskPromptInput): TaskPromptResult;
//# sourceMappingURL=task-prompt.d.ts.map