/**
 * Peer adapter — pushes a runtime-originated interaction to a Claude coordinator, and
 * degrades to the polling fallback whenever it cannot.
 *
 * The ordering below is the whole contract, and it is why the durable store was built
 * first:
 *
 *   1. Write the durable record.        <- before anything else can fail
 *   2. Resolve a route from the roster. <- /proc + procStart, never status, never sockets
 *   3. Attempt the send.                <- acceptance only
 *   4. Wait for a receipt.              <- the only thing that means "delivered"
 *
 * Every step from 2 onward may fail, and none of those failures loses the message: the
 * record from step 1 is already readable through `specialist_status`, and the Specialist
 * stays in `needs_reply` rather than failing or silently proceeding.
 *
 * What this adapter is NOT: it is never authoritative for activation identity, lease
 * authority, result state or forensic state (PRD §107, invariant 14). It writes runtime
 * state only. Forensic emission is an injected callback so `observability.db` stays the
 * single forensic authority and this lane owns no file belonging to the forensic sink.
 */

import {
  create,
  read,
  recordAttempt,
  recordReceipt,
  type InteractionPayload,
  type PendingInteraction,
} from './pending-store.js';
import { awaitReply } from './polling.js';
import {
  buildEnvelope,
  buildUserFrame,
  sendFrame,
  type ReceiptSource,
} from './peer-transport.js';
import { selectRoute, type LiveRoute, type ProcessProbe } from './roster.js';
import type { InteractionKind } from '../interaction.js';

/**
 * Why a push did not reach `delivered`.
 *
 * None of these is an error. §5: peer delivery passes the user's cross-session approval
 * gate and may be held, delayed or refused, and reachability lapses mid-session.
 */
export type PushOutcome =
  | 'delivered'          // a receipt named this message
  | 'no_route'           // no live registration for that coordinator; polling covers it
  | 'send_failed'        // the write failed; says nothing about whether the peer exists
  | 'no_receipt'         // accepted by the wire, never confirmed; may still be held
  | 'refused';           // the peer or the approval gate declined it, explicitly

export interface PushResult {
  outcome: PushOutcome;
  record: PendingInteraction;
  route?: LiveRoute;
  /** Present when the peer answered with an explicit non-delivery status. */
  reason?: string;
}

/** A forensic event, handed to the host rather than written here. */
export interface TransportForensicEvent {
  event: 'peer.route_selected' | 'peer.route_absent' | 'peer.send_attempted' | 'peer.receipt' | 'peer.no_receipt';
  activationId: string;
  messageId: string;
  routeRef?: string;
  detail?: string;
}

export interface PeerAdapterOptions {
  /** Repository root under which `.specialists/interactions/` lives. */
  repoRoot: string;
  /** Receipts, if this process binds a socket. Without it nothing is ever `delivered`. */
  receipts?: ReceiptSource;
  /** This sender's own peer address, echoed as the envelope `from`. */
  selfAddress?: string;
  /** Display label for the envelope. Never an address — `nameSource` is not identity. */
  selfName?: string;
  /** How long to wait for a receipt before recording `sent_unconfirmed`. */
  receiptTimeoutMs?: number;
  /** Roster overrides, for tests. */
  rosterDir?: string;
  probe?: ProcessProbe;
  /** Forensic sink, injected. `observability.db` is not written from this lane. */
  emit?: (event: TransportForensicEvent) => void;
}

/**
 * A message to push, addressed by the coordinator's session id.
 *
 * `messageId`, `activationId` and `kind` are the canonical `InteractionMessage`'s own
 * fields, passed explicitly so this lane indexes the message without reinterpreting the
 * vocabulary it does not own (`src/activation/interaction.ts`, `unitAI-rrdnt.19`).
 */
export interface PushRequest {
  messageId: string;
  activationId: string;
  kind: InteractionKind;
  /** The canonical InteractionMessage, stored verbatim and serialised onto the wire. */
  message: InteractionPayload;
  /** Human-readable body carried in the envelope. */
  body: string;
  /** The coordinator's Claude session id. The only stable address. */
  coordinatorSessionId: string;
}

export class PeerAdapter {
  constructor(private readonly options: PeerAdapterOptions) {}

  /**
   * Push one interaction, writing durable state before anything is attempted.
   *
   * Returns the outcome rather than throwing for a non-delivery: a held, refused or
   * unrouteable message is a normal state of this transport, and the caller's next move is
   * the same in every case — wait on the durable store.
   */
  async push(request: PushRequest): Promise<PushResult> {
    const { repoRoot, emit } = this.options;

    // 1. Durable first. If the process dies on the next line, the message is not lost.
    const existing = read(repoRoot, request.activationId, request.messageId);
    const record = existing ?? create(repoRoot, {
      messageId: request.messageId,
      activationId: request.activationId,
      kind: request.kind,
      message: request.message,
    });

    // 2. Route. A registration is only a route if /proc and procStart agree; the
    //    registration's own `status` and the presence of its socket file are ignored.
    const route = selectRoute(request.coordinatorSessionId, {
      dir: this.options.rosterDir,
      probe: this.options.probe,
    });
    if (!route) {
      emit?.({ event: 'peer.route_absent', activationId: request.activationId, messageId: request.messageId });
      return {
        outcome: 'no_route',
        record: recordAttempt(repoRoot, request.activationId, request.messageId, {
          atMs: Date.now(),
          route: `session:${request.coordinatorSessionId}`,
          outcome: 'undeliverable',
          detail: 'no live registration matched this coordinator session',
        }),
      };
    }
    emit?.({
      event: 'peer.route_selected',
      activationId: request.activationId,
      messageId: request.messageId,
      routeRef: route.routeRef,
    });

    // 3. Send. Arm the receipt wait BEFORE writing, because a fast peer can answer before
    //    the write call returns.
    const receiptTimeoutMs = this.options.receiptTimeoutMs ?? 10_000;
    const pendingReceipt = this.options.receipts?.waitForReceipt(request.messageId, receiptTimeoutMs);

    const frame = buildUserFrame({
      msgId: request.messageId,
      content: buildEnvelope({
        from: this.options.selfAddress,
        fromName: this.options.selfName,
        body: request.body,
      }),
      from: this.options.selfAddress,
    });

    try {
      await sendFrame(route.socketPath, frame);
    } catch (err) {
      emit?.({
        event: 'peer.send_attempted',
        activationId: request.activationId,
        messageId: request.messageId,
        routeRef: route.routeRef,
        detail: String(err),
      });
      // A failed send is evidence about this attempt only. §4 measured a peer that
      // returned ENOENT on send while still delivering messages to this session, so the
      // route is not blacklisted and the peer is not marked gone.
      return {
        outcome: 'send_failed',
        route,
        record: recordAttempt(repoRoot, request.activationId, request.messageId, {
          atMs: Date.now(),
          route: route.routeRef,
          outcome: 'undeliverable',
          detail: err instanceof Error ? err.message : String(err),
        }),
      };
    }

    // The write succeeded. That is acceptance by the wire and nothing more.
    recordAttempt(repoRoot, request.activationId, request.messageId, {
      atMs: Date.now(),
      route: route.routeRef,
      outcome: 'sent_unconfirmed',
    });

    // 4. Receipt, or no claim of delivery.
    const receipt = await pendingReceipt;
    if (!receipt) {
      emit?.({
        event: 'peer.no_receipt',
        activationId: request.activationId,
        messageId: request.messageId,
        routeRef: route.routeRef,
      });
      return { outcome: 'no_receipt', route, record: read(repoRoot, request.activationId, request.messageId)! };
    }

    emit?.({
      event: 'peer.receipt',
      activationId: request.activationId,
      messageId: request.messageId,
      routeRef: route.routeRef,
      detail: receipt.status,
    });

    if (!isDeliveredStatus(receipt.status)) {
      // A held or refused message is not an error and is not lost — it stays readable.
      return {
        outcome: 'refused',
        route,
        reason: receipt.reason ?? receipt.status,
        record: recordAttempt(repoRoot, request.activationId, request.messageId, {
          atMs: Date.now(),
          route: route.routeRef,
          outcome: 'refused',
          detail: receipt.reason ?? receipt.status,
        }),
      };
    }

    return {
      outcome: 'delivered',
      route,
      record: recordReceipt(repoRoot, request.activationId, request.messageId, {
        origMsgId: request.messageId,
        receiptMsgId: receipt.msg_id,
      }),
    };
  }

  /**
   * Push a question and wait for the coordinator's answer.
   *
   * The wait is always on the durable store, never on the socket. That is what makes the
   * two transports indistinguishable to the caller (invariant BH): a coordinator that was
   * pushed to and one that read `specialist_status` both write the reply to the same
   * place, so this resolves identically whether the push was delivered, held, refused or
   * never routed at all.
   */
  async ask(
    request: PushRequest,
    wait: { timeoutMs: number; intervalMs?: number; signal?: AbortSignal },
  ): Promise<{ push: PushResult; reply?: InteractionPayload }> {
    const push = await this.push(request);
    const reply = await awaitReply(this.options.repoRoot, request.activationId, request.messageId, wait);
    return { push, reply: reply?.body };
  }
}

/**
 * Which receipt statuses mean the message reached the coordinator.
 *
 * Deliberately an allowlist. An unrecognised status is treated as non-delivery, because
 * the failure this bead is written against is a channel that silently never delivers, and
 * a denylist would turn every new status into a false success.
 */
function isDeliveredStatus(status: string): boolean {
  return status === 'delivered' || status === 'approved' || status === 'released';
}
