// MCP servers as Workflow steps (docs/spec/settings.md "MCP servers", ADR
// 0003: extension is data). The workflows.mcp_servers Setting names each
// server by command (stdio) or URL (streamable HTTP, or SSE for older
// servers); an `mcp` Step calls one of its tools. A call reaches a third
// party, so it sits behind the always-ask path like an integration. One
// client per server, connected on first use and reconnected when its Setting
// changes, no sampling or resources.
//
// What opens a server lives sealed (mcp-secrets.ts): the values for the
// `{name}` holes in its URL, headers, arguments and environment, and its OAuth
// tokens, which the SDK refreshes on a 401 through the stored provider
// (mcp-oauth.ts). An older entry that still carries its bearer token in the
// Setting keeps working until the Server moves the token into the store.

import type { McpServerSetting, McpServerStatus } from "@monday/shared";
import { McpNeedsSignInError } from "./mcp-oauth.ts";
import { fillTemplate, placeholdersOf } from "./mcp-registry.ts";
import type { McpSecret, McpSecretStore } from "./mcp-secrets.ts";

export interface McpCallResult {
  text: string;
  isError: boolean;
  data: unknown;
}

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface McpClients {
  call(server: string, tool: string, args: Record<string, unknown>): Promise<McpCallResult>;
  /** The tools a configured server offers, filtered by its Setting's allowlist. */
  listTools(server: string): Promise<McpToolInfo[]>;
  /** Every tool a server offers, ignoring the allowlist, over a fresh connection; for choosing tools. */
  probe(setting: McpServerSetting): Promise<McpToolInfo[]>;
  /** Drops the cached connection, after a sign-in or a change to the server. */
  forget(server: string): void;
  /** What the last connection attempt said, per server. */
  status(server: string): { status: McpServerStatus; message: string | null } | null;
}

export class McpServerUnknownError extends Error {
  constructor(readonly server: string) {
    super(`no MCP server named "${server}" under Settings, Workflows`);
    this.name = "McpServerUnknownError";
  }
}

/** A local (stdio) server asked of a Server that cannot start processes (Vercel, Netlify). */
export class McpLocalUnavailableError extends Error {
  constructor(readonly server: string) {
    super(`${server} runs a command, which only a Sidecar or a container Server can start`);
    this.name = "McpLocalUnavailableError";
  }
}

/** Inputs the server needs that were never given. */
export class McpNeedsInputError extends Error {
  constructor(
    readonly server: string,
    readonly missing: string[],
  ) {
    super(`${server} needs ${missing.join(", ")}`);
    this.name = "McpNeedsInputError";
  }
}

export type TransportFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface SdkMcpClientsOptions {
  servers: () => Promise<McpServerSetting[]>;
  /** The sealed values and OAuth state; absent, only what the Setting holds is used. */
  secrets?: McpSecretStore | undefined;
  /** The background OAuth provider for a server that signs in with OAuth. */
  oauthProvider?:
    | ((
        setting: McpServerSetting,
      ) => import("@modelcontextprotocol/sdk/client/auth.js").OAuthClientProvider)
    | undefined;
  /** Whether this Server may spawn commands: true on the Sidecar and in a container. */
  stdio?: boolean | undefined;
  /** How long to wait for a server to connect or list its tools. */
  timeoutMs?: (() => Promise<number>) | undefined;
  /** The HTTP client for URL servers; tests pass one. */
  fetch?: TransportFetch | undefined;
}

type SdkClient = {
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<{
    content?: unknown;
    isError?: boolean | undefined;
    structuredContent?: unknown;
  }>;
  listTools(): Promise<{ tools: Array<{ name: string; description?: string | undefined }> }>;
  close(): Promise<void>;
};

/** Whether an error is the server refusing who we are (a 401, or the SDK's UnauthorizedError). */
export function isUnauthorized(error: unknown): boolean {
  for (let e = error, depth = 0; e && depth < 4; depth++) {
    const x = e as {
      code?: unknown;
      name?: unknown;
      message?: unknown;
      constructor?: { name?: string };
    };
    if (x.code === 401 || x.code === 403) return true;
    if (x.constructor?.name === "UnauthorizedError" || x.name === "UnauthorizedError") return true;
    if (typeof x.message === "string" && /\b401\b|unauthori[sz]ed/i.test(x.message)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** The values a server's holes are filled from: sealed ones, plus an older Setting's token. */
function valuesOf(setting: McpServerSetting, secret: McpSecret | null): Record<string, string> {
  return {
    ...(setting.token ? { token: setting.token } : {}),
    ...(secret?.values ?? {}),
  };
}

function missingIn(templates: string[], values: Record<string, string>): string[] {
  const out: string[] = [];
  for (const t of templates) {
    for (const name of placeholdersOf(t))
      if (!(name in values) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Whether the server refused with 402 Payment Required: its provider wants a paid plan. */
export function isPaymentRequired(error: unknown): boolean {
  for (let e = error, depth = 0; e && depth < 4; depth++) {
    const x = e as { code?: unknown; message?: unknown };
    if (x.code === 402) return true;
    if (typeof x.message === "string" && /\b402\b|payment required/i.test(x.message)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** The status an error from connecting or calling means. */
export function statusOfError(error: unknown): { status: McpServerStatus; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof McpNeedsSignInError) return { status: "needs_sign_in", message };
  if (error instanceof McpNeedsInputError) return { status: "needs_input", message };
  if (error instanceof McpLocalUnavailableError) return { status: "unavailable", message };
  if (isUnauthorized(error)) return { status: "needs_sign_in", message };
  if (isPaymentRequired(error)) {
    return {
      status: "error",
      message:
        "This server's provider asks for a paid plan before it answers (402 Payment Required). Sign up with them, or pick another server.",
    };
  }
  return { status: "error", message };
}

async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} did not answer in ${Math.round(ms / 1000)}s`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The SDK client over stdio, streamable HTTP or SSE, loaded lazily so a Server without MCP steps never imports it. */
export function createSdkMcpClients(options: SdkMcpClientsOptions): McpClients {
  const clients = new Map<string, { key: string; client: Promise<SdkClient> }>();
  const statuses = new Map<string, { status: McpServerStatus; message: string | null }>();
  const stdio = options.stdio ?? true;
  const timeout = async () => (await options.timeoutMs?.()) ?? 20_000;

  const connect = async (setting: McpServerSetting): Promise<SdkClient> => {
    const secret = options.secrets
      ? await options.secrets.load(setting.name).catch((error: unknown) => {
          // A locked Server cannot open the row; a server with nothing sealed never needed it.
          if ((setting.secrets?.length ?? 0) > 0 || setting.auth === "oauth") throw error;
          return null;
        })
      : null;
    const values = valuesOf(setting, secret);
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const client = new Client({ name: "monday", version: "0.1.0" });
    const ms = await timeout();
    if (setting.command) {
      if (!stdio) throw new McpLocalUnavailableError(setting.name);
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
      const parts = setting.args
        ? [setting.command, ...setting.args]
        : setting.command.split(/\s+/);
      const env = setting.env ?? {};
      const missing = missingIn([...parts, ...Object.values(env)], values);
      if (missing.length > 0) throw new McpNeedsInputError(setting.name, missing);
      const [command, ...args] = parts.map((p) => fillTemplate(p, values));
      if (!command) throw new Error(`MCP server ${setting.name}: empty command`);
      const filledEnv = Object.fromEntries(
        Object.entries(env).map(([k, v]) => [k, fillTemplate(v, values)]),
      );
      await withTimeout(
        client.connect(
          new StdioClientTransport({
            command,
            args,
            ...(Object.keys(filledEnv).length > 0 ? { env: filledEnv } : {}),
            stderr: "ignore",
          }),
        ),
        ms,
        setting.name,
      );
    } else if (setting.url) {
      const headersT = { ...(setting.headers ?? {}) };
      // An older entry, or one saved with "bearer", sends its token as the Authorization header.
      const hasAuthHeader = Object.keys(headersT).some((h) => h.toLowerCase() === "authorization");
      if (!hasAuthHeader && setting.auth !== "oauth" && values.token) {
        headersT.Authorization = "Bearer {token}";
      }
      const missing = missingIn([setting.url, ...Object.values(headersT)], values);
      if (missing.length > 0) throw new McpNeedsInputError(setting.name, missing);
      const url = new URL(fillTemplate(setting.url, values));
      const headers = Object.fromEntries(
        Object.entries(headersT).map(([k, v]) => [k, fillTemplate(v, values)]),
      );
      const authProvider = setting.auth === "oauth" ? options.oauthProvider?.(setting) : undefined;
      if (setting.auth === "oauth" && !secret?.oauth?.tokens) {
        throw new McpNeedsSignInError(setting.name);
      }
      const transportOptions = {
        ...(Object.keys(headers).length > 0 ? { requestInit: { headers } } : {}),
        ...(authProvider ? { authProvider } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      };
      const transport =
        setting.transport === "sse"
          ? new (await import("@modelcontextprotocol/sdk/client/sse.js")).SSEClientTransport(
              url,
              transportOptions,
            )
          : new (
              await import("@modelcontextprotocol/sdk/client/streamableHttp.js")
            ).StreamableHTTPClientTransport(url, transportOptions);
      // The SDK's transport type is looser than exactOptionalPropertyTypes likes.
      await withTimeout(
        client.connect(transport as unknown as Parameters<typeof client.connect>[0]),
        ms,
        setting.name,
      );
    } else {
      throw new Error(`MCP server ${setting.name}: a command or a URL is needed`);
    }
    return client as unknown as SdkClient;
  };

  const record = <T>(name: string, work: Promise<T>): Promise<T> =>
    work.then(
      (value) => {
        statuses.set(name, { status: "connected", message: null });
        return value;
      },
      (error: unknown) => {
        statuses.set(name, statusOfError(error));
        throw error;
      },
    );

  const clientFor = async (
    name: string,
  ): Promise<{ client: SdkClient; setting: McpServerSetting }> => {
    const setting = (await options.servers()).find((s) => s.name === name);
    if (!setting) throw new McpServerUnknownError(name);
    const key = JSON.stringify(setting);
    let entry = clients.get(name);
    if (entry && entry.key !== key) {
      void entry.client.then((c) => c.close()).catch(() => {});
      entry = undefined;
    }
    if (!entry) {
      const pending = connect(setting).catch((error) => {
        clients.delete(name);
        throw error;
      });
      entry = { key, client: pending };
      clients.set(name, entry);
    }
    return { client: await entry.client, setting };
  };

  return {
    call(server, tool, args) {
      return record(
        server,
        (async () => {
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
        })(),
      );
    },
    listTools(server) {
      return record(
        server,
        (async () => {
          const { client, setting } = await clientFor(server);
          const { tools } = await withTimeout(client.listTools(), await timeout(), server);
          return tools
            .filter((t) => setting.tools.length === 0 || setting.tools.includes(t.name))
            .map((t) => ({ name: t.name, description: t.description ?? "" }));
        })(),
      );
    },
    probe(setting) {
      return record(
        setting.name,
        (async () => {
          const client = await connect(setting);
          try {
            const { tools } = await withTimeout(client.listTools(), await timeout(), setting.name);
            return tools.map((t) => ({ name: t.name, description: t.description ?? "" }));
          } finally {
            await client.close().catch(() => {});
          }
        })(),
      );
    },
    forget(server) {
      const entry = clients.get(server);
      clients.delete(server);
      statuses.delete(server);
      if (entry) void entry.client.then((c) => c.close()).catch(() => {});
    },
    status(server) {
      return statuses.get(server) ?? null;
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
    async probe(setting) {
      const tools = servers[setting.name];
      if (!tools) throw new McpServerUnknownError(setting.name);
      return Object.keys(tools).map((name) => ({ name, description: "" }));
    },
    forget() {},
    status(server) {
      return servers[server] ? { status: "connected", message: null } : null;
    },
  };
}
