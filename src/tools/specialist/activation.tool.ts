// src/tools/specialist/activation.tool.ts
//
// The Claude Code MCP frontend over `NativeActivationHost` — PRD Phase 13.
//
// Claude Code could previously obtain a Specialist only by shelling out to `sp run` in a
// terminal or an `xt` session. The native runtime already existed in-process, so the
// coordinator best placed to use it was the one that could not. These tools close that
// gap, and they close it by CALLING the host, never by spawning `sp`: a subprocess
// that runs `sp` would satisfy the letter of "expose the runtime over MCP" and defeat its
// entire purpose. The one child process reachable from here is the `bd create` inside
// `createBeadFromContract` for the inline-contract path — the same `bd` CLI the
// runtime's own BeadsClient uses, never the legacy CLI — and it runs only after the
// readiness gate passes. The live evidence for acceptance AV asserts the absence of
// `sp` against the process table rather than against intent.
//
// The gates are not re-implemented here, and that is the load-bearing property. Bead
// readiness, the StepContract compilation, the capability contract, the model gate and
// (once Phase 10 lands) the workspace writer lease all live inside `host.start()`. A
// second dispatch path that re-checked them would drift; a second dispatch path that
// skipped them is how gates die. This module's whole job is argument marshalling and
// snapshot projection.
//
// Deliberately NOT here: any message vocabulary of its own. `specialist_reply` carries an
// `InteractionMessage` through `host.answer()` (PRD invariant BH) — MCP is a
// serialisation of that type, never a parallel protocol. Asynchronous push toward Claude
// is Phase 14 and is why `specialist_status` reports pending asks by projection: until
// the push channel exists, a coordinator learns about a question by reading, and a
// reader that cannot see the ask is a Specialist stuck forever.
//
// Phase 14 (unitAI-rrdnt.34) adds the push half WITHOUT removing that read half. The
// coordinator address is a property of the dispatch, not of the runtime — the server
// builds one host for its whole life and learns a coordinator session only per call — so
// the dispatch registers the route and the settled result with `RuntimeEventPusher`, and
// `specialist_status` projects the same recorded results. A coordinator that never
// received the push reads the identical object here; that is what makes the notification
// a projection rather than the authority.

import * as z from 'zod';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { NativeActivationHost } from '../../activation/native-host.js';
import { describeBuildIdentity, readBuildId } from '../../activation/build-identity.js';
import { evaluateBeadReadiness } from '../../activation/bead-gate.js';
import { createBeadFromContract } from '../../specialist/beads.js';
import { renderRejection } from '../../activation/rejection.js';
import { THINKING_LEVELS } from '../../activation/types.js';
import type { ActivationSnapshot, ActivationTokenUsage } from '../../activation/types.js';
import { DispatchRejectedError } from '../../activation/types.js';
import type { PendingAsk } from '../../activation/interaction.js';
import type { RuntimeEventPusher } from '../../activation/async-events.js';
import type { ActivationResult } from '../../activation/types.js';

/**
 * Transport-neutral projection of one activation.
 *
 * Mirrors `ActivationSnapshot` rather than reshaping it, so an MCP reader and a Pi
 * extension reader answer "what is this Specialist doing" the same way. `workspace` is
 * flattened to its worktree path: the full `WorkspaceIdentity` is a runtime structure and
 * the coordinator needs the mutation domain, not the git plumbing.
 */
export interface ActivationView {
  activation_id: string;
  participant_id: string;
  attempt_id: string;
  specialist: string;
  bead_id: string;
  state: string;
  access: 'read' | 'write';
  worktree_path: string;
  branch?: string;
  pi_session_id?: string;
  /** What was asked for — the override when one was given, the configured model otherwise. */
  requested_model?: string;
  resolved_model: string;
  model_override: boolean;
  thinking_override: boolean;
  /** Seconds since dispatch, from the in-memory snapshot — never an observability.db query. */
  elapsed_s: number;
  /** Cumulative spend counts. Omitted until the first usage event (never zero-filled). */
  token_usage?: ActivationTokenUsage;
  /** Thinking level from session creation. Omitted when unset (never fabricated). */
  thinking_level?: string;
  /** One-line purpose excerpt captured at dispatch. Omitted when absent (never fabricated). */
  purpose?: string;
  /** Last session-event time. Per-tool "doing X now" inference is out of scope. */
  last_activity_at: number;
}

export function toActivationView(snapshot: ActivationSnapshot, nowMs: number = Date.now()): ActivationView {
  return {
    activation_id: snapshot.activationId,
    participant_id: snapshot.participantId,
    attempt_id: snapshot.attemptId,
    specialist: snapshot.specialist,
    bead_id: snapshot.beadId,
    state: snapshot.state,
    access: snapshot.access,
    worktree_path: snapshot.workspace.worktreePath,
    ...(snapshot.workspace.branch ? { branch: snapshot.workspace.branch } : {}),
    ...(snapshot.piSessionId ? { pi_session_id: snapshot.piSessionId } : {}),
    ...(snapshot.requestedModel ? { requested_model: snapshot.requestedModel } : {}),
    resolved_model: snapshot.resolvedModel,
    model_override: snapshot.modelOverride,
    thinking_override: snapshot.thinkingOverride,
    elapsed_s: Math.max(0, Math.floor((nowMs - snapshot.startedAt) / 1000)),
    ...(snapshot.tokenUsage ? { token_usage: { ...snapshot.tokenUsage } } : {}),
    ...(snapshot.thinkingLevel ? { thinking_level: snapshot.thinkingLevel } : {}),
    ...(snapshot.purpose ? { purpose: snapshot.purpose } : {}),
    last_activity_at: snapshot.lastActivityAt,
  };
}

/** An outstanding question or escalation, projected for a coordinator that must answer it. */
export interface PendingAskView {
  message_id: string;
  kind: string;
  activation_id: string;
  attempt_id: string;
  from: string;
  to: string;
  body: string;
  delivery: string;
  asked_at: number;
}

export function toPendingAskView(ask: PendingAsk): PendingAskView {
  return {
    message_id: ask.message.messageId,
    kind: ask.message.kind,
    activation_id: ask.message.activationId,
    attempt_id: ask.message.attemptId,
    from: ask.message.from,
    to: ask.message.to,
    body: ask.message.body,
    delivery: ask.delivery,
    asked_at: ask.askedAt,
  };
}

/**
 * A validated result, projected for a coordinator that reads instead of being pushed.
 *
 * This is the ONE projection of `ActivationResult`, and it carries its own identity so it
 * can stand alone in a list. The Pi extension attaches its result to an `ActivationView`
 * that already names the activation, so the identity fields are redundant there — but
 * redundant is not divergent, and two functions that describe the same settled activation
 * with different field sets is exactly how a Pi coordinator and a Claude coordinator end
 * up disagreeing about one object (`config/pi-extensions/specialist-subagents/index.mjs`,
 * unitAI-rrdnt.45). Exported from `lib.js` so the extension imports it rather than
 * restating it, the way it already does for `toActivationView`.
 */
export interface ActivationResultView {
  activation_id: string;
  participant_id: string;
  attempt_id: string;
  bead_id: string;
  status: string;
  /** Explicitly `null` rather than absent: a missing key reads as "not projected yet". */
  output: unknown;
  validation: { valid: boolean; schema?: string; errors?: string[] };
  pi_session_id?: string;
  configured_model?: string;
  requested_model?: string;
  resolved_model: string;
  model_override: boolean;
  thinking_level?: string;
  thinking_override: boolean;
  fallback_used: boolean;
  completed_at: number;
}

export function toActivationResultView(result: ActivationResult): ActivationResultView {
  return {
    activation_id: result.activationId,
    participant_id: result.participantId,
    attempt_id: result.attemptId,
    bead_id: result.beadId,
    status: result.status,
    output: result.output ?? null,
    validation: result.validation,
    ...(result.piSessionId ? { pi_session_id: result.piSessionId } : {}),
    ...(result.configuredModel ? { configured_model: result.configuredModel } : {}),
    ...(result.requestedModel ? { requested_model: result.requestedModel } : {}),
    resolved_model: result.resolvedModel,
    model_override: result.modelOverride,
    ...(result.thinkingLevel ? { thinking_level: result.thinkingLevel } : {}),
    thinking_override: result.thinkingOverride,
    fallback_used: result.fallbackUsed,
    completed_at: result.completedAt,
  };
}

// Build identity (unitAI-t2kol.4): which artifact this process loaded vs what is on
// disk now — the Pi LOADED_BUILD_ID pattern. This module runs in two layouts (src/
// under tsx/vitest, bundled dist/index.js in production), so the on-disk artifact is
// located by candidate, exactly like resolveCanonicalAssetDir. The loaded id is hashed
// once at module load; the on-disk id is re-read per refusal via readBuildId.
const DIST_LIB_PATH = (() => {
  for (const candidate of ['./lib.js', '../../../dist/lib.js']) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) return path;
  }
  return fileURLToPath(new URL('../../../dist/lib.js', import.meta.url));
})();
const LOADED_BUILD_ID = readBuildId(DIST_LIB_PATH);

export const specialistDispatchSchema = z.object({
  specialist: z.string().describe('Specialist name, e.g. codebase-explorer'),
  bead_id: z.string().optional().describe(
    "The id of an EXISTING READY Bead — this activation's task contract, a COMPLETE " +
    '7-section contract (PROBLEM, SUCCESS, SCOPE, NON_GOALS, CONSTRAINTS, VALIDATION, ' +
    'OUTPUT) plus a SCRUTINY level, which must be exactly one of LOW, MEDIUM, HIGH or ' +
    'CRITICAL. That is EIGHT required parts, not seven; SCRUTINY is the one most often ' +
    'left out. Write each section as a heading: either the section name on its own line ' +
    'with its body beneath, or `PROBLEM: the body` on one line. Both forms are accepted. ' +
    'A draft or incomplete Bead is refused before any model turn. No free-form task ' +
    'text is accepted: a task that needs more definition belongs in the Bead (see the ' +
    'planning skill). Mutually exclusive with contract: provide exactly one of bead_id ' +
    'or contract, never both.',
  ),
  contract: z.string().optional().describe(
    'An INLINE task contract, used instead of bead_id: the SAME readiness gate ' +
    'runs first, then a Bead is created from it and dispatched. The contract ' +
    'must contain all seven sections — PROBLEM, SUCCESS, SCOPE, NON_GOALS, ' +
    'CONSTRAINTS, VALIDATION, OUTPUT — plus a SCRUTINY level, which must be exactly ' +
    'one of LOW, MEDIUM, HIGH or CRITICAL. Note that this is EIGHT required parts, ' +
    'not seven; SCRUTINY is the one most often left out. Write each section as a ' +
    'heading: either the section name on its own line with its body beneath, or ' +
    '`PROBLEM: the body` on one line. Both forms are accepted. ' +
    'A contract missing any section is refused and nothing is created.',
  ),
  title: z.string().optional().describe(
    'Optional title for the Bead created from `contract` (default: derived from PROBLEM). ' +
    'Ignored when bead_id is given.',
  ),
  // Deliberately a bare number, not min(1).max(2): out-of-range values must reach
  // execute and come back as a structured refusal via the shared renderer, not as a
  // zod throw that surfaces as an opaque MCP error (server.ts parses before execute).
  epic_context_depth: z.number().optional().describe(
    'Walk bead.parent UP this many hops (1 = immediate parent epic, 2 = epic + ' +
    "grand-epic) and render each ancestor contract into the turn-1 prompt as an '" +
    "'## Epic lineage' section. Must be 1 or 2; anything else is refused. Omit for " +
    'single-bead dispatch with no lineage. Dropped for beads auto-created from an ' +
    'inline contract (a fresh bead has no parent).',
  ),
  model_override: z.string().optional().describe(
    'Override the configured model for THIS activation only. An unavailable model is refused before the session is created, never silently replaced.',
  ),
  thinking_override: z.enum(THINKING_LEVELS).optional().describe(
    'Override the definition thinking_level for THIS activation only. Absent means the definition level. An unknown value is refused before the session is created.',
  ),
  requested_by: z.string().optional().describe(
    'ParticipantId of the requesting coordinator. Defaults to the MCP gateway participant.',
  ),
  coordinator_session_id: z.string().optional().describe('MCP session id, for lineage.'),
});

/**
 * Dispatch a Specialist onto the in-process runtime.
 *
 * Returns as soon as the activation is admitted and started, NOT when it finishes. The
 * session deliberately outlives the call: a Specialist that reaches `settled` is waiting
 * and resumable, and a tool that blocked until completion would make every clarification
 * a deadlock — the coordinator cannot answer a question it is blocked waiting on.
 */
export function createSpecialistDispatchTool(
  getHost: () => NativeActivationHost,
  getPusher?: () => RuntimeEventPusher | undefined,
) {
  return {
    name: 'specialist_dispatch' as const,
    description:
      'Dispatch a Specialist on the native in-process runtime. No CLI process is spawned. ' +
      'Provide EITHER bead_id (an existing READY Bead) OR contract (an inline 7-section ' +
      'contract: the same readiness gate runs first, then a Bead is created and dispatched). ' +
      'Never both. Returns once the activation is ADMITTED and started, not when it ' +
      'completes — poll specialist_status for state and for any question it raises, and ' +
      'answer with specialist_reply. The Bead is the prompt and MUST be a complete 7-section ' +
      'contract plus a SCRUTINY level; a draft or incomplete Bead is refused here, before a ' +
      'model turn is spent guessing at scope it does not carry — if the Bead is not ' +
      'dispatchable, fix the Bead (planning skill), not the dispatch. Write-capable ' +
      'Specialists (MEDIUM/HIGH tiers) activate only when they can acquire the workspace ' +
      'lease; otherwise dispatch is refused with a structured reason.',
    inputSchema: specialistDispatchSchema,
    async execute(input: z.infer<typeof specialistDispatchSchema>) {
      const build = () => describeBuildIdentity(LOADED_BUILD_ID, readBuildId(DIST_LIB_PATH));
      try {
        // EITHER an existing bead_id OR an inline contract — never both, and the
        // readiness gate runs BEFORE any bead is created (same gate the host runs at
        // admission, never a second one). Mirrors the Pi extension dispatch.
        const beadId = (input.bead_id ?? '').trim();
        const contract = (input.contract ?? '').trim();
        if (beadId && contract) {
          return renderRejection({
            reason: 'both bead_id and contract were provided — provide exactly one; ' +
              'silently preferring one would dispatch against a contract the coordinator did not mean',
          }, build());
        }
        const epicContextDepth = input.epic_context_depth;
        if (epicContextDepth !== undefined && epicContextDepth !== 1 && epicContextDepth !== 2) {
          return renderRejection({
            reason: 'epic_context_depth must be 1 or 2 — 1 walks to the immediate parent epic, ' +
              '2 also includes the grand-epic',
          }, build());
        }
        let effectiveBeadId = beadId;
        let autoCreatedBeadId: string | undefined;
        if (!effectiveBeadId) {
          if (!contract) {
            return renderRejection({
              reason: 'neither bead_id nor contract was provided — dispatch requires a READY Bead ' +
                '(7 sections + SCRUTINY) or an inline contract',
            }, build());
          }
          // The SAME gate the host runs at admission, before anything is created: a
          // refused dispatch leaves the board unchanged.
          const gate = evaluateBeadReadiness({
            id: '<inline>',
            status: 'open',
            title: input.title ?? 'specialist dispatch',
            description: contract,
          });
          if (!gate.ok) {
            return renderRejection({ reason: gate.reason, missing: gate.missing }, build());
          }
          const created = createBeadFromContract(contract, input.title);
          if (!created) {
            return { status: 'error' as const, error: 'bd create failed — bead not created, board unchanged' };
          }
          effectiveBeadId = created;
          autoCreatedBeadId = created;
        }

        const handle = await getHost().start({
          specialist: input.specialist,
          beadId: effectiveBeadId,
          // Inline-contract dispatch creates a fresh bead with no parent: no lineage.
          ...(epicContextDepth !== undefined && !autoCreatedBeadId ? { epicContextDepth } : {}),
          ...(input.model_override ? { modelOverride: input.model_override } : {}),
          ...(input.thinking_override ? { thinkingOverride: input.thinking_override } : {}),
          requestedByParticipantId: input.requested_by ?? 'adapter::specialists-mcp',
          ...(input.coordinator_session_id ? { coordinatorSessionId: input.coordinator_session_id } : {}),
        });

        // The handle's `result` promise is deliberately NOT awaited and deliberately not
        // dropped either: an unhandled rejection on a failed activation would take the
        // MCP server down with it. The host has already recorded the failure forensically
        // and in the snapshot, which is where a reader looks for it.
        //
        // It IS observed, though: settling records the validated result so a completion can
        // be projected from it, and only then is the notification pushed. The order is the
        // contract — `pushCompletion` refuses an activation that has not settled, so a push
        // can never describe a result that does not exist.
        const pusher = getPusher?.();
        pusher?.track(handle.activationId, {
          ...(input.coordinator_session_id ? { coordinatorSessionId: input.coordinator_session_id } : {}),
          coordinatorParticipantId: input.requested_by ?? 'adapter::specialists-mcp',
        });
        handle.result.then(
          async (result) => {
            if (!pusher) return;
            pusher.settle(result);
            // A push that cannot be routed is not an error: the durable record is already
            // written and the result is readable through specialist_status either way.
            await pusher.pushCompletion(handle.activationId).catch(() => { /* degraded to polling */ });
          },
          () => { /* observed via specialist_status */ },
        );

        const snapshot = getHost().inspect(handle.activationId);
        return {
          status: 'dispatched' as const,
          ...(snapshot ? toActivationView(snapshot) : { activation_id: handle.activationId }),
          // An inline contract creates a durable board record. Saying so in the RESULT
          // is the difference between a coordinator tracking it and an operator finding
          // an orphan bead later — the caller cannot see the side effect otherwise.
          // Pi wording, verbatim: one vocabulary for the same side effect.
          ...(autoCreatedBeadId
            ? {
              created_bead_id: autoCreatedBeadId,
              created_bead_note:
                'This dispatch CREATED the bead above from your inline contract. It is a '
                + 'durable board record and is yours to track: close it when the work is '
                + 'done, or reassign it. It is not cleaned up automatically.',
            }
            : {}),
          step_contract: {
            root_work_ref: handle.stepContract.rootWorkRef,
            inputs: handle.stepContract.inputs.length,
            outputs: handle.stepContract.outputs.length,
          },
        };
      } catch (error) {
        // A refusal is the gate working, so it stays a returned tool result — throwing
        // would reach Claude as an opaque MCP error string. Shape comes from the shared
        // renderer: `missing` is promoted top-level but never removed from `detail`.
        if (error instanceof DispatchRejectedError) {
          return renderRejection(
            { reason: error.message, detail: error.detail, missing: error.detail.missing },
            describeBuildIdentity(LOADED_BUILD_ID, readBuildId(DIST_LIB_PATH)),
          );
        }
        throw error;
      }
    },
  };
}

export const specialistReplySchema = z.object({
  message_id: z.string().describe(
    'The message_id of the outstanding ask, from specialist_status.pending_asks. Correlation is by message id and nothing else — there is no "answer the latest ask", because with two asks outstanding that is a coin flip.',
  ),
  body: z.string().describe('The answer. Returned to the Specialist as its tool result.'),
});

/**
 * Answer an outstanding question or escalation.
 *
 * The answer resumes the child inside its existing tool call, so the same AgentSession
 * continues with its context intact rather than being restarted with an answer pasted
 * into a fresh prompt.
 */
export function createSpecialistReplyTool(getHost: () => NativeActivationHost) {
  return {
    name: 'specialist_reply' as const,
    description:
      'Answer an outstanding Specialist question or escalation by its message_id (read ' +
      'them from specialist_status.pending_asks). The answer returns as that tool call\'s ' +
      'result, so the Specialist continues with its context intact. An unknown or already ' +
      'answered message_id is reported, not silently accepted.',
    inputSchema: specialistReplySchema,
    async execute(input: z.infer<typeof specialistReplySchema>) {
      const message = await getHost().answer(input.message_id, input.body);
      if (!message) {
        return {
          status: 'error' as const,
          error: `No outstanding ask with message_id '${input.message_id}' — it may have been answered already, or its activation may have been disposed.`,
          message_id: input.message_id,
        };
      }
      return {
        status: 'answered' as const,
        message_id: message.messageId,
        in_reply_to: message.inReplyTo,
        activation_id: message.activationId,
        attempt_id: message.attemptId,
      };
    },
  };
}

export const specialistStopSchema = z.object({
  activation_id: z.string().describe('Activation to stop and dispose.'),
  reason: z.string().optional().describe('Recorded forensically with the disposal.'),
});
/**
 * Stop and dispose a native activation.
 *
 * Distinct from the legacy `stop_specialist`, which SIGTERMs a `sp run` child process by
 * its recorded pid. There is no child process here; disposal is a method call, and it is
 * the only ordinary path to disposal because settling is not one.
 */
export function createSpecialistStopActivationTool(getHost: () => NativeActivationHost) {
  return {
    name: 'specialist_stop_activation' as const,
    description:
      'Stop and dispose a native activation. This is the only ordinary path to disposal — ' +
      'a settled Specialist is waiting and resumable, not finished. Use stop_specialist ' +
      'instead for legacy CLI-started jobs, which are separate processes.',
    inputSchema: specialistStopSchema,
    async execute(input: z.infer<typeof specialistStopSchema>) {
      const before = getHost().inspect(input.activation_id);
      if (!before) {
        return {
          status: 'error' as const,
          error: `Unknown activation: ${input.activation_id}`,
          activation_id: input.activation_id,
        };
      }
      await getHost().stop(input.activation_id, input.reason ?? 'mcp operator request');
      return { status: 'stopped' as const, activation_id: input.activation_id };
    },
  };
}

export const specialistRetrySchema = z.object({
  activation_id: z.string().describe('The failed activation to re-run in place.'),
  model_override: z.string().optional().describe(
    'Re-run on a named model instead of the one that failed (manual switch after a quota ' +
    'window kills a run). A new session is built for the new model; without this the SAME ' +
    'session is re-prompted and its context survives.',
  ),
  prompt: z.string().optional().describe(
    'Replacement turn prompt. Defaults to the dispatch-time render of the same bead.',
  ),
});

/**
 * Re-run a failed native activation in place — the native equivalent of `sp retry`.
 *
 * Same activation id, new attempt: the bead, the workspace lease and (without a model
 * override) the session survive the retry. Failed only — a live or waiting activation
 * already has its path (reply for an outstanding question, resume for a settled one,
 * steer/stop for a running one), and retry refuses those states with the right pointer
 * rather than becoming a second dispatch. An escalation or question that CAN wait stays
 * an ask answered with specialist_reply; retry is for runs that already died.
 */
export function createSpecialistRetryTool(
  getHost: () => NativeActivationHost,
  getPusher?: () => RuntimeEventPusher | undefined,
) {
  return {
    name: 'specialist_retry' as const,
    description:
      'Re-run a FAILED native activation in place, optionally on a named model. ' +
      'Keeps the activation id, the bead and the workspace lease; without model_override ' +
      'the same session is re-prompted with its context intact. Failed only — answer an ' +
      'outstanding question with specialist_reply and resume a settled activation with ' +
      'specialist_resume instead.',
    inputSchema: specialistRetrySchema,
    async execute(input: z.infer<typeof specialistRetrySchema>) {
      try {
        const handle = await getHost().retry(input.activation_id, {
          ...(input.model_override ? { modelOverride: input.model_override } : {}),
          ...(input.prompt ? { prompt: input.prompt } : {}),
        });

        // Same observation contract as dispatch, minus the route: the coordinator address
        // is a property of the dispatch, so retry must not re-track and clobber it. The
        // retried result settles the recorded completion and its push, readable through
        // specialist_status either way.
        const pusher = getPusher?.();
        handle.result.then(
          async (result) => {
            if (!pusher) return;
            pusher.settle(result as ActivationResult);
            await pusher.pushCompletion(handle.activationId).catch(() => { /* degraded to polling */ });
          },
          () => { /* observed via specialist_status */ },
        );

        const snapshot = getHost().inspect(handle.activationId);
        return {
          status: 'retried' as const,
          ...(snapshot ? toActivationView(snapshot) : { activation_id: handle.activationId }),
        };
      } catch (error) {
        if (error instanceof DispatchRejectedError) {
          return renderRejection(
            { reason: error.message, detail: error.detail, missing: error.detail.missing },
            describeBuildIdentity(LOADED_BUILD_ID, readBuildId(DIST_LIB_PATH)),
          );
        }
        throw error;
      }
    },
  };
}
