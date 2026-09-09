/**
 * Specialists MCP Server
 *
 * Two surfaces, deliberately not merged.
 *
 * `use_specialist` is the legacy path: it runs a Specialist through `SpecialistRunner`
 * and returns its final output synchronously.
 *
 * The `specialist_*` activation tools are the native path (PRD Phase 13). They call
 * `NativeActivationHost` in-process — no `sp` child process is spawned, which is the whole
 * point of the phase and is asserted against the process table rather than against intent.
 * They are what makes a Specialist obtainable from Claude Code without a terminal or an
 * `xt` session (acceptance AV and AW).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { MCP_CONFIG } from './constants.js';
import { createForensicEvent, deploymentEnvironment } from './specialist/forensic-events.js';
import { createObservabilitySqliteClient, type ObservabilitySqliteClient } from './specialist/observability-sqlite.js';
import { SpecialistLoader } from './specialist/loader.js';
import { SpecialistRunner } from './specialist/runner.js';
import { HookEmitter } from './specialist/hooks.js';
import { CircuitBreaker } from './utils/circuitBreaker.js';
import { BeadsClient } from './specialist/beads.js';
import { createUseSpecialistTool, useSpecialistSchema } from './tools/specialist/use_specialist.tool.js';
import { createSpecialistStatusTool } from './tools/specialist/specialist_status.tool.js';
import { createSpecialistListTool, specialistListSchema } from './tools/specialist/specialist_list.tool.js';
import {
  createSpecialistDispatchTool,
  createSpecialistReplyTool,
  createSpecialistRetryTool,
  createSpecialistStopActivationTool,
  specialistDispatchSchema,
  specialistReplySchema,
  specialistRetrySchema,
  specialistStopSchema,
} from './tools/specialist/activation.tool.js';
import { NativeActivationHost } from './activation/native-host.js';
import { RuntimeEventPusher } from './activation/async-events.js';
import { PeerAdapter } from './activation/transport/peer-adapter.js';
import { createActivationForensicSink } from './activation/forensic-sink.js';
import { logger } from './utils/logger.js';

type AnyTool = {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  execute(input: unknown, onProgress?: (msg: string) => void): Promise<unknown>;
};

type McpCallContext = {
  mcpSessionId: string;
  jsonrpcRequestId?: string;
  traceId: string;
  spanId: string;
};

export function createMcpCallContext(sessionId: string, request: { id?: unknown } = {}): McpCallContext {
  return {
    mcpSessionId: sessionId,
    jsonrpcRequestId: typeof request.id === 'string' || typeof request.id === 'number' ? String(request.id) : undefined,
    traceId: randomUUID(),
    spanId: randomUUID(),
  };
}

export function toMcpMeta(context: McpCallContext): Record<string, string> {
  return {
    trace_id: context.traceId,
    span_id: context.spanId,
    mcp_session_id: context.mcpSessionId,
    ...(context.jsonrpcRequestId ? { jsonrpc_request_id: context.jsonrpcRequestId } : {}),
    trace_carrier: '_meta',
  };
}

export function emitMcpForensicEvent(
  observability: ObservabilitySqliteClient | null,
  eventName: string,
  context: McpCallContext,
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
      severity: eventName.endsWith('.failed') || eventName === 'mcp.auth.failed' ? 'error' : eventName === 'mcp.rate_limited' ? 'warn' : 'info',
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
        mcp_session_id: context.mcpSessionId,
        jsonrpc_request_id: context.jsonrpcRequestId,
        trace_id: context.traceId,
        span_id: context.spanId,
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

export class SpecialistsServer {
  private server: Server;
  private tools: AnyTool[];
  private observability: ObservabilitySqliteClient | null;
  private mcpSessionId: string;

  /**
   * The native runtime, one instance for the life of the server process.
   *
   * This must NOT be per-call or per-turn. The FleetRegistry inside it is the seam that
   * survives a turn boundary: a Specialist that reaches `settled` is waiting and
   * resumable, and a host rebuilt per call would lose every live AgentSession and answer
   * `specialist_status` with an empty Fleet while children were still running.
   */
  private activationHost: NativeActivationHost;

  /**
   * Asynchronous runtime events toward the dispatching coordinator (PRD Phase 14).
   *
   * Process-lifetime for the same reason the host is: the coordinator turn that reads a
   * completion is rarely the turn that dispatched it, and a per-call pusher would forget
   * every result it had recorded.
   */
  private eventPusher: RuntimeEventPusher;

  constructor() {
    const circuitBreaker = new CircuitBreaker();
    const loader = new SpecialistLoader();
    const hooks = new HookEmitter({ tracePath: join(process.cwd(), '.specialists', 'trace.jsonl') });
    const beadsClient = new BeadsClient();
    const runner = new SpecialistRunner({ loader, hooks, circuitBreaker, beadsClient });

    this.observability = createObservabilitySqliteClient();

    // Native activations write the SAME observability.db as the legacy runner — there is
    // no separate native telemetry store, which is what makes Phase 7 parity meaningful.
    this.activationHost = new NativeActivationHost({
      loader,
      beadsClient,
      ...(this.observability ? { forensics: createActivationForensicSink(this.observability) } : {}),
    });
    const getHost = () => this.activationHost;

    this.eventPusher = new RuntimeEventPusher({
      adapter: new PeerAdapter({ repoRoot: process.cwd() }),
    });
    const getPusher = () => this.eventPusher;

    this.tools = [
      createUseSpecialistTool(runner),
      createSpecialistStatusTool(loader, circuitBreaker, getHost, getPusher),
      createSpecialistDispatchTool(getHost, getPusher),
      createSpecialistReplyTool(getHost),
      createSpecialistRetryTool(getHost, getPusher),
      createSpecialistStopActivationTool(getHost),
      createSpecialistListTool(loader),
    ];
    this.mcpSessionId = randomUUID();
    this.server = new Server({ name: MCP_CONFIG.SERVER_NAME, version: MCP_CONFIG.VERSION }, { capabilities: MCP_CONFIG.CAPABILITIES });
    this.setupHandlers();
  }

  private toolSchemas: Record<string, z.ZodTypeAny> = {};

  private setupHandlers(): void {
    const schemaMap: Record<string, z.ZodTypeAny> = {
      use_specialist: useSpecialistSchema,
      specialist_dispatch: specialistDispatchSchema,
      specialist_reply: specialistReplySchema,
      specialist_retry: specialistRetrySchema,
      specialist_stop_activation: specialistStopSchema,
      specialist_list: specialistListSchema,
      // specialist_status takes no arguments; the empty-object default applies.
    };
    this.toolSchemas = schemaMap;

    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      logger.debug('Received ListTools request');
      const tools = this.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: zodToJsonSchema(schemaMap[tool.name] ?? z.object({})),
      }));
      logger.debug(`Returning ${tools.length} tools`);
      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name: toolName, arguments: args = {} } = request.params;
      const context = createMcpCallContext(this.mcpSessionId, (request as { id?: unknown }).id ? { id: (request as { id?: unknown }).id } : {});
      logger.info(`Tool call: ${toolName}`);
      emitMcpForensicEvent(this.observability, 'mcp.call.started', context, { mcp_server: MCP_CONFIG.SERVER_NAME, mcp_method: 'tools/call', tool_name: toolName, network_transport: 'stdio' });

      const tool = this.tools.find((candidate) => candidate.name === toolName);
      if (!tool) {
        logger.error(`Tool not found: ${toolName}`);
        emitMcpForensicEvent(this.observability, 'mcp.call.failed', context, { mcp_server: MCP_CONFIG.SERVER_NAME, mcp_method: 'tools/call', tool_name: toolName, status_code: 'ERROR' }, undefined, 'tool_not_found');
        throw new Error(`Tool '${toolName}' not found`);
      }

      const schema = this.toolSchemas[toolName];
      const startedAt = Date.now();

      const onProgress = (msg: string) => {
        this.server.notification({ method: 'notifications/message', params: { level: 'info', logger: 'specialists', data: msg } }).catch(() => {});
      };

      try {
        const parsed = schema ? schema.parse(args) : args;
        const result = await tool.execute(parsed, onProgress);
        const elapsedMs = Date.now() - startedAt;
        emitMcpForensicEvent(this.observability, 'mcp.call.completed', context, { mcp_server: MCP_CONFIG.SERVER_NAME, mcp_method: 'tools/call', tool_name: toolName, status_code: 'OK' }, elapsedMs);
        emitMcpForensicEvent(this.observability, 'mcp.latency.observed', context, { mcp_server: MCP_CONFIG.SERVER_NAME, mcp_method: 'tools/call', tool_name: toolName, status_code: 'OK' }, elapsedMs);
        return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }], _meta: toMcpMeta(context) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Tool ${toolName} failed: ${message}`);
        const elapsedMs = Date.now() - startedAt;
        emitMcpForensicEvent(this.observability, 'mcp.call.failed', context, { mcp_server: MCP_CONFIG.SERVER_NAME, mcp_method: 'tools/call', tool_name: toolName, status_code: 'ERROR' }, elapsedMs, error instanceof Error ? error.name : 'internal_error');
        emitMcpForensicEvent(this.observability, 'mcp.latency.observed', context, { mcp_server: MCP_CONFIG.SERVER_NAME, mcp_method: 'tools/call', tool_name: toolName, status_code: 'ERROR' }, elapsedMs);
        throw error;
      }
    });
  }

  async start(): Promise<void> {
    try {
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      emitMcpForensicEvent(this.observability, 'mcp.connected', createMcpCallContext(this.mcpSessionId), { mcp_server: MCP_CONFIG.SERVER_NAME, mcp_method: 'initialize', network_transport: 'stdio' });
      logger.info(`Specialists MCP Server v2 started — ${this.tools.length} tools registered`);

      process.on('SIGTERM', async () => {
        logger.info('SIGTERM received — shutting down');
        emitMcpForensicEvent(this.observability, 'mcp.disconnected', createMcpCallContext(this.mcpSessionId), { mcp_server: MCP_CONFIG.SERVER_NAME, mcp_method: 'shutdown', network_transport: 'stdio' });
        await this.stop();
        process.exit(0);
      });
    } catch (error) {
      logger.error('Failed to start server', error);
      process.exit(1);
    }
  }

  async stop(): Promise<void> {
    logger.info('Stopping server...');
  }
}
