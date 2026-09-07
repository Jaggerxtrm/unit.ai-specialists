/**
 * Claude Code cross-session wire — the frames, and the receipt that is the only proof of
 * delivery.
 *
 * The shape is not invented here. It is the protocol `pi-claude-link` (MIT) already
 * implements and `docs/design/claude-transport-decision.md` §3 says to reuse: newline-
 * delimited JSON over the per-PID `0600` unix socket named by the session registration.
 *
 * Two properties of that protocol drive every design choice below:
 *
 *   1. A send resolves when the socket write completes and the peer closes the connection.
 *      That is transport ACCEPTANCE and nothing more. The receiving session has not been
 *      consulted, and the user's cross-session approval gate has not yet run.
 *   2. The receipt is asynchronous and arrives on the SENDER's own socket. A sender with
 *      no bound socket can transmit but can never learn an outcome — so it must never
 *      claim one.
 *
 * A third property was MEASURED rather than assumed, on 2026-09-07, by pushing a real
 * frame from this adapter to a live Claude coordinator (pid 3574376) and asking that
 * coordinator what it saw. The message ARRIVED and rendered normally in the peer's
 * session; no `peer_message_status` frame naming it ever came back, over 15s, to a
 * correctly colocated `/run/user/1000/cc-socks/sp-<pid>-<rand>.sock`. The sender held no
 * `~/.claude/sessions/<pid>.json` registration, and `pi-claude-link` always calls
 * `registerPeer()` before it sends.
 *
 * The channel therefore DELIVERS without registration but cannot CONFIRM delivery without
 * it. Acceptance AX consequently depends on the runtime registering itself as a peer,
 * which writes a file into the user's home directory and is the user's decision, not this
 * adapter's. Until that is ruled on, every push is correctly recorded `sent_unconfirmed`
 * and the question stays readable through the polling projection — which is precisely the
 * degradation the no-loss design exists to provide.
 *
 * `sendUserMessage` versus `steer` is deliberately absent from this module. The decision
 * record describes it as a sender choice, but the measured protocol shows otherwise: it is
 * the RECEIVER's injection choice (`pi-claude-link/index.ts:91` picks `deliverAs: "steer"`
 * when its own agent is busy), and every outbound frame carries the default `priority` of
 * `"next"`. A sender that tried to choose would be branching on the registration's
 * self-reported `status`, which §4 measured as unreliable.
 */
/** Claude drops a connection past 1 MiB without a newline. */
export declare const MAX_LINE_BYTES: number;
/** A `user` frame — the carrier for a runtime-originated message. */
export interface UserFrame {
    msgV: 1;
    msg_id: string;
    type: 'user';
    priority: string;
    from?: string;
    session_id?: string;
    message: {
        role: 'user';
        content: string;
    };
}
/** A `peer_message_status` control frame. The only thing that proves delivery. */
export interface ReceiptFrame {
    msgV: 1;
    msg_id: string;
    type: 'control';
    action: 'peer_message_status';
    status: string;
    orig_msg_id?: string;
    reason?: string;
    from?: string;
}
/**
 * The socket directory Claude binds in.
 *
 * Discovered from an existing registration rather than guessed from the environment,
 * because a receipt is only sent to a sibling of Claude's own socket. Falls back to the
 * conventional path when the roster is empty.
 */
export declare function peerSocketDir(rosterDir?: string): string;
/** Wrap a body in the envelope a Claude session recognises as a peer message. */
export declare function buildEnvelope(input: {
    from?: string;
    fromName?: string;
    body: string;
}): string;
/**
 * Build a user frame.
 *
 * `msg_id` is the correlation key a receipt echoes back as `orig_msg_id`. The caller
 * supplies it so it can be the durable record's message id, which is what lets a receipt
 * arriving after a process restart still be matched to the right pending interaction.
 */
export declare function buildUserFrame(input: {
    msgId: string;
    content: string;
    from?: string;
    sessionId?: string;
    priority?: string;
}): UserFrame;
/** True when a frame is a receipt naming `origMsgId`. */
export declare function isReceiptFor(frame: unknown, origMsgId: string): frame is ReceiptFrame;
/**
 * Write one frame to a socket and close.
 *
 * Resolving means the bytes were accepted, NOT that anything was delivered. The caller
 * must treat this as `sent_unconfirmed` until a receipt arrives.
 *
 * A rejection here is equally uninformative in the other direction: §4 measured a peer
 * whose socket returned `ENOENT` on send while it kept delivering messages to this
 * session. A throw means this attempt failed, never that the peer is gone.
 */
export declare function sendFrame(socketPath: string, frame: unknown, timeoutMs?: number): Promise<void>;
/**
 * A source of delivery receipts.
 *
 * Injectable because a receipt requires a bound, colocated socket, which not every host
 * process has. When no source is supplied the adapter can still transmit — it simply can
 * never mark anything delivered, and every message stays readable through polling. That is
 * the correct degradation: a runtime that cannot observe an outcome must not assert one.
 */
export interface ReceiptSource {
    /** Resolve with the receipt naming `origMsgId`, or `undefined` if none arrives in time. */
    waitForReceipt(origMsgId: string, timeoutMs: number): Promise<ReceiptFrame | undefined>;
    close(): Promise<void>;
}
/**
 * Bind a colocated socket and collect receipts from it.
 *
 * Receipts are retained by `orig_msg_id` whether or not anyone is waiting yet, because the
 * receipt for a fast peer can arrive before the send call has returned.
 *
 * The connection is not held half-open: Claude's sender resolves its own send only when
 * the socket fully closes, so holding it would make every inbound message to us look like
 * a failure to the peer that sent it.
 */
export declare function createSocketReceiptSource(socketPath: string): Promise<ReceiptSource>;
/** A fresh peer address for a process that binds its own receipt socket. */
export declare function newPeerSocketPath(rosterDir?: string): string;
//# sourceMappingURL=peer-transport.d.ts.map