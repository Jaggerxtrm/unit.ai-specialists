/**
 * Forensic sink for native activations, writing the canonical `observability.db`.
 *
 * There is deliberately NO native-subagent telemetry database. Native activations and
 * legacy `sp run` activations must be answerable by one query against one store, or
 * "which Specialists touched this Bead?" gets two different answers depending on which
 * runtime happened to serve the request.
 *
 * This is a thin adapter, not a second forensic model: it reuses `createForensicEvent`
 * and `appendForensicEvent` exactly as the MCP gateway does (`src/server.ts`), which is
 * the existing precedent for a non-runner component writing forensic rows.
 *
 * Identity note: `attempt_id` and `pi_session_id` have no dedicated columns in the current
 * schema, so they are carried in the event body and in `correlation` where a field exists.
 * Promoting them to indexed columns is tracked separately — until that lands, attempt-level
 * lineage is present in the data but not efficiently queryable.
 */

import { createForensicEvent, deploymentEnvironment, type ForensicSeverity } from './../specialist/forensic-events.js';
import type { ObservabilitySqliteClient } from '../specialist/observability-sqlite.js';
import type { ActivationForensicSink } from './native-host.js';

/** Event names that denote a failure, so severity is not guessed at each call site. */
const ERROR_EVENTS = new Set([
  'activation_rejected',
  'activation_failed',
  'output_validation_failed',
  'retry_failed',
  'tool_blocked',
  'lease_denied',
]);

const WARN_EVENTS = new Set([
  'activation_uncertain',
  'lease_uncertain',
  'retry_started',
]);

function severityFor(name: string): ForensicSeverity {
  if (ERROR_EVENTS.has(name)) return 'error';
  if (WARN_EVENTS.has(name)) return 'warn';
  return 'info';
}

/**
 * Build a sink that appends native-activation events to `observability.db`.
 *
 * Passing `null` yields a no-op sink rather than throwing: forensics must never be the
 * reason a Specialist fails to start. A dropped event is a diagnostic loss; a refused
 * activation is a functional one.
 */
export function createActivationForensicSink(
  observability: ObservabilitySqliteClient | null,
): ActivationForensicSink {
  if (!observability) return { emit: () => {} };

  return {
    emit(event) {
      try {
        observability.appendForensicEvent(
          event.activationId,
          event.specialist,
          event.beadId,
          createForensicEvent({
            event_family: 'activation',
            event_name: `activation.${event.name}`,
            severity: severityFor(event.name),
            resource: {
              service_namespace: 'xtrm',
              service_name: 'specialists',
              service_component: 'native-activation-host',
              deployment_environment: deploymentEnvironment(),
              repo: 'specialists',
              participant_kind: 'specialist',
              participant_role: event.specialist,
            },
            correlation: {
              participant_id: event.participantId,
              job_id: event.activationId,
              bead_id: event.beadId,
            },
            body: {
              attempt_id: event.attemptId,
              ...(event.payload ?? {}),
            },
          }),
        );
      } catch {
        // Never let a forensic write failure abort an activation.
      }
    },
  };
}
