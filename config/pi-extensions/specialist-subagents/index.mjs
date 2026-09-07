// config/pi-extensions/specialist-subagents/index.mjs
//
// The PRIMARY coordinator surface named in the PRD — the Pi extension over
// `NativeActivationHost`. MCP (integrations/claude-code) is the other frontend;
// both serialise the SAME `InteractionMessage` protocol and the SAME
// `ActivationSnapshot` projection, and neither spawns a process. A tool that
// shelled out to `sp run` would satisfy the letter of "dispatch a Specialist"
// and defeat the entire purpose of the native runtime; nothing in this file
// constructs a child process (VALIDATION 2 asserts this on the process table).
//
// What this file does NOT do (and why):
//   - No permission logic. The capability invariant (PRD §112) — extension
//     installed != extension selected != capability granted — is enforced by the
//     host: only the resolved tool contract reaches the child session, plus the
//     two ask/escalate tools, fail-closed. `extension-tool-policy` remains the
//     single selector; nothing here reimplements it (PRD §113).
//   - No scheduler and no workflow engine (PRD non-goals). Dispatch is one
//     activation; the Fleet Registry inside the host is the persistent state.
//   - No second message vocabulary (PRD invariant BH). `specialist_reply`
//     correlates on `message_id` and nothing else; the answer returns as the
//     child's ask-tool result, resuming the same AgentSession.
//
// The host is a process-lifetime singleton created on first tool use: the
// FleetRegistry inside it is the seam that survives a turn boundary (VALIDATION
// 5). A per-turn host would answer `specialist_status` with an empty Fleet while
// children were still running.
//
// POLLING BUDGET (measured, not guessed): a child turn on a typical small model
// takes ~2 minutes (120s observed with deepseek-v4-flash), and the coordinator
// must keep polling specialist_status across the whole window. A loop that ends
// before settlement returns an empty result that looks like a fast failure —
// budget >= 3 minutes of polling before concluding an activation is stuck.

import { Type } from 'typebox';
import {
  DispatchRejectedError,
  NativeActivationHost,
  toActivationView,
  toPendingAskView,
} from '../../../dist/lib.js';

/** Default coordinator ParticipantId: <participant_kind>::<participant_role>, matching MCP. */
export const DEFAULT_REQUESTED_BY = 'adapter::pi-extension';

// ── Pi-surface result projection ─────────────────────────────────────────────

/**
 * Projection of the validated `ActivationResult` (PRD §37).
 *
 * This is what answers acceptance AU for the Pi coordinator: when a Specialist
 * settles, the coordinator RECEIVES its validated result here — status, output,
 * validation record, and the resolved model — rather than a bare "done" message.
 * `toActivationView` and `toPendingAskView` are IMPORTED from the shared frontend
 * module (src/tools/specialist/activation.tool.ts) so both coordinator surfaces
 * project identically; only this result projection is Pi-surface-specific.
 */
export function toResultView(result) {
  return {
    status: result.status,
    output: result.output ?? null,
    validation: result.validation,
    ...(result.piSessionId ? { pi_session_id: result.piSessionId } : {}),
    ...(result.configuredModel ? { configured_model: result.configuredModel } : {}),
    ...(result.requestedModel ? { requested_model: result.requestedModel } : {}),
    resolved_model: result.resolvedModel,
    model_override: result.modelOverride,
    fallback_used: result.fallbackUsed,
    completed_at: result.completedAt,
  };
}

/**
 * Attach a settled result to a shared `ActivationView` when one is available.
 * Additive-only over the MCP vocabulary: never mutates the shared projection.
 */
function withResult(view, result) {
  if (!result) return view;
  return { ...view, result: toResultView(result) };
}

/**
 * Render a refusal as a tool RESULT rather than a thrown error.
 *
 * A `DispatchRejectedError` is the gate working, not a malfunction: it carries
 * the structured reason an operator acts on (missing sections, held lease,
 * draft contract). Throwing it would reach the coordinator as an opaque error
 * string and lose `detail.missing[]` — the exact part that says what to write.
 */
function rejectionResult(error) {
  return {
    status: 'rejected',
    reason: error.message,
    detail: error.detail,
  };
}

// ── Extension factory ────────────────────────────────────────────────────────

/**
 * @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi
 * @param {{ createHost?: () => NativeActivationHost }} [options] — test seam;
 *   when omitted, one process-lifetime host is created on first tool use.
 */
export default function specialistSubagentsExtension(pi, options = {}) {
  /** One host for the life of the pi process — never per-turn (VALIDATION 5). */
  let host = null;
  const getHost = () => {
    if (!host) host = options.createHost ? options.createHost() : new NativeActivationHost();
    return host;
  };

  /** Settled ActivationResults by activation id, collected without blocking a turn. */
  const results = new Map();

  const disposeActivation = async (activationId, reason) => {
    await getHost().stop(activationId, reason);
    results.delete(activationId);
  };

  pi.registerTool({
    name: 'specialist_dispatch',
    label: 'Specialist dispatch',
    description:
      'Dispatch a Specialist on the native in-process runtime. No CLI process is ' +
      'spawned. Returns once the activation is ADMITTED and started, not when it ' +
      'completes — poll specialist_status for state and for any question it raises, ' +
      'and answer with specialist_reply. The Bead is the prompt and must be a complete ' +
      '7-section contract with a SCRUTINY level; a draft or incomplete Bead is refused ' +
      'here, before a model turn is spent guessing at scope it does not carry. ' +
      'Write-capable Specialists (MEDIUM/HIGH tiers) activate only when they can acquire ' +
      'the workspace lease; otherwise dispatch is refused with a structured reason.',
    promptSnippet: 'Dispatch an XTRM Specialist (specialist_dispatch: specialist, bead_id)',
    parameters: Type.Object({
      specialist: Type.String({ description: 'Specialist name, e.g. codebase-explorer' }),
      bead_id: Type.String({
        description:
          "The Bead that is this activation's task contract. `--bead` is the prompt: " +
          'there is no free-form task field, because supplementing an incomplete Bead ' +
          'through delegation prose is how durable work loses its scope.',
      }),
      model_override: Type.Optional(
        Type.String({
          description:
            'Override the configured model for THIS activation only. An unavailable ' +
            'model is refused before the session is created, never silently replaced.',
        }),
      ),
      requested_by: Type.Optional(
        Type.String({
          description:
            'ParticipantId of the requesting coordinator. Defaults to the Pi extension ' +
            'adapter participant.',
        }),
      ),
      coordinator_session_id: Type.Optional(
        Type.String({ description: 'Pi session id, for lineage.' }),
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const h = getHost();
      try {
        const handle = await h.start({
          specialist: params.specialist,
          beadId: params.bead_id,
          ...(params.model_override ? { modelOverride: params.model_override } : {}),
          requestedByParticipantId: params.requested_by ?? DEFAULT_REQUESTED_BY,
          ...(params.coordinator_session_id ? { coordinatorSessionId: params.coordinator_session_id } : {}),
        });

        // Deliberately NOT awaited (a tool that blocked until completion would make
        // every clarification a deadlock) and deliberately not dropped either: an
        // unhandled rejection on a failed activation would crash the pi process. The
        // host has already recorded the failure forensically and in the snapshot; the
        // settled result is projected through specialist_status.
        handle.result
          .then((result) => { results.set(handle.activationId, result); })
          .catch(() => { /* observed via specialist_status */ });

        const snapshot = h.inspect(handle.activationId);
        const view = snapshot ? toActivationView(snapshot) : { activation_id: handle.activationId };        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'dispatched',
              ...view,
              step_contract: {
                root_work_ref: handle.stepContract.rootWorkRef,
                inputs: handle.stepContract.inputs.length,
                outputs: handle.stepContract.outputs.length,
              },
            }, null, 2),
          }],
          details: {},
        };
      } catch (error) {
        if (error instanceof DispatchRejectedError) {
          return {
            content: [{ type: 'text', text: JSON.stringify(rejectionResult(error), null, 2) }],
            details: {},
          };
        }
        throw error;
      }
    },
  });

  pi.registerTool({
    name: 'specialist_status',
    label: 'Specialist fleet status',
    description:
      'The Fleet: every native activation this process hosts, with its state, and ' +
      'every outstanding question or escalation it is waiting on (answer those with ' +
      'specialist_reply). Settled activations carry their validated ActivationResult. ' +
      'No CLI background jobs are shown — this surface only hosts in-process ' +
      'activations.',
    promptSnippet: 'Show the Specialist Fleet (specialist_status)',
    parameters: Type.Object({}),
    async execute() {
      const h = getHost();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            activations: h.list().map((snapshot) =>
              withResult(toActivationView(snapshot), results.get(snapshot.activationId))),
            pending_asks: h.pendingAsks().map(toPendingAskView),
          }, null, 2),
        }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: 'specialist_reply',
    label: 'Specialist reply',
    description:
      'Answer an outstanding Specialist question or escalation by its message_id (read ' +
      'them from specialist_status.pending_asks). The answer returns as that tool call\'s ' +
      'result, so the Specialist continues with its context intact rather than being ' +
      'restarted with an answer pasted into a fresh prompt. An unknown or already ' +
      'answered message_id is reported, not silently accepted.',
    promptSnippet: 'Answer a Specialist question (specialist_reply: message_id, body)',
    parameters: Type.Object({
      message_id: Type.String({
        description:
          'The message_id of the outstanding ask, from specialist_status.pending_asks. ' +
          'Correlation is by message id and nothing else — there is no "answer the ' +
          'latest ask", because with two asks outstanding that is a coin flip.',
      }),
      body: Type.String({ description: 'The answer. Returned to the Specialist as its tool result.' }),
    }),
    async execute(toolCallId, params) {
      const message = await getHost().answer(params.message_id, params.body);
      if (!message) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'error',
              error: `No outstanding ask with message_id '${params.message_id}' — it may have been answered already, or its activation may have been disposed.`,
              message_id: params.message_id,
            }, null, 2),
          }],
          details: {},
        };
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'answered',
            message_id: message.messageId,
            in_reply_to: message.inReplyTo ?? null,
            activation_id: message.activationId,
            attempt_id: message.attemptId,
          }, null, 2),
        }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: 'specialist_stop_activation',
    label: 'Specialist stop',
    description:
      'Stop and dispose a native activation. This is the only ordinary path to ' +
      'disposal — a settled Specialist is waiting and resumable, not finished. ' +
      'There is no child process to signal; disposal is a method call on the ' +
      'in-process AgentSession.',
    promptSnippet: 'Stop a Specialist (specialist_stop_activation: activation_id)',
    parameters: Type.Object({
      activation_id: Type.String({ description: 'Activation to stop and dispose.' }),
      reason: Type.Optional(Type.String({ description: 'Recorded forensically with the disposal.' })),
    }),
    async execute(toolCallId, params) {
      if (!getHost().inspect(params.activation_id)) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'error',
              error: `Unknown activation: ${params.activation_id}`,
              activation_id: params.activation_id,
            }, null, 2),
          }],
          details: {},
        };
      }
      await disposeActivation(params.activation_id, params.reason ?? 'pi operator request');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'stopped',
            activation_id: params.activation_id,
          }, null, 2),
        }],
        details: {},
      };
    },
  });

  // A child must never outlive the coordinator process. Best-effort: stop and
  // dispose every live activation when the pi session shuts down.
  pi.on('session_shutdown', async () => {
    if (!host) return;
    for (const snapshot of host.list()) {
      try {
        await disposeActivation(snapshot.activationId, 'session shutdown');
      } catch {
        // Disposal during shutdown is best-effort.
      }
    }
  });
}