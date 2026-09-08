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
export declare function buildBeadContext(bead: BeadRecord, completedBlockers?: BeadRecord[], epicAncestors?: BeadRecord[]): string;
/**
 * Walk bead.parent upward, collecting up to `depth` ancestors (parent first).
 * Stops silently at a null/absent parent or an unreadable bead. Depth outside
 * 1|2 collects nothing; the tool layer refuses such values.
 */
export declare function collectEpicAncestors(readBead: (id: string) => BeadRecord | null, bead: Pick<BeadRecord, 'parent'>, depth: number | undefined): BeadRecord[];
export declare class BeadsClient {
    private readonly available;
    constructor();
    private static checkAvailable;
    isAvailable(): boolean;
    /** Create a bead for a specialist run. Returns the bead ID or null on failure. */
    createBead(specialistName: string): string | null;
    /** Read a bead by ID. Returns null on any failure. */
    readBead(id: string): BeadRecord | null;
    /**
     * Fetch completed blockers of a bead at the given depth.
     * depth=1 returns immediate completed blockers only.
     * depth=2 also includes their completed blockers, etc.
     */
    getCompletedBlockers(id: string, depth?: number): BeadRecord[];
    /** Link a tracking bead back to the input bead that supplied the prompt. */
    addDependency(trackingBeadId: string, inputBeadId: string): void;
    /** Close a bead with COMPLETE or ERROR status. */
    closeBead(id: string, status: 'COMPLETE' | 'ERROR' | 'CANCELLED', durationMs: number, model: string): void;
    /**
     * Close a bead only if it is currently open or in_progress.
     * Idempotent: no-op when bead is already closed/deferred/blocked or unreadable.
     * Used by supervisor terminal-state writes and `sp stop` to retire linked beads automatically (unitAI-9truh).
     */
    closeBeadIfInProgress(id: string, reason: string): boolean;
    /** Append bead notes with specialist output or metadata. */
    updateBeadNotes(id: string, notes: string): {
        ok: boolean;
        error?: string;
    };
    /** Record a bd audit entry linking the bead to the specialist invocation. */
    auditBead(id: string, toolName: string, model: string, exitCode: number): void;
}
/**
 * Determine whether to create a bead for this specialist run.
 *
 * auto   — create bead only for non-READ_ONLY specialists (write-capable)
 * always — always create (discovery specialists: codebase-explorer, init-session)
 * never  — skip entirely (utility one-offs, fast runs)
 */
export declare function shouldCreateBead(beadsIntegration: 'auto' | 'always' | 'never', permissionRequired: string): boolean;
//# sourceMappingURL=beads.d.ts.map