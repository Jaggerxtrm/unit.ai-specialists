import type { DispatchRejectedError } from './types.js';
/**
 * Shared refusal renderer (unitAI-t2kol.4).
 *
 * Three renderers described one gate: the Pi bead-path `{status,reason,detail}`
 * plus build, the Pi inline-path `{status,reason,missing}` plus build, and the
 * MCP local `{status,reason,detail}` with no build and `missing` buried in
 * detail. An MCP operator could not see top-level `missing` and could not tell
 * a stale-build refusal from a broken-contract refusal. This is the single
 * renderer both frontends use; the Pi extension adopts it as a follow-up.
 *
 * Pure given explicit inputs: the caller renders the build string with
 * `describeBuildIdentity(loadedId, readBuildId(path))` and passes it in, so
 * tests never touch the filesystem. `missing` is promoted to the top level by
 * the caller and is never stripped from `detail` where the host put it — the
 * envelope stays byte-identical to what the host threw.
 */
export interface RejectionInput {
    reason: string;
    detail?: DispatchRejectedError['detail'];
    missing?: string[];
}
export declare function renderRejection(input: RejectionInput, build?: string): {
    build?: string | undefined;
    missing?: string[] | undefined;
    detail?: {
        specialist?: string;
        beadId?: string;
        missing?: string[];
        workspace?: string;
        holder?: string;
        requestedModel?: string;
        activationId?: string;
        note?: string;
    } | undefined;
    status: "rejected";
    reason: string;
};
//# sourceMappingURL=rejection.d.ts.map