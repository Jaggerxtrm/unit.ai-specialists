export declare const OBSERVABILITY_SCHEMA_VERSION = 15;
export interface ObservabilityDbLocation {
    gitRoot: string;
    dbDirectory: string;
    dbPath: string;
    dbWalPath: string;
    dbShmPath: string;
    source: 'git-root' | 'xdg-data-home';
}
export declare function resolveObservabilityDbLocation(cwd?: string): ObservabilityDbLocation;
export declare function ensureObservabilityDbFile(location: ObservabilityDbLocation): {
    created: boolean;
};
export declare function ensureGitignoreHasObservabilityDbEntries(gitRoot: string): {
    changed: boolean;
};
export declare function isObservabilityDbInitialized(location: ObservabilityDbLocation): boolean;
export declare function isPathInsideJobsDirectory(pathToCheck: string, gitRoot: string): boolean;
//# sourceMappingURL=observability-db.d.ts.map