// `monday-server mcp`: monday's tools on stdio for a CLI that cannot reach
// an HTTP MCP server (ADR 0002, slice 15). A thin proxy: tools/list and
// tools/call are forwarded to the Sidecar's loopback endpoint with the
// Device token, so tiers, approvals and the Activity log stay in one place.
//
//   monday-server mcp --port <sidecar port> --token <device token>
//                     --workspace <workspace id> [--session <session id>] [--pinned a.b,c.d]
//
// The same values are read from MONDAY_SIDECAR_PORT, MONDAY_SIDECAR_TOKEN,
// MONDAY_WORKSPACE, MONDAY_SESSION and MONDAY_PINNED when a flag is absent.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export interface McpLauncherArgs {
  port: number;
  token: string;
  workspace: string;
  session: string | null;
  pinned: string[];
}

/** Flags first, the environment second. Throws with the usage line when something is missing. */
export function parseMcpArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
): McpLauncherArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} needs a value`);
      }
      flags.set(arg.slice(2), value);
      i += 1;
    }
  }
  const port = Number(flags.get("port") ?? env.MONDAY_SIDECAR_PORT);
  const token = flags.get("token") ?? env.MONDAY_SIDECAR_TOKEN ?? "";
  const workspace = flags.get("workspace") ?? env.MONDAY_WORKSPACE ?? "";
  if (!Number.isInteger(port) || port <= 0 || !token || !workspace) {
    throw new Error(
      "usage: monday-server mcp --port <sidecar port> --token <device token> --workspace <workspace id> [--session <session id>] [--pinned a.b,c.d]",
    );
  }
  const pinnedRaw = flags.get("pinned") ?? env.MONDAY_PINNED ?? "";
  return {
    port,
    token,
    workspace,
    session: flags.get("session") ?? env.MONDAY_SESSION ?? null,
    pinned: pinnedRaw
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  };
}

/** The headers the loopback endpoint attributes a call by. */
export function mcpHeaders(args: McpLauncherArgs): Record<string, string> {
  return {
    authorization: `Bearer ${args.token}`,
    "x-monday-workspace": args.workspace,
    ...(args.session ? { "x-monday-session": args.session } : {}),
    ...(args.pinned.length > 0 ? { "x-monday-pinned": args.pinned.join(",") } : {}),
  };
}

/** The stdio server that forwards to an MCP client; the transports are the caller's. */
export function createMcpProxy(upstream: Client): Server {
  const server = new Server({ name: "monday", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => upstream.listTools());
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await upstream.callTool({
      name: request.params.name,
      arguments: request.params.arguments ?? {},
    });
    return result as CallToolResult;
  });
  return server;
}

export async function runMcpLauncher(argv: readonly string[]): Promise<void> {
  const args = parseMcpArgs(argv, process.env);
  const upstream = new Client({ name: "monday-mcp-launcher", version: "0.1.0" });
  // The SDK's client transport declares `sessionId: string | undefined` under exactOptionalPropertyTypes.
  const transport: Transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${args.port}/mcp/local`),
    { requestInit: { headers: mcpHeaders(args) } },
  ) as unknown as Transport;
  await upstream.connect(transport);
  const server = createMcpProxy(upstream);
  await server.connect(new StdioServerTransport());
  await new Promise<void>((resolve) => {
    process.stdin.on("end", () => resolve());
    process.on("SIGTERM", () => resolve());
  });
  await server.close().catch(() => {});
  await upstream.close().catch(() => {});
}
