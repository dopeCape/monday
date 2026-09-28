// What opens a connected MCP server, sealed (docs/spec/settings.md "MCP
// servers"): the values of its secret inputs (a token, an API key header, an
// environment variable), and its OAuth state (the registered client, the
// tokens, what discovery found, a sign-in waiting on the browser). One row per
// server in integration_secrets under the key "mcp:<name>", sealed under the
// envelope as an "integration" object exactly like a Workflow integration's
// secret, so the rekey and the Workspace deletion already cover it. The
// workflows.mcp_servers Setting names which values exist and never holds one.

import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Integration } from "@monday/shared";
import { eq, like } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { integrationSecrets } from "../db/schema.ts";
import type { ContentStore } from "../mailstore/content.ts";

/** What discovery found, kept so a refresh or a code exchange does not rediscover (the SDK's OAuthDiscoveryState). */
export interface McpDiscovery {
  authorizationServerUrl: string;
  resourceMetadataUrl?: string | undefined;
  authorizationServerMetadata?: unknown;
  resourceMetadata?: unknown;
}

/** A sign-in waiting on the browser: enough to finish it on any Server sharing this database. */
export interface McpPendingSignIn {
  state: string;
  redirectUri: string;
  codeVerifier: string | null;
  /** The authorization server's issuer when the browser left, for the RFC 9207 check. */
  issuer: string | null;
  startedAt: string;
  expiresAt: string;
}

export interface McpOAuthState {
  client?: OAuthClientInformationMixed | undefined;
  tokens?: OAuthTokens | undefined;
  /** When the tokens were saved, so the list can say how old they are. */
  tokensAt?: string | undefined;
  discovery?: McpDiscovery | undefined;
  pending?: McpPendingSignIn | undefined;
  /** Why the last sign-in or refresh failed; cleared by the next success. */
  error?: string | undefined;
  /** How the last sign-in ended, so any Server sharing the database can answer its status. */
  outcome?:
    | { state: string; status: "done" | "error" | "cancelled"; message?: string | undefined }
    | undefined;
}

export interface McpSecret {
  /** Values for the `{name}` holes in the server's URL, headers, arguments and environment. */
  values?: Record<string, string> | undefined;
  oauth?: McpOAuthState | undefined;
}

export interface McpSecretStore {
  /** The server's sealed values, or null. Throws LockedError. */
  load(name: string): Promise<McpSecret | null>;
  /** Seals and stores, replacing what was there. An empty secret removes the row. Throws LockedError. */
  put(workspaceId: string, name: string, secret: McpSecret): Promise<void>;
  /** Reads, changes and writes back under the same Workspace; creates the row under `workspaceId` when absent. */
  update(
    name: string,
    change: (current: McpSecret) => McpSecret,
    workspaceId?: string,
  ): Promise<McpSecret>;
  remove(name: string): Promise<void>;
  /** The servers with a sealed row. Works locked. */
  list(): Promise<string[]>;
}

const PREFIX = "mcp:";
const rowId = (name: string) => `${PREFIX}${name}` as Integration;

function isEmpty(secret: McpSecret): boolean {
  const values = Object.keys(secret.values ?? {}).length;
  const oauth = secret.oauth ? Object.values(secret.oauth).some((v) => v !== undefined) : false;
  return values === 0 && !oauth;
}

export function createMcpSecretStore(
  db: Db,
  content: ContentStore,
  options: { now?: () => Date } = {},
): McpSecretStore {
  const now = options.now ?? (() => new Date());

  const row = (name: string) =>
    db.query.integrationSecrets.findFirst({
      where: eq(integrationSecrets.integration, rowId(name)),
    });

  const store: McpSecretStore = {
    async load(name) {
      const found = await row(name);
      if (!found) return null;
      return JSON.parse(
        await content.readText({
          workspaceId: found.workspaceId,
          kind: "integration",
          key: found.key,
          chunks: [found.dataEnc],
          size: -1,
        }),
      ) as McpSecret;
    },

    async put(workspaceId, name, secret) {
      if (isEmpty(secret)) {
        await store.remove(name);
        return;
      }
      const ref = await content.storeContent(workspaceId, "integration", JSON.stringify(secret));
      const envelope = ref.chunks[0];
      if (!envelope || ref.chunks.length !== 1) throw new RangeError("mcp envelope missing");
      await db
        .insert(integrationSecrets)
        .values({
          integration: rowId(name),
          workspaceId,
          key: ref.key,
          dataEnc: envelope,
          updatedAt: now(),
        })
        .onConflictDoUpdate({
          target: integrationSecrets.integration,
          set: { workspaceId, key: ref.key, dataEnc: envelope, updatedAt: now() },
        });
    },

    async update(name, change, workspaceId) {
      const found = await row(name);
      const current = (await store.load(name)) ?? {};
      const next = change(current);
      const ws = found?.workspaceId ?? workspaceId;
      if (!ws) throw new RangeError(`no Workspace to seal the MCP server ${name} under`);
      await store.put(ws, name, next);
      return next;
    },

    async remove(name) {
      await db.delete(integrationSecrets).where(eq(integrationSecrets.integration, rowId(name)));
    },

    async list() {
      const rows = await db
        .select({ id: integrationSecrets.integration })
        .from(integrationSecrets)
        .where(like(integrationSecrets.integration, `${PREFIX}%`));
      return rows.map((r) => String(r.id).slice(PREFIX.length)).sort();
    },
  };
  return store;
}

/** An in-memory store for tests and hosts without a database. */
export function createMemoryMcpSecretStore(): McpSecretStore & { rows: Map<string, McpSecret> } {
  const rows = new Map<string, McpSecret>();
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const store = {
    rows,
    async load(name: string) {
      const found = rows.get(name);
      return found ? clone(found) : null;
    },
    async put(_workspaceId: string, name: string, secret: McpSecret) {
      if (isEmpty(secret)) rows.delete(name);
      else rows.set(name, clone(secret));
    },
    async update(name: string, change: (current: McpSecret) => McpSecret) {
      const next = change(clone(rows.get(name) ?? {}));
      await store.put("", name, next);
      return next;
    },
    async remove(name: string) {
      rows.delete(name);
    },
    async list() {
      return [...rows.keys()].sort();
    },
  };
  return store;
}
