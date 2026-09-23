// The external MCP server (docs/spec/external-mcp.md, slice 19): a key from
// the owner's routes, the real MCP client over streamable HTTP against /mcp,
// the listing filtered by scope, the credential name as the actor of every
// Activity row, an act key's approval parked and routed to the owner's
// client, the pending status past the timeout, the desktop notification when
// no client is open, revoked and expired keys, the rate limit, the OAuth 2.1
// flow with PKCE through the routes, the Agent's key tool with its undo, and
// the launcher's --key mode.

import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ExternalCredential, ExternalKeyCreated, ExternalPending } from "@monday/shared";
import { Hono } from "hono";
import { mcpHeaders, parseMcpArgs, upstreamUrl } from "../entry/mcp.ts";
import type { AppEnv } from "../src/auth/middleware.ts";
import {
  authenticate,
  PUBLIC_PATHS,
  PUBLIC_PREFIXES,
  requireAuth,
} from "../src/auth/middleware.ts";
import {
  createExternal,
  createMemoryCredentialStore,
  createMemoryNotifier,
  type ExternalSettings,
  KEY_PREFIX,
  pkceChallenge,
} from "../src/external/index.ts";
import {
  createAgentHost,
  createMemoryActivityLog,
  createMemorySessionStore,
} from "../src/intelligence/agent/index.ts";
import {
  createFakeToolHost,
  type FakeThreadInput,
} from "../src/intelligence/agent/tools/fake-host.ts";
import { createFakeRuntime } from "../src/intelligence/runtime/fake/index.ts";
import { agentRoutes } from "../src/routes/agent.ts";
import {
  EXTERNAL_PUBLIC_PATHS,
  EXTERNAL_PUBLIC_PREFIXES,
  externalRoutes,
} from "../src/routes/external.ts";

const START = new Date("2026-09-19T10:00:00Z");
const daysAgo = (n: number) => new Date(START.getTime() - n * 86_400_000).toISOString();
const WS = "ws-fake";
const DEVICE_TOKEN = "device-token";

function fixtureMailbox(): FakeThreadInput[] {
  const old = Array.from({ length: 12 }, (_, i) => ({
    id: `nl-old-${i + 1}`,
    subject: `Weekly digest ${i + 1}`,
    from: "digest@newsletter.test",
    lastActivity: daysAgo(8 + i),
    section: "newsletters",
  }));
  const inbox = [
    {
      id: "t-boss",
      subject: "Budget review Friday",
      from: "boss@example.test",
      lastActivity: daysAgo(1),
      section: "needs-reply",
      text: "Can you send the numbers before Friday?",
    },
    {
      id: "t-team",
      subject: "Standup notes",
      from: "team@example.test",
      lastActivity: daysAgo(2),
      section: "fyi",
    },
  ];
  return [...old, ...inbox];
}

const defaultSettings: ExternalSettings = {
  ratePerMinute: 60,
  searchCap: 5,
  approvalTimeoutMs: 5 * 60_000,
  keyExpiryDays: 90,
  consentTtlMs: 10 * 60_000,
};

const consentStrings = {
  title: "Connect to monday",
  intro: "{client} asks to use your mail through monday.",
  scopeRead: "Read only",
  scopeAct: "Read and act, asks first",
  codeHint: "Type this code in monday.",
  waiting: "Waiting for approval",
  deny: "Decline",
  approved: "Approved.",
  denied: "Declined.",
  expired: "Expired.",
};

/** The whole stack over fakes: the Agent host, the external module, both route groups behind the Device middleware. */
function stack(over: Partial<ExternalSettings> = {}) {
  let clock = START.getTime();
  const now = () => new Date(clock);
  const advance = (ms: number) => {
    clock += ms;
  };
  const { runtime } = createFakeRuntime({ steps: [], now: () => clock });
  const host = createFakeToolHost(fixtureMailbox(), { now });
  const activity = createMemoryActivityLog({ now });
  const sessions = createMemorySessionStore({ now });
  const agent = createAgentHost({
    runtime,
    activity,
    sessions,
    hostFor: () => host,
    now,
    workspaceAddress: async () => "me@example.test",
    settings: async () => ({
      systemPrompt: "You are monday.",
      maxSteps: 24,
      previewAbove: 10,
      alwaysAsk: [],
      searchLimit: 100,
    }),
  });
  const store = createMemoryCredentialStore({ now });
  const notifier = createMemoryNotifier();
  const settings = { ...defaultSettings, ...over };
  const external = createExternal({
    agent,
    store,
    notify: notifier,
    now,
    settings: async () => settings,
    workspaces: async () => [{ id: WS, address: "me@example.test" }],
  });
  const app = new Hono<AppEnv>();
  // The same middleware as the app: a Device token for the owner's routes, the external paths let through.
  app.use(
    "*",
    authenticate(
      {
        authenticate: async (bearer: string | null) =>
          bearer === DEVICE_TOKEN ? { kind: "device", deviceId: "d1" } : null,
      } as never,
      () => true,
    ),
  );
  app.use(
    "*",
    requireAuth(
      [...PUBLIC_PATHS, ...EXTERNAL_PUBLIC_PATHS],
      [...PUBLIC_PREFIXES, ...EXTERNAL_PUBLIC_PREFIXES],
    ),
  );
  app.route("/", agentRoutes(agent));
  app.route("/", externalRoutes({ external, consentStrings: async () => consentStrings }));
  return { app, agent, host, activity, store, notifier, external, advance, settings };
}

type Stack = ReturnType<typeof stack>;

const owner = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: {
    authorization: `Bearer ${DEVICE_TOKEN}`,
    ...(body !== undefined ? { "content-type": "application/json" } : {}),
  },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

async function makeKey(
  s: Stack,
  input: { name: string; scope: "read" | "act"; workspaceIds?: string[] | null },
): Promise<ExternalKeyCreated> {
  const res = await s.app.request("/external/credentials", owner("POST", input));
  expect(res.status).toBe(201);
  return (await res.json()) as ExternalKeyCreated;
}

/** A Claude Code session outside monday: the real SDK client over streamable HTTP, a credential as bearer. */
async function outsideClient(s: Stack, bearer: string, headers: Record<string, string> = {}) {
  const transport = new StreamableHTTPClientTransport(new URL("http://monday.test/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${bearer}`, ...headers } },
    fetch: async (input, init) =>
      s.app.request(input instanceof Request ? input : String(input), init),
  }) as unknown as Transport;
  const client = new Client({ name: "claude-code", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

const textOf = (result: Record<string, unknown>) =>
  (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";

async function until<T>(probe: () => T | null | undefined, ms = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("the external MCP server", () => {
  test("a Claude Code session outside monday reads the inbox with a read key and is refused a send", async () => {
    const s = stack();
    const made = await makeKey(s, { name: "assistant", scope: "read", workspaceIds: [WS] });
    // The key is shown once: a recognisable prefix, never stored in clear, listed with its prefix.
    expect(made.secret.startsWith(KEY_PREFIX)).toBe(true);
    expect(made.credential).toMatchObject({
      kind: "key",
      name: "assistant",
      scope: "read",
      workspaceIds: [WS],
      prefix: made.secret.slice(0, 14),
      lastUsedAt: null,
    });
    expect(Date.parse(made.credential.expiresAt) - START.getTime()).toBe(90 * 86_400_000);
    expect(JSON.stringify(s.store.credentials)).not.toContain(made.secret);

    // Never a Device token: the owner's own token is refused on /mcp, and a key is refused on the owner's routes.
    const withDevice = await s.app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${DEVICE_TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(withDevice.status).toBe(401);
    expect(withDevice.headers.get("www-authenticate")).toContain("resource_metadata=");
    const keyOnOwner = await s.app.request("/external/credentials", {
      headers: { authorization: `Bearer ${made.secret}` },
    });
    expect(keyOnOwner.status).toBe(401);

    const claude = await outsideClient(s, made.secret);
    const listed = (await claude.listTools()).tools;
    expect(listed.map((t) => t.name).sort()).toEqual(
      [
        "search_threads",
        "read_thread",
        "list_groups_and_sections",
        "undo",
        "list_workflows",
        "dry_run_workflow",
        "list_workflow_runs",
        "onboarding_context",
        "propose_workflows",
        "list_events",
        "explain_placement",
        "list_judgments",
        "test_judgment",
        "list_drafts",
        "read_draft",
        "open_draft",
      ].sort(),
    );
    expect(listed.every((t) => t._meta?.tier === "read")).toBe(true);
    expect(listed.find((t) => t.name === "send_draft")).toBeUndefined();

    // The inbox, capped at the external search cap (5 here) below the Agent's own limit.
    const search = await claude.callTool({ name: "search_threads", arguments: {} });
    expect(search.isError).toBeFalsy();
    expect(textOf(search).startsWith("5 threads:")).toBe(true);
    expect(textOf(search)).toContain("Budget review Friday");
    const read = await claude.callTool({
      name: "read_thread",
      arguments: { thread_id: "t-boss" },
    });
    expect(textOf(read)).toContain("Subject: Budget review Friday");
    expect(textOf(read)).toContain("Can you send the numbers before Friday?");

    // A direct call to a tool outside the scope answers a scope error and never reaches the mailbox.
    const send = await claude.callTool({
      name: "send_draft",
      arguments: { draft_id: "any" },
    });
    expect(send.isError).toBe(true);
    expect(textOf(send)).toContain("Scope error");
    expect(textOf(send)).toContain("read scope");
    expect(send._meta).toEqual({ error: "scope" });
    expect(s.host.sends).toHaveLength(0);

    // Every call that reached a tool is in the Activity log with the key's name as its actor.
    const rows = (await s.agent.listActivity(WS)).filter((r) => r.tool !== "undo");
    expect(rows.map((r) => [r.tool, r.actor, r.actorName, r.status])).toEqual([
      ["read_thread", "external", "assistant", "done"],
      ["search_threads", "external", "assistant", "done"],
    ]);
    // In the key's own Session, titled after it, so the history names the caller.
    const session = (await s.agent.listSessions(WS)).find(
      (x) => x.title === "assistant (external)",
    );
    expect(session).toBeDefined();
    expect(rows.every((r) => r.sessionId === session?.id)).toBe(true);
    // Last use is recorded and listed.
    const list = (await (await s.app.request("/external/credentials", owner("GET"))).json()) as {
      credentials: ExternalCredential[];
    };
    expect(list.credentials[0]?.lastUsedAt).toBe(START.toISOString());
    await claude.close();
  });

  test("an act key's archive above the threshold parks an approval that the owner's client answers, with the caller's name", async () => {
    const s = stack();
    const made = await makeKey(s, { name: "ops bot", scope: "act", workspaceIds: null });
    const claude = await outsideClient(s, made.secret, { "x-monday-workspace": WS });
    const listed = (await claude.listTools()).tools.map((t) => t.name);
    expect(listed).toContain("send_draft");
    expect(listed).toContain("archive_threads");

    // The owner's client is open: subscribed to the Workspace's external feed.
    const feed: ExternalPending[] = [];
    const stop = s.external.live(WS, (p) => feed.push(p));
    const ids = Array.from({ length: 12 }, (_, i) => `nl-old-${i + 1}`);
    const call = claude.callTool({ name: "archive_threads", arguments: { thread_ids: ids } });
    const waiting = await until(() => feed.find((p) => p.status === "waiting"));
    expect(waiting).toMatchObject({
      credentialName: "ops bot",
      tool: "archive_threads",
      workspaceId: WS,
      inputSummary: "12 threads",
    });
    expect(s.host.intents).toHaveLength(0);
    // No notification: a client is open.
    expect(s.notifier.sent).toHaveLength(0);
    // The card sits in the caller's Session as a waiting card the composer renders.
    const session = await s.agent.getSession(waiting.sessionId as string);
    const card = session?.events.find((e) => e.kind === "tool" && e.call.id === waiting.activityId);
    expect(card?.kind === "tool" ? card.call : null).toMatchObject({
      status: "waiting",
      tier: "reversible",
      tool: "archive_threads",
    });
    // The owner's list shows it, and the owner answers it from the client.
    const pending = (await (
      await s.app.request(`/external/pending?workspace=${WS}`, owner("GET"))
    ).json()) as { pending: ExternalPending[] };
    expect(pending.pending.map((p) => p.activityId)).toEqual([waiting.activityId]);
    const decided = await s.app.request(
      `/external/pending/${waiting.activityId}`,
      owner("POST", { decision: "approved" }),
    );
    expect(decided.status).toBe(200);
    const result = await call;
    expect(textOf(result)).toBe("Archive: 12 threads.");
    expect(ids.every((id) => s.host.threads.get(id)?.archived)).toBe(true);
    const row = (await s.agent.listActivity(WS)).find((r) => r.tool === "archive_threads");
    expect(row).toMatchObject({
      actor: "external",
      actorName: "ops bot",
      decision: "approved",
      approvedBy: "user",
      status: "done",
    });
    expect(feed.at(-1)?.status).toBe("done");

    // The same card is answerable through the ordinary approval route of its
    // Session, which is what the composer's Approve button calls.
    const second = claude.callTool({ name: "trash_threads", arguments: { thread_ids: ids } });
    const trash = await until(() =>
      feed.find((p) => p.status === "waiting" && p.tool === "trash_threads"),
    );
    expect(trash.credentialName).toBe("ops bot");
    const viaSession = await s.app.request(
      `/sessions/${trash.sessionId}/approvals/${trash.activityId}`,
      owner("POST", { decision: "declined" }),
    );
    expect(viaSession.status).toBe(200);
    await viaSession.text();
    expect(textOf(await second)).toContain("Declined by the user");
    expect(s.host.threads.get("nl-old-1")?.deleted).toBe(false);
    stop();
    await claude.close();
  });

  test("with no client open the call returns pending past the timeout, a desktop notification is requested, and the caller polls the result", async () => {
    const s = stack({ approvalTimeoutMs: 30 });
    const made = await makeKey(s, { name: "night shift", scope: "act", workspaceIds: [WS] });
    const claude = await outsideClient(s, made.secret);
    const result = await claude.callTool({
      name: "send_draft",
      arguments: { draft_id: "missing" },
    });
    // A send of a Draft that does not exist is refused before it asks: no pending, no notification.
    expect(result.isError).toBe(true);
    expect(s.notifier.sent).toHaveLength(0);

    const ids = Array.from({ length: 12 }, (_, i) => `nl-old-${i + 1}`);
    const parked = await claude.callTool({
      name: "archive_threads",
      arguments: { thread_ids: ids },
    });
    expect(parked._meta).toMatchObject({ pending: true, status: "waiting" });
    const activityId = String(parked._meta?.activityId);
    expect(textOf(parked)).toContain(`/mcp/pending/${activityId}`);
    expect(s.notifier.sent).toHaveLength(1);
    expect(s.notifier.sent[0]).toMatchObject({
      workspaceId: WS,
      title: "night shift asks for an approval",
      body: "archive threads: 12 threads",
      activityId,
    });

    // The caller polls with its own credential; another credential sees nothing.
    const poll = await s.app.request(`/mcp/pending/${activityId}`, {
      headers: { authorization: `Bearer ${made.secret}` },
    });
    expect(poll.status).toBe(200);
    expect((await poll.json()) as ExternalPending).toMatchObject({ status: "waiting" });
    const other = await makeKey(s, { name: "other", scope: "act", workspaceIds: [WS] });
    const foreign = await s.app.request(`/mcp/pending/${activityId}`, {
      headers: { authorization: `Bearer ${other.secret}` },
    });
    expect(foreign.status).toBe(404);

    // The owner comes back and declines; the poll shows the outcome.
    await s.app.request(`/external/pending/${activityId}`, owner("POST", { decision: "declined" }));
    const after = (await (
      await s.app.request(`/mcp/pending/${activityId}`, {
        headers: { authorization: `Bearer ${made.secret}` },
      })
    ).json()) as ExternalPending;
    expect(after.status).toBe("done");
    expect(after.text).toContain("Declined by the user");
    expect(s.host.threads.get("nl-old-1")?.archived).toBe(false);
    await claude.close();
  });

  test("an expired or revoked key gets 401, a key kept to its Workspaces, and the rate limit answers 429", async () => {
    const s = stack({ ratePerMinute: 5 });
    const made = await makeKey(s, { name: "temp", scope: "read", workspaceIds: [WS] });
    const other = await s.app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${made.secret}`,
        "x-monday-workspace": "ws-other",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(other.status).toBe(403);

    // Five requests a minute per credential, the refused one and the SDK's own
    // handshake included: within a handful of listings the answer is 429.
    const claude = await outsideClient(s, made.secret);
    let limited: unknown = null;
    for (let i = 0; i < 6 && !limited; i++) {
      await claude.listTools().catch((e: unknown) => {
        limited = e;
      });
    }
    expect(String(limited)).toContain("rate_limited");
    const direct429 = await s.app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${made.secret}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(direct429.status).toBe(429);
    expect(direct429.headers.get("retry-after")).toBe("60");
    // A minute later the window has moved on.
    s.advance(61_000);
    await claude.listTools();

    // Revoked from the list: the next call is 401 with the reason.
    const revoked = await s.app.request(
      `/external/credentials/${made.credential.id}`,
      owner("DELETE"),
    );
    expect(revoked.status).toBe(204);
    await expect(claude.listTools()).rejects.toThrow(/unauthorized|Unauthorized/);
    const direct = await s.app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${made.secret}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(await direct.json()).toEqual({ error: "unauthorized", reason: "revoked" });
    const twice = await s.app.request(
      `/external/credentials/${made.credential.id}`,
      owner("DELETE"),
    );
    expect(twice.status).toBe(404);

    // Expiry: a key past its date is refused the same way.
    const short = await makeKey(s, { name: "short", scope: "read", workspaceIds: [WS] });
    s.advance(91 * 86_400_000);
    const expired = await s.app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${short.secret}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(expired.status).toBe(401);
    expect(await expired.json()).toEqual({ error: "unauthorized", reason: "expired" });
    // An unknown key too.
    const unknown = await s.app.request("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer mk_live_nope", "content-type": "application/json" },
      body: "{}",
    });
    expect(unknown.status).toBe(401);
    await claude.close().catch(() => {});
  });

  test("the OAuth 2.1 flow end to end with PKCE through the routes: discovery, registration, consent by pairing code, tokens, refresh, revocation", async () => {
    const s = stack();
    const issuer = "http://monday.test";
    const meta = (await (
      await s.app.request(`${issuer}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(meta).toMatchObject({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
    const resource = (await (
      await s.app.request(`${issuer}/.well-known/oauth-protected-resource`)
    ).json()) as Record<string, unknown>;
    expect(resource).toMatchObject({ resource: `${issuer}/mcp`, authorization_servers: [issuer] });

    // Dynamic client registration: a public client with a loopback redirect.
    const registered = await s.app.request(`${issuer}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude Desktop",
        redirect_uris: ["http://127.0.0.1:43110/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registered.status).toBe(201);
    const client = (await registered.json()) as { client_id: string; client_name: string };
    expect(client.client_name).toBe("Claude Desktop");
    const refusedSecret = await s.app.request(`${issuer}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://evil.test/cb"],
      }),
    });
    expect(refusedSecret.status).toBe(400);

    // The authorization request opens the consent page: the client, the scope, the Workspaces, a code.
    const verifier = "a-verifier-of-at-least-forty-three-characters-long-0123456789";
    const challenge = await pkceChallenge(verifier);
    const q = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "http://127.0.0.1:43110/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "read act",
      state: "xyz",
      resource: `${issuer}/mcp`,
    });
    const page = await s.app.request(`${issuer}/oauth/authorize?${q}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("Claude Desktop");
    expect(html).toContain("Read and act, asks first");
    expect(html).toContain("me@example.test");
    const consentId = /\/oauth\/consent\/([0-9a-f-]+)"/.exec(html)?.[1] as string;
    expect(consentId).toBeTruthy();
    const code = /class="code">(\d{6})</.exec(html)?.[1] as string;
    expect(code).toMatch(/^\d{6}$/);
    // Without PKCE the request is refused back to the client.
    const noPkce = await s.app.request(
      `${issuer}/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "http://127.0.0.1:43110/callback",
        state: "s",
      })}`,
    );
    expect(noPkce.status).toBe(400);

    // The page polls; the owner sees the consent in the client and approves it by the code.
    expect(await (await s.app.request(`${issuer}/oauth/consent/${consentId}`)).json()).toEqual({
      status: "pending",
    });
    const consents = (await (await s.app.request("/external/consents", owner("GET"))).json()) as {
      consents: Array<{ id: string; clientName: string; code: string; scope: string }>;
    };
    expect(consents.consents).toMatchObject([
      { id: consentId, clientName: "Claude Desktop", code, scope: "act" },
    ]);
    const wrong = await s.app.request(
      "/external/consents/approve",
      owner("POST", { code: "000000" }),
    );
    expect(wrong.status).toBe(404);
    const approved = await s.app.request(
      "/external/consents/approve",
      owner("POST", { code, workspaceIds: [WS] }),
    );
    expect(approved.status).toBe(200);
    const status = (await (await s.app.request(`${issuer}/oauth/consent/${consentId}`)).json()) as {
      status: string;
      redirect: string;
    };
    expect(status.status).toBe("approved");
    const redirect = new URL(status.redirect);
    expect(redirect.origin + redirect.pathname).toBe("http://127.0.0.1:43110/callback");
    expect(redirect.searchParams.get("state")).toBe("xyz");
    const authCode = redirect.searchParams.get("code") as string;
    expect(authCode).toBeTruthy();

    // The token exchange: the wrong verifier is refused, the right one mints a credential.
    const form = (fields: Record<string, string>) => ({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
    const bad = await s.app.request(
      `${issuer}/oauth/token`,
      form({
        grant_type: "authorization_code",
        code: authCode,
        code_verifier: "not-the-verifier",
        client_id: client.client_id,
        redirect_uri: "http://127.0.0.1:43110/callback",
      }),
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()) as { error: string }).toMatchObject({ error: "invalid_grant" });
    // A code is single use: the failed exchange spent it, so the flow restarts for a clean one.
    const again = await s.app.request(`${issuer}/oauth/authorize?${q}`);
    const html2 = await again.text();
    const code2 = /class="code">(\d{6})</.exec(html2)?.[1] as string;
    const id2 = /\/oauth\/consent\/([0-9a-f-]+)"/.exec(html2)?.[1] as string;
    await s.app.request(
      "/external/consents/approve",
      owner("POST", { id: id2, workspaceIds: [WS] }),
    );
    void code2;
    const status2 = (await (await s.app.request(`${issuer}/oauth/consent/${id2}`)).json()) as {
      redirect: string;
    };
    const authCode2 = new URL(status2.redirect).searchParams.get("code") as string;
    const tokens = await s.app.request(
      `${issuer}/oauth/token`,
      form({
        grant_type: "authorization_code",
        code: authCode2,
        code_verifier: verifier,
        client_id: client.client_id,
        redirect_uri: "http://127.0.0.1:43110/callback",
      }),
    );
    expect(tokens.status).toBe(200);
    const issued = (await tokens.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    };
    expect(issued).toMatchObject({ token_type: "Bearer", scope: "act", expires_in: 90 * 86_400 });
    expect(issued.access_token.startsWith("mo_")).toBe(true);

    // The token is a credential like a key: listed in the same place, the same scope model, usable on /mcp.
    const list = (await (await s.app.request("/external/credentials", owner("GET"))).json()) as {
      credentials: ExternalCredential[];
    };
    const oauthRow = list.credentials.find((c) => c.kind === "oauth");
    expect(oauthRow).toMatchObject({
      name: "Claude Desktop",
      scope: "act",
      workspaceIds: [WS],
      clientId: client.client_id,
      prefix: null,
    });
    const remote = await outsideClient(s, issued.access_token);
    expect((await remote.listTools()).tools.map((t) => t.name)).toContain("send_draft");
    const search = await remote.callTool({
      name: "search_threads",
      arguments: { query: "Budget" },
    });
    expect(textOf(search)).toContain("Budget review Friday");
    const row = (await s.agent.listActivity(WS)).find((r) => r.tool === "search_threads");
    expect(row).toMatchObject({ actor: "external", actorName: "Claude Desktop" });
    await remote.close();

    // Refresh rotates: the old access token stops, the old refresh token is spent.
    const refreshed = await s.app.request(
      `${issuer}/oauth/token`,
      form({
        grant_type: "refresh_token",
        refresh_token: issued.refresh_token,
        client_id: client.client_id,
      }),
    );
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect(next.access_token).not.toBe(issued.access_token);
    const stale = await s.app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.access_token}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(stale.status).toBe(401);
    const spent = await s.app.request(
      `${issuer}/oauth/token`,
      form({ grant_type: "refresh_token", refresh_token: issued.refresh_token }),
    );
    expect(spent.status).toBe(400);

    // Revocation (RFC 7009): the credential is gone for both tokens, and the list says so.
    const revoked = await s.app.request(
      `${issuer}/oauth/revoke`,
      form({ token: next.refresh_token }),
    );
    expect(revoked.status).toBe(200);
    const afterRevoke = await s.app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${next.access_token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(await afterRevoke.json()).toEqual({ error: "unauthorized", reason: "revoked" });
    const denied = await s.app.request(`${issuer}/oauth/authorize?${q}`);
    const id3 = /\/oauth\/consent\/([0-9a-f-]+)"/.exec(await denied.text())?.[1] as string;
    await s.app.request(`${issuer}/oauth/consent/${id3}/deny`, { method: "POST" });
    expect(
      (await (await s.app.request(`${issuer}/oauth/consent/${id3}`)).json()) as { status: string },
    ).toMatchObject({ status: "denied" });
  });

  test("the Agent makes a key through a reversible tool that shows it once in the card, and undo revokes it", async () => {
    const s = stack();
    // The key tool reaches the external module through the extensions seam, as the app wires it.
    const agentWithSeam = createAgentHost({
      runtime: createFakeRuntime({ steps: [], now: () => START.getTime() }).runtime,
      activity: s.activity,
      sessions: createMemorySessionStore({ now: () => START }),
      hostFor: () => s.host,
      now: () => START,
      workspaceAddress: async () => "me@example.test",
      settings: async () => ({
        systemPrompt: "",
        maxSteps: 4,
        previewAbove: 10,
        alwaysAsk: [],
        searchLimit: 100,
      }),
      extensions: { external: s.external },
    });
    const session = await agentWithSeam.createSession(WS, { kind: "local", cli: "claude-code" });
    const outcome = await agentWithSeam.call({
      workspaceId: WS,
      sessionId: session.id,
      name: "create_external_key",
      args: { name: "my assistant", scope: "read" },
    });
    expect(outcome.isError).toBe(false);
    const secret = /Key (mk_live_[A-Za-z0-9_-]+) for/.exec(outcome.text)?.[1] as string;
    expect(secret).toBeTruthy();
    // The card's result line carries the key, once; the row is reversible.
    const card = (await agentWithSeam.listActivity(WS)).find(
      (r) => r.tool === "create_external_key",
    );
    expect(card).toMatchObject({ tier: "reversible", status: "done", undoable: true });
    expect(card?.result).toContain(secret);
    const listed = await s.external.listCredentials();
    expect(listed).toMatchObject([{ name: "my assistant", scope: "read", workspaceIds: [WS] }]);
    expect(await s.external.authenticate(secret)).toMatchObject({ ok: true });
    const undone = await agentWithSeam.undo(card?.id as string, session.id);
    expect(undone.result).toBe("Undone: the key was revoked.");
    expect(await s.external.authenticate(secret)).toEqual({ ok: false, reason: "revoked" });
  });

  test("the launcher's --key mode targets /mcp with the credential; the Device mode is unchanged", async () => {
    const keyed = parseMcpArgs(["--port", "4242", "--key", "mk_live_abc", "--workspace", "ws"]);
    expect(keyed).toEqual({
      port: 4242,
      token: null,
      key: "mk_live_abc",
      url: null,
      workspace: "ws",
      session: null,
      pinned: [],
    });
    expect(upstreamUrl(keyed)).toBe("http://127.0.0.1:4242/mcp");
    expect(mcpHeaders(keyed)).toEqual({
      authorization: "Bearer mk_live_abc",
      "x-monday-workspace": "ws",
    });
    // A Cloud URL with a key, for a remote Server.
    const remote = parseMcpArgs(["--url", "https://mail.example.test", "--key", "mk_live_abc"]);
    expect(upstreamUrl(remote)).toBe("https://mail.example.test/mcp");
    expect(mcpHeaders(remote)).toEqual({ authorization: "Bearer mk_live_abc" });
    expect(parseMcpArgs([], { MONDAY_MCP_KEY: "k", MONDAY_SIDECAR_PORT: "7" })).toMatchObject({
      key: "k",
      port: 7,
    });
    // The Device mode as before.
    const device = parseMcpArgs(["--port", "1", "--token", "t", "--workspace", "w"]);
    expect(upstreamUrl(device)).toBe("http://127.0.0.1:1/mcp/local");
    expect(mcpHeaders(device)).toEqual({ authorization: "Bearer t", "x-monday-workspace": "w" });
    expect(() => parseMcpArgs(["--port", "1"])).toThrow(/usage/);
    expect(() => parseMcpArgs(["--port", "1", "--token", "t"])).toThrow(/usage/);
  });
});
