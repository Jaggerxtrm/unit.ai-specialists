import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { STATIC_WORKFLOW_RULES_BLOCK } from './memory-retrieval.js';
import { resolveCanonicalAssetDir } from './canonical-asset-resolver.js';

export interface MandatoryRule {
  id: string;
  level: string;
  text: string;
  when?: string;
}

export interface MandatoryRuleSet {
  id: string;
  rules: MandatoryRule[];
}

export interface SpecialistMandatoryRulesConfig {
  template_sets?: string[];
  disable_default_globals?: boolean;
  inline_rules?: MandatoryRule[];
}

interface MandatoryRulesIndex {
  required_template_sets?: string[];
  default_template_sets?: string[];
}

export interface MandatoryRulesSection {
  setId: string;
  block: string;
  priority: 'must_keep' | 'important' | 'optional';
  ruleCount: number;
}

export interface MandatoryRulesInjection {
  block: string;
  sections: MandatoryRulesSection[];
  setsLoaded: string[];
  ruleCount: number;
  inlineRulesCount: number;
  globalsDisabled: boolean;
  budgetLimit: number;
  candidateTokens: number;
  injectedTokens: number;
  injectedSectionIds: string[];
  evictedSectionIds: string[];
  payloadDigest: string;
  outcome: 'full' | 'degraded';
}

export type MandatoryRulesBudgetResult = Pick<
  MandatoryRulesInjection,
  | 'block'
  | 'sections'
  | 'budgetLimit'
  | 'candidateTokens'
  | 'injectedTokens'
  | 'injectedSectionIds'
  | 'evictedSectionIds'
  | 'payloadDigest'
  | 'outcome'
>;

export class MandatoryRulesBudgetError extends Error {
  readonly outcome = 'impossible' as const;

  constructor(
    readonly budgetLimit: number,
    readonly candidateTokens: number,
    readonly mustKeepTokens: number,
    readonly injectedSectionIds: string[],
    readonly evictedSectionIds: string[],
  ) {
    super(`Mandatory rules MUST_KEEP floor requires ${mustKeepTokens} tokens, exceeding budget ${budgetLimit}`);
    this.name = 'MandatoryRulesBudgetError';
  }

  readonly injectedTokens = 0;
}

function formatSectionsBlock(sections: MandatoryRulesSection[]): string {
  return sections.length > 0 ? `## MANDATORY_RULES\n${sections.map(section => section.block).join('\n\n')}` : '';
}

function estimateTokens(text: string): number {
  return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
}

export function compileMandatoryRulesBudget(
  candidateSections: MandatoryRulesSection[],
  budgetLimit: number,
): MandatoryRulesBudgetResult {
  const sections = candidateSections.filter(section => section.block.trim() && section.ruleCount > 0);
  const candidateTokens = estimateTokens(formatSectionsBlock(sections));
  const mustKeep = sections.filter(section => section.priority === 'must_keep');
  const floorTokens = estimateTokens(formatSectionsBlock(mustKeep));
  if (floorTokens > budgetLimit) {
    throw new MandatoryRulesBudgetError(
      budgetLimit,
      candidateTokens,
      floorTokens,
      [],
      sections.map(section => section.setId),
    );
  }

  const retained = new Set(mustKeep);
  for (const priority of ['important', 'optional'] as const) {
    for (const section of sections.filter(item => item.priority === priority)) {
      const proposed = sections.filter(item => retained.has(item) || item === section);
      if (estimateTokens(formatSectionsBlock(proposed)) <= budgetLimit) retained.add(section);
    }
  }

  const injected = sections.filter(section => retained.has(section));
  const block = formatSectionsBlock(injected);
  const evicted = sections.filter(section => !retained.has(section));
  return {
    block,
    sections: injected,
    budgetLimit,
    candidateTokens,
    injectedTokens: estimateTokens(block),
    injectedSectionIds: injected.map(section => section.setId),
    evictedSectionIds: evicted.map(section => section.setId),
    payloadDigest: createHash('sha256').update(block).digest('hex'),
    outcome: evicted.length === 0 ? 'full' : 'degraded',
  };
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

function mergeIndex(base: MandatoryRulesIndex, overlay: MandatoryRulesIndex): MandatoryRulesIndex {
  const dedupe = (values: string[] | undefined): string[] | undefined =>
    values ? Array.from(new Set(values)) : undefined;

  return {
    required_template_sets: dedupe([
      ...(base.required_template_sets ?? []),
      ...(overlay.required_template_sets ?? []),
    ]),
    default_template_sets: dedupe([
      ...(base.default_template_sets ?? []),
      ...(overlay.default_template_sets ?? []),
    ]),
  };
}

export function loadMandatoryRulesIndex(cwd: string): MandatoryRulesIndex | null {
  const sourcePath = resolve(cwd, 'config/mandatory-rules/index.json');
  const canonicalCopyPath = resolve(cwd, '.specialists/default/mandatory-rules/index.json');
  const userOverlayPath = resolve(cwd, '.specialists/user/mandatory-rules/index.json');
  const packageLivePath = resolveCanonicalAssetDir('mandatory-rules');
  const overlayPath = resolve(cwd, '.specialists/mandatory-rules/index.json');

  const packageLiveIndexPath = packageLivePath ? resolve(packageLivePath, 'index.json') : null;
  const tierPaths = [userOverlayPath, sourcePath, canonicalCopyPath, overlayPath].filter((value): value is string => Boolean(value));
  const tiers: MandatoryRulesIndex[] = [];
  for (const path of tierPaths) {
    if (existsSync(path)) tiers.push(readJsonFile<MandatoryRulesIndex>(path));
  }

  if (tiers.length === 0 && packageLiveIndexPath && existsSync(packageLiveIndexPath)) {
    tiers.push(readJsonFile<MandatoryRulesIndex>(packageLiveIndexPath));
  }

  if (tiers.length === 0) {
    console.warn('[specialist runner] Missing mandatory-rules index (checked config/, .specialists/default/, .specialists/); skipping MANDATORY_RULES injection');
    return null;
  }

  return tiers.reduce((acc, next) => mergeIndex(acc, next));
}

function parseQuotedScalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function parseRuleEntry(lines: string[], startIndex: number): { rule: MandatoryRule; nextIndex: number } | null {
  const entryLine = lines[startIndex]?.trim();
  if (!entryLine?.startsWith('- ')) return null;

  const firstLine = entryLine.slice(2).trim();
  const inlineFields: Record<string, string> = {};

  if (firstLine.length > 0 && !firstLine.includes(':')) {
    inlineFields.text = parseQuotedScalar(firstLine);
  } else if (firstLine.length > 0) {
    const [key, ...rest] = firstLine.split(':');
    inlineFields[key.trim()] = parseQuotedScalar(rest.join(':'));
  }

  let nextIndex = startIndex + 1;
  while (nextIndex < lines.length) {
    const line = lines[nextIndex];
    if (!line.trim()) {
      nextIndex += 1;
      continue;
    }

    if (/^\s*-\s+/.test(line)) break;
    if (!/^\s+/.test(line)) break;

    const trimmed = line.trim();
    const match = trimmed.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!match) {
      nextIndex += 1;
      continue;
    }

    inlineFields[match[1]] = parseQuotedScalar(match[2]);
    nextIndex += 1;
  }

  if (!inlineFields.text) return null;

  return {
    rule: {
      id: inlineFields.id ?? '',
      level: inlineFields.level ?? 'required',
      text: inlineFields.text,
      ...(inlineFields.when ? { when: inlineFields.when } : {}),
    },
    nextIndex,
  };
}

function parseMandatoryRulesFrontmatter(content: string, setId: string): MandatoryRule[] {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!frontmatterMatch) return [];

  const lines = frontmatterMatch[1].split('\n');
  const rulesHeaderIndex = lines.findIndex(line => /^rules:\s*$/.test(line.trim()));
  if (rulesHeaderIndex === -1) return [];

  const rules: MandatoryRule[] = [];
  let index = rulesHeaderIndex + 1;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (!/^\s*-\s+/.test(line)) break;

    const parsed = parseRuleEntry(lines, index);
    if (!parsed) break;

    const ruleIndex = rules.length + 1;
    rules.push({
      id: parsed.rule.id || `${setId}-${ruleIndex}`,
      level: parsed.rule.level,
      text: parsed.rule.text,
      ...(parsed.rule.when ? { when: parsed.rule.when } : {}),
    });
    index = parsed.nextIndex;
  }

  return rules;
}

function readMandatoryRuleSet(cwd: string, id: string): MandatoryRuleSet | null {
  // Path-containment (security, unitAI-klo6k): set ids are file names resolved
  // INTO the tier directories below. Reject anything that is not a plain
  // kebab-case id so neither a specialist `template_sets` value nor an index
  // id (required/default_template_sets from any tier) can traverse
  // (`../../...`) out of the tiers and read arbitrary files into the prompt.
  // This is the single sink that every id route funnels through, so guarding
  // here closes both the override and index-overlay routes.
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    console.warn(`[specialist runner] Rejecting unsafe mandatory-rules set id '${id}' (must be kebab-case)`);
    return null;
  }

  const packageCanonicalDir = resolveCanonicalAssetDir('mandatory-rules');
  const candidates = [
    resolve(cwd, `.specialists/user/mandatory-rules/${id}.md`),
    resolve(cwd, `.specialists/mandatory-rules/${id}.md`),
    resolve(cwd, `.specialists/default/mandatory-rules/${id}.md`),
    resolve(cwd, `config/mandatory-rules/${id}.md`),
    ...(packageCanonicalDir ? [resolve(packageCanonicalDir, `${id}.md`)] : []),
  ];

  const filePath = candidates.find(path => existsSync(path));
  if (!filePath) return null;

  const content = readFileSync(filePath, 'utf8');
  const rules = parseMandatoryRulesFrontmatter(content, id);
  if (rules.length > 0) return { id, rules };

  const body = content
    .replace(/^---\n[\s\S]*?\n---\n?/, '')
    .trim();
  if (!body) return null;

  return {
    id,
    rules: [{ id: `${id}-1`, level: 'required', text: body.replace(/\s+/g, ' ') }],
  };
}

function formatMandatoryRulesBlock(
  sets: Array<MandatoryRuleSet & { priority: MandatoryRulesSection['priority'] }>,
  inlineRules: MandatoryRule[] = [],
): { block: string; sections: MandatoryRulesSection[] } {
  if (sets.length === 0 && inlineRules.length === 0) return { block: '', sections: [] };

  const sections = [
    ...sets.map(set => {
      const rules = set.rules.map(rule => `- [${rule.level}] ${rule.text}`).join('\n');
      return { setId: set.id, priority: set.priority, ruleCount: set.rules.length, block: `### ${set.id}\n${rules}` };
    }),
    ...(inlineRules.length > 0
      ? [
          {
            setId: 'specialist-inline-rules',
            priority: 'must_keep' as const,
            ruleCount: inlineRules.length,
            block: `### specialist-inline-rules\n${inlineRules.map((rule, index) => `- [${rule.level}] ${rule.text}${rule.id ? ` (id: ${rule.id})` : ` (id: inline-${index + 1})`}`).join('\n')}`,
          },
        ]
      : []),
  ];

  return { block: `## MANDATORY_RULES\n${sections.map(section => section.block).join('\n\n')}`, sections };
}

function collectMandatoryRuleSets(cwd: string, setIds: string[]): MandatoryRuleSet[] {
  const seen = new Set<string>();
  const sets: MandatoryRuleSet[] = [];

  for (const id of setIds) {
    if (seen.has(id)) continue;
    seen.add(id);

    const set = readMandatoryRuleSet(cwd, id);
    if (!set) {
      console.warn(`[specialist runner] Missing mandatory-rules set: ${id}`);
      continue;
    }

    sets.push(set);
  }

  return sets;
}

export function buildMandatoryRulesInjection(
  specialistConfig: { cwd?: string; specialist?: { mandatory_rules?: SpecialistMandatoryRulesConfig } },
  budgetLimit = Number.POSITIVE_INFINITY,
): MandatoryRulesInjection {
  const cwd = specialistConfig.cwd ?? process.cwd();
  const index = loadMandatoryRulesIndex(cwd);
  const mandatoryRules = specialistConfig.specialist?.mandatory_rules;

  const setIds = [
    ...(index?.required_template_sets ?? []),
    ...(index?.default_template_sets ?? []),
    ...(mandatoryRules?.template_sets ?? []),
  ];
  const sets = collectMandatoryRuleSets(cwd, setIds);
  const inlineRules = mandatoryRules?.inline_rules ?? [];
  // workflow-quick-rules global retired from memory text (unitAI-cnca3 S1):
  // the STATIC block's persistence line is stripped. The set id is kept —
  // cli/list display + mandatory-rules tests still key on it (whole-global
  // removal is a follow-up, not S1).
  const globalsDisabled = mandatoryRules?.disable_default_globals ?? false;
  const globals = globalsDisabled
    ? []
    : [{
        id: 'workflow-quick-rules',
        rules: [{
          id: 'workflow-quick-rules-1',
          level: 'required',
          text: STATIC_WORKFLOW_RULES_BLOCK.trim()
            .replace(/^##\s+Beads Workflow Quick Rules\n/, '')
            .replace(/^- Store reusable insight:.*\n/m, ''),
        }],
        priority: 'must_keep' as const,
      }];

  const requiredIds = new Set(index?.required_template_sets ?? []);
  const defaultIds = new Set(index?.default_template_sets ?? []);
  const prioritizedSets = sets.map(set => ({
    ...set,
    priority: requiredIds.has(set.id)
      ? 'must_keep' as const
      : defaultIds.has(set.id)
        ? 'important' as const
        : 'optional' as const,
  }));
  const formatted = formatMandatoryRulesBlock([...globals, ...prioritizedSets], inlineRules);
  const compiled = compileMandatoryRulesBudget(formatted.sections, budgetLimit);
  const injectedSetIds = new Set(compiled.injectedSectionIds);
  return {
    ...compiled,
    setsLoaded: [...globals, ...prioritizedSets].filter(set => injectedSetIds.has(set.id)).map(set => set.id),
    ruleCount: compiled.sections.reduce((count, section) => count + section.ruleCount, 0),
    inlineRulesCount: injectedSetIds.has('specialist-inline-rules') ? inlineRules.length : 0,
    globalsDisabled,
  };
}

export function buildMandatoryRulesBlock(specialistConfig: { cwd?: string; specialist?: { mandatory_rules?: SpecialistMandatoryRulesConfig } }): string {
  return buildMandatoryRulesInjection(specialistConfig).block;
}
