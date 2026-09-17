// The push registrations and webhooks end to end over the in-memory Gmail and
// Graph, the real Jobs table, the sync engine and the Hono app: the OAuth
// routes create the Accounts, the push Jobs register watches and
// subscriptions (Graph's validation handshake is answered by the app itself),
// and the webhooks wake sync.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { type AccountService, createAccountService } from "../../src/accounts.ts";
import { type AppEnv, createApp } from "../../src/app.ts";
import { createAuth } from "../../src/auth/index.ts";
import { randomKey } from "../../src/crypto/aead.ts";
import { createKeys } from "../../src/crypto/keys.ts";
import { jobs as jobsTable } from "../../src/db/schema.ts";
import { createJobs, type Jobs } from "../../src/jobs/index.ts";
import { createMailstore } from "../../src/mailstore/index.ts";
import { type CredentialStore, createCredentialStore } from "../../src/providers/credentials.ts";
import { generateFixture } from "../../src/providers/fake/fixture.ts";
import { createProviderRegistry } from "../../src/providers/index.ts";
import { createOAuthFlow } from "../../src/providers/oauth/flow.ts";
import { createTokenBroker } from "../../src/providers/oauth/tokens.ts";
import {
  createPushManager,
  GMAIL_PUSH_SUBSCRIBE_STEP,
  GMAIL_WATCH_RENEW_STEP,
  GRAPH_SUBSCRIBE_STEP,
  NO_PUBLIC_URL_SLEEP_MS,
  type PushManager,
  readPushState,
} from "../../src/providers/push.ts";
import {
  createSyncEngine,
  RECONCILE_STEP,
  SYNC_STEP,
  WATCH_STEP,
} from "../../src/providers/sync.ts";
import type { LoopbackListener } from "../../src/routes/oauth.ts";
import { type TestDatabase, testDatabase } from "../harness.ts";
import { createGmailServer, type GmailServer } from "./gmail-server.ts";
import { createGraphServer, type GraphServer } from "./graph-server.ts";

const fixture = generateFixture();
const SIDECAR_TOKEN = "per-launch-token";
const auth = { authorization: `Bearer ${SIDECAR_TOKEN}` };
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...auth },
  body: JSON.stringify(body),
});

/** A loopback listener that captures the redirect URI and lets the test deliver the callback. */
function fakeLoopback() {
  let deliver: ((query: Record<string, string>) => void) | null = null;
  let lastRedirect = "";
  const listener: LoopbackListener = {
    async open(provider) {
      lastRedirect =
        provider === "google" ? "http://127.0.0.1:4242/callback" : "http://localhost:4242";
      const callback = new Promise<Record<string, string>>((resolve) => {
        deliver = resolve;
      });
      return { redirectUri: lastRedirect, callback, close: () => {} };
    },
  };
  return {
    listener,
    redirectUri: () => lastRedirect,
    deliver: (query: Record<string, string>) => deliver?.(query),
  };
}

describe("push registrations, webhooks and the OAuth routes", () => {
  let db: TestDatabase;
  let app: Hono<AppEnv>;
  let jobs: Jobs;
  let push: PushManager;
  let credentials: CredentialStore;
  let accounts: AccountService;
  let gmail: GmailServer;
  let graph: GraphServer;
  let publicUrl: string | null = null;
  const loopback = fakeLoopback();
  let gmailAccountId = "";
  let graphAccountId = "";
  let refreshedAuths = 0;

  /** Every fake answers through one fetch, routed by host. */
  const fetchAll = async (url: string, init?: RequestInit) => {
    const host = new URL(url).host;
    if (
      host.endsWith("microsoft.com") ||
      host.endsWith("microsoftonline.com") ||
      host === "outlook.office.com"
    ) {
      return graph.fetch(url, init);
    }
    return gmail.fetch(url, init);
  };

  beforeAll(async () => {
    db = await testDatabase();
    gmail = createGmailServer(fixture);
    graph = createGraphServer(fixture);
    const keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    const mailstore = createMailstore(db.handle.db, keys);
    credentials = createCredentialStore(db.handle.db, mailstore);
    const tokens = createTokenBroker({
      fetch: fetchAll,
      onRefreshed: async (a) => {
        refreshedAuths += await credentials.updateAuth(a);
      },
    });
    const providers = createProviderRegistry({
      tokens,
      gmail: { fetch: fetchAll, sleep: async () => {}, pullRetryMs: 1 },
      graph: { fetch: fetchAll, pollMs: 50 },
    });
    jobs = createJobs(db.handle.db);
    const engine = createSyncEngine({
      db: db.handle.db,
      mailstore,
      providers,
      credentials,
      watchDebounceMs: 10,
    });
    engine.registerSteps(jobs);
    push = createPushManager({
      db: db.handle.db,
      engine,
      serverId: "cloud-1",
      publicUrl: async () => publicUrl,
      settings: async () => ({
        gmailWatchRenewHours: 24,
        graphSubscriptionRenewHours: 72,
        publicUrl: "",
      }),
    });
    push.registerSteps(jobs);
    accounts = createAccountService({
      db: db.handle.db,
      mailstore,
      providers,
      credentials,
      onAdded: async (accountId, provider) => {
        await engine.startAccount(jobs, accountId);
        await push.startAccount(jobs, accountId, provider);
      },
    });
    const authService = createAuth({ db: db.handle.db, sidecarToken: SIDECAR_TOKEN });
    app = createApp({
      db: db.handle.db,
      auth: authService,
      mode: "sidecar",
      keys,
      mailstore,
      remoteAddress: () => "127.0.0.1",
      accounts: { accounts },
      oauth: {
        flow: createOAuthFlow({ fetch: fetchAll }),
        loopback: loopback.listener,
        fetch: fetchAll,
        statusWaitMs: 200,
      },
      push,
    });
    // Graph validates a subscription's URLs by posting to them: route that through the app.
    graph.validate = async (url) => {
      const u = new URL(url);
      if (u.origin !== publicUrl) return false;
      const token = `token-${Math.random().toString(36).slice(2)}`;
      const res = await app.request(`${u.pathname}?validationToken=${encodeURIComponent(token)}`, {
        method: "POST",
      });
      return (
        res.status === 200 &&
        (res.headers.get("content-type") ?? "").startsWith("text/plain") &&
        (await res.text()) === token
      );
    };
  }, 60_000);

  afterAll(async () => {
    await db.drop();
  });

  async function runStep(cls: string): Promise<unknown> {
    const rows = await db.handle.db.select().from(jobsTable).where(eq(jobsTable.class, cls));
    const row = rows.find((r) => r.status === "queued");
    if (!row) throw new Error(`no queued ${cls}`);
    await db.handle.db
      .update(jobsTable)
      .set({ runAt: new Date(0) })
      .where(eq(jobsTable.id, row.id));
    const claimed = await jobs.claim("cloud-1", ["needs-process", "needs-public-url"], 30_000);
    if (!claimed || claimed.id !== row.id) {
      // Something older was queued first; run it and try again.
      if (claimed) await jobs.run(claimed, 30_000);
      return runStep(cls);
    }
    return jobs.run(claimed, 30_000);
  }

  async function queuedSyncJobs(accountId: string): Promise<number> {
    const rows = await db.handle.db.select().from(jobsTable).where(eq(jobsTable.class, SYNC_STEP));
    return rows.filter(
      (r) => (r.payload as { accountId: string }).accountId === accountId && r.status === "queued",
    ).length;
  }

  test("the Google wizard: validate, start with PKCE and the loopback, sign in, Account created", async () => {
    const bad = await app.request(
      "/oauth/google/validate?clientId=nope.apps.googleusercontent.com&clientSecret=x",
      { headers: auth },
    );
    expect(await bad.json()).toMatchObject({ ok: false, field: "clientId" });
    const good = await app.request(
      "/oauth/google/validate?clientId=1234-abc.apps.googleusercontent.com&clientSecret=GOCSPX-secret",
      { headers: auth },
    );
    expect(await good.json()).toMatchObject({ ok: true });
    expect((await app.request("/oauth/google/validate?clientId=x")).status).toBe(401);

    const started = await app.request(
      "/oauth/google/start",
      json({
        clientId: "1234-abc.apps.googleusercontent.com",
        clientSecret: "GOCSPX-secret",
        pubsubTopic: "projects/monday-test/topics/gmail",
      }),
    );
    expect(started.status).toBe(200);
    const { state, url, redirectUri } = (await started.json()) as Record<string, string>;
    expect(redirectUri).toBe("http://127.0.0.1:4242/callback");
    const authUrl = new URL(url ?? "");
    expect(authUrl.searchParams.get("redirect_uri")).toBe(redirectUri ?? "");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");

    const pending = await app.request(`/oauth/google/status?state=${state}`, { headers: auth });
    expect(await pending.json()).toEqual({ status: "pending" });

    // The browser comes back to the loopback with the code.
    const code = gmail.issueCode(
      redirectUri ?? "",
      authUrl.searchParams.get("code_challenge") ?? "",
    );
    loopback.deliver({ code, state: state ?? "" });
    const done = await app.request(`/oauth/google/status?state=${state}`, { headers: auth });
    const outcome = (await done.json()) as {
      status: string;
      account: { id: string; provider: string; address: string; capabilities: { push: boolean } };
    };
    expect(outcome.status).toBe("done");
    expect(outcome.account).toMatchObject({
      provider: "gmail",
      address: fixture.address,
      capabilities: { push: true, labels: true },
    });
    gmailAccountId = outcome.account.id;

    const stored = await credentials.load(gmailAccountId);
    expect(stored.endpoint).toEqual({
      kind: "gmail",
      pubsubTopic: "projects/monday-test/topics/gmail",
    });
    expect(stored.auth.kind === "oauth" && stored.auth.client?.id).toBe(
      "1234-abc.apps.googleusercontent.com",
    );

    const list = await app.request("/accounts", { headers: auth });
    expect(await list.json()).toMatchObject({
      accounts: [{ id: gmailAccountId, provider: "gmail" }],
    });

    const classes = (await db.handle.db.select().from(jobsTable)).map(
      (j) => [j.class, j.needs] as const,
    );
    expect(classes).toContainEqual([SYNC_STEP, []]);
    expect(classes).toContainEqual([WATCH_STEP, ["needs-process"]]);
    expect(classes).toContainEqual([RECONCILE_STEP, []]);
    expect(classes).toContainEqual([GMAIL_WATCH_RENEW_STEP, []]);
    expect(classes).toContainEqual([GMAIL_PUSH_SUBSCRIBE_STEP, ["needs-public-url"]]);
  });

  test("the Microsoft wizard finishes through the explicit route and the state mismatch is refused", async () => {
    const started = await app.request(
      "/oauth/microsoft/start",
      json({ clientId: "12345678-1234-1234-1234-123456789abc", tenant: "consumers" }),
    );
    const { state, url, redirectUri } = (await started.json()) as Record<string, string>;
    expect(redirectUri).toBe("http://localhost:4242");
    const challenge = new URL(url ?? "").searchParams.get("code_challenge") ?? "";
    loopback.deliver({ error: "access_denied", error_description: "The user cancelled" });
    const cancelled = await app.request(`/oauth/microsoft/status?state=${state}`, {
      headers: auth,
    });
    expect(await cancelled.json()).toMatchObject({
      status: "error",
      message: "The user cancelled",
    });

    const again = await app.request(
      "/oauth/microsoft/start",
      json({ clientId: "12345678-1234-1234-1234-123456789abc", tenant: "consumers" }),
    );
    const second = (await again.json()) as Record<string, string>;
    const goodChallenge = new URL(second.url ?? "").searchParams.get("code_challenge") ?? "";
    expect(goodChallenge).not.toBe(challenge);
    const code = graph.issueCode("http://localhost:4242", goodChallenge);
    const finished = await app.request(
      "/oauth/microsoft/finish",
      json({ state: second.state, code }),
    );
    expect(finished.status).toBe(200);
    const body = (await finished.json()) as {
      account: { id: string; provider: string; capabilities: { push: boolean } };
    };
    expect(body.account).toMatchObject({
      provider: "graph",
      capabilities: { push: true, labels: false },
    });
    graphAccountId = body.account.id;
    const replay = await app.request(
      "/oauth/microsoft/finish",
      json({ state: second.state, code }),
    );
    expect(replay.status).toBe(401);
    expect((await app.request("/oauth/other/start", json({ clientId: "x" }))).status).toBe(404);
    const classes = (await db.handle.db.select().from(jobsTable))
      .filter((j) => (j.payload as { accountId?: string }).accountId === graphAccountId)
      .map((j) => j.class);
    expect(classes).toContain(GRAPH_SUBSCRIBE_STEP);
  });

  test("provider.gmail.watch-renew calls users.watch and records the expiration", async () => {
    const result = await runStep(GMAIL_WATCH_RENEW_STEP);
    expect(result).toEqual({ sleepMs: 24 * 3_600_000 });
    expect(gmail.watches.at(-1)?.topicName).toBe("projects/monday-test/topics/gmail");
    const state = await readPushState(db.handle.db, gmailAccountId);
    expect(state.gmail?.watchExpiration).toBeGreaterThan(Date.now());
    expect(state.gmail?.watchHistoryId).toBeDefined();
  });

  test("needs-public-url Jobs sleep without a public URL and register once there is one", async () => {
    publicUrl = null;
    expect(await runStep(GMAIL_PUSH_SUBSCRIBE_STEP)).toEqual({ sleepMs: NO_PUBLIC_URL_SLEEP_MS });
    expect(await runStep(GRAPH_SUBSCRIBE_STEP)).toEqual({ sleepMs: NO_PUBLIC_URL_SLEEP_MS });

    publicUrl = "https://monday.example";
    expect(await runStep(GMAIL_PUSH_SUBSCRIBE_STEP)).toEqual({ sleepMs: 24 * 3_600_000 });
    const gmailState = (await readPushState(db.handle.db, gmailAccountId)).gmail;
    expect(gmailState?.registeredBy).toBe("cloud-1");
    expect(gmailState?.pushSecret).toBeTruthy();
    const sub = gmail.subscriptions.get(gmailState?.pushSubscription ?? "");
    expect(sub).toMatchObject({
      pushConfig: {
        pushEndpoint: `https://monday.example/webhooks/gmail/${gmailAccountId}?secret=${gmailState?.pushSecret}`,
      },
    });

    expect(await runStep(GRAPH_SUBSCRIBE_STEP)).toEqual({ sleepMs: 72 * 3_600_000 });
    const graphState = (await readPushState(db.handle.db, graphAccountId)).graph;
    expect(graphState?.subscriptionId).toBeTruthy();
    expect(graphState?.registeredBy).toBe("cloud-1");
    expect(graph.subscriptions.get(graphState?.subscriptionId ?? "")).toMatchObject({
      notificationUrl: "https://monday.example/webhooks/graph",
      lifecycleNotificationUrl: "https://monday.example/webhooks/graph/lifecycle",
      clientState: graphState?.clientState,
      resource: "/me/messages",
    });

    // A second run well before expiry renews in place.
    expect(await runStep(GRAPH_SUBSCRIBE_STEP)).toEqual({ sleepMs: 72 * 3_600_000 });
    expect(graph.subscriptions.get(graphState?.subscriptionId ?? "")?.renewed).toBe(1);
    expect((await readPushState(db.handle.db, graphAccountId)).graph?.subscriptionId).toBe(
      graphState?.subscriptionId ?? "",
    );
  });

  test("the Gmail webhook checks the secret and wakes sync", async () => {
    const state = (await readPushState(db.handle.db, gmailAccountId)).gmail;
    const envelope = {
      message: {
        data: btoa(JSON.stringify({ emailAddress: fixture.address, historyId: 5 })),
        messageId: "1",
      },
      subscription: state?.pushSubscription,
    };
    const forbidden = await app.request(`/webhooks/gmail/${gmailAccountId}?secret=wrong`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    expect(forbidden.status).toBe(403);
    const before = await queuedSyncJobs(gmailAccountId);
    const ok = await app.request(`/webhooks/gmail/${gmailAccountId}?secret=${state?.pushSecret}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    expect(ok.status).toBe(204);
    expect(await queuedSyncJobs(gmailAccountId)).toBe(before + 1);
    // Someone else's address is acknowledged and ignored.
    const other = await app.request(
      `/webhooks/gmail/${gmailAccountId}?secret=${state?.pushSecret}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: { data: btoa(JSON.stringify({ emailAddress: "x@y.test", historyId: 6 })) },
        }),
      },
    );
    expect(other.status).toBe(204);
    expect(await queuedSyncJobs(gmailAccountId)).toBe(before + 1);
  });

  test("the Graph webhook answers the handshake, checks clientState, and lifecycle events reregister", async () => {
    const handshake = await app.request("/webhooks/graph?validationToken=abc%20def", {
      method: "POST",
    });
    expect(handshake.status).toBe(200);
    expect(handshake.headers.get("content-type")).toContain("text/plain");
    expect(await handshake.text()).toBe("abc def");

    const state = (await readPushState(db.handle.db, graphAccountId)).graph;
    const notify = (clientState: string) =>
      app.request("/webhooks/graph", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: [
            {
              subscriptionId: state?.subscriptionId,
              clientState,
              changeType: "created",
              resource: "Users/x/Messages/y",
              resourceData: { id: "y" },
            },
          ],
        }),
      });
    const before = await queuedSyncJobs(graphAccountId);
    expect((await notify("wrong")).status).toBe(202);
    expect(await queuedSyncJobs(graphAccountId)).toBe(before);
    expect((await notify(state?.clientState ?? "")).status).toBe(202);
    expect(await queuedSyncJobs(graphAccountId)).toBe(before + 1);

    const lifecycle = (event: string) =>
      app.request("/webhooks/graph/lifecycle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: [
            {
              subscriptionId: state?.subscriptionId,
              clientState: state?.clientState,
              lifecycleEvent: event,
              resource: "/me/messages",
            },
          ],
        }),
      });
    const subscribeJobs = async () =>
      (await db.handle.db.select().from(jobsTable)).filter(
        (j) => j.class === GRAPH_SUBSCRIBE_STEP && j.id.includes("lifecycle"),
      ).length;
    // "missed" means notifications were lost: a sync makes up for them.
    expect((await lifecycle("missed")).status).toBe(202);
    expect(await queuedSyncJobs(graphAccountId)).toBeGreaterThanOrEqual(before + 1);
    expect((await lifecycle("reauthorizationRequired")).status).toBe(202);
    expect(await subscribeJobs()).toBe(1);
    expect((await lifecycle("subscriptionRemoved")).status).toBe(202);
    expect((await readPushState(db.handle.db, graphAccountId)).graph?.subscriptionId).toBeNull();
    // A fresh subscribe Job is queued for a public-URL Server; running it creates a new subscription.
    expect(await runStep(GRAPH_SUBSCRIBE_STEP)).toEqual({ sleepMs: 72 * 3_600_000 });
    const fresh = (await readPushState(db.handle.db, graphAccountId)).graph;
    expect(fresh?.subscriptionId).toBeTruthy();
    expect(fresh?.subscriptionId).not.toBe(state?.subscriptionId);
    expect(handshake.status).toBe(200);
  });

  test("refreshed tokens are written back through the credential store", async () => {
    const stored = await credentials.load(gmailAccountId);
    if (stored.auth.kind !== "oauth") throw new Error("not oauth");
    const before = stored.auth.accessToken;
    gmail.expireNext = 1;
    await runStep(GMAIL_WATCH_RENEW_STEP);
    const after = await credentials.load(gmailAccountId);
    expect(after.auth.kind === "oauth" && after.auth.accessToken).toBe(gmail.accessToken);
    expect(gmail.accessToken).not.toBe(before);
    expect(refreshedAuths).toBeGreaterThanOrEqual(1);
  });

  test("removing an Account clears its credentials", async () => {
    const res = await app.request(`/accounts/${graphAccountId}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(res.status).toBe(204);
    await expect(credentials.load(graphAccountId)).rejects.toMatchObject({ code: "auth" });
    expect(
      (await app.request(`/accounts/${graphAccountId}`, { method: "DELETE", headers: auth }))
        .status,
    ).toBe(404);
  });
});
