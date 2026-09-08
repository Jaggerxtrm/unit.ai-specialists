/**
 * Bead readiness gate for native Specialist activation — PRD Phase 3.
 *
 * `--bead` is the prompt. A Specialist dispatched against a Bead that is only a title and
 * a sentence has nothing to work from, so it invents the missing scope; that is how
 * durable work silently loses its boundaries. The seven sections are not paperwork, they
 * are the task contract, and a Bead without them is not dispatchable.
 *
 * Before this module the discipline existed only in CLAUDE.md and hooks — nothing in
 * `src/` mentioned PROBLEM, NON_GOALS or SCRUTINY. The gate moves it into the admission
 * path, where a refusal is cheap and reversible, rather than leaving it to be discovered
 * by a child that already spent a model turn guessing.
 *
 * Deliberately NOT here: the contract's *quality*. The gate proves a section exists and is
 * non-empty. Whether SCOPE is a good scope is a judgement no parser makes, and pretending
 * otherwise would trade a useful gate for a bureaucratic one.
 */

import { spawnSync } from 'node:child_process';
import type { BeadRecord } from '../specialist/beads.js';

/** The 7-section task contract, in the order an operator writes them. */
export const REQUIRED_SECTIONS = [
  'PROBLEM',
  'SUCCESS',
  'SCOPE',
  'NON_GOALS',
  'CONSTRAINTS',
  'VALIDATION',
  'OUTPUT',
] as const;

export const SCRUTINY_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

export type BeadGateResult =
  | { ok: true }
  | { ok: false; reason: string; missing: string[] };

/** Closed and deferred Beads are not work; dispatching against them resurrects dead scope. */
const NON_DISPATCHABLE_STATUSES = new Set(['closed', 'deferred']);

export interface BeadGateOptions {
  /**
   * Reads the `contract` state marker for a Bead, returning e.g. 'ready' or 'draft'.
   *
   * Injected so tests need no `bd` binary. The default shells out to `bd state`, which is
   * the only surface that carries the marker — `bd show --json` does not include it.
   */
  readContractState?: (beadId: string) => string | undefined;
}

/** Read `bd state <id> contract`. Returns undefined when bd is absent or the state is unset. */
export function readContractState(beadId: string): string | undefined {
  const result = spawnSync('bd', ['state', beadId, 'contract'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
  });
  if (result.error || result.status !== 0) return undefined;
  const value = result.stdout?.trim().toLowerCase();
  return value ? value : undefined;
}

/** Every heading this parser recognises as terminating the previous section. */
const ALL_HEADINGS = new Set<string>([...REQUIRED_SECTIONS, 'SCRUTINY']);

/** A recognised heading, plus any body text that shared its line. */
type Heading = { readonly name: string; readonly inlineBody?: string };

/**
 * Normalise one line to a canonical heading, or undefined when it is not a heading.
 *
 * Two forms are accepted, because operators and models both write contracts and they do
 * not write them the same way:
 *
 *   PROBLEM              a bare word on its own line, optionally decorated with markdown
 *   the thing is broken  heading marks, bold, or a trailing colon
 *
 *   PROBLEM: the thing is broken     the section name, a colon, and the body on one line
 *
 * The second form used to be rejected, and rejected in the worst possible way: the whole
 * line normalised to `PROBLEM:_THE_THING_IS_BROKEN`, matched nothing, so `extractSections`
 * returned an empty map and the gate reported every section missing from a description
 * that plainly contained all of them (unitAI-rrdnt.54). Anyone writing
 * `bd create --description="PROBLEM: ...\nSUCCESS: ..."` hit it, and the refusal pointed
 * away from the cause.
 *
 * A section name inside prose is still not a heading: the name must START the line and the
 * colon must follow it immediately. `see OUTPUT: below` heads nothing.
 */
function headingOf(line: string): Heading | undefined {
  const bare = line.trim().replace(/^#+\s*/, '').replace(/\*/g, '').trim();

  const canonical = (text: string): string => text.toUpperCase().replace(/[\s-]+/g, '_');

  const whole = canonical(bare.replace(/:$/, '').trim());
  if (ALL_HEADINGS.has(whole)) return { name: whole };

  const split = bare.match(/^([A-Za-z][A-Za-z _-]*?)\s*:\s*(.*)$/);
  if (!split) return undefined;
  const name = canonical(split[1].trim());
  if (!ALL_HEADINGS.has(name)) return undefined;
  // The text after the colon is this section's first body line. Discarding it would turn
  // "missing" into "declared but empty" — a distinction this parser deliberately keeps.
  const inlineBody = split[2].trim();
  return inlineBody ? { name, inlineBody } : { name };
}

/**
 * Split a Bead description into its sections, keyed by canonical heading name.
 *
 * The single parser for the 7-section contract. The gate uses it to decide admission and
 * the StepContract compiler uses it to read section bodies; a second parser would let the
 * two disagree about what a Bead says, which is worse than either being wrong alone.
 * Sections with an empty body are present as empty strings, so callers can tell "absent"
 * from "declared but empty".
 */
export function extractSections(description: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | undefined;
  let body: string[] = [];

  const flush = () => {
    if (current) sections.set(current, body.join('\n').trim());
  };

  for (const line of description.split('\n')) {
    const heading = headingOf(line);
    if (heading) {
      flush();
      current = heading.name;
      body = heading.inlineBody ? [heading.inlineBody] : [];
      continue;
    }
    if (current) body.push(line);
  }
  flush();

  return sections;
}

/** Max chars of a purpose excerpt carried on a fleet row. Single line, whitespace-collapsed. */
export const PURPOSE_EXCERPT_MAX = 60;

/**
 * One-line purpose excerpt for a fleet row, from an already-validated contract.
 *
 * First meaningful line of SCOPE, falling back to SUCCESS. Cheap and bounded:
 * whitespace-collapsed, single line, truncated to PURPOSE_EXCERPT_MAX chars.
 * Returns undefined when neither section yields text — the field is omitted,
 * never fabricated.
 */
export function extractPurposeExcerpt(description: string): string | undefined {
  const sections = extractSections(description ?? '');
  for (const name of ['SCOPE', 'SUCCESS'] as const) {
    const line = (sections.get(name) ?? '').split('\n').map(s => s.trim()).find(Boolean);
    if (!line) continue;
    const flat = line.replace(/\s+/g, ' ');
    return flat.length <= PURPOSE_EXCERPT_MAX ? flat : `${flat.slice(0, PURPOSE_EXCERPT_MAX - 1)}…`;
  }
  return undefined;
}

/** Extract the declared SCRUTINY level, if any. */
function scrutinyLevel(description: string): string | undefined {
  const match = description.match(/SCRUTINY\b[^\n]*\n?\s*\**\s*(LOW|MEDIUM|HIGH|CRITICAL)\b/i)
    ?? description.match(/SCRUTINY\b\s*[:\-—]?\s*(LOW|MEDIUM|HIGH|CRITICAL)\b/i);
  return match?.[1]?.toUpperCase();
}

/**
 * Decide whether a Bead is a dispatchable task contract.
 *
 * Returns a result rather than throwing so the caller owns the refusal shape — the host
 * renders one `DispatchRejectedError` for every rejection reason, and a gate that threw its
 * own error type would give operators two.
 */
export function evaluateBeadReadiness(bead: BeadRecord, options: BeadGateOptions = {}): BeadGateResult {
  const status = bead.status?.trim().toLowerCase();
  if (status && NON_DISPATCHABLE_STATUSES.has(status)) {
    return { ok: false, reason: `bead is ${status} and is not dispatchable`, missing: [] };
  }

  // An explicit draft marker is decisive. An ABSENT marker is not treated as draft: most
  // Beads predate the marker, and refusing them all would make the gate unusable.
  const contractState = (options.readContractState ?? readContractState)(bead.id);
  if (contractState === 'draft') {
    return {
      ok: false,
      reason: 'bead contract is marked draft — promote it with `bd set-state <id> contract=ready` first',
      missing: [],
    };
  }

  const description = bead.description ?? '';
  const sections = extractSections(description);
  const missing = REQUIRED_SECTIONS.filter(section => !sections.get(section));

  if (missing.length > 0) {
    return {
      ok: false,
      reason: 'bead is not a usable task contract: required sections are missing or empty',
      missing: [...missing],
    };
  }

  if (!scrutinyLevel(description)) {
    return {
      ok: false,
      reason: `bead declares no SCRUTINY level (expected one of ${SCRUTINY_LEVELS.join(', ')})`,
      missing: ['SCRUTINY'],
    };
  }

  return { ok: true };
}
