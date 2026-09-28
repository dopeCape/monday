// The MCP pieces one Server runs, wired over its database: the sealed store,
// the clients Workflow Steps and the Agent call through, the registry search
// and the Connect surface's service (docs/spec/settings.md "MCP servers").
// A stdio server runs on the machine running this Server, so only a Sidecar
// or a container starts one; Vercel and Netlify say it is unavailable there.

import type { DeploymentMode, McpServerSetting } from "@monday/shared";
import type { Db } from "../db/client.ts";
import { settings } from "../db/schema.ts";
import type { ContentStore } from "../mailstore/content.ts";
import { readGlobalSettings } from "../settings/read.ts";
import { createSdkMcpClients, type McpClients, type TransportFetch } from "./mcp.ts";
import { createMcpCatalog, type McpCatalog } from "./mcp-catalog.ts";
import { createMcpConnections, type McpConnections, type McpLoopback } from "./mcp-connections.ts";
import { createStoredOAuthProvider, type FetchLike } from "./mcp-oauth.ts";
import { createMcpRegistry, type McpRegistry } from "./mcp-registry.ts";
import { createMcpSecretStore, type McpSecretStore } from "./mcp-secrets.ts";

export const MCP_SERVERS_SETTING = "workflows.mcp_servers";

export interface McpModule {
  secrets: McpSecretStore;
  clients: McpClients;
  registry: McpRegistry;
  /** The registry copy behind `registry`; the Sidecar warms it at boot. */
  catalog: McpCatalog;
  connections: McpConnections;
}

export interface McpModuleOptions {
  db: Db;
  content: ContentStore;
  mode: DeploymentMode;
  loopback?: McpLoopback | null | undefined;
  /** The clients to call through; the SDK's by default. */
  clients?: McpClients | undefined;
  /** For the registry, OAuth and URL servers; tests pass one. */
  fetch?: FetchLike | undefined;
  now?: () => Date;
}

/** Whether a Server of this kind can start a local (stdio) server. */
export function canRunLocal(mode: DeploymentMode): boolean {
  return mode === "sidecar" || mode === "container";
}

export function createMcpModule(options: McpModuleOptions): McpModule {
  const { db } = options;
  const now = options.now ?? (() => new Date());
  const secrets = createMcpSecretStore(db, options.content, { now });
  const servers = async (): Promise<McpServerSetting[]> =>
    (await readGlobalSettings(db, [MCP_SERVERS_SETTING]))[MCP_SERVERS_SETTING];
  const writeServers = async (value: McpServerSetting[]): Promise<void> => {
    await db
      .insert(settings)
      .values({
        scope: "global",
        deviceId: null,
        key: MCP_SERVERS_SETTING,
        value,
        updatedAt: now(),
      })
      .onConflictDoUpdate({
        target: [settings.scope, settings.deviceId, settings.key],
        set: { value, updatedAt: now() },
      });
  };
  const stdio = canRunLocal(options.mode);
  const clients =
    options.clients ??
    createSdkMcpClients({
      servers,
      secrets,
      stdio,
      oauthProvider: (setting) =>
        // A background provider never registers, so the name it would register under is unused.
        createStoredOAuthProvider({ store: secrets, name: setting.name, clientName: "monday" }),
      timeoutMs: async () =>
        (await readGlobalSettings(db, ["workflows.mcp_connect.timeout_seconds"]))[
          "workflows.mcp_connect.timeout_seconds"
        ] * 1000,
      ...(options.fetch ? { fetch: options.fetch as TransportFetch } : {}),
    });
  const liveRegistry = createMcpRegistry({
    settings: async () => {
      const s = await readGlobalSettings(db, [
        "workflows.mcp_registry.enabled",
        "workflows.mcp_registry.url",
        "workflows.mcp_registry.results",
        "workflows.mcp_registry.cache_minutes",
      ]);
      return {
        enabled: s["workflows.mcp_registry.enabled"],
        url: s["workflows.mcp_registry.url"],
        results: s["workflows.mcp_registry.results"],
        cacheMinutes: s["workflows.mcp_registry.cache_minutes"],
      };
    },
    ...(options.fetch ? { fetch: (url, init) => (options.fetch as FetchLike)(url, init) } : {}),
  });
  // Search answers from the Server's copy of the registry; the live one is its fallback.
  const catalog = createMcpCatalog({
    db,
    live: liveRegistry,
    settings: async () => {
      const s = await readGlobalSettings(db, [
        "workflows.mcp_registry.enabled",
        "workflows.mcp_registry.url",
        "workflows.mcp_registry.results",
        "workflows.mcp_registry.refresh_hours",
        "workflows.mcp_registry.demote",
        "workflows.mcp_registry.live_wait_seconds",
      ]);
      return {
        enabled: s["workflows.mcp_registry.enabled"],
        url: s["workflows.mcp_registry.url"],
        results: s["workflows.mcp_registry.results"],
        refreshHours: s["workflows.mcp_registry.refresh_hours"],
        demote: s["workflows.mcp_registry.demote"],
        liveWaitMs: s["workflows.mcp_registry.live_wait_seconds"] * 1000,
      };
    },
    ...(options.fetch ? { fetch: (url, init) => (options.fetch as FetchLike)(url, init) } : {}),
    now: () => now().getTime(),
  });
  const registry: McpRegistry = catalog;
  const connections = createMcpConnections({
    servers,
    writeServers,
    secrets,
    clients,
    stdio,
    loopback: options.loopback ?? null,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    now,
    settings: async () => {
      const s = await readGlobalSettings(db, [
        "workflows.mcp_connect.client_name",
        "workflows.mcp_connect.sign_in_minutes",
      ]);
      return {
        clientName: s["workflows.mcp_connect.client_name"],
        signInMinutes: s["workflows.mcp_connect.sign_in_minutes"],
      };
    },
  });
  return { secrets, clients, registry, catalog, connections };
}
