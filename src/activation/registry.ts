/**
 * FleetRegistry — the persistent store behind `NativeActivationHost`.
 *
 * A coordinator turn ends and starts many times; the Fleet must not. This is the seam that
 * survives a turn boundary: it owns activation records (identity, live session, and the
 * result each is running toward) and exposes only `ActivationSnapshot` outward, so the Pi
 * extension, the Claude Code MCP server and a future Chain scheduler all read the same
 * transport-neutral shape rather than reaching into host internals.
 */

import type { PiAgentSessionLike } from './pi-sdk.js';
import type { ActivationSnapshot, AttemptId } from './types.js';
import type { StepContract } from './step-contract.js';

/** Everything the host needs to keep a running or resumable activation alive. */
export interface ActivationRecord {
  snapshot: ActivationSnapshot;
  session: PiAgentSessionLike;
  /** Detaches the host's own lifecycle listener; re-created on every `resume()`. */
  unsubscribe: () => void;
  result: Promise<unknown>;
  /** Derived, never persisted independently — carried so a resumed handle can return it. */
  stepContract: StepContract;
}

export class FleetRegistry {
  private readonly records = new Map<string, ActivationRecord>();

  register(record: ActivationRecord): void {
    this.records.set(record.snapshot.activationId, record);
  }

  get(activationId: string): ActivationRecord | undefined {
    return this.records.get(activationId);
  }

  remove(activationId: string): void {
    this.records.delete(activationId);
  }

  /** Transport-neutral projection of every activation this process knows about. */
  list(): ActivationSnapshot[] {
    return [...this.records.values()].map(r => r.snapshot);
  }

  projection(activationId: string): ActivationSnapshot | undefined {
    return this.records.get(activationId)?.snapshot;
  }
}

/**
 * Next attempt id for a resumed activation: `att:<suffix>:<n>` -> `att:<suffix>:<n+1>`.
 *
 * Resume never mints a new activation id — only the attempt counter advances, per the
 * identity model in types.ts (retries/resumes are attempts under one activation).
 */
export function nextAttemptId(current: AttemptId): AttemptId {
  const match = /^(.*):(\d+)$/.exec(current);
  if (!match) return `${current}:2`;
  const [, prefix, count] = match;
  return `${prefix}:${Number(count) + 1}`;
}

/** States from which `resume()` may start a new attempt. Running/starting/disposed cannot. */
export const RESUMABLE_STATES = new Set(['settled', 'waiting', 'needs_reply', 'escalated']);
