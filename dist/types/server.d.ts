import { type ObservabilitySqliteClient } from './specialist/observability-sqlite.js';
type McpCallContext = {
    mcpSessionId: string;
    jsonrpcRequestId?: string;
    traceId: string;
    spanId: string;
};
export declare function createMcpCallContext(sessionId: string, request?: {
    id?: unknown;
}): McpCallContext;
export declare function toMcpMeta(context: McpCallContext): Record<string, string>;
export declare function emitMcpForensicEvent(observability: ObservabilitySqliteClient | null, eventName: string, context: McpCallContext, body: Record<string, unknown>, durationMs?: number, errorType?: string): void;
export declare class SpecialistsServer {
    private server;
    private tools;
    private observability;
    private mcpSessionId;
    /**
     * The native runtime, one instance for the life of the server process.
     *
     * This must NOT be per-call or per-turn. The FleetRegistry inside it is the seam that
     * survives a turn boundary: a Specialist that reaches `settled` is waiting and
     * resumable, and a host rebuilt per call would lose every live AgentSession and answer
     * `specialist_status` with an empty Fleet while children were still running.
     */
    private activationHost;
    /**
     * Asynchronous runtime events toward the dispatching coordinator (PRD Phase 14).
     *
     * Process-lifetime for the same reason the host is: the coordinator turn that reads a
     * completion is rarely the turn that dispatched it, and a per-call pusher would forget
     * every result it had recorded.
     */
    private eventPusher;
    constructor();
    private toolSchemas;
    private setupHandlers;
    start(): Promise<void>;
    stop(): Promise<void>;
}
export {};
//# sourceMappingURL=server.d.ts.map