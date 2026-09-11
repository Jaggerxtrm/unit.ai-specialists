/**
 * Specialists MCP server on the official SDK v2, serving protocol revisions
 * 2025-11-25 and 2026-07-28 through one stdio entrypoint.
 *
 * Served via `serveStdio(() => buildV2Server(), { legacy: 'serve' })` (§J):
 * the SDK pins each connection to the opening request's era. Legacy clients
 * use the 2025-11-25 `initialize` handshake; modern clients use the
 * 2026-07-28 per-request `_meta` envelope (protocol revision + client
 * capabilities), validated independently without an `initialize` handshake,
 * `Mcp-Session-Id`, or connection-remembered capabilities (§G/H).
 * `server/discover`, `resultType: complete` and serverInfo stamping are owned
 * by the SDK; this module admits the six t2kol tools plus `specialist_resume`
 * (Wave E4 Resume-only: the same session continues, id kept, attempt advances).
 *
 * t2kol parity is structural, not re-implemented: the SAME tool factories, the
 * SAME zod schemas (kept as the parse authority), the SAME SpecialistLoader
 * authority, the SAME readiness gate inside `host.start()`, and the SAME
 * shared `renderRejection` renderer. The SDK cannot consume zod v3 schemas, so
 * tools are advertised via `fromJsonSchema(zodToJsonSchema(...))` — one JSON
 * Schema object per tool, generated from the same schema that parses.
 *
 * Deliberately absent per §§M/N: wire progress push (deprecated Logging
 * family — results are projected via `specialist_status`, Phase 14) and
 * server-initiated requests (no sampling/elicitation/roots; long operations
 * return `complete` synchronously, so no `input_required` round-trips).
 */
import { join } from 'node:path';
import * as z from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { McpServer, fromJsonSchema, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { ServerContext } from '@modelcontextprotocol/server';
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { MCP_CONFIG } from '../constants.js';
import { createObservabilitySqliteClient } from '../specialist/observability-sqlite.js';
import { SpecialistLoader } from '../specialist/loader.js';
import { SpecialistRunner } from '../specialist/runner.js';
import { HookEmitter } from '../specialist/hooks.js';
import { CircuitBreaker } from '../utils/circuitBreaker.js';
import { BeadsClient } from '../specialist/beads.js';
import { createUseSpecialistTool, useSpecialistSchema } from '../tools/specialist/use_specialist.tool.js';
import { createSpecialistStatusTool } from '../tools/specialist/specialist_status.tool.js';
import { createSpecialistListTool, specialistListSchema } from '../tools/specialist/specialist_list.tool.js';
import {
  createSpecialistDispatchTool,
  createSpecialistReplyTool,
  createSpecialistStopActivationTool,
  specialistDispatchSchema,
  specialistReplySchema,
  specialistStopSchema,
} from '../tools/specialist/activation.tool.js';
import { createSpecialistResumeTool, specialistResumeSchema } from './resume-tool.js';
import { NativeActivationHost } from '../activation/native-host.js';
import { createFileAuthorityWriter } from '../activation/authority-store.js';
import { RuntimeEventPusher } from '../activation/async-events.js';
import { PeerAdapter } from '../activation/transport/peer-adapter.js';
import { createActivationForensicSink } from '../activation/forensic-sink.js';
import { logger } from '../utils/logger.js';
import { createMcpRequestContext, emitMcpForensicEvent } from './request-meta.js';

type AnyTool = {
  name: string;
  description: string;
  execute(input: unknown): Promise<unknown>;
};

function textResult(result: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text' as const, text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
}

/**
 * Build one server instance. The `serveStdio` factory calls this once per
 * connection; the host inside lives for that connection because a dispatch in
 * one turn and its `specialist_reply`/`specialist_status` in the next must see
 * the same FleetRegistry. That is application continuity keyed by explicit
 * handles (activation_id/bead_id), not protocol state: capabilities and the
 * protocol revision are re-read from every request's own envelope.
 */
export function buildV2Server(): McpServer {
  const circuitBreaker = new CircuitBreaker();
  const loader = new SpecialistLoader();
  const hooks = new HookEmitter({ tracePath: join(process.cwd(), '.specialists', 'trace.jsonl') });
  const beadsClient = new BeadsClient();
  const runner = new SpecialistRunner({ loader, hooks, circuitBreaker, beadsClient });

  const observability = createObservabilitySqliteClient();

  // Native activations write the SAME observability.db as the legacy runner —
  // no separate native telemetry store (Phase 7 parity, unchanged from v1).
  const host = new NativeActivationHost({
    loader,
    beadsClient,
    // One Substrate authority shared with sb/Pi; path from XTRM_STATE_DB or ~/.xtrm/state.db.
    authority: createFileAuthorityWriter(),
    ...(observability ? { forensics: createActivationForensicSink(observability) } : {}),
  });
  const getHost = () => host;

  const pusher = new RuntimeEventPusher({
    adapter: new PeerAdapter({ repoRoot: process.cwd() }),
  });
  const getPusher = () => pusher;

  const server = new McpServer(
    { name: MCP_CONFIG.SERVER_NAME, version: MCP_CONFIG.VERSION },
    // Tools only: no prompts/logging capabilities (§N deprecates Logging, and
    // the list is static so listChanged stays false per §K).
    { capabilities: { tools: { listChanged: false } } },
  );

  const tools: AnyTool[] = [
    createUseSpecialistTool(runner),
    createSpecialistStatusTool(loader, circuitBreaker, getHost, getPusher),
    createSpecialistDispatchTool(getHost, getPusher),
    createSpecialistReplyTool(getHost),
    createSpecialistResumeTool(getHost, getPusher),
    createSpecialistStopActivationTool(getHost),
    createSpecialistListTool(loader),
  ];

  const schemaMap: Record<string, z.ZodTypeAny> = {
    use_specialist: useSpecialistSchema,
    specialist_dispatch: specialistDispatchSchema,
    specialist_reply: specialistReplySchema,
    specialist_resume: specialistResumeSchema,
    specialist_stop_activation: specialistStopSchema,
    specialist_list: specialistListSchema,
    // specialist_status takes no arguments; the empty-object default applies.
  };

  for (const tool of tools) {
    const schema = schemaMap[tool.name] ?? z.object({});
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema(zodToJsonSchema(schema) as Record<string, unknown>),
      },
      async (args: unknown, ctx: ServerContext) => {
        // RequestMetaEnvelope is typed `{}` (neutral layer); the reserved keys are present at runtime (probed). Read through a record view keyed by the SDK constant.
        const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
        const context = createMcpRequestContext({
          protocolVersion: envelope?.[PROTOCOL_VERSION_META_KEY],
          requestId: ctx.mcpReq.id,
        });
        logger.info(`Tool call: ${tool.name}`);
        emitMcpForensicEvent(observability, 'mcp.call.started', context, {
          mcp_server: MCP_CONFIG.SERVER_NAME,
          mcp_method: 'tools/call',
          tool_name: tool.name,
          network_transport: 'stdio',
        });
        const startedAt = Date.now();
        try {
          const parsed = schema.parse(args);
          const result = await tool.execute(parsed);
          const elapsedMs = Date.now() - startedAt;
          emitMcpForensicEvent(observability, 'mcp.call.completed', context, {
            mcp_server: MCP_CONFIG.SERVER_NAME,
            mcp_method: 'tools/call',
            tool_name: tool.name,
            status_code: 'OK',
          }, elapsedMs);
          return textResult(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`Tool ${tool.name} failed: ${message}`);
          const elapsedMs = Date.now() - startedAt;
          emitMcpForensicEvent(observability, 'mcp.call.failed', context, {
            mcp_server: MCP_CONFIG.SERVER_NAME,
            mcp_method: 'tools/call',
            tool_name: tool.name,
            status_code: 'ERROR',
          }, elapsedMs, error instanceof Error ? error.name : 'internal_error');
          throw error;
        }
      },
    );
  }

  return server;
}

/**
 * Official SDK v2 stdio entry. The SDK serves both supported eras from this
 * factory and rejects unsupported protocol revisions.
 */
export function serveV2Stdio(): StdioServerHandle {
  const handle = serveStdio(() => buildV2Server(), {
    legacy: 'serve',
    onerror: (error) => logger.error('MCP v2 transport error', error),
  });
  logger.info(
    `Specialists MCP Server v2 (2025-11-25 + 2026-07-28, dual-revision) started — 7 tools registered`,
  );
  process.on('SIGTERM', () => {
    logger.info('SIGTERM received — shutting down');
    void handle.close().finally(() => process.exit(0));
  });
  return handle;
}
