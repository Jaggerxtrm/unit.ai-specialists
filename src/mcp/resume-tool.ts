/**
 * MCP `specialist_resume` over `NativeActivationHost.resume` (Wave E4, Resume-only).
 *
 * Mirrors the Pi extension tool of the same name field-for-field: same params
 * (`activation_id`, `prompt`), same session continuity (id kept, attempt
 * advances), same unknown-activation error shape, same refusal-as-result rule.
 * The host is the SAME instance that dispatch/reply/stop use — resume adds no
 * authority and no second resolver. Refusals render through the shared
 * `renderRejection`, so reason strings stay byte-identical to every other
 * MCP refusal surface.
 *
 * Returns admission + view synchronously (`resultType: complete`); the new
 * attempt's validated result settles into the pusher exactly like a dispatch
 * result, so `specialist_status` projects it with no extra path.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as z from 'zod';
import { describeBuildIdentity, readBuildId } from '../activation/build-identity.js';
import { renderRejection } from '../activation/rejection.js';
import { DispatchRejectedError } from '../activation/types.js';
import type { NativeActivationHost } from '../activation/native-host.js';
import type { RuntimeEventPusher } from '../activation/async-events.js';
import { toActivationView } from '../tools/specialist/activation.tool.js';

// Same loaded-vs-on-disk artifact comparison the dispatch tool renders: this
// module runs in two layouts (src/ under tsx/vitest, bundled dist in
// production), so the on-disk artifact is located by candidate from HERE
// (src/mcp/ — one level shallower than src/tools/specialist/).
const DIST_LIB_PATH = (() => {
  for (const candidate of ['./lib.js', '../../dist/lib.js']) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) return path;
  }
  return fileURLToPath(new URL('../../dist/lib.js', import.meta.url));
})();
const LOADED_BUILD_ID = readBuildId(DIST_LIB_PATH);

export const specialistResumeSchema = z.object({
  activation_id: z.string().describe('The settled or waiting activation to resume.'),
  prompt: z.string().describe('The new instruction for the resumed Specialist.'),
});

/**
 * Resume a settled or waiting activation in the SAME session.
 *
 * Not a second dispatch: `activation_id` is kept and `attempt_id` advances, so
 * the child keeps its context and workspace lease rather than starting over.
 * A disposed activation cannot be resumed — that is what makes
 * `specialist_stop_activation` the irreversible one.
 */
export function createSpecialistResumeTool(
  getHost: () => NativeActivationHost,
  getPusher?: () => RuntimeEventPusher | undefined,
) {
  return {
    name: 'specialist_resume' as const,
    description:
      'Resume a settled or waiting Specialist with a new prompt, in the SAME session. ' +
      'This is not a second dispatch: the activation_id is kept and the attempt_id advances, ' +
      'so the child keeps its context and its workspace lease rather than starting over. ' +
      'Use this after answering a question, or to give a settled Specialist more work. ' +
      'A disposed activation cannot be resumed — that is what makes specialist_stop_activation ' +
      'the irreversible one.',
    inputSchema: specialistResumeSchema,
    async execute(input: z.infer<typeof specialistResumeSchema>) {
      const build = () => describeBuildIdentity(LOADED_BUILD_ID, readBuildId(DIST_LIB_PATH));
      const before = getHost().inspect(input.activation_id);
      if (!before) {
        return {
          status: 'error' as const,
          error: `Unknown activation: ${input.activation_id}`,
          activation_id: input.activation_id,
        };
      }
      // Capture the VALUE now. `inspect` hands back the host's live snapshot
      // object, not a copy, and `resume` mutates it in place — reading
      // `before.attemptId` after the resume returns the NEW attempt.
      const previousAttemptId = before.attemptId;
      try {
        const handle = await getHost().resume(input.activation_id, input.prompt);
        // Same observation contract as dispatch: never await (admit-not-block),
        // never drop (an unhandled rejection would take the server down). The
        // new attempt's result overwrites the stale one under the same id, so
        // `specialist_status` projects the latest settlement with no extra path.
        const pusher = getPusher?.();
        handle.result.then(
          async (result) => {
            if (!pusher) return;
            pusher.settle(result);
            await pusher.pushCompletion(handle.activationId).catch(() => { /* degraded to polling */ });
          },
          () => { /* observed via specialist_status */ },
        );
        const snapshot = getHost().inspect(handle.activationId);
        return {
          status: 'resumed' as const,
          previous_attempt_id: previousAttemptId,
          ...(snapshot ? toActivationView(snapshot) : { activation_id: handle.activationId }),
        };
      } catch (error) {
        // A refusal is the gate working, so it stays a returned tool result —
        // throwing would reach the coordinator as an opaque MCP error string.
        // Shape comes from the shared renderer: reason strings byte-identical
        // to what the host threw.
        if (error instanceof DispatchRejectedError) {
          return renderRejection(
            { reason: error.message, detail: error.detail, missing: error.detail.missing },
            build(),
          );
        }
        throw error;
      }
    },
  };
}
