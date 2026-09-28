// Connect a tool (docs/spec/settings.md "MCP servers"): the registry search
// through the Server, and connecting remote servers (OAuth, bearer) and local
// ones (declared inputs) with every secret sealed and the Setting free of
// them. The OAuth flow runs end to end on loopback against a fake
// authorization server and a fake MCP server: 401, Protected Resource
// Metadata, Dynamic Client Registration, PKCE, the code exchange, a tool call
// with the token, and a refresh when the token expires.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type {
  Account,
  McpCatalogEntry,
  McpServerView,
  McpSignInStatus,
  McpToolView,
} from "@monday/shared";
import type { Hono } from "hono";
import { createLoopbackListener } from "../entry/oauth-loopback.ts";
import { type AppEnv, createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/index.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys, type Keys } from "../src/crypto/keys.ts";
import { createMemoryActivityLog, createToolServer } from "../src/intelligence/agent/index.ts";
import type { McpConnectSeam } from "../src/intelligence/agent/tools/extensions.ts";
import { createFakeToolHost } from "../src/intelligence/agent/tools/fake-host.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import type { McpConnectInput } from "../src/workflows/mcp-connections.ts";
import { createMcpModule } from "../src/workflows/mcp-module.ts";
import { catalogEntryOf, createMcpRegistry } from "../src/workflows/mcp-registry.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

setDefaultTimeout(30_000);

const SIDECAR_TOKEN = "per-launch-token";
const REGISTRY = "https://registry.test/v0.1";

const account: Account = {
  id: "acct-mcp",
  provider: "imap",
  address: "me@example.test",
  displayName: "Me",
  capabilities: {
    push: false,
    labels: false,
    snooze: false,
    mute: false,
    calendar: false,
    meetingLink: null,
  },
};

/* ------------------------------ The fake registry ------------------------------ */

const LINEAR = {
  server: {
    name: "app.linear/linear",
    title: "Linear",
    description: "Issues and projects in Linear.",
    version: "1.0.0",
    websiteUrl: "https://linear.app",
    remotes: [{ type: "streamable-http", url: "https://mcp.linear.test/mcp" }],
  },
  _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
};
const WEATHER = {
  server: {
    name: "io.github.someone/weather",
    description: "Forecasts.",
    version: "0.3.1",
    packages: [
      {
        registryType: "npm",
        identifier: "@someone/weather-mcp",
        version: "0.3.1",
        transport: { type: "stdio" },
        packageArguments: [{ type: "positional", valueHint: "region", isRequired: true }],
        environmentVariables: [
          { name: "WEATHER_KEY", description: "API key", isRequired: true, isSecret: true },
          { name: "UNITS", description: "metric or imperial", default: "metric" },
        ],
      },
    ],
    remotes: [
      {
        type: "sse",
        url: "https://weather.test/{tenant}/sse",
        headers: [
          {
            name: "Authorization",
            value: "Bearer {api_key}",
            isSecret: true,
            variables: { api_key: { description: "Your key", isSecret: true } },
          },
        ],
      },
    ],
  },
};
const GONE = {
  server: {
    name: "io.github.x/gone",
    description: "",
    version: "1",
    remotes: [{ type: "sse", url: "https://gone.test" }],
  },
  _meta: { "io.modelcontextprotocol.registry/official": { status: "deleted" } },
};

function registryFetch(calls: string[]) {
  return async (url: string): Promise<Response> => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === "/v0.1/servers") {
      const q = (u.searchParams.get("search") ?? "").toLowerCase();
      const servers = [LINEAR, WEATHER, GONE].filter((s) => s.server.name.includes(q));
      return Response.json({ servers, metadata: { count: servers.length } });
    }
    if (u.pathname === `/v0.1/servers/${encodeURIComponent(LINEAR.server.name)}/versions/latest`) {
      return Response.json(LINEAR);
    }
    return new Response("not found", { status: 404 });
  };
}

describe("the registry, read into cards", () => {
  test("a remote and a local package become cards with only their declared inputs", () => {
    const linear = catalogEntryOf(LINEAR) as McpCatalogEntry;
    expect(linear).toMatchObject({
      id: "app.linear/linear",
      name: "linear",
      title: "Linear",
      publisher: "linear.app",
      remote: {
        url: "https://mcp.linear.test/mcp",
        transport: "streamable-http",
        headers: {},
        inputs: [],
      },
      local: null,
    });
    const weather = catalogEntryOf(WEATHER) as McpCatalogEntry;
    expect(weather.publisher).toBe("someone");
    expect(weather.title).toBe("weather");
    expect(weather.remote?.transport).toBe("sse");
    expect(weather.remote?.headers).toEqual({ Authorization: "Bearer {api_key}" });
    expect(weather.remote?.inputs.map((i) => [i.kind, i.name, i.secret])).toEqual([
      ["variable", "tenant", false],
      ["variable", "api_key", true],
    ]);
    expect(weather.local).toMatchObject({
      command: "npx",
      args: ["-y", "@someone/weather-mcp@0.3.1", "{region}"],
      env: { WEATHER_KEY: "{WEATHER_KEY}", UNITS: "{UNITS}" },
    });
    expect(weather.local?.inputs.map((i) => [i.name, i.required, i.secret, i.default])).toEqual([
      ["region", true, false, null],
      ["WEATHER_KEY", true, true, null],
      ["UNITS", false, false, "metric"],
    ]);
    expect(catalogEntryOf(GONE)).toBeNull();
  });

  test("search asks once per query inside the cache window, and says when it is off", async () => {
    const calls: string[] = [];
    let at = 0;
    let enabled = true;
    const registry = createMcpRegistry({
      settings: async () => ({ enabled, url: REGISTRY, results: 10, cacheMinutes: 5 }),
      fetch: registryFetch(calls),
      now: () => at,
    });
    expect((await registry.search("linear")).map((e) => e.id)).toEqual(["app.linear/linear"]);
    await registry.search("linear");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("search=linear");
    expect(calls[0]).toContain("version=latest");
    at = 6 * 60_000;
    await registry.search("linear");
    expect(calls).toHaveLength(2);
    enabled = false;
    await expect(registry.search("linear")).rejects.toThrow("switched off");
  });
});

/* ------------------------------ Fake OAuth and MCP servers ------------------------------ */

interface FakeAuth {
  base: string;
  registered: Array<Record<string, unknown>>;
  authorizeParams: URLSearchParams[];
  tokenRequests: URLSearchParams[];
  stop(): void;
}

function startFakeAuthServer(): FakeAuth {
  const registered: Array<Record<string, unknown>> = [];
  const authorizeParams: URLSearchParams[] = [];
  const tokenRequests: URLSearchParams[] = [];
  const codes = new Map<string, { challenge: string; resource: string | null }>();
  let n = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const base: string = `http://127.0.0.1:${server.port}`;
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.pathname === "/register" && req.method === "POST") {
        const body = (await req.json()) as Record<string, unknown>;
        registered.push(body);
        return Response.json(
          { ...body, client_id: `client-${registered.length}` },
          { status: 201 },
        );
      }
      if (url.pathname === "/authorize") {
        authorizeParams.push(url.searchParams);
        const code = `code-${++n}`;
        codes.set(code, {
          challenge: url.searchParams.get("code_challenge") ?? "",
          resource: url.searchParams.get("resource"),
        });
        const back = new URL(url.searchParams.get("redirect_uri") ?? "");
        back.searchParams.set("code", code);
        back.searchParams.set("state", url.searchParams.get("state") ?? "");
        back.searchParams.set("iss", base);
        return new Response(null, { status: 302, headers: { location: String(back) } });
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const form = new URLSearchParams(await req.text());
        tokenRequests.push(form);
        if (form.get("grant_type") === "authorization_code") {
          const issued = codes.get(form.get("code") ?? "");
          const verifier = form.get("code_verifier") ?? "";
          const challenge = createHash("sha256").update(verifier).digest("base64url");
          if (!issued || issued.challenge !== challenge) {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
          return Response.json({
            access_token: "at-1",
            refresh_token: "rt-1",
            token_type: "Bearer",
            expires_in: 3600,
          });
        }
        if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") === "rt-1") {
          return Response.json({
            access_token: "at-2",
            refresh_token: "rt-2",
            token_type: "Bearer",
            expires_in: 3600,
          });
        }
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    registered,
    authorizeParams,
    tokenRequests,
    stop: () => server.stop(true),
  };
}

interface FakeMcp {
  url: string;
  valid: Set<string>;
  seen: string[];
  calls: Array<{ tool: string; auth: string }>;
  stop(): void;
}

/** A streamable HTTP MCP server answering JSON, behind a bearer check that points at `authBase`. */
function startFakeMcpServer(options: { authBase?: string; bearer?: string } = {}): FakeMcp {
  const valid = new Set<string>(options.bearer ? [options.bearer] : []);
  const seen: string[] = [];
  const calls: FakeMcp["calls"] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const base: string = `http://127.0.0.1:${server.port}`;
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp" && options.authBase) {
        return Response.json({
          resource: `${base}/mcp`,
          authorization_servers: [options.authBase],
          scopes_supported: ["issues:read"],
        });
      }
      if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });
      const auth = req.headers.get("authorization") ?? "";
      seen.push(auth);
      if (!valid.has(auth.replace(/^Bearer /, ""))) {
        return new Response("unauthorized", {
          status: 401,
          headers: options.authBase
            ? {
                "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
              }
            : { "www-authenticate": "Bearer" },
        });
      }
      if (req.method === "GET") return new Response(null, { status: 405 });
      if (req.method === "DELETE") return new Response(null, { status: 200 });
      const msg = (await req.json()) as {
        id?: number;
        method: string;
        params?: Record<string, unknown>;
      };
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const reply = (result: unknown) =>
        Response.json(
          { jsonrpc: "2.0", id: msg.id, result },
          { headers: { "mcp-session-id": "s1" } },
        );
      if (msg.method === "initialize") {
        return reply({
          protocolVersion: msg.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fake", version: "1" },
        });
      }
      if (msg.method === "tools/list") {
        return reply({
          tools: [
            { name: "list_issues", description: "Lists issues", inputSchema: { type: "object" } },
            {
              name: "create_issue",
              description: "Creates an issue",
              inputSchema: { type: "object" },
            },
          ],
        });
      }
      if (msg.method === "tools/call") {
        const tool = String(msg.params?.name);
        calls.push({ tool, auth });
        return reply({ content: [{ type: "text", text: `${tool} ok` }] });
      }
      return Response.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    valid,
    seen,
    calls,
    stop: () => server.stop(true),
  };
}

/** The browser: follows the authorization URL to its redirect and lands on it. */
async function actAsBrowser(authorizationUrl: string): Promise<void> {
  const res = await fetch(authorizationUrl, { redirect: "manual" });
  const location = res.headers.get("location");
  if (!location) throw new Error(`no redirect from ${authorizationUrl}`);
  await (await fetch(location)).text();
}

/* ------------------------------ Through the Server ------------------------------ */

describe("Connect a tool through the Server", () => {
  let db: TestDatabase;
  let keys: Keys;
  let store: Mailstore;
  let app: Hono<AppEnv>;
  let workspaceId = "";
  const rootKey = randomKey();
  const registryCalls: string[] = [];
  const fakeAuth = startFakeAuthServer();
  const oauthMcp = startFakeMcpServer({ authBase: fakeAuth.base });
  const keyMcp = startFakeMcpServer({ bearer: "sk-live-giraffe" });

  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SIDECAR_TOKEN}`,
        ...(init.headers ?? {}),
      },
    });
  const send = (path: string, body: unknown, method = "POST") =>
    request(path, { method, body: JSON.stringify(body) });
  const settingsText = async () =>
    (await db.handle.sql<{ t: string }[]>`select settings::text as t from settings`)
      .map((r) => r.t)
      .join("\n");
  const serverSetting = async () =>
    ((
      await db.handle.sql<{ value: unknown }[]>`
        select value from settings where key = 'workflows.mcp_servers'
      `
    )[0]?.value ?? []) as Array<Record<string, unknown>>;

  beforeAll(async () => {
    db = await testDatabase();
    keys = createKeys(db.handle.db);
    await keys.unlock(rootKey);
    store = createMailstore(db.handle.db, keys);
    const auth = createAuth({ db: db.handle.db, sidecarToken: SIDECAR_TOKEN });
    const real = (url: string | URL, init?: RequestInit) => fetch(url, init);
    const fromRegistry = registryFetch(registryCalls);
    app = createApp({
      db: db.handle.db,
      auth,
      mode: "sidecar",
      keys,
      mailstore: store,
      remoteAddress: () => "127.0.0.1",
      mcp: {
        loopback: { open: () => createLoopbackListener({ timeoutMs: 30_000 }).open("mcp") },
        fetch: (url, init) =>
          String(url).startsWith(REGISTRY) ? fromRegistry(String(url)) : real(url, init),
      },
    });
    workspaceId = (await store.createWorkspace(account)).id;
    await send("/settings/workflows.mcp_registry.url", { value: REGISTRY }, "PUT");
  }, 60_000);

  afterAll(async () => {
    fakeAuth.stop();
    oauthMcp.stop();
    keyMcp.stop();
    await db.drop();
  });

  test("search goes through the Server to the registry and comes back as cards", async () => {
    const res = await request("/mcp-servers/catalog?q=linear");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; entries: McpCatalogEntry[] };
    expect(body.enabled).toBe(true);
    expect(body.entries.map((e) => e.title)).toEqual(["Linear"]);
    expect(registryCalls.at(-1)).toContain("limit=24");
    await send("/settings/workflows.mcp_registry.enabled", { value: false }, "PUT");
    const off = (await (await request("/mcp-servers/catalog?q=linear")).json()) as {
      enabled: boolean;
    };
    expect(off.enabled).toBe(false);
    await send("/settings/workflows.mcp_registry.enabled", { value: true }, "PUT");
  });

  test("OAuth end to end: 401, resource metadata, registration, PKCE, code, tool call, refresh", async () => {
    // Connecting by URL alone finds out the server wants an OAuth sign-in.
    const added = await send("/mcp-servers", {
      workspace: workspaceId,
      name: "Linear",
      registry: "app.linear/linear",
      url: oauthMcp.url,
    });
    expect(added.status).toBe(200);
    const connect = (await added.json()) as { server: McpServerView; next: string };
    expect(connect.next).toBe("sign_in");
    expect(connect.server).toMatchObject({
      name: "linear",
      auth: "oauth",
      status: "needs_sign_in",
    });

    // Sign in: the Server discovers, registers and hands back the authorization URL.
    const started = (await (
      await send("/mcp-servers/linear/sign-in", { workspace: workspaceId })
    ).json()) as { state: string; url: string };
    const authorize = new URL(started.url);
    expect(authorize.origin).toBe(fakeAuth.base);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("resource")).toBe(oauthMcp.url);
    expect(authorize.searchParams.get("state")).toBe(started.state);
    expect(authorize.searchParams.get("redirect_uri")).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    );
    expect(fakeAuth.registered).toHaveLength(1);
    expect(fakeAuth.registered[0]).toMatchObject({
      client_name: "monday",
      token_endpoint_auth_method: "none",
      application_type: "native",
      grant_types: ["authorization_code", "refresh_token"],
    });
    expect(
      (
        (await (
          await request(`/mcp-servers/sign-in/status?state=${started.state}&wait=0`)
        ).json()) as McpSignInStatus
      ).status,
    ).toBe("pending");

    // The browser comes back to the loopback listener; the code is exchanged.
    await actAsBrowser(started.url);
    const done = (await (
      await request(`/mcp-servers/sign-in/status?state=${started.state}`)
    ).json()) as McpSignInStatus;
    expect(done.status).toBe("done");
    const exchange = fakeAuth.tokenRequests.find(
      (t) => t.get("grant_type") === "authorization_code",
    );
    expect(exchange?.get("resource")).toBe(oauthMcp.url);
    expect(exchange?.get("code_verifier")?.length).toBeGreaterThan(40);

    // The tools list with the token, all allowed by default.
    oauthMcp.valid.add("at-1");
    const listed = (await (await request("/mcp-servers/linear/tools")).json()) as {
      server: McpServerView;
      tools: McpToolView[];
    };
    expect(listed.server.status).toBe("connected");
    expect(listed.tools.map((t) => [t.name, t.enabled])).toEqual([
      ["list_issues", true],
      ["create_issue", true],
    ]);

    // Nothing that opens the server is in the settings table.
    const text = await settingsText();
    expect(text).not.toContain("at-1");
    expect(text).not.toContain("rt-1");
    expect(text).not.toContain("client-1");
    expect(text).not.toContain("code_verifier");

    // A Workflow Step's or the Agent's call goes through the same clients and sends the token.
    const module = createMcpModule({ db: db.handle.db, content: store, mode: "sidecar" });
    const result = await module.clients.call("linear", "list_issues", {});
    expect(result).toEqual({ text: "list_issues ok", isError: false, data: null });
    expect(oauthMcp.calls.at(-1)).toEqual({ tool: "list_issues", auth: "Bearer at-1" });

    // The token expires: the server refuses it, the SDK refreshes and retries.
    oauthMcp.valid.delete("at-1");
    oauthMcp.valid.add("at-2");
    const again = (await (await request("/mcp-servers/linear/tools")).json()) as {
      server: McpServerView;
    };
    expect(again.server.status).toBe("connected");
    expect(fakeAuth.tokenRequests.some((t) => t.get("grant_type") === "refresh_token")).toBe(true);
    expect(oauthMcp.seen.at(-1)).toBe("Bearer at-2");

    // Revoked everywhere: the refresh fails too, and the status says sign in again.
    oauthMcp.valid.clear();
    const refused = (await (await request("/mcp-servers/linear/tools")).json()) as {
      server: McpServerView;
    };
    expect(refused.server.status).toBe("needs_sign_in");
  });

  test("a sign-in cancelled while the browser is open adds nothing when the browser comes back", async () => {
    const started = (await (
      await send("/mcp-servers/linear/sign-in", { workspace: workspaceId })
    ).json()) as { state: string; url: string };
    const cancelled = (await (
      await send("/mcp-servers/sign-in/cancel", { state: started.state })
    ).json()) as McpSignInStatus;
    expect(cancelled.status).toBe("cancelled");
    const before = fakeAuth.tokenRequests.length;
    // The listener is closed, so the browser's redirect goes nowhere.
    await actAsBrowser(started.url).catch(() => {});
    expect(fakeAuth.tokenRequests.length).toBe(before);
    expect(
      (
        (await (
          await request(`/mcp-servers/sign-in/status?state=${started.state}`)
        ).json()) as McpSignInStatus
      ).status,
    ).toBe("cancelled");
  });

  test("a bearer key is sealed; the Setting names it and a wrong one reads as needing input", async () => {
    const wrong = (await (
      await send("/mcp-servers", {
        workspace: workspaceId,
        name: "keyed",
        url: keyMcp.url,
        token: "sk-wrong",
      })
    ).json()) as { server: McpServerView; next: string };
    expect(wrong.next).toBe("input");
    const right = (await (
      await send("/mcp-servers", {
        workspace: workspaceId,
        name: "keyed",
        url: keyMcp.url,
        token: "sk-live-giraffe",
        replace: true,
      })
    ).json()) as { server: McpServerView; next: string; tools: McpToolView[] };
    expect(right.next).toBe("ready");
    expect(right.server).toMatchObject({ auth: "bearer", status: "connected", secrets: ["token"] });
    expect(right.tools).toHaveLength(2);
    expect(await settingsText()).not.toContain("sk-live-giraffe");
    const entry = (await serverSetting()).find((s) => s.name === "keyed");
    expect(entry).toMatchObject({
      headers: { Authorization: "Bearer {token}" },
      secrets: ["token"],
    });

    // Choosing tools narrows what Workflows and the Agent may use.
    const narrowed = (await (
      await send("/mcp-servers/keyed", { tools: ["list_issues"] }, "PATCH")
    ).json()) as { server: McpServerView };
    expect(narrowed.server.tools).toEqual(["list_issues"]);
    const tools = (await (await request("/mcp-servers/keyed/tools")).json()) as {
      tools: McpToolView[];
    };
    expect(tools.tools.map((t) => [t.name, t.enabled])).toEqual([
      ["list_issues", true],
      ["create_issue", false],
    ]);
  });

  test("a local package asks only its declared inputs; the secret one is sealed and reaches the process", async () => {
    const fixture = join(import.meta.dir, "fixtures", "mcp-stdio-server.ts");
    const res = await send("/mcp-servers", {
      workspace: workspaceId,
      name: "weather",
      command: process.execPath,
      args: [fixture, "{region}"],
      env: { FIXTURE_KEY: "{FIXTURE_KEY}" },
      values: { region: "eu", FIXTURE_KEY: "wk-secret-otter" },
      secret: ["FIXTURE_KEY"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      server: McpServerView;
      next: string;
      tools: McpToolView[];
    };
    expect(body.next).toBe("ready");
    expect(body.server).toMatchObject({ kind: "local", auth: "inputs", secrets: ["FIXTURE_KEY"] });
    expect(body.tools.map((t) => t.name)).toEqual(["whoami", "echo"]);
    const entry = (await serverSetting()).find((s) => s.name === "weather");
    expect(entry?.args).toEqual([fixture, "eu"]);
    expect(entry?.env).toEqual({ FIXTURE_KEY: "{FIXTURE_KEY}" });
    expect(await settingsText()).not.toContain("wk-secret-otter");

    // A missing input is refused before anything is saved.
    const missing = await send("/mcp-servers", {
      workspace: workspaceId,
      name: "weather2",
      command: process.execPath,
      args: [fixture],
      env: { FIXTURE_KEY: "{FIXTURE_KEY}" },
    });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toBe("missing_input");
  }, 30_000);

  test("the Agent's call_mcp_tool path runs the local server with its sealed key", async () => {
    // The clients the Workflow Steps and the Agent use are the ones the Server built.
    const res = await request("/mcp-servers/weather/tools");
    expect(((await res.json()) as { server: McpServerView }).server.status).toBe("connected");
  }, 30_000);

  test("an older entry's token in the Setting is moved into the sealed store on unlock", async () => {
    const current = await serverSetting();
    await send(
      "/settings/workflows.mcp_servers",
      {
        value: [
          ...current,
          { name: "legacy", url: keyMcp.url, token: "sk-live-giraffe", tools: [] },
        ],
      },
      "PUT",
    );
    expect(await settingsText()).toContain("sk-live-giraffe");
    // Still works before the move.
    expect(
      ((await (await request("/mcp-servers/legacy/tools")).json()) as { server: McpServerView })
        .server.status,
    ).toBe("connected");
    keys.lock();
    await keys.unlock(rootKey);
    // The sweep runs on unlock; give it a moment.
    for (let i = 0; i < 50 && (await settingsText()).includes("sk-live-giraffe"); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await settingsText()).not.toContain("sk-live-giraffe");
    const legacy = (await serverSetting()).find((s) => s.name === "legacy");
    expect(legacy).toMatchObject({ auth: "bearer", secrets: ["token"] });
    expect(
      ((await (await request("/mcp-servers/legacy/tools")).json()) as { server: McpServerView })
        .server.status,
    ).toBe("connected");
  });

  test("remove forgets the server and its sealed row", async () => {
    expect((await request("/mcp-servers/keyed", { method: "DELETE" })).status).toBe(204);
    const list = (await (await request("/mcp-servers")).json()) as { servers: McpServerView[] };
    expect(list.servers.map((s) => s.name)).not.toContain("keyed");
    const rows = await db.handle.sql<{ id: string }[]>`
      select integration as id from integration_secrets where integration = 'mcp:keyed'
    `;
    expect(rows).toHaveLength(0);
  });
});

describe("a Cloud server", () => {
  test("refuses a local server it cannot start", async () => {
    const db = await testDatabase();
    try {
      const keys = createKeys(db.handle.db);
      await keys.unlock(randomKey());
      const store = createMailstore(db.handle.db, keys);
      const app = createApp({
        db: db.handle.db,
        auth: createAuth({ db: db.handle.db, sidecarToken: SIDECAR_TOKEN }),
        mode: "vercel",
        keys,
        mailstore: store,
        remoteAddress: () => "127.0.0.1",
      });
      const ws = (await store.createWorkspace(account)).id;
      const res = await app.request("/mcp-servers", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SIDECAR_TOKEN}` },
        body: JSON.stringify({ workspace: ws, name: "local", command: "npx some-server" }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("local_unavailable");
    } finally {
      await db.drop();
    }
  }, 60_000);
});

/* ------------------------------ The Agent's tools ------------------------------ */

describe("the Agent's MCP tools", () => {
  const NOW = new Date("2026-09-28T10:00:00Z");
  function tools(added: McpConnectInput[]) {
    const registry = createMcpRegistry({
      settings: async () => ({ enabled: true, url: REGISTRY, results: 10, cacheMinutes: 0 }),
      fetch: registryFetch([]),
    });
    const connections: McpConnectSeam["connections"] = {
      list: async () => [],
      add: async (_ws, input) => {
        added.push(input);
        return {
          server: {
            name: input.name,
            title: input.title ?? input.name,
            registry: input.registry ?? null,
            kind: "remote",
            target: input.url ?? "",
            auth: "oauth",
            secrets: [],
            tools: [],
            status: "needs_sign_in",
            message: null,
          },
          next: "sign_in",
          tools: [],
        };
      },
    };
    return createToolServer({
      host: createFakeToolHost([], { now: () => NOW }),
      activity: createMemoryActivityLog({ now: () => NOW }),
      now: () => NOW,
      settings: async () => ({ previewAbove: 10, alwaysAsk: [], searchLimit: 100 }),
      extensions: { mcpConnect: { registry, connections } },
    });
  }

  test("search_mcp_catalog is read-only and lists what the registry has", async () => {
    const server = tools([]);
    const out = await server.preview({ name: "search_mcp_catalog", args: { query: "linear" } });
    if (out.kind !== "result") throw new Error(out.kind);
    expect(out.text).toContain("app.linear/linear");
    expect(out.text).toContain("No MCP servers are connected yet.");
  });

  test("connect_mcp always asks and shows exactly what it connects; inputs go to Settings", async () => {
    const added: McpConnectInput[] = [];
    const server = tools(added);
    const out = await server.preview({ name: "connect_mcp", args: { id: "app.linear/linear" } });
    if (out.kind !== "action") throw new Error(out.kind);
    expect(out.asks).toBe(true);
    expect(JSON.stringify(out.preview)).toContain("https://mcp.linear.test/mcp");
    expect(added).toHaveLength(0);
    // A server that needs inputs is sent to Settings: the Agent never takes a secret.
    const needs = await server.preview({
      name: "connect_mcp",
      args: { id: "io.github.someone/weather" },
    });
    expect(needs.kind).toBe("refused");
  });
});
