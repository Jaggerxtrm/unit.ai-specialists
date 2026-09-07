/**
 * Durable pending state for runtime-originated participant interactions.
 *
 * This module is the state of record for BOTH transports, and it is deliberately the
 * first thing built: `docs/design/claude-transport-decision.md` §5 and §7 require that
 * every runtime-originated event is written here **before** any send is attempted, and
 * that the peer push is an optimisation layered on top of this state rather than the
 * thing that creates it. An undeliverable, held or refused push therefore degrades to a
 * record that is still readable — it does not lose a message (PRD §30).
 *
 * Two rules follow, enforced by the API rather than by convention:
 *
 *   1. `create()` is the only way a record comes into existence, and it refuses to
 *      replace one. A send has nothing to reference until it has returned.
 *   2. Delivery reaches `delivered` only through `recordReceipt()`, which requires a
 *      receipt naming the originating message. `recordAttempt()` cannot reach that state:
 *      the absence of an error is not a receipt.
 *
 * Layout under `<repoRoot>/.specialists/interactions/`, matching the existing
 * `.specialists/jobs/` precedent:
 *
 *   <activationId>/<messageId>.json         written only by the sending runtime
 *   <activationId>/<messageId>.reply.json   written only by the replying coordinator side
 *
 * The reply lives in its own file on purpose. The two sides run in different processes, so
 * one file would need a lock to survive concurrent read-modify-write. Separate
 * single-writer files remove the race instead of guarding it.
 *
 * This store is RUNTIME state and never a second forensic record: `observability.db`
 * remains the single forensic authority, and nothing here writes to it. Forensic emission
 * is an injected callback on the adapter (see `peer-adapter.ts`), so this lane owns no
 * file belonging to the forensic sink.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeliveryState, InteractionKind, InteractionMessage } from '../interaction.js';

/**
 * The canonical `InteractionMessage` — the ONE semantic participant protocol (invariant BH).
 *
 * Owned by `src/activation/interaction.ts` (`unitAI-rrdnt.19`) and imported rather than
 * restated: this lane declares no field of the wire format. The store indexes a message by
 * the two correlation fields the transport needs, `activationId` and `messageId`, and never
 * reinterprets the rest.
 */
export type InteractionPayload = InteractionMessage;

/**
 * Delivery state of one runtime-originated message.
 *
 * Richer than the shared `DeliveryState` of the participant protocol, because a real wire
 * distinguishes outcomes the semantic protocol does not need to. `projectDeliveryState()`
 * maps this down: `sent_unconfirmed` and `undeliverable` both project to `pending`, since
 * neither is a receipt and neither is a refusal.
 */
export type WireDeliveryState =
  | 'pending'           // written durably; no send attempted yet
  | 'sent_unconfirmed'  // accepted by a transport; nothing has confirmed a coordinator saw it
  | 'delivered'         // receipt received, naming this message
  | 'refused'           // the approval gate or the peer declined it; not an error
  | 'undeliverable';    // no route could be selected, or the send failed

/** The participant protocol's three-state view, re-exported from the canonical module. */
export type SharedDeliveryState = DeliveryState;

/**
 * Project a wire state onto the shared protocol state.
 *
 * Only a receipt yields `delivered` and only an explicit decline yields `refused`.
 * Everything else is still outstanding, which is what a coordinator needs to know.
 */
export function projectDeliveryState(state: WireDeliveryState): SharedDeliveryState {
  if (state === 'delivered') return 'delivered';
  if (state === 'refused') return 'refused';
  return 'pending';
}

/**
 * Message kinds that create an outstanding ask.
 *
 * `question` and `escalation` expect an answer; `finding` and `completion` are
 * informational and create no attention. The kind vocabulary itself belongs to rrdnt.19 —
 * this is a routing predicate over it, not a redeclaration of it.
 */
const KINDS_AWAITING_REPLY: ReadonlySet<InteractionKind> = new Set<InteractionKind>(['question', 'escalation']);

export function createsPendingAsk(kind: string): boolean {
  return KINDS_AWAITING_REPLY.has(kind as InteractionKind);
}

/** One send attempt. Attempts accumulate; none of them is evidence of delivery. */
export interface DeliveryAttempt {
  atMs: number;
  /** Opaque route reference (`pid:<pid>/session:<sessionId>`). Never a display name. */
  route: string;
  outcome: 'sent_unconfirmed' | 'refused' | 'undeliverable';
  detail?: string;
}

/** A durable record of one runtime-originated interaction. */
export interface PendingInteraction {
  messageId: string;
  activationId: string;
  /** Copied from the message so a projection need not parse the payload. */
  kind: InteractionKind;
  createdAtMs: number;
  /** The canonical InteractionMessage, stored verbatim. */
  message: InteractionPayload;
  delivery: {
    state: WireDeliveryState;
    attempts: DeliveryAttempt[];
    receiptMsgId?: string;
    deliveredAtMs?: number;
  };
}

/**
 * A coordinator's answer. Written by the receiving side only.
 *
 * `body` carries the canonical reply message, whose `inReplyTo` is the sole correlation
 * mechanism in the participant protocol. The filename encodes the same correlation so the
 * reply can be found without scanning; it never replaces `inReplyTo`.
 */
export interface InteractionReply {
  messageId: string;
  activationId: string;
  repliedAtMs: number;
  body: InteractionPayload;
}

/** A record joined with its reply, if one has arrived. */
export interface PendingInteractionView extends PendingInteraction {
  reply?: InteractionReply;
}

export function interactionsRoot(repoRoot: string): string {
  return join(repoRoot, '.specialists', 'interactions');
}

function recordPath(repoRoot: string, activationId: string, messageId: string): string {
  return join(interactionsRoot(repoRoot), activationId, `${messageId}.json`);
}

function replyPath(repoRoot: string, activationId: string, messageId: string): string {
  return join(interactionsRoot(repoRoot), activationId, `${messageId}.reply.json`);
}

/**
 * Write JSON so a reader never observes a half-written file.
 *
 * Rename within one directory is atomic, so a concurrent reader sees either the previous
 * bytes or the complete new ones. `exclusive` additionally refuses to replace an existing
 * record, which is what stops `create()` from discarding a live interaction.
 */
function writeAtomic(path: string, value: unknown, exclusive = false): void {
  if (exclusive && existsSync(path)) {
    throw new Error(`interaction record already exists: ${path}`);
  }
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* the rename failure is the error worth reporting */ }
    throw err;
  }
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    // A record that cannot be parsed is corrupt, not absent. Listing skips it rather than
    // failing the sweep, so one bad file cannot hide every other pending message.
    return undefined;
  }
}

/**
 * Create the durable record. Call this BEFORE attempting any send.
 *
 * Throws if a record with this id already exists: overwriting one would discard a delivery
 * history a coordinator may already be acting on.
 */
export function create(
  repoRoot: string,
  input: {
    messageId: string;
    activationId: string;
    kind: InteractionKind;
    message: InteractionPayload;
    createdAtMs?: number;
  },
): PendingInteraction {
  const record: PendingInteraction = {
    messageId: input.messageId,
    activationId: input.activationId,
    kind: input.kind,
    createdAtMs: input.createdAtMs ?? Date.now(),
    message: input.message,
    delivery: { state: 'pending', attempts: [] },
  };
  mkdirSync(join(interactionsRoot(repoRoot), input.activationId), { recursive: true, mode: 0o700 });
  writeAtomic(recordPath(repoRoot, input.activationId, input.messageId), record, true);
  return record;
}

export function read(repoRoot: string, activationId: string, messageId: string): PendingInteraction | undefined {
  return readJson<PendingInteraction>(recordPath(repoRoot, activationId, messageId));
}

export function readReply(repoRoot: string, activationId: string, messageId: string): InteractionReply | undefined {
  return readJson<InteractionReply>(replyPath(repoRoot, activationId, messageId));
}

/**
 * Record one send attempt.
 *
 * No outcome here can mark a message delivered — only `recordReceipt()` can, and only
 * against a receipt naming this message. A `refused` or `undeliverable` outcome is a normal
 * result of the user's cross-session approval gate, not an error, and leaves the message
 * readable through polling.
 *
 * A later attempt never downgrades a message a receipt already confirmed. This matters
 * because reachability is asymmetric and lapses mid-session: a failed retry against a peer
 * that already answered must not erase the answer's delivery.
 */
export function recordAttempt(
  repoRoot: string,
  activationId: string,
  messageId: string,
  attempt: DeliveryAttempt,
): PendingInteraction {
  const record = read(repoRoot, activationId, messageId);
  if (!record) throw new Error(`no interaction record for ${activationId}/${messageId}`);
  record.delivery.attempts.push(attempt);
  if (record.delivery.state !== 'delivered') {
    record.delivery.state = attempt.outcome;
  }
  writeAtomic(recordPath(repoRoot, activationId, messageId), record);
  return record;
}

/**
 * Mark delivered, against a receipt naming the originating message.
 *
 * The id check is the point of the function: a receipt for another message proves nothing
 * about this one, and accepting it would produce exactly the silently-never-delivered
 * failure this bead is written against.
 */
export function recordReceipt(
  repoRoot: string,
  activationId: string,
  messageId: string,
  receipt: { origMsgId: string; receiptMsgId?: string; atMs?: number },
): PendingInteraction {
  const record = read(repoRoot, activationId, messageId);
  if (!record) throw new Error(`no interaction record for ${activationId}/${messageId}`);
  if (receipt.origMsgId !== messageId) {
    throw new Error(`receipt orig_msg_id ${receipt.origMsgId} does not match ${messageId}`);
  }
  record.delivery.state = 'delivered';
  record.delivery.receiptMsgId = receipt.receiptMsgId;
  record.delivery.deliveredAtMs = receipt.atMs ?? Date.now();
  writeAtomic(recordPath(repoRoot, activationId, messageId), record);
  return record;
}

/**
 * Write a coordinator's reply.
 *
 * Deliberately independent of delivery state: a coordinator that read the question by
 * polling never generated a receipt, and its answer must still resume the Specialist.
 */
export function recordReply(
  repoRoot: string,
  activationId: string,
  messageId: string,
  body: InteractionPayload,
  repliedAtMs = Date.now(),
): InteractionReply {
  if (!read(repoRoot, activationId, messageId)) {
    throw new Error(`no interaction record for ${activationId}/${messageId}`);
  }
  const reply: InteractionReply = { messageId, activationId, repliedAtMs, body };
  writeAtomic(replyPath(repoRoot, activationId, messageId), reply);
  return reply;
}

/**
 * Whether a kind can ever be confirmed as delivered on this transport.
 *
 * Measured on Claude Code 2.1.263: it emits no `peer_message_status` receipt to a peer
 * sender, registered or not. `receiptFrame` appears once in `pi-claude-link`'s index.ts and
 * only on the inbound path — it is what a non-Claude peer sends so a CLAUDE sender's own
 * delivered-UI resolves, never something Claude sends to us.
 *
 * So the only confirmation available is a correlated reply, and only a message that expects
 * an answer can receive one. `finding` and `completion` therefore have NO confirmation
 * available on this transport and stay `sent_unconfirmed` permanently. That is the designed
 * steady state, not a stuck record and not a bug to fix: an informational push that was
 * accepted by the wire is exactly as much as this transport can tell you.
 */
export function isConfirmable(kind: string): boolean {
  return createsPendingAsk(kind);
}

/**
 * Mark delivered on the strength of a correlated reply.
 *
 * A reply is STRICTLY STRONGER evidence than a receipt: a receipt says the wire accepted
 * the frame, whereas a reply proves a coordinator read it and answered. Acceptance AX is
 * defined as the coordinator receiving, replying, and the child resuming — so the reply is
 * the acceptance criterion, and the receipt was only ever a proxy for it.
 *
 * Three boundaries, all enforced here rather than left to the caller:
 *
 *   - Correlation is `inReplyTo === messageId` and nothing else. Never ordering, never
 *     timestamp proximity, and never "this is the only outstanding ask so it must be the
 *     one" — that heuristic is right until exactly the moment two asks are open, which is
 *     when crossing them does the damage.
 *   - Only a confirmable kind can be upgraded. An informational push is not retroactively
 *     confirmed by a reply that happened to arrive near it.
 *   - Only a push the wire actually accepted (`sent_unconfirmed`) can be upgraded. This is
 *     the boundary that is easiest to get wrong and it was caught by a test rather than by
 *     reasoning: if the send FAILED or no route was ever found, a reply proves the
 *     coordinator answered by SOME route — polling, almost certainly — and proves nothing
 *     about a push that demonstrably never left. Upgrading there would manufacture exactly
 *     the false confidence this module exists to prevent. The same logic excludes
 *     `refused`: a refusal is an explicit signal from the coordinator's approval gate, and
 *     an answer arriving by another path is not evidence about THIS push.
 */
export function recordReplyDelivery(
  repoRoot: string,
  activationId: string,
  messageId: string,
  reply: { inReplyTo?: string; atMs?: number },
): PendingInteraction {
  const record = read(repoRoot, activationId, messageId);
  if (!record) throw new Error(`no interaction record for ${activationId}/${messageId}`);
  if (reply.inReplyTo !== messageId) {
    throw new Error(`reply inReplyTo ${String(reply.inReplyTo)} does not match ${messageId}`);
  }
  if (!isConfirmable(record.kind)) return record;
  // Only a push the wire accepted may be confirmed by a reply. See the boundary note above.
  if (record.delivery.state !== 'sent_unconfirmed') return record;

  record.delivery.state = 'delivered';
  record.delivery.deliveredAtMs = reply.atMs ?? Date.now();
  writeAtomic(recordPath(repoRoot, activationId, messageId), record);
  return record;
}

/** Every record for one activation, joined with replies, oldest first. */
export function listForActivation(repoRoot: string, activationId: string): PendingInteractionView[] {
  const dir = join(interactionsRoot(repoRoot), activationId);
  if (!existsSync(dir)) return [];
  const views: PendingInteractionView[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json') || entry.endsWith('.reply.json') || entry.endsWith('.tmp')) continue;
    const record = readJson<PendingInteraction>(join(dir, entry));
    if (!record) continue;
    views.push({ ...record, reply: readReply(repoRoot, activationId, record.messageId) });
  }
  return views.sort((a, b) => a.createdAtMs - b.createdAtMs);
}

/** Every record this repository knows about, joined with replies, oldest first. */
export function listAll(repoRoot: string): PendingInteractionView[] {
  const root = interactionsRoot(repoRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .flatMap(activationId => listForActivation(repoRoot, activationId))
    .sort((a, b) => a.createdAtMs - b.createdAtMs);
}
