/**
 * Pre-creation validation of the model an activation will run on.
 *
 * An explicitly requested model that is unavailable must fail BEFORE the AgentSession
 * exists, rather than silently running on a different model — a Specialist that quietly
 * ran on a fallback produces results nobody can attribute.
 *
 * Two checks are required and neither is sufficient alone. This is not defensiveness; both
 * failure modes were reproduced against pi 0.84.3 and re-verified against 0.85.1:
 *
 *   - `resolveCliModel` given a KNOWN provider and an unknown model id returns a
 *     *fabricated* model with `error: undefined` and only a warning ("Using custom model
 *     id"). `hasConfiguredAuth(provider)` is then true, so an auth-only gate accepts a
 *     model that does not exist. Only the `no-match` diagnostic catches this.
 *   - A real model under a provider with no configured auth resolves cleanly through
 *     `resolveCliModel`. Only the auth check catches this.
 *
 * Provider *reachability* cannot be determined here — neither API probes the network. A
 * reachable-looking model that fails at request time is a runtime failure, not a dispatch
 * rejection, and must be reported as such.
 */
import type { PiSdk, PiModelRuntimeLike } from './pi-sdk.js';
export interface ModelGateResult {
    ok: boolean;
    /**
     * The resolved pi `Model` object.
     *
     * `createAgentSession` takes `model?: Model<any>`, NOT a provider-qualified string. A
     * string is accepted by the call and then fails at request time with "No API key found
     * for undefined", because the provider never resolves. The gate already holds the real
     * object, so it hands it over rather than making the host re-resolve it.
     */
    model?: {
        id?: string;
        provider?: string;
    };
    /** Provider-qualified id actually resolved, when available. Diagnostics/telemetry only. */
    resolvedModel?: string;
    provider?: string;
    /** Human-readable rejection reason; present iff `ok` is false. */
    reason?: string;
    diagnostics: Array<{
        type: string;
        code: string;
        message: string;
        pattern?: string;
    }>;
}
/**
 * Create a ModelRuntime suitable for availability checking.
 *
 * `refreshOnCreate: false` must NOT be used: it yields zero providers with configured
 * auth, which would make this gate reject every model. Suppress network with
 * `allowModelNetwork: false` instead and leave refresh alone.
 *
 * Measure auth with `hasConfiguredAuth(providerId)`, never with `getAvailable()`. On
 * 0.85.1 `getAvailable()` returns the full catalogue regardless of auth or of either
 * option, so a count-based check cannot tell the two modes apart. `hasConfiguredAuth`
 * reports 8 authed providers under normal creation and zero under `refreshOnCreate: false`,
 * which is the distinction this gate depends on.
 */
export declare function createGateModelRuntime(sdk: PiSdk): Promise<PiModelRuntimeLike>;
/**
 * Validate that `requested` is a real, authed model.
 *
 * @param requested provider-qualified model pattern, e.g. `anthropic/claude-sonnet-4-5`.
 */
export declare function validateModelAvailable(sdk: PiSdk, modelRuntime: PiModelRuntimeLike, requested: string): Promise<ModelGateResult>;
//# sourceMappingURL=model-gate.d.ts.map