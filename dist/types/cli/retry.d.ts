export declare const RETRYABLE_JOB_STATUSES: Set<string>;
export interface RetryStatusSnapshot {
    id: string;
    specialist: string;
    status: string;
    bead_id?: string;
    worktree_path?: string;
}
export interface ParsedRetryArgs {
    jobId?: string;
    model?: string;
    background?: boolean;
}
export declare function parseRetryArgs(argv: readonly string[]): ParsedRetryArgs & {
    error?: string;
};
/**
 * Resolve the equivalent `sp run` arguments for a failed activation.
 * Returns `{ argv }` on success or `{ error }` with an actionable message.
 */
export declare function buildRetryArgv(status: RetryStatusSnapshot, opts: {
    model?: string;
    background?: boolean;
}): {
    argv: string[];
} | {
    error: string;
};
export declare function run(): Promise<void>;
//# sourceMappingURL=retry.d.ts.map