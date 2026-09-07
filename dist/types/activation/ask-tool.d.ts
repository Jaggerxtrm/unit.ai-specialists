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
 * Three separate defects made this file unreachable, each hidden by the last. The tools
 * were filtered out of the session entirely (unitAI-rrdnt.43.1); then they arrived with the
 * wrong execute signature (.43.2); then they ran correctly and returned a bare string,
 * which pi normalises to empty content (.43.3). Every one was invisible to a unit test that
 * called `execute` directly and asserted on its return value, because at that boundary each
 * defect was correct.
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
export declare const ASK_TOOL = "ask_coordinator";
export declare const ESCALATE_TOOL = "escalate_to_coordinator";
/**
 * Build the ask and escalate tools for one activation.
 *
 * Returned as SDK-defined custom tools, which are admitted alongside `noTools: 'builtin'`
 * and the resolved allowlist. A read-only Specialist therefore gains the ability to ask
 * without gaining any mutation capability — asking is not a workspace operation, and
 * widening the allowlist to grant it would hand every reader an edit tool.
 */
export interface AgentToolResult {
    content: Array<{
        type: 'text';
        text: string;
    }>;
    details: Record<string, unknown>;
}
export declare function createAskTools(sdk: PiSdk, ctx: AskToolContext): unknown[];
//# sourceMappingURL=ask-tool.d.ts.map