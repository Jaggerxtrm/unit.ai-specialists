/**
 * Mutating tools that consult the workspace lease before they run — PRD §52,
 * unitAI-rrdnt.36.2.
 *
 * The lease was wired at admission and release (unitAI-rrdnt.36.1) and that half works:
 * two activations cannot both hold one worktree, because the second is refused before a
 * session exists. What was missing is the block DURING a turn. `admitToolCall` existed,
 * was correct, emitted `tool_blocked`, failed closed on an unknown activation — and had no
 * caller. A guard nothing calls is not a guard.
 *
 * The obvious fix is to make each frontend call it. That is the wrong shape: it makes
 * enforcement optional, and the next frontend forgets without anything going red. Here the
 * host constructs the mutating builtins itself and wraps their `execute`, so the only
 * mutating tool the child can reach IS the guarded one. A frontend that wires nothing
 * cannot produce an unguarded activation, because the frontend is not involved.
 *
 * NOT `setActiveToolsByName`: within a turn the agent loop runs against a tool snapshot
 * taken at turn start, so revoking a tool cannot cancel a call that is already planned.
 * Every handler in a batch fires before any execution, which is why a per-call verdict is
 * enforceable where a tool-set change is not.
 *
 * KNOWN HOLE, unclosed and not closable on pi 0.85.1: this covers the LLM tool path only.
 * `AgentSession.executeBash()` and `pi.exec()` never route through a tool at all, so an
 * extension mutating through those bypasses this entirely (unitAI-rrdnt.6).
 */

import type { PiSdk } from './pi-sdk.js';
import type { AdmissionVerdict } from './workspace-lease.js';

/** The SDK's tool-result shape. A bare string is normalised to empty content. */
interface AgentToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
}

interface ToolLike {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
}

/**
 * The pi builtins that can mutate a workspace, and the factory that rebuilds each.
 *
 * Deliberately an ALLOWLIST of four rather than `isMutatingTool`, which is the inverse — a
 * denylist of known read-only names, so it answers true for everything else including
 * `structured_return`, `goal_complete` and the task tools. That predicate is right inside
 * `admitToolCall`, where the question is "may this call proceed"; it is wrong here, where
 * the question is "which tools must I replace", and using it refuses every dispatch.
 *
 * These four are what pi exposes that writes to the filesystem or runs a command. A tool
 * outside this list either does not touch the workspace or is not pi's to construct, and
 * the runtime check inside each wrapper is the second line either way.
 */
const FACTORY_NAMES: Record<string, string> = {
  edit: 'createEditTool',
  write: 'createWriteTool',
  bash: 'createBashTool',
  powershell: 'createPowerShellTool',
};

export interface GuardedToolsResult {
  /** Guarded replacements, to be passed as `customTools`. */
  tools: unknown[];
  /** Names successfully guarded. These stay in the allowlist. */
  guarded: string[];
  /**
   * Names in the allowlist that this runtime says are mutators but cannot reconstruct.
   *
   * Empty on pi 0.85.1, which exports a factory for all four. Kept because the failure it
   * describes is silent and severe: a mutating tool passed through unwrapped makes the
   * lease decorative for exactly the calls it exists to stop, so the caller must decide
   * explicitly rather than inherit a gap.
   */
  unguardable: string[];
}

/**
 * Build guarded replacements for every mutating tool in a resolved allowlist.
 *
 * `admit` is called at execution time, never captured, so it reads live lease state: a
 * lease that turns uncertain mid-turn blocks the next call rather than the next turn.
 */
export function createGuardedTools(
  sdk: PiSdk,
  input: {
    toolNames: readonly string[];
    cwd: string;
    admit: (toolName: string) => AdmissionVerdict;
  },
): GuardedToolsResult {
  const sdkAny = sdk as unknown as Record<string, ((cwd: string, options?: unknown) => ToolLike) | undefined>;
  const tools: unknown[] = [];
  const guarded: string[] = [];
  const unguardable: string[] = [];

  for (const name of input.toolNames) {
    const key = name.trim().toLowerCase();
    const factoryName = FACTORY_NAMES[key];
    if (!factoryName) continue;

    const factory = sdkAny[factoryName];
    if (!factory) { unguardable.push(name); continue; }

    const original = factory(input.cwd);
    const originalExecute = original.execute.bind(original);

    tools.push({
      ...original,
      execute: async (...args: unknown[]): Promise<unknown> => {
        const verdict = input.admit(name);
        if (verdict.allow) return originalExecute(...args);

        // A refusal is a tool RESULT, not a throw. The child must see why it was blocked
        // and be able to react — an exception reads as a broken tool and invites a retry
        // loop against a lease that is not going to change on its own.
        const refusal: AgentToolResult = {
          content: [{
            type: 'text',
            text: `Refused: ${verdict.reason ?? `${name} is not admitted against this workspace`}`,
          }],
          details: { blocked: true, tool: name },
        };
        return refusal;
      },
    });
    guarded.push(name);
  }

  return { tools, guarded, unguardable };
}
