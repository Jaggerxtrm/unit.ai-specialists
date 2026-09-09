import { randomUUID } from 'node:crypto';
import { createForensicEvent, deploymentEnvironment } from '../specialist/forensic-events.js';
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

export function createMcpRequestContext(input: {
  protocolVersion?: unknown;
  requestId?: unknown;
} = {}): McpRequestContext {
  return {
    ...(typeof input.protocolVersion === 'string' ? { protocolVersion: input.protocolVersion } : {}),
    ...(typeof input.requestId === 'string' || typeof input.requestId === 'number'
      ? { jsonrpcRequestId: String(input.requestId) }
      : {}),
    traceId: randomUUID(),
    spanId: randomUUID(),
  };
}

export function emitMcpForensicEvent(
  observability: ObservabilitySqliteClient | null,
  eventName: string,
  context: McpRequestContext,
  body: Record<string, unknown>,
  durationMs?: number,
  errorType?: string,
): void {
  if (!observability) return;
  observability.appendForensicEvent(
    'mcp-gateway',
    'specialists-mcp',
    undefined,
    createForensicEvent({
      event_family: 'mcp',
      event_name: eventName,
      severity: eventName.endsWith('.failed') ? 'error' : eventName === 'mcp.rate_limited' ? 'warn' : 'info',
      resource: {
        service_namespace: 'xtrm',
        service_name: 'specialists',
        service_component: 'mcp-gateway',
        deployment_environment: deploymentEnvironment(),
        repo: 'specialists',
        participant_kind: 'adapter',
        participant_role: 'specialists-mcp',
      },
      correlation: {
        trace_id: context.traceId,
        span_id: context.spanId,
        ...(context.jsonrpcRequestId ? { jsonrpc_request_id: context.jsonrpcRequestId } : {}),
        ...(context.protocolVersion ? { protocol_version: context.protocolVersion } : {}),
      },
      body: {
        ...body,
        ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
        ...(errorType ? { error_type: errorType } : {}),
      },
      redaction: { status: 'clean' },
    }),
  );
}
