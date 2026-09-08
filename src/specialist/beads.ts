// src/specialist/beads.ts
// Beads tracking for SpecialistRunner.
// Uses spawnSync with args array (no shell) to prevent injection.
// All methods are fire-and-forget: never throw, never crash a run.

import { spawnSync } from 'node:child_process';


export interface BeadDependency {
  id: string;
  title?: string;
  description?: string;
  notes?: string;
  status?: string;
  dependency_type?: string;
}

export interface BeadRecord {
  id: string;
  title: string;
  description?: string;
  notes?: string;
  parent?: string;
  status?: string;
  dependencies?: BeadDependency[];
}

export function buildBeadContext(bead: BeadRecord, completedBlockers: BeadRecord[] = [], epicAncestors: BeadRecord[] = []): string {
  // The exact bead id heads the context so an interactive launcher's turn-1
  // role=user message can obey claim/bead-id-verbatim discipline without
  // rediscovering the id (unitAI-edfjs). Templates may also interpolate
  // $bead_id, but every render surface routes through this one assembly, so
  // this is the single shared contract that carries the id for role and roleless.
  const lines = [`# Task: ${bead.title}`, `## Bead id: ${bead.id}`];

  if (bead.description?.trim()) {
    lines.push(bead.description.trim());
  }

  if (bead.parent?.trim()) {
    lines.push('', '## Parent epic', bead.parent.trim());
  }

  if (bead.notes?.trim()) {
    lines.push('', '## Notes', bead.notes.trim());
  }

  if (epicAncestors.length > 0) {
    lines.push('', '## Epic lineage');
    for (const ancestor of epicAncestors) {
      lines.push('', `### ${ancestor.title} (${ancestor.id})`);
      if (ancestor.description?.trim()) {
        lines.push(ancestor.description.trim());
      }
      if (ancestor.notes?.trim()) {
        lines.push('', ancestor.notes.trim());
      }
    }
  }

  if (completedBlockers.length > 0) {
    lines.push('', '## Context from completed dependencies:');
    for (const blocker of completedBlockers) {
      lines.push('', `### ${blocker.title} (${blocker.id})`);
      if (blocker.description?.trim()) {
        lines.push(blocker.description.trim());
      }
      if (blocker.notes?.trim()) {
        lines.push('', blocker.notes.trim());
      }
    }
  }

  return lines.join('\n').trim();
}

/**
 * Walk bead.parent upward, collecting up to `depth` ancestors (parent first).
 * Stops silently at a null/absent parent or an unreadable bead. Depth outside
 * 1|2 collects nothing; the tool layer refuses such values.
 */
export function collectEpicAncestors(
  readBead: (id: string) => BeadRecord | null,
  bead: Pick<BeadRecord, 'parent'>,
  depth: number | undefined,
): BeadRecord[] {
  if (depth !== 1 && depth !== 2) return [];
  const ancestors: BeadRecord[] = [];
  let parentId = bead.parent?.trim();
  for (let i = 0; i < depth && parentId; i++) {
    let parent: BeadRecord | null = null;
    try {
      parent = readBead(parentId);
    } catch {
      break;
    }
    if (!parent) break;
    ancestors.push(parent);
    parentId = parent.parent?.trim();
  }
  return ancestors;
}

export class BeadsClient {
  private readonly available: boolean;

  constructor() {
    this.available = BeadsClient.checkAvailable();
    if (!this.available) {
      console.warn('[specialists] bd CLI not found — beads tracking disabled');
    }
  }

  private static checkAvailable(): boolean {
    const result = spawnSync('bd', ['--version'], { stdio: 'ignore' });
    return result.status === 0;
  }

  isAvailable(): boolean {
    return this.available;
  }

  /** Create a bead for a specialist run. Returns the bead ID or null on failure. */
  createBead(specialistName: string): string | null {
    if (!this.available) return null;
    const result = spawnSync(
      'bd',
      ['q', `specialist:${specialistName}`, '--type', 'task', '--labels', 'specialist'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    if (result.status !== 0) return null;
    const id = result.stdout?.trim();
    return id || null;
  }

  /** Read a bead by ID. Returns null on any failure. */
  readBead(id: string): BeadRecord | null {
    if (!this.available || !id) return null;
    const result = spawnSync(
      'bd',
      ['show', id, '--json'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
    );
    if (result.error || result.status !== 0 || !result.stdout?.trim()) return null;

    try {
      const parsed = JSON.parse(result.stdout);
      const bead = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!bead || typeof bead !== 'object'
        || typeof bead.id !== 'string'
        || typeof bead.title !== 'string') return null;
      return bead as BeadRecord;
    } catch (err) {
      console.warn(`[specialists] readBead: JSON parse failed for id=${id}: ${err}`);
      return null;
    }
  }

  /**
   * Fetch completed blockers of a bead at the given depth.
   * depth=1 returns immediate completed blockers only.
   * depth=2 also includes their completed blockers, etc.
   */
  getCompletedBlockers(id: string, depth = 1): BeadRecord[] {
    if (!this.available || !id || depth < 1) return [];

    const result = spawnSync(
      'bd',
      ['dep', 'list', id, '--json'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
    );
    if (result.error || result.status !== 0 || !result.stdout?.trim()) return [];

    let deps: BeadDependency[];
    try {
      deps = JSON.parse(result.stdout);
      if (!Array.isArray(deps)) return [];
    } catch {
      return [];
    }

    const blockers = deps.filter(d => d.dependency_type === 'blocks' && d.status === 'closed');
    const records: BeadRecord[] = [];
    for (const dep of blockers) {
      const record = this.readBead(dep.id);
      if (record) {
        records.push(record);
        if (depth > 1) {
          records.push(...this.getCompletedBlockers(dep.id, depth - 1));
        }
      }
    }
    return records;
  }

  /** Link a tracking bead back to the input bead that supplied the prompt. */
  addDependency(trackingBeadId: string, inputBeadId: string): void {
    if (!this.available || !trackingBeadId || !inputBeadId) return;
    spawnSync('bd', ['dep', 'add', trackingBeadId, inputBeadId], { stdio: 'ignore' });
  }

  /** Close a bead with COMPLETE or ERROR status. */
  closeBead(id: string, status: 'COMPLETE' | 'ERROR' | 'CANCELLED', durationMs: number, model: string): void {
    if (!this.available || !id) return;
    const reason = `${status}, ${Math.round(durationMs)}ms, ${model}`;
    spawnSync('bd', ['close', id, '-r', reason], { stdio: 'ignore' });
  }

  /**
   * Close a bead only if it is currently open or in_progress.
   * Idempotent: no-op when bead is already closed/deferred/blocked or unreadable.
   * Used by supervisor terminal-state writes and `sp stop` to retire linked beads automatically (unitAI-9truh).
   */
  closeBeadIfInProgress(id: string, reason: string): boolean {
    if (!this.available || !id) return false;
    const bead = this.readBead(id);
    if (!bead) return false;
    if (bead.status !== 'open' && bead.status !== 'in_progress') return false;
    const result = spawnSync('bd', ['close', id, '-r', reason], { stdio: 'ignore' });
    return result.status === 0;
  }

  /** Append bead notes with specialist output or metadata. */
  updateBeadNotes(id: string, notes: string): { ok: boolean; error?: string } {
    if (!this.available || !id || !notes) return { ok: false, error: 'beads unavailable or empty payload' };
    const result = spawnSync('bd', ['update', id, '--append-notes', notes], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) {
      return { ok: false, error: result.error.message };
    }
    if (result.status !== 0) {
      const stderr = result.stderr?.trim();
      return { ok: false, error: stderr || `bd update failed with exit code ${result.status}` };
    }
    return { ok: true };
  }

  /** Record a bd audit entry linking the bead to the specialist invocation. */
  auditBead(id: string, toolName: string, model: string, exitCode: number): void {
    if (!this.available || !id) return;
    spawnSync(
      'bd',
      [
        'audit', 'record',
        '--kind', 'tool_call',
        '--tool-name', toolName,
        '--model', model,
        '--issue-id', id,
        '--exit-code', String(exitCode),
      ],
      { stdio: 'ignore' },
    );
  }
}

/**
 * Determine whether to create a bead for this specialist run.
 *
 * auto   — create bead only for non-READ_ONLY specialists (write-capable)
 * always — always create (discovery specialists: codebase-explorer, init-session)
 * never  — skip entirely (utility one-offs, fast runs)
 */
export function shouldCreateBead(
  beadsIntegration: 'auto' | 'always' | 'never',
  permissionRequired: string,
): boolean {
  if (beadsIntegration === 'never') return false;
  if (beadsIntegration === 'always') return true;
  return permissionRequired !== 'READ_ONLY';
}
