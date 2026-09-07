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

import { spawnSync } from 'node:child_process';
import { Type } from 'typebox';
import {
  createActivationForensicSink,
  createObservabilitySqliteClientAtPath,
  DispatchRejectedError,
  evaluateBeadReadiness,
  extractSections,
  NativeActivationHost,
  resolveModelChain,
  resolveObservabilityDbLocation,
  resolveRuntimeToolContract,
  SpecialistLoader,
  toActivationView,
  toPendingAskView,
  validateBeforeRun,
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

/** Permission tiers that mutate the workspace (mirrors native-host.ts line 57). */
const WRITE_TIERS = new Set(['MEDIUM', 'HIGH']);

/**
 * The SAME admission checks the host runs (unitAI-rrdnt.49): model chain,
 * resolved tool contract, and preflight. A specialist whose checks pass is
 * dispatchable on the native runtime; `reason` explains the rest.
 */
export async function dispatchability(spec) {
  const execution = spec.specialist.execution;
  const tier = execution.permission_required ?? 'READ_ONLY';
  const modelChain = resolveModelChain(execution);
  if (modelChain.length === 0) {
    return { dispatchable: false, reason: 'no configured model — pass model_override at dispatch' };
  }
  const toolContract = resolveRuntimeToolContract({
    level: tier,
    specialistName: spec.specialist.metadata.name,
    specialistPermissions: spec.specialist.permissions,
    cwd: process.cwd(),
  });
  if (!toolContract || toolContract.toolsList.length === 0) {
    return { dispatchable: false, reason: 'empty tool contract for tier' };
  }
  try {
    validateBeforeRun(spec, tier, toolContract);
  } catch (error) {
    return { dispatchable: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { dispatchable: true };
}

/** Scope/layer provenance of a resolved specialist (repo + user overrides). */
function specialistSummaryView(summary) {
  return {
    name: summary.name,
    category: summary.category,
    description: summary.description,
    scope: summary.scope,
    source: summary.source,
    version: summary.version,
    permission_required: summary.permission_required,
  };
}

/**
 * Create a Bead from an inline dispatch contract (unitAI-rrdnt.48).
 *
 * The readiness gate has already passed BEFORE this is called — a refused
 * dispatch must leave the board unchanged. Uses the `bd` CLI exactly like the
 * runtime's own BeadsClient does; the created bead is the durable record every
 * later participant reads. Returns the new bead id, or null on failure.
 */
export function createBeadFromContract(contract, title) {
  const problem = extractSections(contract).get('PROBLEM');
  const firstLine = (problem ?? '').split('\n').map((s) => s.trim()).find(Boolean);
  const resolvedTitle = title ?? (firstLine ?? 'Specialist dispatch contract').slice(0, 72);
  const result = spawnSync(
    'bd',
    ['create', resolvedTitle, '--description', contract, '--type', 'task', '--priority', '2', '--json'],
    { encoding: 'utf-8', timeout: 20000 },
  );
  if (result.error || result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    return typeof parsed.id === 'string' ? parsed.id : null;
  } catch {
    return null;
  }
}

/** Render an inline-contract gate refusal as a structured tool result. */
function inlineRejectionResult(reason, missing, note) {
  return {
    status: 'rejected',
    reason,
    ...(missing?.length ? { missing } : {}),
    ...(note ? { note } : {}),
  };
}

/** Render a host-thrown `DispatchRejectedError` as a structured tool result. */
function rejectionResult(error) {
  return {
    status: 'rejected',
    reason: error.message,
    detail: error.detail,
  };
}

/** Wrap a payload into the pi AgentToolResult shape. */
function resultOf(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], details: {} };
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
    if (!host) host = options.createHost ? options.createHost() : createCoordinatorHost();
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
      'spawned. Provide EITHER bead_id (an existing READY Bead — 7 sections plus ' +
      'SCRUTINY) OR contract (an inline 7-section contract: the same readiness gate ' +
      'runs first, then a Bead is created and dispatched). Never both. Returns once ' +
      'the activation is ADMITTED and started, not when it completes — poll ' +
      'specialist_status for state and for any question it raises, and answer with ' +
      'specialist_reply. A draft or incomplete contract is refused here, before a model ' +
      'turn is spent guessing at scope it does not carry — fix the Bead (planning ' +
      'skill, /planning), not the dispatch. Write-capable Specialists (MEDIUM/HIGH ' +
      'tiers) activate only when they can acquire the workspace lease.',
    promptSnippet: 'Dispatch an XTRM Specialist (specialist_dispatch: specialist, bead_id)',
    parameters: Type.Object({
      specialist: Type.String({ description: 'Specialist name, e.g. codebase-explorer' }),
      bead_id: Type.Optional(
        Type.String({
          description:
            'The id of an EXISTING READY Bead to dispatch against. Mutually exclusive ' +
            'with contract: provide exactly one of bead_id or contract, never both.',
        }),
      ),
      contract: Type.Optional(
        Type.String({
          description:
            'An INLINE task contract, used instead of bead_id: the SAME readiness gate ' +
            'runs first, then a Bead is created from it and dispatched. The contract ' +
            'must contain all seven sections — PROBLEM, SUCCESS, SCOPE, NON_GOALS, ' +
            'CONSTRAINTS, VALIDATION, OUTPUT — plus a SCRUTINY level. Use the planning ' +
            'skill (/planning) to write one; a contract missing any section is refused ' +
            'and nothing is created.',
        }),
      ),
      title: Type.Optional(
        Type.String({
          description: 'Optional title for the Bead created from `contract` (default: derived from PROBLEM).',
        }),
      ),
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
        // unitAI-rrdnt.48: EITHER an existing bead_id OR an inline contract —
        // never both, and the readiness gate runs BEFORE any bead is created.
        const beadId = (params.bead_id ?? '').trim();
        const contract = (params.contract ?? '').trim();
        if (beadId && contract) {
          return resultOf(inlineRejectionResult(
            'both bead_id and contract were provided — provide exactly one; silently preferring one would dispatch against a contract the coordinator did not mean',
          ));
        }
        let effectiveBeadId = beadId;
        if (!effectiveBeadId) {
          if (!contract) {
            return resultOf(inlineRejectionResult(
              'neither bead_id nor contract was provided — dispatch requires a READY Bead (7 sections + SCRUTINY) or an inline contract',
            ));
          }
          // The SAME gate the host runs at admission, before anything is created.
          const gate = evaluateBeadReadiness({
            id: '<inline>',
            status: 'open',
            title: params.title ?? 'specialist dispatch',
            description: contract,
          });
          if (!gate.ok) {
            return resultOf(inlineRejectionResult(gate.reason, gate.missing));
          }
          const created = (options.createBead ?? createBeadFromContract)(contract, params.title);
          if (!created) {
            return resultOf({ status: 'error', error: 'bd create failed — bead not created, board unchanged' });
          }
          effectiveBeadId = created;
        }

        const handle = await h.start({
          specialist: params.specialist,
          beadId: effectiveBeadId,
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
        const view = snapshot ? toActivationView(snapshot) : { activation_id: handle.activationId };
        return {
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

  // unitAI-rrdnt.49: an sp-list equivalent inside the extension — awareness, not
  // surface area. One listing tool over the RESOLVED registry (repo + user layer
  // overrides merged by SpecialistLoader), marking what the native runtime can
  // actually dispatch. The full CLI surface is `sp help`; this tool is not a
  // replacement for it and deliberately does not reproduce run/feed/steer.
  pi.registerTool({
    name: 'specialist_list',
    label: 'Specialist registry',
    description:
      'List the resolved Specialist registry — every configured specialist after ' +
      'repo and user layer overrides, with its permission tier and whether the ' +
      'native runtime can dispatch it right now (model configured, tool contract ' +
      'non-empty, preflight passing). Write-capable tiers (MEDIUM/HIGH) still need ' +
      'the workspace lease at dispatch time. This is awareness only: for the full ' +
      'CLI surface (run, feed, result, steer, resume, stop and the rest) use the ' +
      'specialists CLI — `sp help`.',
    promptSnippet: 'List configured Specialists (specialist_list)',
    parameters: Type.Object({}),
    async execute() {
      const loader = new SpecialistLoader({ projectDir: process.cwd() });
      const summaries = await loader.list();
      const rows = [];
      for (const summary of summaries) {
        const row = {
          ...specialistSummaryView(summary),
          access: WRITE_TIERS.has(summary.permission_required ?? 'READ_ONLY') ? 'write' : 'read',
        };
        // loader.get throws for specialists with no configured model — that IS the
        // undispatchable signal (the host rejects them with no_model_configured),
        // not a listing failure.
        let spec = null;
        try {
          spec = await loader.get(summary.name);
        } catch (error) {
          row.dispatchable = false;
          row.reason = error instanceof Error ? error.message : String(error);
        }
        if (spec) {
          const capability = await dispatchability(spec);
          row.dispatchable = capability.dispatchable;
          if (capability.reason) row.reason = capability.reason;
        }
        rows.push(row);
      }
      return resultOf({ specialists: rows, note: 'Full CLI surface: sp help' });
    },
  });


  // ── Operator surface (unitAI-rrdnt.46) ─────────────────────────────────────
  //
  // Everything above this line is a MODEL surface: it exists only when the
  // coordinator decides to call a tool. An operator in an interactive TUI saw
  // nothing at all — no Fleet, no pending ask, no way to answer one. The PRD
  // says this extension owns a child viewport; it owned none.
  //
  // Measured against pi 0.85.1 before any of this was written (the SDK types at
  // dist/core/extensions/types.d.ts and @aliou/pi-processes as the worked
  // example), then proved in a live TUI: `pi.registerCommand` produces a real
  // slash command with argument completion, and `ctx.ui.setWidget` paints a
  // persistent panel above or below the editor. Neither needed a host change.
  //
  // The view is a PROJECTION and never a second source of state. Every repaint
  // reads `host.list()` and `host.pendingAsks()` afresh; nothing is cached
  // between ticks, because a cache would drift exactly when something
  // interesting happens. `toActivationView`/`toPendingAskView` are the same
  // projections the tools serialise, so the operator and the model are looking
  // at one vocabulary rather than two.
  //
  // Refresh is a poll, deliberately. `NativeActivationHost` is pull-only
  // (`list`, `pendingAsks`, `inspect`) and giving it an emitter whose only
  // subscriber is a widget would couple the host to a UI consumer for no
  // measured gain. A tick is a read of an in-memory Map. If the latency ever
  // shows in use, that is the evidence that justifies an emitter.

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

  const FLEET_WIDGET_KEY = 'specialist-fleet';
  const FLEET_POLL_MS = 1000;

  /** Operator-facing toggle. The widget is shown by default; `/fleet hide` opts out. */
  let fleetVisible = true;
  let fleetTimer = null;

  /** Snapshot state and pending asks together — every caller needs both. */
  const readFleet = () => {
    // `host` stays null until the first tool use, and a null host is an empty
    // Fleet, not an error: creating one here would open the observability
    // database for a session that has not dispatched anything.
    if (!host) return { activations: [], asks: [] };
    return {
      activations: host.list().map(toActivationView),
      asks: host.pendingAsks().map(toPendingAskView),
    };
  };

  /** One line per activation, then one per outstanding ask. Nothing else fits. */
  const renderFleetLines = ({ activations, asks }) => {
    const lines = [`Specialists — ${activations.length} activation(s), ${asks.length} pending ask(s)`];
    for (const view of activations) {
      lines.push(
        `  ${view.state.padEnd(9)} ${view.specialist} ${view.bead_id} ` +
        `[${view.access}] ${view.activation_id}`,
      );
    }
    for (const ask of asks) {
      // The body is the operator's whole reason to look, but it must not push
      // the editor off the screen; one truncated line keeps the panel bounded.
      const body = ask.body.replace(/\s+/g, ' ').trim();
      lines.push(
        `  ASK ${ask.kind} ${ask.message_id} — ` +
        `${body.length > 96 ? `${body.slice(0, 95)}…` : body}`,
      );
      lines.push(`      answer with: /fleet:reply ${ask.message_id} <your answer>`);
    }
    return lines;
  };

  const paintFleet = () => {
    const ctx = liveContext({ requireUI: true });
    if (!ctx) return;
    const fleet = readFleet();
    // An empty Fleet clears the panel rather than rendering a header for
    // nothing — an operator with no activations should see their editor.
    const content =
      fleetVisible && (fleet.activations.length > 0 || fleet.asks.length > 0)
        ? renderFleetLines(fleet)
        : undefined;
    ctx.ui.setWidget(FLEET_WIDGET_KEY, content, { placement: 'aboveEditor' });
    ctx.ui.setStatus(
      FLEET_WIDGET_KEY,
      fleet.asks.length > 0
        ? `specialists: ${fleet.activations.length} · ${fleet.asks.length} waiting`
        : fleet.activations.length > 0
          ? `specialists: ${fleet.activations.length}`
          : undefined,
    );
  };

  pi.on('session_start', (_event, ctx) => {
    if (!ctx.hasUI) return;
    if (fleetTimer) clearInterval(fleetTimer);
    // The tick is a null check until the first dispatch creates a host, so an
    // operator who never dispatches pays nothing for the surface being present.
    fleetTimer = setInterval(paintFleet, FLEET_POLL_MS);
    // Do not hold the event loop open on the poll alone.
    fleetTimer.unref?.();
    paintFleet();
  });

  /** Report to the operator on whichever surface the current mode actually has. */
  const report = (ctx, message, level = 'info') => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else console.log(message);
  };

  pi.registerCommand('fleet', {
    description: 'Show the Specialist Fleet and any pending asks. Usage: /fleet [show|hide]',
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trim().toLowerCase();
      const items = ['show', 'hide']
        .filter((value) => value.startsWith(normalized))
        .map((value) => ({
          value,
          label: value,
          description: value === 'show' ? 'Show the Fleet panel.' : 'Hide the Fleet panel.',
        }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().split(/\s+/, 1)[0] ?? '';
      if (action === 'hide') fleetVisible = false;
      else if (action === 'show') fleetVisible = true;
      else if (action !== '') {
        report(ctx, 'Usage: /fleet [show|hide]', 'warning');
        return;
      }
      // The panel is only half the answer: in json/print mode there is no
      // widget at all, so the command always reports the Fleet in text too.
      report(ctx, renderFleetLines(readFleet()).join('\n'));
      paintFleet();
    },
  });

  pi.registerCommand('fleet:reply', {
    description:
      'Answer an outstanding Specialist question or escalation. ' +
      'Usage: /fleet:reply <message_id> <answer>',
    getArgumentCompletions: (prefix) => {
      // Completing the message id is the whole point — an operator cannot be
      // expected to retype one off the panel.
      const normalized = prefix.trim();
      if (normalized.includes(' ')) return null;
      const items = readFleet().asks
        .filter((ask) => ask.message_id.startsWith(normalized))
        .map((ask) => ({
          value: ask.message_id,
          label: ask.message_id,
          description: `${ask.kind} from ${ask.from}`,
        }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const split = trimmed.indexOf(' ');
      if (split === -1) {
        report(ctx, 'Usage: /fleet:reply <message_id> <answer>', 'warning');
        return;
      }
      const messageId = trimmed.slice(0, split);
      const body = trimmed.slice(split + 1).trim();
      if (!body) {
        report(ctx, 'Usage: /fleet:reply <message_id> <answer>', 'warning');
        return;
      }
      const message = await getHost().answer(messageId, body);
      if (!message) {
        report(
          ctx,
          `No outstanding ask with message_id '${messageId}' — it may have been ` +
          'answered already, or its activation may have been disposed.',
          'warning',
        );
        return;
      }
      report(ctx, `Answered ${message.messageId} on activation ${message.activationId}.`);
      paintFleet();
    },
  });

  pi.registerCommand('fleet:stop', {
    description: 'Stop and dispose a native activation. Usage: /fleet:stop <activation_id> [reason]',
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trim();
      if (normalized.includes(' ')) return null;
      const items = readFleet().activations
        .filter((view) => view.activation_id.startsWith(normalized))
        .map((view) => ({
          value: view.activation_id,
          label: view.activation_id,
          description: `${view.specialist} · ${view.state}`,
        }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        report(ctx, 'Usage: /fleet:stop <activation_id> [reason]', 'warning');
        return;
      }
      const split = trimmed.indexOf(' ');
      const activationId = split === -1 ? trimmed : trimmed.slice(0, split);
      const reason = split === -1 ? '' : trimmed.slice(split + 1).trim();
      if (!getHost().inspect(activationId)) {
        report(ctx, `Unknown activation: ${activationId}`, 'warning');
        return;
      }
      await disposeActivation(activationId, reason || 'pi operator request');
      report(ctx, `Stopped ${activationId}.`);
      paintFleet();

    },
  });

  // A child must never outlive the coordinator process. Best-effort: stop and
  // dispose every live activation when the pi session shuts down.
  pi.on('session_shutdown', async () => {
    if (fleetTimer) {
      clearInterval(fleetTimer);
      fleetTimer = null;
    }
    if (!host) return;
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