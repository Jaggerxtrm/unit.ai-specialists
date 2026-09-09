export declare const STATIC_WORKFLOW_RULES_BLOCK: string;
export interface MemoryRecord {
    key: string;
    value: string;
}
export interface MemoryInjectionResult {
    block: string;
    memories: MemoryRecord[];
    estimatedTokens: number;
}
export declare function extractMemoryKeywords(title: string, description?: string): string[];
export declare function parseMemoriesPayload(jsonText: string): MemoryRecord[];
export declare function shouldRefreshCache(args: {
    nowMs: number;
    cacheCount: number | null;
    cacheLastSyncAtMs: number | null;
    sourceCount: number;
}): boolean;
export declare function syncMemoriesCacheFromBd(_cwd: string, _nowMs?: number, _forceFullSync?: boolean): {
    synced: boolean;
    memoryCount: number;
};
export declare function invalidateAndRefreshMemoriesCache(_cwd: string, _nowMs?: number): {
    synced: boolean;
    memoryCount: number;
};
export declare function buildFilteredMemoryInjection(_args: {
    cwd: string;
    beadTitle: string;
    beadDescription?: string;
}): MemoryInjectionResult;
export declare function estimateInjectedTokens(text: string): number;
//# sourceMappingURL=memory-retrieval.d.ts.map