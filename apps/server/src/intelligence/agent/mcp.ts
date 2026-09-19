// monday's tools as an MCP server for the Local runtimes (ADR 0002): the same
// catalog the LangGraph loop binds, listed with tier annotations, and every
// call routed through the Agent host so tiers, approvals and the Activity log
// are the tool's own. A tool above the free tier blocks the MCP call until
// the composer's card is answered; the CLI sees only the result. One server
// per transport connection: the streamable HTTP route on the Sidecar builds
// one per request, the stdio launcher one per process.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { AgentHost } from "./index.ts";
import type { ToolOutcome } from "./tools/index.ts";

/** Who is calling: the Workspace, the Session the cards belong to, what the Device pins. */
export interface McpContext {
  workspaceId: string;
  sessionId: string | null;
  pinned?: readonly string[] | undefined;
}

export const MCP_SERVER_NAME = "monday";
export const MCP_SERVER_VERSION = "0.1.0";

/** What the model reads back: the same text the Hosted loop's tool message carries. */
export function mcpResultOf(outcome: ToolOutcome): CallToolResult {
  return {
    content: [{ type: "text", text: outcome.text }],
    ...(outcome.isError ? { isError: true } : {}),
    _meta: { activityId: outcome.activity.id, tier: outcome.activity.tier },
  };
}

export function createMondayMcpServer(agent: AgentHost, context: McpContext): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: agent.tools(context.workspaceId).mcpTools(),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const outcome = await agent.call({
      workspaceId: context.workspaceId,
      sessionId: context.sessionId,
      name: request.params.name,
      args: request.params.arguments ?? {},
      pinned: context.pinned,
    });
    return mcpResultOf(outcome);
  });
  return server;
}
