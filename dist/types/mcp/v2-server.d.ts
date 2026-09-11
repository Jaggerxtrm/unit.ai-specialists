import { McpServer } from '@modelcontextprotocol/server';
import type { McpRequestContext } from '@modelcontextprotocol/server';
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';
/**
 * Build one server instance. The `serveStdio` factory calls this once per
 * connection; the host inside lives for that connection because a dispatch in
 * one turn and its `specialist_reply`/`specialist_status` in the next must see
 * the same FleetRegistry. That is application continuity keyed by explicit
 * handles (activation_id/bead_id), not protocol state: capabilities and the
 * protocol revision are re-read from every request's own envelope.
 */
export declare function buildV2Server(ctx?: McpRequestContext): McpServer;
/**
 * Official SDK v2 stdio entry. The SDK serves both supported eras from this
 * factory and rejects unsupported protocol revisions.
 */
export declare function serveV2Stdio(): StdioServerHandle;
//# sourceMappingURL=v2-server.d.ts.map