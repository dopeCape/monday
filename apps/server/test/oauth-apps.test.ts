// The OAuth app per provider (ADR 0008), app level: saved the moment the live
// check passes, the secret sealed under the root key and never returned by a
// route, sign-ins through the saved app with no fields, Remove forgets it,
// and a Server from before the store imports the app from an existing
// Account on the first read.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys, type Keys, LockedError } from "../src/crypto/keys.ts";
import { accounts, oauthApps, workspaces } from "../src/db/schema.ts";
import { createContentStore } from "../src/mailstore/content.ts";
import { createCredentialStore } from "../src/providers/credentials.ts";
import { generateFixture } from "../src/providers/fake/fixture.ts";
import {
  createMemoryOAuthAppStore,
  createOAuthAppStore,
  type LegacyOAuthApps,
  legacyFromAccounts,
} from "../src/providers/oauth/apps.ts";
import { createOAuthFlow } from "../src/providers/oauth/flow.ts";
import { oauthRoutes } from "../src/routes/oauth.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";
import { createGmailServer } from "./providers/gmail-server.ts";

const CLIENT = "1234-abc.apps.googleusercontent.com";
const SECRET = "GOCSPX-secret";

describe("the OAuth app store over Postgres", () => {
  let db: TestDatabase;
  let keys: Keys;

  beforeAll(async () => {
    db = await testDatabase();
    keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
  }, 60_000);

  afterAll(async () => {
    await db.drop();
  });

  test("seals the secret, lists without it, loads it in the clear only when unlocked", async () => {
    const store = createOAuthAppStore({ db: db.handle.db, keys });
    const view = await store.put("google", {
      clientId: ` ${CLIENT} `,
      clientSecret: SECRET,
      pubsubTopic: "projects/p/topics/monday-gmail",
    });
    expect(view).toMatchObject({ provider: "google", clientId: CLIENT, hasSecret: true });
    expect(JSON.stringify(view)).not.toContain(SECRET);
    const row = await db.handle.db.query.oauthApps.findFirst({
      where: eq(oauthApps.provider, "google"),
    });
    expect(row?.secretEnc).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(row?.secretEnc ?? new Uint8Array())).not.toContain(SECRET);
    expect(JSON.stringify(await store.get("google"))).not.toContain(SECRET);
    expect(await store.load("google")).toEqual({
      client: { id: CLIENT, secret: SECRET },
      pubsubTopic: "projects/p/topics/monday-gmail",
    });
    expect(await store.update("google", { pubsubTopic: "" })).toMatchObject({ pubsubTopic: null });

    keys.lock();
    // The view needs no key; the secret does.
    expect(await store.get("google")).toMatchObject({ clientId: CLIENT });
    await expect(store.load("google")).rejects.toBeInstanceOf(LockedError);

    expect(await store.remove("google")).toBe(true);
    expect(await store.get("google")).toBeNull();
    expect(await store.remove("google")).toBe(false);
  });

  test("an empty store imports the app an existing Account signed in through, once", async () => {
    let asked = 0;
    const legacy: LegacyOAuthApps = async (provider) => {
      asked++;
      return provider === "microsoft"
        ? {
            clientId: "12345678-1234-1234-1234-123456789abc",
            tenant: "consumers",
            accountType: "personal",
          }
        : null;
    };
    const store = createOAuthAppStore({ db: db.handle.db, keys, legacy });
    expect(await store.get("microsoft")).toMatchObject({
      clientId: "12345678-1234-1234-1234-123456789abc",
      tenant: "consumers",
      accountType: "personal",
      hasSecret: false,
    });
    await store.get("microsoft");
    expect(asked).toBe(1);
    expect(await store.get("google")).toBeNull();
  });

  test("the import reads the client out of a Gmail Account's sealed credentials", async () => {
    const h = db.handle.db;
    // The first test left the Server locked; no Workspace key exists yet, so any root opens it.
    if (!keys.isUnlocked()) await keys.unlock(randomKey());
    await h.insert(accounts).values({
      id: "acct-g",
      provider: "gmail",
      address: "me@gmail.test",
      capabilities: {
        push: true,
        labels: true,
        snooze: false,
        mute: false,
        calendar: false,
        meetingLink: null,
      },
    });
    await h.insert(workspaces).values({ id: "ws-g", accountId: "acct-g" });
    await keys.createWorkspaceKey("ws-g");
    const credentials = createCredentialStore(h, createContentStore(keys));
    await credentials.store("ws-g", "acct-g", {
      address: "me@gmail.test",
      auth: {
        kind: "oauth",
        user: "me@gmail.test",
        issuer: "google",
        accessToken: "at",
        client: { id: CLIENT, secret: SECRET },
      },
      endpoint: { kind: "gmail", pubsubTopic: "projects/p/topics/t" },
    });
    await h.delete(oauthApps);
    const store = createOAuthAppStore({ db: h, keys, legacy: legacyFromAccounts(h, credentials) });
    expect(await store.get("google")).toMatchObject({
      clientId: CLIENT,
      hasSecret: true,
      pubsubTopic: "projects/p/topics/t",
    });
    expect((await store.load("google"))?.client).toEqual({ id: CLIENT, secret: SECRET });
  });
});

/** The routes over the in-memory store and the fake Google endpoints. */
function harness(legacy?: LegacyOAuthApps) {
  const google = createGmailServer(generateFixture());
  const apps = createMemoryOAuthAppStore(legacy ? { legacy } : {});
  const routes = oauthRoutes({
    flow: createOAuthFlow({ fetch: google.fetch }),
    accounts: {
      list: async () => [],
      add: async () => {
        throw new Error("not in this test");
      },
      remove: async () => false,
    },
    fetch: google.fetch,
    apps,
  });
  const bodies: string[] = [];
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await routes.request(path, {
      method,
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
        : {}),
    });
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };
  return { call, bodies, apps };
}

describe("the OAuth app routes", () => {
  test("a failed check saves nothing; a passing one saves at once; no response carries the secret", async () => {
    const { call, bodies } = harness();
    expect((await call("GET", "/oauth/google/app")).json).toEqual({ app: null });

    const wrong = await call("PUT", "/oauth/google/app", {
      clientId: CLIENT,
      clientSecret: "wrong",
    });
    expect(wrong.json).toMatchObject({ result: { ok: false, field: "clientSecret" }, app: null });
    expect((await call("GET", "/oauth/google/app")).json).toEqual({ app: null });

    const saved = await call("PUT", "/oauth/google/app", {
      clientId: CLIENT,
      clientSecret: SECRET,
      projectId: "my-project",
    });
    expect(saved.json).toMatchObject({
      result: { ok: true },
      app: { clientId: CLIENT, hasSecret: true, projectId: "my-project" },
    });
    const topic = await call("PATCH", "/oauth/google/app", {
      pubsubTopic: "projects/my-project/topics/monday-gmail",
    });
    expect(topic.json).toMatchObject({
      app: { pubsubTopic: "projects/my-project/topics/monday-gmail" },
    });

    // A sign-in, failed or not, starts from the saved app with no fields.
    const first = await call("POST", "/oauth/google/start", {
      redirectUri: "http://127.0.0.1:5555/callback",
    });
    expect(first.status).toBe(200);
    expect(String(first.json.url)).toContain(`client_id=${encodeURIComponent(CLIENT)}`);
    const second = await call("POST", "/oauth/google/start", {
      redirectUri: "http://127.0.0.1:5556/callback",
    });
    expect(second.status).toBe(200);
    expect(second.json.state).not.toBe(first.json.state);

    expect((await call("DELETE", "/oauth/google/app")).status).toBe(204);
    expect((await call("GET", "/oauth/google/app")).json).toEqual({ app: null });
    const none = await call("POST", "/oauth/google/start", {
      redirectUri: "http://127.0.0.1:5557/callback",
    });
    expect(none).toMatchObject({ status: 400, json: { error: "no_app" } });
    expect((await call("DELETE", "/oauth/google/app")).status).toBe(404);

    for (const body of bodies) expect(body).not.toContain(SECRET);
  });

  test("an unknown provider is refused", async () => {
    const { call } = harness();
    expect((await call("GET", "/oauth/yahoo/app")).status).toBe(404);
    expect((await call("PUT", "/oauth/yahoo/app", { clientId: "x" })).status).toBe(404);
  });
});

describe("cancelling a sign-in", () => {
  test("Cancel closes the loopback listener, and a late redirect adds no Account", async () => {
    const google = createGmailServer(generateFixture());
    let deliver: (query: Record<string, string>) => void = () => {};
    let closed = 0;
    const added: unknown[] = [];
    const routes = oauthRoutes({
      flow: createOAuthFlow({ fetch: google.fetch }),
      accounts: {
        list: async () => [],
        add: async (input) => {
          added.push(input);
          throw new Error("no Account may be added");
        },
        remove: async () => false,
      },
      fetch: google.fetch,
      loopback: {
        open: async () => ({
          redirectUri: "http://127.0.0.1:5558/callback",
          callback: new Promise<Record<string, string>>((resolve) => {
            deliver = resolve;
          }),
          close: () => {
            closed += 1;
          },
        }),
      },
      statusWaitMs: 10,
    });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await routes.request(path, {
        method,
        ...(body !== undefined
          ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
          : {}),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };

    const started = await call("POST", "/oauth/google/start", {
      clientId: CLIENT,
      clientSecret: SECRET,
    });
    const state = String(started.json.state);
    expect((await call("GET", `/oauth/google/status?state=${state}`)).json).toEqual({
      status: "pending",
    });

    expect((await call("POST", "/oauth/google/cancel", { state })).json).toEqual({
      status: "cancelled",
    });
    expect(closed).toBeGreaterThan(0);
    expect((await call("GET", `/oauth/google/status?state=${state}`)).json).toEqual({
      status: "cancelled",
    });

    // The browser finishes anyway: nothing is added, by the listener or by /finish.
    deliver({ code: "late-code", state });
    await Bun.sleep(20);
    expect(added).toHaveLength(0);
    expect((await call("GET", `/oauth/google/status?state=${state}`)).json).toEqual({
      status: "cancelled",
    });
    const finish = await call("POST", "/oauth/google/finish", { state, code: "late-code" });
    expect(finish.status).toBe(409);
    expect(added).toHaveLength(0);

    expect((await call("POST", "/oauth/google/cancel", { state: "nope" })).status).toBe(404);
  });
});
