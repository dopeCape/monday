// `monday-server mcp`: monday's tools on stdio for a CLI that cannot reach
// an HTTP MCP server (ADR 0002, slice 15; docs/spec/external-mcp.md, slice 19).
// A thin proxy: tools/list and tools/call are forwarded to a running Server,
// so tiers, approvals and the Activity log stay in one place. It never
// starts a second server. Two modes, by which credential it carries:
//
//   monday-server mcp --port <sidecar port> --token <device token>
//                     --workspace <workspace id> [--session <session id>] [--pinned a.b,c.d]
//     The user's own CLI beside the client: the Device token on the Sidecar's
//     loopback endpoint /mcp/local, every tool, cards in the named Session.
//
//   monday-server mcp --key <external key> (--port <sidecar port> | --url <server url>)
//                     [--workspace <workspace id>]
//     Another agent with a Key from Settings, AI, External access: the
//     credential on /mcp of the Sidecar (loopback) or a Cloud Server (HTTPS),
//     the tools its scope allows, approvals routed to the owner.
//
// The same values are read from MONDAY_SIDECAR_PORT, MONDAY_SERVER_URL,
// MONDAY_SIDECAR_TOKEN, MONDAY_MCP_KEY, MONDAY_WORKSPACE, MONDAY_SESSION and
// MONDAY_PINNED when a flag is absent.

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
  /** The Sidecar's loopback port; null when a Cloud URL is given instead. */
  port: number | null;
  /** A Cloud Server's URL, for the key mode off the user's machine. */
  url: string | null;
  /** The Device token (Device mode); null in key mode. */
  token: string | null;
  /** The external key (key mode); null in Device mode. */
  key: string | null;
  /** Required in Device mode; optional in key mode when the key reaches one Workspace. */
  workspace: string | null;
  session: string | null;
  pinned: string[];
}

const USAGE =
  "usage: monday-server mcp --port <sidecar port> --token <device token> --workspace <workspace id> [--session <session id>] [--pinned a.b,c.d]\n" +
  "       monday-server mcp --key <external key> (--port <sidecar port> | --url <server url>) [--workspace <workspace id>]";

/** Flags first, the environment second. Throws with the usage lines when something is missing. */
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
  const portRaw = flags.get("port") ?? env.MONDAY_SIDECAR_PORT;
  const port = portRaw === undefined ? null : Number(portRaw);
  const url = flags.get("url") ?? env.MONDAY_SERVER_URL ?? null;
  const key = flags.get("key") ?? env.MONDAY_MCP_KEY ?? null;
  const token = key ? null : (flags.get("token") ?? env.MONDAY_SIDECAR_TOKEN ?? null);
  const workspace = flags.get("workspace") ?? env.MONDAY_WORKSPACE ?? null;
  const portOk = port !== null && Number.isInteger(port) && port > 0;
  if (key) {
    if (!portOk && !url) throw new Error(USAGE);
  } else if (!portOk || !token || !workspace) {
    throw new Error(USAGE);
  }
  const pinnedRaw = flags.get("pinned") ?? env.MONDAY_PINNED ?? "";
  return {
    port: portOk ? port : null,
    url: key ? url : null,
    token,
    key,
    workspace,
    session: key ? null : (flags.get("session") ?? env.MONDAY_SESSION ?? null),
    pinned: key
      ? []
      : pinnedRaw
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean),
  };
}

/** Where the proxy connects: /mcp with a key (Sidecar loopback or Cloud), /mcp/local with a Device token. */
export function upstreamUrl(args: McpLauncherArgs): string {
  if (args.key) {
    const base = args.url ? args.url.replace(/\/+$/, "") : `http://127.0.0.1:${args.port}`;
    return `${base}/mcp`;
  }
  return `http://127.0.0.1:${args.port}/mcp/local`;
}

/** The headers the endpoint attributes a call by. */
export function mcpHeaders(args: McpLauncherArgs): Record<string, string> {
  return {
    authorization: `Bearer ${args.key ?? args.token ?? ""}`,
    ...(args.workspace ? { "x-monday-workspace": args.workspace } : {}),
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
  const transport: Transport = new StreamableHTTPClientTransport(new URL(upstreamUrl(args)), {
    requestInit: { headers: mcpHeaders(args) },
  }) as unknown as Transport;
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
