import { type BeadRecord } from './beads.js';
import { type PayloadComponentMeasurement } from './payload-measure.js';
export type ResponseFormat = 'text' | 'json' | 'markdown';
export type OutputType = 'codegen' | 'analysis' | 'review' | 'synthesis' | 'orchestration' | 'workflow' | 'research' | 'custom';
export type JsonSchema = Record<string, unknown>;
export declare function buildOutputContractInstruction(responseFormat: ResponseFormat, outputType: OutputType, outputSchema: JsonSchema | undefined): string;
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
    /** `rendered.beadContextText` — retained for caller compat; memory sizing retired (unitAI-cnca3 S1). */
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
    tokens: {
        static: number;
        memory: number;
        gitnexus: number;
    };
}
export declare function buildSystemPrompt(ctx: SystemPromptContext): SystemPromptResult;
//# sourceMappingURL=system-prompt.d.ts.map