/**
 * Resolution of the Pi coding-agent SDK for native (in-process) Specialist activation.
 *
 * Specialists deliberately does NOT take a hard dependency on
 * `@earendil-works/pi-coding-agent`. The operator installs `pi` globally and pins its
 * version; hard-depending here would version-couple the two and force a Specialists
 * release for every pi release. Instead we resolve the SDK at runtime, preferring a
 * normal module resolution and falling back to the global install — the same precedent
 * `resolveGlobalNodeModulesDir()` (src/pi/session.ts) already sets for locating pi assets.
 *
 * The legacy `sp run` path spawns the `pi` binary and speaks RPC to it, so it needs none
 * of this. Only the native activation host, which hosts an `AgentSession` inside this
 * process, imports the SDK.
 *
 * An `AgentSession` does not require running inside pi's own process — `createAgentSession`
 * builds a session in whatever Node/Bun process calls it. That is what allows both the Pi
 * extension and the Claude Code MCP server to host children directly rather than shelling
 * out.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveGlobalNodeModulesDir } from '../pi/session.js';

export const PI_SDK_PACKAGE = '@earendil-works/pi-coding-agent';

/**
 * The subset of the Pi SDK the native activation host uses.
 *
 * Typed structurally rather than by importing pi's declarations, because the package is an
 * optional runtime peer: a type-level import would make `tsc` fail wherever pi is not
 * installed. Members are validated at load time by {@link loadPiSdk}.
 */
export interface PiSdk {
  createAgentSession: (options?: Record<string, unknown>) => Promise<{
    session: PiAgentSessionLike;
    extensionsResult?: unknown;
    modelFallbackMessage?: string;
  }>;
  ModelRuntime: { create: (options?: Record<string, unknown>) => Promise<PiModelRuntimeLike> };
  resolveModelScopeWithDiagnostics: (
    patterns: string[],
    modelRuntime: PiModelRuntimeLike,
  ) => Promise<PiModelScopeResult> | PiModelScopeResult;
  defineTool: (definition: Record<string, unknown>) => unknown;
}

/** Minimal structural view of a live Pi `AgentSession`. */
export interface PiAgentSessionLike {
  readonly sessionId: string;
  readonly messages: unknown[];
  readonly isIdle: boolean;
  prompt(text: string, options?: Record<string, unknown>): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(listener: (event: PiAgentSessionEvent) => void): () => void;
  getActiveToolNames(): string[];
  setActiveToolsByName(names: string[]): void;
  waitForIdle(): Promise<void>;
}

/**
 * Session events the host observes.
 *
 * `agent_end` fires per model turn and carries `willRetry`; `agent_settled` is the
 * governed quiescence boundary. They are NOT equivalent, and settling must never be
 * treated as completion or as a reason to dispose — a settled Specialist stays resumable.
 */
export interface PiAgentSessionEvent {
  type: string;
  willRetry?: boolean;
  [key: string]: unknown;
}

export interface PiModelRuntimeLike {
  hasConfiguredAuth(providerId: string): boolean | Promise<boolean>;
  getAvailable?: () => Promise<unknown[]>;
}

export interface PiModelScopeResult {
  scopedModels: Array<{ model: { id?: string; provider?: string }; thinkingLevel?: string }>;
  diagnostics: Array<{ type: string; code: string; message: string; pattern?: string }>;
}

const REQUIRED_EXPORTS = [
  'createAgentSession',
  'ModelRuntime',
  'resolveModelScopeWithDiagnostics',
  'defineTool',
] as const;

export class PiSdkUnavailableError extends Error {
  constructor(public readonly attempted: string[], cause?: unknown) {
    super(
      `Native Specialist activation requires ${PI_SDK_PACKAGE}, which could not be resolved.\n` +
        `Tried:\n${attempted.map(p => `  • ${p}`).join('\n')}\n` +
        `Install pi (npm i -g ${PI_SDK_PACKAGE}) or add it as a dependency. ` +
        `The legacy 'sp run' path does not require it.`,
    );
    this.name = 'PiSdkUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}

let cached: PiSdk | undefined;

/** Candidate specifiers, most-preferred first. Exported for diagnostics and tests. */
export function piSdkCandidates(): string[] {
  const candidates = [PI_SDK_PACKAGE];
  const globalDir = resolveGlobalNodeModulesDir();
  if (globalDir) {
    const entry = join(globalDir, PI_SDK_PACKAGE, 'dist', 'index.js');
    if (existsSync(entry)) candidates.push(pathToFileURL(entry).href);
  }
  return candidates;
}

/**
 * Load the Pi SDK, preferring normal resolution and falling back to the global install.
 *
 * Throws {@link PiSdkUnavailableError} rather than returning a partial module: a native
 * activation that starts without a validated SDK would fail deep inside session creation,
 * where the error is far less actionable. The result is cached for the process.
 */
export async function loadPiSdk(): Promise<PiSdk> {
  if (cached) return cached;

  const attempted = piSdkCandidates();
  let lastError: unknown;

  for (const specifier of attempted) {
    try {
      const mod = (await import(specifier)) as Partial<PiSdk>;
      const missing = REQUIRED_EXPORTS.filter(name => typeof mod[name] === 'undefined');
      if (missing.length > 0) {
        lastError = new Error(`${specifier} is missing exports: ${missing.join(', ')}`);
        continue;
      }
      cached = mod as PiSdk;
      return cached;
    } catch (error) {
      lastError = error;
    }
  }

  throw new PiSdkUnavailableError(attempted, lastError);
}

/** Test seam: drop the cached module so a test can supply its own. */
export function resetPiSdkCache(): void {
  cached = undefined;
}

/** Test seam: install a stub SDK without touching module resolution. */
export function setPiSdkForTesting(sdk: PiSdk | undefined): void {
  cached = sdk;
}
