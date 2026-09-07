// src/tools/specialist/activation.tool.ts
//
// The Claude Code MCP frontend over `NativeActivationHost` — PRD Phase 13.
//
// Claude Code could previously obtain a Specialist only by shelling out to `sp run` in a
// terminal or an `xt` session. The native runtime already existed in-process, so the
// coordinator best placed to use it was the one that could not. These tools close that
// gap, and they close it by CALLING the host, never by spawning anything: a subprocess
// that runs `sp` would satisfy the letter of "expose the runtime over MCP" and defeat its
// entire purpose. Nothing in this file constructs a child process, and the live evidence
// for acceptance AV asserts that against the process table rather than against intent.
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

import * as z from 'zod';
import type { NativeActivationHost } from '../../activation/native-host.js';
import type { ActivationSnapshot } from '../../activation/types.js';
import { DispatchRejectedError } from '../../activation/types.js';
import type { PendingAsk } from '../../activation/interaction.js';

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
}

export function toActivationView(snapshot: ActivationSnapshot): ActivationView {
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
 * Render a refusal as a tool RESULT rather than a thrown error.
 *
 * A `DispatchRejectedError` is not a malfunction — it is the gate working, and it carries
 * a structured reason the coordinator is meant to act on. Throwing it would reach Claude
 * as an opaque MCP error string and lose the `missing` sections that tell an operator
 * exactly which part of the contract to write. Genuine faults still throw.
 */
function rejectionResult(error: DispatchRejectedError) {
  return {
    status: 'rejected' as const,
    reason: error.message,
    detail: error.detail,
  };
}

export const specialistDispatchSchema = z.object({
  specialist: z.string().describe('Specialist name, e.g. codebase-explorer'),
  bead_id: z.string().describe(
    "The Bead that is this activation's task contract — a COMPLETE 7-section contract " +
    '(PROBLEM, SUCCESS, SCOPE, NON_GOALS, CONSTRAINTS, VALIDATION, OUTPUT) plus a SCRUTINY ' +
    'level. A draft or incomplete Bead is refused before any model turn. No free-form task ' +
    'text is accepted: a task that needs more definition belongs in the Bead (see the ' +
    'planning skill).',
  ),
  model_override: z.string().optional().describe(
    'Override the configured model for THIS activation only. An unavailable model is refused before the session is created, never silently replaced.',
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
export function createSpecialistDispatchTool(getHost: () => NativeActivationHost) {
  return {
    name: 'specialist_dispatch' as const,
    description:
      'Dispatch a Specialist on the native in-process runtime. No CLI process is spawned. ' +
      'Returns once the activation is ADMITTED and started, not when it completes — poll ' +
      'specialist_status for state and for any question it raises, and answer with ' +
      'specialist_reply. The Bead is the prompt and MUST be a complete 7-section contract ' +
      'plus a SCRUTINY level; a draft or incomplete Bead is refused here, before a model ' +
      'turn is spent guessing at scope it does not carry — if the Bead is not dispatchable, ' +
      'fix the Bead (planning skill), not the dispatch. Write-capable Specialists ' +
      '(MEDIUM/HIGH tiers) activate only when they can acquire the workspace lease; ' +
      'otherwise dispatch is refused with a structured reason.',
    inputSchema: specialistDispatchSchema,
    async execute(input: z.infer<typeof specialistDispatchSchema>) {
      try {
        const handle = await getHost().start({
          specialist: input.specialist,
          beadId: input.bead_id,
          ...(input.model_override ? { modelOverride: input.model_override } : {}),
          requestedByParticipantId: input.requested_by ?? 'adapter::specialists-mcp',
          ...(input.coordinator_session_id ? { coordinatorSessionId: input.coordinator_session_id } : {}),
        });

        // The handle's `result` promise is deliberately NOT awaited and deliberately not
        // dropped either: an unhandled rejection on a failed activation would take the
        // MCP server down with it. The host has already recorded the failure forensically
        // and in the snapshot, which is where a reader looks for it.
        handle.result.catch(() => { /* observed via specialist_status */ });

        const snapshot = getHost().inspect(handle.activationId);
        return {
          status: 'dispatched' as const,
          ...(snapshot ? toActivationView(snapshot) : { activation_id: handle.activationId }),
          step_contract: {
            root_work_ref: handle.stepContract.rootWorkRef,
            inputs: handle.stepContract.inputs.length,
            outputs: handle.stepContract.outputs.length,
          },
        };
      } catch (error) {
        if (error instanceof DispatchRejectedError) return rejectionResult(error);
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
