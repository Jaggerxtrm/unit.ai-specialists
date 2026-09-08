import type { ForensicEventRecord } from './observability-sqlite.js';
export interface NativeActivationSummary {
    activation_id: string;
    specialist: string;
    bead_id?: string;
    /** Last-known lifecycle state derived from the latest forensic event. */
    state: string;
    last_event: string;
    last_event_at_ms: number;
    first_event_at_ms: number;
    event_count: number;
    turns: number;
    pi_session_id?: string;
    /** Error / stop reason for failed or disposed activations. */
    detail?: string;
}
/**
 * Group forensic activation rows by job (activation) id and derive one
 * last-known summary per activation, newest first. Pure: takes rows, returns
 * summaries. Rows are expected from readForensicEvents({eventFamily:
 * 'activation'}) but any order is tolerated — latest is picked by (t, seq).
 */
export declare function summarizeNativeActivations(rows: readonly ForensicEventRecord[]): NativeActivationSummary[];
export declare function formatActivationAge(nowMs: number, atMs: number): string;
//# sourceMappingURL=native-activation-summary.d.ts.map