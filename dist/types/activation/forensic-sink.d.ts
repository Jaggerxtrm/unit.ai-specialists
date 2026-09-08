/**
 * Native-activation adapter for the canonical Specialists observability pipeline.
 *
 * Native and legacy activations write one `observability.db`. Native events are projected
 * onto the existing timeline vocabulary, written through the same append-event writer
 * (which mirrors every timeline row into `specialist_forensic_events`), and carry the
 * full v15 identity lineage. There is deliberately NO native-subagent telemetry database
 * and no second forensic model: a native activation and a legacy one are answerable by
 * one query against one store.
 *
 * Producer rule: raw Pi events enter through `sessionEvent` and are the sole producers of
 * turn, message, tool, retry, and compaction timeline rows. The host's legacy translated
 * `emit` aliases remain status-only to avoid duplicate rows. `activation_settled` stays on
 * `emit` and is the sole producer of the waiting status-change row.
 */
import type { ActivationForensicSink } from './native-host.js';
import type { ObservabilitySqliteClient } from '../specialist/observability-sqlite.js';
/**
 * Build a failure-isolated sink backed by the shared timeline/forensic writer.
 *
 * `null` remains a true no-op. A database failure is diagnostic loss and must never change
 * native activation behavior.
 */
export declare function createActivationForensicSink(observability: ObservabilitySqliteClient | null): ActivationForensicSink;
//# sourceMappingURL=forensic-sink.d.ts.map