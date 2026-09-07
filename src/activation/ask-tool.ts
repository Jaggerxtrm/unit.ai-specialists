/**
 * The ask/escalate tool — PRD Phase 6.
 *
 * This is how a running Specialist reaches its parent. The shape is the important part:
 * the tool call itself BLOCKS until the answer arrives, and then returns the answer as its
 * tool result. That is what satisfies "the same AgentSession resumes" — the model is
 * sitting inside a tool call, so when it returns, the turn continues with the answer in
 * context and the child's whole history intact.
 *
 * The alternative — end the turn, store the question, start a new session with the answer
 * prepended — looks equivalent on a whiteboard and is not. It discards the child's
 * context and turns a clarification into a restart, which is the failure mode this phase
 * exists to prevent and the one that looks like success.
 *
 * The `execute` signature is `(toolCallId, args, ...)`, NOT `(args)`. Measured on pi
 * 0.85.1: the SDK invokes a custom tool's execute with five arguments and the parameters
 * object is the SECOND. Writing `(args)` binds the tool-call id string to `args`, so
 * `args.question` is undefined and the tool refuses every call as empty — the child sees a
 * tool that returns nothing and reasons about the harness being broken. Nothing catches
 * this: the parameter is typed, the call compiles, and a unit test that invokes
 * `tool.execute({ question })` directly asserts the wrong contract and passes.
 *
 * Blocking here does not block the host: `prompt()` is already awaited elsewhere, the
 * session stays alive, and `agent_settled` never fires while a tool call is outstanding.
 * There is deliberately no timeout — an unanswered question is a state an operator
 * resolves, not an error the runtime invents on their behalf.
 */

import type { PiSdk } from './pi-sdk.js';
import type { InteractionTransport } from './interaction.js';
import type { ActivationId, AttemptId, ParticipantId } from './types.js';

export interface AskToolContext {
  transport: InteractionTransport;
  activationId: ActivationId;
  /** Read at call time, not captured: a resumed activation advances its attempt. */
  currentAttemptId: () => AttemptId;
  self: ParticipantId;
  parent: ParticipantId;
  /** Notifies the host so it can move activation state and emit forensics. */
  onAsk?: (kind: 'question' | 'escalation', body: string) => void;
  onAnswered?: (kind: 'question' | 'escalation') => void;
}

/** Tool names the child sees. Stable — they appear in the child's tool contract. */
export const ASK_TOOL = 'ask_coordinator';
export const ESCALATE_TOOL = 'escalate_to_coordinator';

/**
 * Build the ask and escalate tools for one activation.
 *
 * Returned as SDK-defined custom tools, which are admitted alongside `noTools: 'builtin'`
 * and the resolved allowlist. A read-only Specialist therefore gains the ability to ask
 * without gaining any mutation capability — asking is not a workspace operation, and
 * widening the allowlist to grant it would hand every reader an edit tool.
 */
export function createAskTools(sdk: PiSdk, ctx: AskToolContext): unknown[] {
  const ask = async (kind: 'question' | 'escalation', body: string): Promise<string> => {
    if (!body?.trim()) {
      return 'Refused: an empty question cannot be answered. State the question.';
    }

    ctx.onAsk?.(kind, body);

    const reply = await ctx.transport.request({
      kind,
      from: ctx.self,
      to: ctx.parent,
      activationId: ctx.activationId,
      attemptId: ctx.currentAttemptId(),
      body,
    });

    ctx.onAnswered?.(kind);
    return reply.body;
  };

  return [
    sdk.defineTool({
      name: ASK_TOOL,
      description:
        'Ask the coordinator a clarifying question and WAIT for the answer. Use when the ' +
        'task is ambiguous and guessing would produce work that has to be redone. Your ' +
        'session stays alive while you wait and the answer is returned to you here.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question. Be specific and self-contained.' },
        },
        required: ['question'],
      },
      execute: async (_toolCallId: string, args: { question: string }) => ask('question', args.question),
    }),

    sdk.defineTool({
      name: ESCALATE_TOOL,
      description:
        'Escalate a blocker that you cannot resolve and that the coordinator may not be ' +
        'able to resolve either — a missing permission, a contradiction in the contract, ' +
        'a decision that is not yours to make. You stay alive and resume when it is resolved.',
      parameters: {
        type: 'object',
        properties: {
          blocker: { type: 'string', description: 'What is blocking you and what decision is needed.' },
        },
        required: ['blocker'],
      },
      execute: async (_toolCallId: string, args: { blocker: string }) => ask('escalation', args.blocker),
    }),
  ];
}
