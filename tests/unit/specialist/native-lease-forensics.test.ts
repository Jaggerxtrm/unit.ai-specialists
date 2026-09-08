import { describe, it, expect } from 'vitest';
import {
  mapNativeLifecycleEvent,
  NATIVE_LIFECYCLE_OBSERVABILITY_GAPS,
} from '../../../src/specialist/native-activation-observability.js';

/**
 * unitAI-rrdnt.58. Phase 7 dropped every lease event because "workspace-lease contention has
 * no legacy runner concept". There is genuinely no legacy event to COMPARE against — which
 * makes these uncomparable, not unimportant. Parity means a native activation answers the same
 * queries a legacy one does, not that it may only emit events legacy also emits.
 *
 * Measured consequence before this fix: `SELECT ... WHERE event_name LIKE '%lease%'` returned
 * nothing for the entire history of the store, so a write refused for lease contention left no
 * durable trace at all — and PRD acceptance V (a blocked write emits a forensic event) was
 * unsatisfiable.
 */

const CONTEXT = { startedAtMs: 0, workspacePath: '/ws' };
const base = (name: string, payload?: Record<string, unknown>) => ({
  activationId: 'act:1', specialist: 'executor', beadId: 'bd-1', name, payload,
});

describe('lease events reach the timeline (unitAI-rrdnt.58)', () => {
  it.each(['lease_acquired', 'lease_denied', 'lease_uncertain', 'tool_blocked'])(
    'maps %s to a durable control_signal rather than dropping it',
    (name) => {
      const mapped = mapNativeLifecycleEvent(base(name), CONTEXT, 1000);
      expect(mapped, `${name} was dropped — a blocked write must leave a trace`).not.toBeNull();
      expect(mapped).toMatchObject({ type: 'control_signal', action: name, t: 1000 });
    },
  );

  it('carries the refusal reason, which is the only reason the row is worth having', () => {
    const mapped = mapNativeLifecycleEvent(
      base('lease_denied', { reason: 'workspace_lease_unavailable', holder: 'act:other' }),
      CONTEXT, 1000,
    ) as Record<string, unknown>;

    expect(mapped.reason).toBe('workspace_lease_unavailable');
    expect(mapped.holder).toBe('act:other');
    expect(mapped.bead_id).toBe('bd-1');
  });

  it('no longer claims in the gap table that these are intentionally unmapped', () => {
    // The table is the file's own account of what it drops. Leaving these listed while mapping
    // them would reproduce the defect this epic keeps finding: prose disagreeing with code.
    for (const name of ['lease_acquired', 'lease_denied', 'lease_uncertain', 'tool_blocked']) {
      expect(NATIVE_LIFECYCLE_OBSERVABILITY_GAPS).not.toHaveProperty(name);
    }
  });

  it('leaves genuinely unmapped lifecycle names alone', () => {
    expect(mapNativeLifecycleEvent(base('activation_requested'), CONTEXT, 1000)).toBeNull();
    expect(NATIVE_LIFECYCLE_OBSERVABILITY_GAPS).toHaveProperty('activation_requested');
  });
});
