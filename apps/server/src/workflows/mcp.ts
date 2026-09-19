// MCP servers as Workflow steps (docs/spec/settings.md "MCP servers", ADR
// 0003: extension is data). The workflows.mcp_servers Setting names each
// server by command (stdio) or URL (streamable HTTP); an `mcp` Step calls one
// of its tools. A call reaches a third party, so it sits behind the always-ask
// path like an integration. Kept minimal: one client per server, connected on
// first use, no sampling or resources.

import type { McpServerSetting } from "@monday/shared";

export interface McpCallResult {
  text: string;
  isError: boolean;
  data: unknown;
}

export interface McpClients {
  call(server: string, tool: string, args: Record<string, unknown>): Promise<McpCallResult>;
  /** The tools a configured server offers, filtered by its Setting's allowlist. */
  listTools(server: string): Promise<Array<{ name: string; description: string }>>;
}

export class McpServerUnknownError extends Error {
  constructor(readonly server: string) {
    super(`no MCP server named "${server}" under Settings, Workflows`);
    this.name = "McpServerUnknownError";
  }
}

export interface SdkMcpClientsOptions {
  servers: () => Promise<McpServerSetting[]>;
}

/** The SDK client over stdio or streamable HTTP, loaded lazily so a Server without MCP steps never imports it. */
export function createSdkMcpClients(options: SdkMcpClientsOptions): McpClients {
  type Client = {
    callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<{
      content?: unknown;
      isError?: boolean | undefined;
      structuredContent?: unknown;
    }>;
    listTools(): Promise<{ tools: Array<{ name: string; description?: string | undefined }> }>;
  };
  const clients = new Map<string, Promise<Client>>();

  const connect = async (setting: McpServerSetting): Promise<Client> => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const client = new Client({ name: "monday", version: "0.1.0" });
    if (setting.command) {
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
      const [command, ...args] = setting.command.split(/\s+/);
      if (!command) throw new Error(`MCP server ${setting.name}: empty command`);
      await client.connect(new StdioClientTransport({ command, args }));
    } else if (setting.url) {
      const { StreamableHTTPClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/streamableHttp.js"
      );
      const transport = new StreamableHTTPClientTransport(
        new URL(setting.url),
        setting.token
          ? { requestInit: { headers: { authorization: `Bearer ${setting.token}` } } }
          : {},
      );
      // The SDK's transport type is looser than exactOptionalPropertyTypes likes.
      await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    } else {
      throw new Error(`MCP server ${setting.name}: a command or a URL is needed`);
    }
    return client as unknown as Client;
  };

  const clientFor = async (
    name: string,
  ): Promise<{ client: Client; setting: McpServerSetting }> => {
    const setting = (await options.servers()).find((s) => s.name === name);
    if (!setting) throw new McpServerUnknownError(name);
    let pending = clients.get(name);
    if (!pending) {
      pending = connect(setting).catch((error) => {
        clients.delete(name);
        throw error;
      });
      clients.set(name, pending);
    }
    return { client: await pending, setting };
  };

  return {
    async call(server, tool, args) {
      const { client, setting } = await clientFor(server);
      if (setting.tools.length > 0 && !setting.tools.includes(tool)) {
        throw new Error(`MCP server ${server} does not expose "${tool}" to monday`);
      }
      const result = await client.callTool({ name: tool, arguments: args });
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : ""))
        .filter((t) => t.length > 0)
        .join("\n");
      return { text, isError: result.isError === true, data: result.structuredContent ?? null };
    },
    async listTools(server) {
      const { client, setting } = await clientFor(server);
      const { tools } = await client.listTools();
      return tools
        .filter((t) => setting.tools.length === 0 || setting.tools.includes(t.name))
        .map((t) => ({ name: t.name, description: t.description ?? "" }));
    },
  };
}

/* ------------------------------ Fake ------------------------------ */

export interface FakeMcpClients extends McpClients {
  calls: Array<{ server: string; tool: string; args: Record<string, unknown> }>;
}

export function createFakeMcpClients(
  servers: Record<string, Record<string, (args: Record<string, unknown>) => McpCallResult>> = {},
): FakeMcpClients {
  const calls: FakeMcpClients["calls"] = [];
  return {
    calls,
    async call(server, tool, args) {
      const tools = servers[server];
      if (!tools) throw new McpServerUnknownError(server);
      const fn = tools[tool];
      if (!fn) return { text: `no tool ${tool}`, isError: true, data: null };
      calls.push({ server, tool, args });
      return fn(args);
    },
    async listTools(server) {
      const tools = servers[server];
      if (!tools) throw new McpServerUnknownError(server);
      return Object.keys(tools).map((name) => ({ name, description: "" }));
    },
  };
}
