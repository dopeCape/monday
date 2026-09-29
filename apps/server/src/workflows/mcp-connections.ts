// Connect a tool (docs/spec/settings.md "MCP servers"): the Server side of
// the Connect surface and of the Agent's MCP tools. It owns the
// workflows.mcp_servers Setting the way the integration store owns
// workflows.integrations: it writes the entry (names, templates, the tools
// allowlist) and seals every value that opens the server, so the Setting
// never holds a secret. It lists servers with a status, probes their tools,
// runs the OAuth sign-in (mcp-oauth.ts) with a Cancel, and moves an older
// entry's bearer token into the sealed store.

import type {
  McpAuth,
  McpServerSetting,
  McpServerStatus,
  McpServerView,
  McpSignInStatus,
  McpToolView,
} from "@monday/shared";
import { mcpServerSchema } from "@monday/shared";
import {
  type McpClients,
  McpLocalUnavailableError,
  McpServerUnknownError,
  type McpToolInfo,
  statusOfError,
} from "./mcp.ts";
import { createStoredOAuthProvider, type FetchLike } from "./mcp-oauth.ts";
import { placeholdersOf } from "./mcp-registry.ts";
import type { McpSecret, McpSecretStore } from "./mcp-secrets.ts";

/** What POST /mcp-servers takes: a server by URL or command, with the inputs the user filled. */
export interface McpConnectInput {
  name: string;
  title?: string | undefined;
  registry?: string | undefined;
  url?: string | undefined;
  transport?: "streamable-http" | "sse" | undefined;
  /** Header name to value template. */
  headers?: Record<string, string> | undefined;
  command?: string | undefined;
  args?: string[] | undefined;
  /** Environment variable name to value template. */
  env?: Record<string, string> | undefined;
  /** Values for the `{name}` holes. */
  values?: Record<string, string> | undefined;
  /** Which of `values` are secrets, sealed rather than written into the Setting. */
  secret?: string[] | undefined;
  /** A bearer token for a URL server, sealed. */
  token?: string | undefined;
  /** "auto" (the default) finds out: a server that answers 401 with OAuth metadata signs in with OAuth. */
  auth?: McpAuth | "auto" | undefined;
  tools?: string[] | undefined;
  /** Replace an existing server of the same name (Reconnect with new inputs). */
  replace?: boolean | undefined;
}

export interface McpConnectResult {
  server: McpServerView;
  /** What the user does next: nothing, sign in in the browser, or fill what is missing. */
  next: "ready" | "sign_in" | "input";
  tools: McpToolView[];
}

export class McpConnectError extends Error {
  constructor(
    readonly code: "exists" | "invalid" | "missing_input" | "local_unavailable" | "pinned",
    message: string,
  ) {
    super(message);
    this.name = "McpConnectError";
  }
}

/** The Sidecar's loopback receiver, the same one the mail sign-in uses. */
export interface McpLoopback {
  open(): Promise<{
    redirectUri: string;
    callback: Promise<Record<string, string>>;
    close(): void;
  }>;
}

export interface McpConnectionsSettings {
  clientName: string;
  signInMinutes: number;
}

export interface McpConnectionsOptions {
  servers: () => Promise<McpServerSetting[]>;
  writeServers: (servers: McpServerSetting[]) => Promise<void>;
  secrets: McpSecretStore;
  clients: McpClients;
  settings: () => Promise<McpConnectionsSettings>;
  /** Whether this Server can start a local (stdio) server. */
  stdio: boolean;
  loopback?: McpLoopback | null | undefined;
  /** For OAuth discovery, registration and the token exchange; tests pass one. */
  fetch?: FetchLike | undefined;
  now?: () => Date;
  random?: () => string;
}

export interface McpConnections {
  list(): Promise<McpServerView[]>;
  add(workspaceId: string, input: McpConnectInput): Promise<McpConnectResult>;
  /** Every tool the server offers with whether it is allowed, and the status that probe found. */
  tools(name: string): Promise<{ server: McpServerView; tools: McpToolView[] }>;
  /** The tools Workflows and the Agent may use; empty means every one. */
  setTools(name: string, tools: string[]): Promise<McpServerView>;
  remove(name: string): Promise<void>;
  /**
   * Starts the browser sign-in. `callbackBase` is where a Server without a
   * loopback listener (a Cloud server) takes the redirect.
   */
  signIn(
    workspaceId: string,
    name: string,
    callbackBase: string | null,
  ): Promise<{ state: string; url: string }>;
  signInStatus(state: string): Promise<McpSignInStatus>;
  cancelSignIn(state: string): Promise<McpSignInStatus>;
  /** The redirect's query, from the loopback or the Cloud callback route. */
  finishSignIn(query: Record<string, string>): Promise<McpSignInStatus>;
  /** Moves bearer tokens an older version kept in the Setting into the sealed store. Returns how many. */
  adopt(workspaceId: string): Promise<number>;
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,59}$/;

export function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|-+$/g, "")
    .slice(0, 60);
}

function authOf(setting: McpServerSetting): McpAuth {
  if (setting.auth) return setting.auth;
  return setting.token ? "bearer" : "none";
}

function targetOf(setting: McpServerSetting): string {
  if (setting.url) return setting.url;
  return setting.args
    ? [setting.command ?? "", ...setting.args].join(" ")
    : (setting.command ?? "");
}

function viewOf(
  setting: McpServerSetting,
  status: { status: McpServerStatus; message: string | null },
): McpServerView {
  return {
    name: setting.name,
    title: setting.title ?? setting.name,
    registry: setting.registry ?? null,
    kind: setting.command ? "local" : "remote",
    target: targetOf(setting),
    auth: authOf(setting),
    secrets: [...(setting.secrets ?? []), ...(setting.token ? ["token"] : [])],
    tools: setting.tools,
    status: status.status,
    message: status.message,
  };
}

function toolViews(tools: McpToolInfo[], allowed: string[]): McpToolView[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    enabled: allowed.length === 0 || allowed.includes(t.name),
  }));
}

/** Fills the holes whose values are not secret, so the Setting keeps only the secret ones open. */
function inline(template: string, plain: Record<string, string>): string {
  return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (whole, name: string) => plain[name] ?? whole);
}

export function createMcpConnections(options: McpConnectionsOptions): McpConnections {
  const now = options.now ?? (() => new Date());
  const random = options.random ?? (() => crypto.randomUUID().replaceAll("-", ""));
  const listeners = new Map<string, { close(): void }>();
  const fetchFn = options.fetch;

  const find = async (name: string): Promise<McpServerSetting> => {
    const found = (await options.servers()).find((s) => s.name === name);
    if (!found) throw new McpServerUnknownError(name);
    return found;
  };

  /** The status without a network call: what the setting and the sealed row already say. */
  const quickStatus = async (
    setting: McpServerSetting,
  ): Promise<{ status: McpServerStatus; message: string | null }> => {
    if (setting.command && !options.stdio) {
      return { status: "unavailable", message: new McpLocalUnavailableError(setting.name).message };
    }
    const seen = options.clients.status(setting.name);
    if (authOf(setting) === "oauth") {
      const secret = await options.secrets.load(setting.name).catch(() => null);
      if (!secret?.oauth?.tokens) return { status: "needs_sign_in", message: null };
    }
    return seen ?? { status: "unknown", message: null };
  };

  const probe = async (
    setting: McpServerSetting,
  ): Promise<{
    status: { status: McpServerStatus; message: string | null };
    tools: McpToolInfo[];
  }> => {
    try {
      const tools = await options.clients.probe(setting);
      return { status: { status: "connected", message: null }, tools };
    } catch (error) {
      return { status: statusOfError(error), tools: [] };
    }
  };

  const replaceEntry = async (setting: McpServerSetting | null, name: string) => {
    const current = await options.servers();
    const rest = current.filter((s) => s.name !== name);
    await options.writeServers(setting ? [...rest, setting] : rest);
    options.clients.forget(name);
  };

  /** Finds the server whose pending sign-in carries `state`, or whose last outcome does. */
  const byState = async (state: string): Promise<{ name: string; secret: McpSecret } | null> => {
    for (const name of await options.secrets.list()) {
      const secret = await options.secrets.load(name).catch(() => null);
      if (!secret?.oauth) continue;
      if (secret.oauth.pending?.state === state || secret.oauth.outcome?.state === state) {
        return { name, secret };
      }
    }
    return null;
  };

  const settle = async (
    name: string,
    state: string,
    outcome: { status: "done" | "error" | "cancelled"; message?: string },
  ) => {
    await options.secrets.update(name, (s) => ({
      ...s,
      oauth: {
        ...(s.oauth ?? {}),
        pending: undefined,
        outcome: { state, ...outcome },
        ...(outcome.status === "error" ? { error: outcome.message } : {}),
      },
    }));
    listeners.get(state)?.close();
    listeners.delete(state);
  };

  const statusFor = async (state: string): Promise<McpSignInStatus> => {
    const found = await byState(state);
    if (!found) return { status: "error", message: "no sign-in with that state" };
    const o = found.secret.oauth;
    if (o?.pending?.state === state) {
      if (Date.parse(o.pending.expiresAt) < now().getTime()) {
        await settle(found.name, state, { status: "error", message: "the sign-in timed out" });
        return { status: "error", message: "the sign-in timed out" };
      }
      return { status: "pending" };
    }
    const outcome = o?.outcome;
    if (outcome?.status === "done") {
      const setting = await find(found.name);
      return { status: "done", server: viewOf(setting, await quickStatus(setting)) };
    }
    if (outcome?.status === "cancelled") return { status: "cancelled" };
    return { status: "error", message: outcome?.message ?? "the sign-in failed" };
  };

  const connections: McpConnections = {
    async list() {
      const servers = await options.servers();
      return Promise.all(servers.map(async (s) => viewOf(s, await quickStatus(s))));
    },

    async add(workspaceId, input) {
      const name = normalizeName(input.name);
      if (!NAME.test(name)) throw new McpConnectError("invalid", "a name is needed");
      const existing = (await options.servers()).find((s) => s.name === name);
      if (existing && !input.replace) {
        throw new McpConnectError("exists", `a server named ${name} is already connected`);
      }
      const url = input.url?.trim();
      const command = input.command?.trim();
      if (!url === !command) throw new McpConnectError("invalid", "give a URL or a command");
      if (command && !options.stdio) {
        throw new McpConnectError("local_unavailable", new McpLocalUnavailableError(name).message);
      }
      const values = Object.fromEntries(
        Object.entries(input.values ?? {})
          .map(([k, v]) => [k, v.trim()] as const)
          .filter(([, v]) => v.length > 0),
      );
      const secretNames = new Set(input.secret ?? []);
      const token = input.token?.trim();
      const sealed: Record<string, string> = {};
      const plain: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) (secretNames.has(k) ? sealed : plain)[k] = v;
      const headers = Object.fromEntries(
        Object.entries(input.headers ?? {}).map(([k, v]) => [k, inline(v, plain)]),
      );
      if (token) {
        sealed.token = token;
        if (!Object.keys(headers).some((h) => h.toLowerCase() === "authorization")) {
          headers.Authorization = "Bearer {token}";
        }
      }
      const env = Object.fromEntries(
        Object.entries(input.env ?? {}).map(([k, v]) => [k, inline(v, plain)]),
      );
      const args = input.args?.map((a) => inline(a, plain));
      const filledUrl = url ? inline(url, plain) : undefined;
      // Every hole left must be a sealed value; anything else was never asked for.
      const holes = [
        ...(filledUrl ? [filledUrl] : []),
        ...Object.values(headers),
        ...(args ?? (command ? command.split(/\s+/) : [])),
        ...Object.values(env),
      ].flatMap(placeholdersOf);
      const missing = [...new Set(holes.filter((h) => !(h in sealed)))];
      if (missing.length > 0) {
        throw new McpConnectError("missing_input", `still needed: ${missing.join(", ")}`);
      }
      let auth: McpAuth =
        input.auth && input.auth !== "auto"
          ? input.auth
          : token
            ? "bearer"
            : Object.keys(sealed).length > 0
              ? "inputs"
              : "none";
      const draft = {
        name,
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
        ...(input.registry ? { registry: input.registry } : {}),
        ...(filledUrl ? { url: filledUrl } : {}),
        ...(filledUrl && input.transport === "sse" ? { transport: "sse" as const } : {}),
        ...(command ? { command } : {}),
        ...(command && args ? { args } : {}),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(Object.keys(sealed).length > 0 ? { secrets: Object.keys(sealed).sort() } : {}),
        tools: input.tools ?? [],
      };
      const parsed = mcpServerSchema.safeParse({ ...draft, auth });
      if (!parsed.success)
        throw new McpConnectError("invalid", parsed.error.issues[0]?.message ?? "invalid");
      let setting = parsed.data;

      // Seal first, so the entry never names a value the store does not hold.
      const previous = existing ? await options.secrets.load(name).catch(() => null) : null;
      await options.secrets.put(workspaceId, name, {
        values: sealed,
        // Reconnecting keeps a registered OAuth client; a new server starts clean.
        ...(previous?.oauth?.client && url === existing?.url
          ? { oauth: { client: previous.oauth.client, discovery: previous.oauth.discovery } }
          : {}),
      });

      // A URL server with nothing given: try it as is, and sign in with OAuth when it refuses.
      let found = {
        status: { status: "unknown" as McpServerStatus, message: null as string | null },
        tools: [] as McpToolInfo[],
      };
      if (auth !== "oauth") {
        found = await probe(setting);
        if (
          url &&
          (input.auth === undefined || input.auth === "auto") &&
          found.status.status === "needs_sign_in" &&
          (await offersOAuth(new URL(setting.url as string), fetchFn))
        ) {
          auth = "oauth";
        }
      }
      if (auth === "oauth") {
        setting = { ...setting, auth: "oauth" };
        found = { status: { status: "needs_sign_in", message: null }, tools: [] };
      } else if (found.status.status === "needs_sign_in" && url) {
        // Refused, and no OAuth on offer: it wants a token or a key.
        found = { status: { status: "needs_input", message: found.status.message }, tools: [] };
      }
      await replaceEntry(setting, name);
      const view = viewOf(setting, found.status);
      return {
        server: view,
        next:
          view.status === "needs_sign_in"
            ? "sign_in"
            : view.status === "needs_input"
              ? "input"
              : "ready",
        tools: toolViews(found.tools, setting.tools),
      };
    },

    async tools(name) {
      let setting = await find(name);
      let found = await probe(setting);
      // Saved without a sign-in but now refused, and OAuth is on offer: it signs in from here.
      if (
        setting.url &&
        (setting.auth === "none" || setting.auth === undefined) &&
        found.status.status === "needs_sign_in" &&
        (await offersOAuth(new URL(setting.url), fetchFn))
      ) {
        setting = { ...setting, auth: "oauth" };
        await replaceEntry(setting, name);
        found = { status: { status: "needs_sign_in", message: null }, tools: [] };
      }
      return {
        server: viewOf(setting, found.status),
        tools: toolViews(found.tools, setting.tools),
      };
    },

    async setTools(name, tools) {
      const setting = await find(name);
      const next = { ...setting, tools: [...new Set(tools)] };
      await replaceEntry(next, name);
      return viewOf(next, await quickStatus(next));
    },

    async remove(name) {
      await find(name);
      await options.secrets.remove(name);
      await replaceEntry(null, name);
    },

    async signIn(workspaceId, name, callbackBase) {
      const setting = await find(name);
      if (!setting.url) throw new McpConnectError("invalid", `${name} is not a remote server`);
      const s = await options.settings();
      const listener = options.loopback ? await options.loopback.open() : null;
      const redirectUri =
        listener?.redirectUri ??
        (callbackBase ? `${callbackBase.replace(/\/+$/, "")}/mcp-servers/oauth/callback` : null);
      if (!redirectUri) {
        throw new McpConnectError("invalid", "this Server has no way to take the browser back");
      }
      const state = random();
      // A sign-in starts clean: new tokens, and any earlier sign-in forgotten.
      await options.secrets.update(
        name,
        (secret) => ({
          ...secret,
          oauth: {
            ...(secret.oauth ?? {}),
            tokens: undefined,
            error: undefined,
            outcome: undefined,
            pending: {
              state,
              redirectUri,
              codeVerifier: null,
              issuer: null,
              startedAt: now().toISOString(),
              expiresAt: new Date(now().getTime() + s.signInMinutes * 60_000).toISOString(),
            },
          },
        }),
        workspaceId,
      );
      let authorizationUrl: URL | null = null;
      const provider = createStoredOAuthProvider({
        store: options.secrets,
        name,
        clientName: s.clientName,
        redirectUri,
        state,
        workspaceId,
        onRedirect: (u) => {
          authorizationUrl = u;
        },
      });
      try {
        const { auth } = await import("@modelcontextprotocol/sdk/client/auth.js");
        const result = await auth(provider, {
          serverUrl: setting.url,
          ...(fetchFn ? { fetchFn } : {}),
        });
        if (result === "AUTHORIZED" || !authorizationUrl) {
          throw new Error("the server did not ask for a sign-in");
        }
      } catch (error) {
        listener?.close();
        const message = error instanceof Error ? error.message : String(error);
        await settle(name, state, { status: "error", message });
        throw new McpConnectError("invalid", message);
      }
      const current = await provider.current();
      const issuer =
        (current.discovery?.authorizationServerMetadata as { issuer?: string } | undefined)
          ?.issuer ?? null;
      await options.secrets.update(name, (secret) => ({
        ...secret,
        oauth: {
          ...(secret.oauth ?? {}),
          pending: secret.oauth?.pending ? { ...secret.oauth.pending, issuer } : undefined,
        },
      }));
      if (listener) {
        listeners.set(state, listener);
        void listener.callback
          .then((query) => connections.finishSignIn({ state, ...query }))
          .catch(async (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            const found = await byState(state);
            if (found?.secret.oauth?.pending?.state === state) {
              await settle(found.name, state, { status: "error", message });
            }
          })
          .finally(() => {
            listeners.delete(state);
            listener.close();
          });
      }
      return { state, url: String(authorizationUrl) };
    },

    signInStatus: statusFor,

    async cancelSignIn(state) {
      const found = await byState(state);
      if (!found) return { status: "error", message: "no sign-in with that state" };
      // Too late to cancel: it already finished one way or the other.
      if (found.secret.oauth?.pending?.state !== state) return statusFor(state);
      await settle(found.name, state, { status: "cancelled" });
      return { status: "cancelled" };
    },

    async finishSignIn(query) {
      const state = query.state ?? "";
      const found = state ? await byState(state) : null;
      // An unknown or cancelled state adds nothing, whatever the browser carries.
      if (!found || found.secret.oauth?.pending?.state !== state) {
        return { status: "error", message: "no sign-in is waiting for this redirect" };
      }
      const pending = found.secret.oauth.pending;
      if (Date.parse(pending.expiresAt) < now().getTime()) {
        await settle(found.name, state, { status: "error", message: "the sign-in timed out" });
        return statusFor(state);
      }
      if (query.error) {
        await settle(found.name, state, {
          status: "error",
          message: query.error_description ?? query.error,
        });
        return statusFor(state);
      }
      // RFC 9207: a redirect from another authorization server is refused.
      if (query.iss && pending.issuer && query.iss !== pending.issuer) {
        await settle(found.name, state, {
          status: "error",
          message: "the sign-in came back from another server",
        });
        return statusFor(state);
      }
      if (!query.code) {
        await settle(found.name, state, {
          status: "error",
          message: "the redirect carried no code",
        });
        return statusFor(state);
      }
      try {
        const setting = await find(found.name);
        const s = await options.settings();
        const provider = createStoredOAuthProvider({
          store: options.secrets,
          name: found.name,
          clientName: s.clientName,
          redirectUri: pending.redirectUri,
          state,
        });
        const { auth } = await import("@modelcontextprotocol/sdk/client/auth.js");
        const result = await auth(provider, {
          serverUrl: setting.url as string,
          authorizationCode: query.code,
          ...(fetchFn ? { fetchFn } : {}),
        });
        if (result !== "AUTHORIZED") throw new Error("the server did not accept the sign-in");
        options.clients.forget(found.name);
        await settle(found.name, state, { status: "done" });
      } catch (error) {
        await settle(found.name, state, {
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return statusFor(state);
    },

    async adopt(workspaceId) {
      const servers = await options.servers();
      const legacy = servers.filter((s) => s.token);
      if (legacy.length === 0) return 0;
      for (const s of legacy) {
        await options.secrets.update(
          s.name,
          (secret) => ({
            ...secret,
            values: { ...(secret.values ?? {}), token: s.token as string },
          }),
          workspaceId,
        );
      }
      await options.writeServers(
        servers.map((s) => {
          if (!s.token) return s;
          const { token: _token, ...rest } = s;
          const headers = { ...(rest.headers ?? {}) };
          if (!Object.keys(headers).some((h) => h.toLowerCase() === "authorization")) {
            headers.Authorization = "Bearer {token}";
          }
          return {
            ...rest,
            auth: rest.auth ?? "bearer",
            headers,
            secrets: [...new Set([...(rest.secrets ?? []), "token"])].sort(),
          };
        }),
      );
      for (const s of legacy) options.clients.forget(s.name);
      return legacy.length;
    },
  };
  return connections;
}

/** Whether a server that refused us publishes OAuth metadata (RFC 9728), the sign that OAuth is how it wants to be met. */
export async function offersOAuth(serverUrl: URL, fetchFn?: FetchLike): Promise<boolean> {
  const sdk = await import("@modelcontextprotocol/sdk/client/auth.js");
  try {
    const found = await sdk.discoverOAuthProtectedResourceMetadata(serverUrl, {}, fetchFn);
    if (Array.isArray(found.authorization_servers) && found.authorization_servers.length > 0) {
      return true;
    }
  } catch {
    // No protected-resource metadata: an earlier-spec server (Atlassian's, for
    // one) publishes only its authorization server's metadata at its root.
  }
  try {
    const meta = await sdk.discoverAuthorizationServerMetadata(new URL("/", serverUrl), {
      ...(fetchFn ? { fetchFn } : {}),
    });
    return typeof meta?.authorization_endpoint === "string";
  } catch {
    return false;
  }
}
