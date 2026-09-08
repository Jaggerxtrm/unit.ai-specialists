export declare const BUILD_ID_BYTES = 12;
export declare const UNKNOWN_BUILD_ID = "unknown";
/** sha256 hex of a file's bytes. Throws if the file cannot be read. */
export declare function hashFileBytes(path: string): string;
export declare function shortBuildId(hash: string): string;
/** Short content id of an artifact file, or 'unknown' — never throws. */
export declare function readBuildId(path: string): string;
/**
 * One line stating which build rendered this outcome and whether the
 * artifact on disk has changed since this process loaded it. When the ids
 * differ the line names staleness outright, so a stale-build refusal can
 * never again read as a broken contract.
 */
export declare function describeBuildIdentity(loadedId: string, onDiskId: string): string;
//# sourceMappingURL=build-identity.d.ts.map