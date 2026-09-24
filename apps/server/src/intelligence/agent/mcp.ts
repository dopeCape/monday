// monday's tools as an MCP server for the Local runtimes (ADR 0002): the same
// catalog the LangGraph loop binds, listed with tier annotations, and every
// call routed through the Agent host so tiers, approvals and the Activity log
// are the tool's own. A tool above the free tier blocks the MCP call until
// the composer's card is answered; the CLI sees only the result. One server
// per transport connection: the streamable HTTP route on the Sidecar builds
// one per request, the stdio launcher one per process. The SDK loads on the
// first MCP request, not at boot.
//
// Slice 19: the same server for an external credential (docs/spec/external-mcp.md),
// with its scope filtering the listing (read: read-only tools; act: every
// tool, the asking ones still asking), the credential name as the actor of
// every Activity row, and the external search cap. Developer mode never
// applies here: this server only ever serves monday's tools.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult, Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { ExternalScope } from "@monday/shared";
import { lazy } from "../../lazy.ts";
import type { AgentHost } from "./index.ts";
import type { ToolOutcome } from "./tools/index.ts";

/** Who is calling: the Workspace, the Session the cards belong to, what the Device pins. */
export interface McpContext {
  workspaceId: string;
  sessionId: string | null;
  pinned?: readonly string[] | undefined;
  /** An external credential's scope; absent for the user's own CLIs, which see every tool. */
  scope?: ExternalScope | undefined;
  /** The external credential, named as the actor on every row and card. */
  actor?: { kind: "external"; name: string } | undefined;
  /** The external search cap (external.search_cap). */
  searchLimit?: number | undefined;
  /** Runs around every call: the external module's rate limit and approval timeout. */
  around?:
    | ((run: () => Promise<CallToolResult>, name: string) => Promise<CallToolResult>)
    | undefined;
}

export const MCP_SERVER_NAME = "monday";
export const MCP_SERVER_VERSION = "0.1.0";

/** Whether a scope reaches a tool of that tier: read scope reads only, act scope everything. */
export function scopeAllows(scope: ExternalScope | undefined, tier: unknown): boolean {
  if (!scope || scope === "act") return true;
  return tier === "read";
}

/** The listing an external credential sees: the catalog filtered by its scope. */
export function toolsForScope(tools: McpTool[], scope: ExternalScope | undefined): McpTool[] {
  return tools.filter((t) => scopeAllows(scope, t._meta?.tier));
}

/** What the model reads back: the same text the Hosted loop's tool message carries. */
export function mcpResultOf(outcome: ToolOutcome): CallToolResult {
  return {
    content: [{ type: "text", text: outcome.text }],
    ...(outcome.isError ? { isError: true } : {}),
    _meta: { activityId: outcome.activity.id, tier: outcome.activity.tier },
  };
}

/** A call refused before it reached a tool: outside the credential's scope. */
export function scopeError(name: string, scope: ExternalScope): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: `Scope error: "${name}" is outside this credential's ${scope} scope. Only read-only tools are available; ask the owner for an act key.`,
      },
    ],
    isError: true,
    _meta: { error: "scope" },
  };
}

type McpSdk = [
  typeof import("@modelcontextprotocol/sdk/server/index.js"),
  typeof import("@modelcontextprotocol/sdk/types.js"),
  typeof import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"),
];

/** The SDK's server side, imported by the first MCP request and reused after it. */
const loadSdk = lazy(
  (): Promise<McpSdk> =>
    Promise.all([
      import("@modelcontextprotocol/sdk/server/index.js"),
      import("@modelcontextprotocol/sdk/types.js"),
      import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"),
    ]),
);

export type McpServer = Server;

/**
 * A stateless streamable HTTP transport for one request: no MCP session id,
 * the JSON answer once the tool returns. The SDK loads on the first request.
 */
export async function createMcpHttpTransport(): Promise<WebStandardStreamableHTTPServerTransport> {
  const [, , http] = await loadSdk();
  return new http.WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
}

export async function createMondayMcpServer(
  agent: AgentHost,
  context: McpContext,
): Promise<Server> {
  const [{ Server: SdkServer }, { CallToolRequestSchema, ListToolsRequestSchema }] =
    await loadSdk();
  const server = new SdkServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  const listing = () => toolsForScope(agent.tools(context.workspaceId).mcpTools(), context.scope);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listing() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const run = async (): Promise<CallToolResult> => {
      if (context.scope) {
        const tool = agent
          .tools(context.workspaceId)
          .mcpTools()
          .find((t) => t.name === name);
        if (tool && !scopeAllows(context.scope, tool._meta?.tier)) {
          return scopeError(name, context.scope);
        }
      }
      const outcome = await agent.call({
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        name,
        args: request.params.arguments ?? {},
        pinned: context.pinned,
        actor: context.actor,
        searchLimit: context.searchLimit,
      });
      return mcpResultOf(outcome);
    };
    return context.around ? context.around(run, name) : run();
  });
  return server;
}
