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
import type { ObservabilitySqliteClient } from '../specialist/observability-sqlite.js';
import type { ActivationForensicSink } from './native-host.js';
/**
 * Build a sink that appends native-activation events to `observability.db`.
 *
 * Passing `null` yields a no-op sink rather than throwing: forensics must never be the
 * reason a Specialist fails to start. A dropped event is a diagnostic loss; a refused
 * activation is a functional one.
 */
export declare function createActivationForensicSink(observability: ObservabilitySqliteClient | null): ActivationForensicSink;
//# sourceMappingURL=forensic-sink.d.ts.map