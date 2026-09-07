/**
 * Polling fallback — the degraded path, and the only one with no external dependency.
 *
 * `docs/design/claude-transport-decision.md` §7 requires this to be built first, because
 * it is what the pending state is read through. Every guarantee the peer channel cannot
 * make is made here instead: when no route can be selected, when the user's cross-session
 * approval gate holds or refuses a push, or when reachability lapses mid-session, the
 * question is still visible and the answer still resumes the Specialist.
 *
 * Nothing in this module talks to a socket, a roster or a process. It reads the durable
 * store and nothing else, which is what makes it the fallback rather than a second
 * transport.
 */

import {
  createsPendingAsk,
  listAll,
  listForActivation,
  projectDeliveryState,
  readReply,
  type InteractionReply,
  type PendingInteractionView,
  type SharedDeliveryState,
} from './pending-store.js';

/**
 * One outstanding interaction, projected for a status surface.
 *
 * Field names are snake_case to match the existing `specialist_status` payload shape
 * (`background_jobs`, `started_at_ms`), so a coordinator reads one consistent surface.
 */
export interface PendingInteractionProjection {
  activation_id: string;
  message_id: string;
  kind: string;
  /** The participant protocol's three-state view, never the richer wire state. */
  delivery: SharedDeliveryState;
  /** The wire outcome, for diagnosis only. A coordinator must not branch on it. */
  wire_delivery: string;
  created_at_ms: number;
  send_attempts: number;
  /** True once a coordinator has answered, whether it read the ask by push or by polling. */
  answered: boolean;
  /** Present only for informational kinds, which never wait for an answer. */
  awaiting_reply: boolean;
  body?: string;
}

/**
 * Read `body` out of an opaque payload without depending on the message vocabulary.
 *
 * The projection surfaces the question text so a polling coordinator can act on it without
 * a second fetch. `body` is a documented field of the canonical `InteractionMessage`, but
 * this lane treats the payload as opaque, so the read is structural and tolerates its
 * absence rather than asserting a shape it does not own.
 */
function bodyOf(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const value = (message as { body?: unknown }).body;
  return typeof value === 'string' ? value : undefined;
}

function project(view: PendingInteractionView): PendingInteractionProjection {
  return {
    activation_id: view.activationId,
    message_id: view.messageId,
    kind: view.kind,
    delivery: projectDeliveryState(view.delivery.state),
    wire_delivery: view.delivery.state,
    created_at_ms: view.createdAtMs,
    send_attempts: view.delivery.attempts.length,
    answered: view.reply !== undefined,
    awaiting_reply: createsPendingAsk(view.kind) && view.reply === undefined,
    body: bodyOf(view.message),
  };
}

/**
 * Every interaction this repository knows about, for the status surface.
 *
 * Exported with an explicit signature because `unitAI-rrdnt.19` wires it into
 * `specialist_status`; this lane does not edit the MCP dispatch surface itself.
 */
export function projectInteractionsForStatus(repoRoot: string): PendingInteractionProjection[] {
  return listAll(repoRoot).map(project);
}

/**
 * Only the interactions still waiting on a coordinator.
 *
 * This is the answer to "did anything get lost when the push failed?". A question whose
 * push was refused appears here identically to one that was never pushed at all — which is
 * the point: the coordinator's view does not depend on the transport.
 */
export function projectOutstandingAsks(repoRoot: string): PendingInteractionProjection[] {
  return projectInteractionsForStatus(repoRoot).filter(p => p.awaiting_reply);
}

/** The same projection, narrowed to one activation. */
export function projectActivationInteractions(
  repoRoot: string,
  activationId: string,
): PendingInteractionProjection[] {
  return listForActivation(repoRoot, activationId).map(project);
}

export interface AwaitReplyOptions {
  /** Give up after this long. Expiry is not failure: the record stays readable. */
  timeoutMs: number;
  /** How often to re-read the store. */
  intervalMs?: number;
  /** Abort early, e.g. when the activation is stopped. */
  signal?: AbortSignal;
}

/**
 * Wait for a coordinator's answer by polling the durable store.
 *
 * This is how a Specialist resumes when the peer push never arrived, and it is also
 * correct when the push did arrive: the reply is written to the same place either way, so
 * a coordinator that answered over the peer channel and one that answered after reading
 * `specialist_status` are indistinguishable here apart from latency (invariant BH).
 *
 * Returns `undefined` on timeout rather than throwing. A question that has not been
 * answered yet is a normal state — the Specialist stays in `needs_reply`; it does not fail
 * and it does not silently proceed.
 */
export async function awaitReply(
  repoRoot: string,
  activationId: string,
  messageId: string,
  options: AwaitReplyOptions,
): Promise<InteractionReply | undefined> {
  const intervalMs = options.intervalMs ?? 500;
  const deadline = Date.now() + options.timeoutMs;

  for (;;) {
    const reply = readReply(repoRoot, activationId, messageId);
    if (reply) return reply;
    if (options.signal?.aborted) return undefined;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return undefined;
    await sleep(Math.min(intervalMs, remaining), options.signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}
