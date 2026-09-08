/**
 * StepContract compilation — PRD §15, Phase 4.
 *
 * A StepContract bounds ONE activation. It is derived, in-memory, and reproducible from
 * the Bead plus the SpecialistDefinition; it is **not** a second durable work item. The
 * PRD says this twice (Phase 4 "do not create step issues", invariant 4 "StepContract does
 * not create a second work graph") because the tempting next step — persisting these,
 * giving them ids, letting them depend on each other — rebuilds the dependency graph Beads
 * already owns, in a place nothing else can see.
 *
 * Nothing here writes, persists, or registers anything. Compilation is a pure function of
 * its inputs.
 *
 * ON THE TYPES: PRD §15 gives `EvidenceRef`, `OutputRequirement`, `ScopeContract` and
 * `ValidationRequirement` as a conceptual shape with no field definitions. They are
 * narrowed here to what a Bead can actually supply today rather than modelling an evidence
 * subsystem that does not exist. When real evidence refs arrive, these widen; inventing
 * them now would produce a contract whose fields are always empty and whose shape nobody
 * trusts.
 */

import type { BeadRecord } from '../specialist/beads.js';
import { extractSections } from './bead-gate.js';

/**
 * A pointer to something the activation was given as input.
 *
 * Today a Bead can only cite other Beads, so `kind` is deliberately narrow. It is an enum
 * rather than a free string so that widening it later is a compile error at every reader.
 */
export interface EvidenceRef {
  kind: 'bead' | 'blocker';
  ref: string;
  title?: string;
}

/** Something the activation is required to produce. */
export interface OutputRequirement {
  description: string;
  /** Response format the Specialist is configured to emit, when it declares one. */
  format?: string;
}

/**
 * What this activation is for.
 *
 * The boundary lives in the sibling `nonGoals` field, not here. PRD §15 lists `scope` and
 * `nonGoals` separately, so carrying the exclusions in both would give the contract two
 * sources of truth for the same statement and let them drift.
 */
export interface ScopeContract {
  inScope: string;
}

/** A condition the result is checked against. */
export interface ValidationRequirement {
  description: string;
}

export interface StepContract {
  /** The durable work this activation serves. Always a Bead id — never a synthetic id. */
  rootWorkRef: string;

  /** What THIS Specialist is being asked to do, narrowed to its role. */
  mandate: string;

  inputs: EvidenceRef[];
  outputs: OutputRequirement[];
  scope: ScopeContract;
  nonGoals: string[];
  constraints?: string[];
  validation?: ValidationRequirement[];

  provenance: {
    specialist: string;
    generatedAt: number;
    /** Bead revision this was compiled from, when `bd` reports one. */
    sourceBeadRevision?: string;
  };
}

export interface CompileStepContractInput {
  bead: BeadRecord;
  specialist: string;
  /** The Specialist's configured response format, if any. */
  responseFormat?: string;
  now?: () => number;
}

/** Split a section body into list items, tolerating bullets, numbering, or plain lines. */
function toList(body: string | undefined): string[] {
  if (!body) return [];
  return body
    .split('\n')
    .map(line => line.trim().replace(/^[-*•]\s*/, '').replace(/^\d+[.)]\s*/, '').trim())
    .filter(line => line.length > 0);
}

/**
 * Compile the bounded contract for one activation.
 *
 * Assumes the Bead already passed the Phase 3 gate, so all seven sections are present and
 * non-empty. It stays total anyway — a missing section yields an empty field rather than a
 * throw, because a compiler that can abort an admitted activation turns a documentation
 * problem into an outage.
 */
export function compileStepContract(input: CompileStepContractInput): StepContract {
  const { bead, specialist } = input;
  const now = input.now ?? (() => Date.now());
  const sections = extractSections(bead.description ?? '');

  // The mandate narrows the root work to this Specialist's role: what the Bead wants
  // (SUCCESS) bounded by what this activation is for (SCOPE).
  const scopeText = sections.get('SCOPE') ?? '';
  const successText = sections.get('SUCCESS') ?? '';
  const mandate = [successText, scopeText].filter(Boolean).join('\n\n');

  const inputs: EvidenceRef[] = [
    { kind: 'bead', ref: bead.id, title: bead.title },
    ...(bead.dependencies ?? [])
      .filter(dep => typeof dep?.id === 'string' && dep.id.length > 0)
      .map((dep): EvidenceRef => ({ kind: 'blocker', ref: dep.id })),
  ];

  const outputText = sections.get('OUTPUT') ?? '';
  const outputs: OutputRequirement[] = outputText
    ? [{ description: outputText, ...(input.responseFormat ? { format: input.responseFormat } : {}) }]
    : [];

  const constraints = toList(sections.get('CONSTRAINTS'));
  const validation = toList(sections.get('VALIDATION')).map(description => ({ description }));

  const revision = (bead as BeadRecord & { revision?: unknown }).revision;

  return {
    rootWorkRef: bead.id,
    mandate,
    inputs,
    outputs,
    scope: { inScope: scopeText },
    nonGoals: toList(sections.get('NON_GOALS')),
    ...(constraints.length > 0 ? { constraints } : {}),
    ...(validation.length > 0 ? { validation } : {}),
    provenance: {
      specialist,
      generatedAt: now(),
      ...(revision === undefined || revision === null ? {} : { sourceBeadRevision: String(revision) }),
    },
  };
}
