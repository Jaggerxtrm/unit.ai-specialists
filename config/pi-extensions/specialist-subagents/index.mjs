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
  createActivationForensicSink,
  createObservabilitySqliteClientAtPath,
  DispatchRejectedError,
  NativeActivationHost,
  resolveObservabilityDbLocation,
  toActivationView,
  toPendingAskView,
} from '../../../dist/lib.js';

/** Default coordinator ParticipantId: <participant_kind>::<participant_role>, matching MCP. */
export const DEFAULT_REQUESTED_BY = 'adapter::pi-extension';

// ── Forensic wiring (unitAI-rrdnt.37.1) ──────────────────────────────────────
//
// Native activations must be answerable from the SAME observability.db the legacy
// runner and the MCP frontend write — no second telemetry store (PRD §73/AP). The
// MCP server wires `createActivationForensicSink(createObservabilitySqliteClient())`
// at construction; this extension does the equivalent through the lib seam. The
// canonical file is created when absent (exactly what `sp run` does), then opened
// by the same client the CLI reads, so resolution parity holds by construction.
// Null-safe: if the client cannot open (e.g. `bun:sqlite` unavailable under the
// node-based pi runtime), the host falls back to its no-op sink exactly as MCP
// does when its client is null.

export function createCoordinatorHost({ createClient, wrapSink, Host } = {}) {
  const client = createClient
    ? createClient()
    : createObservabilitySqliteClientAtPath(resolveObservabilityDbLocation(process.cwd()).dbPath);
  const HostCtor = Host ?? NativeActivationHost;
  // A null client means forensics could not open, not that nothing is listening: the
  // wake rides this sink, so the wrapper must still run over a no-op base. Returning
  // `new HostCtor()` here would make a coordinator whose observability.db failed to
  // open silently lose every escalation notification — the exact silence this bead
  // exists to remove, reappearing only in the degraded case nobody runs (rrdnt.45).
  const sink = client ? createActivationForensicSink(client) : { emit: () => {} };
  // unitAI-rrdnt.45 seam: the wake lane wraps the sink so the extension can
  // observe host emits (escalation_raised / clarification_requested) without
  // touching NativeActivationHost or this constructor's internals.
  return new HostCtor({ forensics: wrapSink ? wrapSink(sink) : sink });
}

// ── Ask observation (unitAI-rrdnt.45) ────────────────────────────────────────
//
// The coordinator's wake-up rides a seam that already exists rather than adding
// one. `native-host.ts` already emits `clarification_requested` and
// `escalation_raised` through the forensic sink on every ask, and this extension
// is what constructs that sink — so observing asks costs a wrapper here and no
// change to the host, to `InteractionTransport`, or to `NativeActivationHostDeps`.
//
// The property that matters is what this DOES NOT touch. `DeliveryState` lives in
// the transport and the wake never reaches it, so an ask stays `pending` and stays
// readable through `specialist_status` whether the wake fires, is disabled, or
// throws. Push cannot become authoritative because it has no way to say otherwise
// (PRD SS30) — that is a consequence of where the seam is, not of care at the call
// site.
//
// Timing note, measured rather than assumed: `ask-tool.ts` calls `onAsk` BEFORE
// `transport.request()`, so at notification time the ask is not yet in
// `pendingAsks()` and no `message_id` exists to carry. The wake therefore carries
// the activation identity and the question, and the coordinator reads
// `specialist_status` for the id. That keeps the durable projection as the single
// correlation authority; a message_id sourced from anywhere else would be a second
// one for the exact thing that must have only one.

/** Forensic event names that mean a child is now blocked on the coordinator. */
const ASK_EVENTS = {
  clarification_requested: 'question',
  escalation_raised: 'escalation',
};

/**
 * Wrap a forensic sink so asks are also reported to `onAsk`, forwarding everything
 * else untouched.
 *
 * `onAsk` throwing must never reach the sink's caller: forensics are on the
 * activation's path, and a failed notification is a diagnostic loss while a failed
 * activation is a functional one. The optional members are forwarded conditionally
 * because the host tests for their presence — defining them unconditionally over a
 * sink that lacks them would silently change which forensic paths the host takes.
 */
export function createAskObserverSink(base, onAsk) {
  const wrapped = {
    emit(event) {
      try {
        base.emit(event);
      } finally {
        const kind = ASK_EVENTS[event.name];
        if (kind) {
          try {
            onAsk({
              kind,
              activationId: event.activationId,
              attemptId: event.attemptId,
              specialist: event.specialist,
              beadId: event.beadId,
              body: typeof event.payload?.body === 'string' ? event.payload.body : '',
            });
          } catch {
            // A wake that throws leaves the ask exactly as it was: pending, and
            // readable through specialist_status. That is the degraded path, and
            // it is the same path taken when no coordinator is listening at all.
          }
        }
      }
    },
  };
  if (base.sessionEvent) wrapped.sessionEvent = (input) => base.sessionEvent(input);
  if (base.peerTransportEvent) wrapped.peerTransportEvent = (event) => base.peerTransportEvent(event);
  return wrapped;
}

/** The wake message a blocked child produces. Exported so its shape is testable. */
export function formatAskWake(ask) {
  const what = ask.kind === 'escalation' ? 'ESCALATED' : 'is asking a question';
  return [
    `Specialist \`${ask.specialist}\` ${what} and is blocked waiting for you.`,
    '',
    `activation_id: ${ask.activationId}`,
    ...(ask.beadId ? [`bead: ${ask.beadId}`] : []),
    '',
    ask.body || '(no body)',
    '',
    'Call specialist_status to read this ask\'s message_id from pending_asks, then ' +
      'answer it with specialist_reply. The child is alive and resumable; it stays ' +
      'blocked until you answer.',
  ].join('\n');
}

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
  // The wake exists so that an operator who does nothing still learns a child is
  // blocked. The flag turns it off so the DEGRADED path is reproducible on demand:
  // the case worth regression-testing is not that a notification fires, it is that
  // an ask with no notification is still readable and still not marked delivered.
  pi.registerFlag('no-specialist-wake', {
    type: 'boolean',
    default: false,
    description:
      'Do not wake this coordinator when a Specialist asks or escalates. The ask ' +
      'remains readable through specialist_status; only the notification is suppressed.',
  });

  /**
   * Wake the coordinator for one blocked child.
   *
   * `followUp` rather than `steer`: a question delivered between a tool call and
   * its result splits a turn the coordinator is in the middle of, and the child is
   * blocked either way — waiting for the current turn's tool calls to finish costs
   * the child nothing and costs the coordinator its train of thought otherwise.
   * `triggerTurn` is what makes an IDLE coordinator act, which is the whole bug:
   * without it a dispatched-then-waiting coordinator sees the message only when the
   * operator next types, which is the polling they were already doing.
   */
  const wake = (ask) => {
    if (pi.getFlag('no-specialist-wake') === true) return;

    const summary = `Specialist ${ask.specialist} ${ask.kind === 'escalation' ? 'escalated' : 'asked a question'}`;
    const ctx = liveContext({ requireUI: true });
    if (ctx) {
      try {
        ctx.ui.notify(summary, ask.kind === 'escalation' ? 'warning' : 'info');
      } catch {
        // The UI can disappear while async work settles; the message below is the
        // load-bearing half and does not depend on it.
      }
    }

    pi.sendMessage(
      {
        customType: 'specialist_ask',
        content: formatAskWake(ask),
        display: true,
        details: ask,
      },
      { deliverAs: 'followUp', triggerTurn: true },
    );
  };

  /**
   * State the wake behaviour once, when the operator first dispatches a child.
   *
   * Not at session start: an extension that announces itself on every session is
   * noise, and before a dispatch there is nothing the wake could do. This fires at
   * the moment it becomes true that a child could start a turn on its own — which
   * is the behaviour a reader needs to have been told about, and the suppressed
   * case is the one a silent session would otherwise be unexplainable without.
   */
  let announced = false;
  const announceWake = () => {
    if (announced) return;
    announced = true;
    const ctx = liveContext({ requireUI: true });
    if (!ctx) return;
    const off = pi.getFlag('no-specialist-wake') === true;
    try {
      ctx.ui.notify(
        off
          ? 'Specialist wake is OFF (--no-specialist-wake): a blocked child will not notify you. Read its question with specialist_status.'
          : 'Specialist wake is on: a blocked child will start a turn here on its own. Disable with --no-specialist-wake.',
        off ? 'warning' : 'info',
      );
    } catch {
      // Announcing is courtesy, never a precondition for dispatching.
    }
  };

  /** One host for the life of the pi process — never per-turn (VALIDATION 5). */
  let host = null;
  const getHost = () => {
    if (!host) {
      // The wrapper is handed to the test seam as well as to the real constructor,
      // so a test with an injected host still exercises the wake rather than
      // routing around the only path that matters here.
      const wrapSink = (sink) => createAskObserverSink(sink, wake);
      host = options.createHost
        ? options.createHost({ wrapSink })
        : createCoordinatorHost({ wrapSink });
      announceWake();
    }
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

  // One capture of the live ExtensionContext, shared by every consumer in this
  // file (unitAI-rrdnt.45 wake-ups, unitAI-rrdnt.46 Fleet UI). Two independent
  // holders is how a stale ctx survives a session restart, so there is one.
  let capture = null;          // { ctx, generation, sessionId }
  let generation = 0;

  pi.on('session_start', (_event, ctx) => {
    capture = {
      ctx,
      generation: ++generation,
      sessionId: ctx.sessionManager.getSessionId(),
    };
  });
  pi.on('session_shutdown', () => { capture = null; });

  /**
   * The live context, or null. Null means "no UI right now", never an error:
   * every consumer must degrade rather than throw, because a context can go
   * stale mid-flight during a session switch or reload.
   */
  function liveContext({ requireUI = false } = {}) {
    const held = capture;
    if (!held || held.generation !== generation) return null;
    try {
      // A context that outlived its session reports a different id; one that is
      // torn down throws on property access. Both mean "not live".
      if (held.sessionId && held.ctx.sessionManager.getSessionId() !== held.sessionId) return null;
      if (requireUI && !held.ctx.hasUI) return null;
      return held.ctx;
    } catch {
      return null;
    }
  }

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