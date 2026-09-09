import type { ObservabilitySqliteClient } from '../specialist/observability-sqlite.js';
/**
 * Per-request MCP context for the SDK v2 (2026-07-28) server.
 *
 * Strictly per-request: a fresh trace/span pair is minted for every tool call
 * and nothing is carried across requests. There is deliberately no session id —
 * 2026-07-28 removed `initialize`/`Mcp-Session-Id`, so cross-request linkage
 * would be connection-scoped state smuggled back in (§G).
 */
export interface McpRequestContext {
    protocolVersion?: string;
    jsonrpcRequestId?: string;
    traceId: string;
    spanId: string;
}
export declare function createMcpRequestContext(input?: {
    protocolVersion?: unknown;
    requestId?: unknown;
}): McpRequestContext;
export declare function emitMcpForensicEvent(observability: ObservabilitySqliteClient | null, eventName: string, context: McpRequestContext, body: Record<string, unknown>, durationMs?: number, errorType?: string): void;
//# sourceMappingURL=request-meta.d.ts.map