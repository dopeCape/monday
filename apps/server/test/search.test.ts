// The Server side of search (ADR 0011): the headers-only Postgres index and
// the bulk body route, through the Mailstore and through the app.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, HeaderSearchPage, MessageBodiesPage } from "@monday/shared";
import type { Hono } from "hono";
import { type AppEnv, createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/index.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys, type Keys } from "../src/crypto/keys.ts";
import { createMailstore, headersTsQuery, type Mailstore } from "../src/mailstore/index.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const account: Account = {
  id: "acct-search",
  provider: "jmap",
  address: "tejas@genai-labs.io",
  displayName: "Tejas",
  capabilities: {
    push: true,
    labels: true,
    snooze: false,
    mute: false,
    calendar: false,
    meetingLink: null,
  },
};

const kenji = { name: "Kenji Watanabe", email: "kenji.w@meridianfund.co" };
const aoife = { name: "Aoife Brennan", email: "aoife@northlight.dev" };
const me = { name: "Tejas", email: "tejas@genai-labs.io" };

describe("server search", () => {
  let db: TestDatabase;
  let keys: Keys;
  let store: Mailstore;
  let app: Hono<AppEnv>;
  let workspaceId = "";
  const threadIds = { term: "", rust: "", old: "" };
  const SIDECAR_TOKEN = "per-launch-token";
  const root = randomKey();

  beforeAll(async () => {
    db = await testDatabase();
    keys = createKeys(db.handle.db);
    store = createMailstore(db.handle.db, keys);
    await keys.unlock(root);
    const auth = createAuth({ db: db.handle.db, sidecarToken: SIDECAR_TOKEN, setupCode: "111111" });
    app = createApp({
      db: db.handle.db,
      auth,
      mode: "sidecar",
      keys,
      mailstore: store,
      remoteAddress: () => "127.0.0.1",
    });
    workspaceId = (await store.createWorkspace(account)).id;

    const seed = async (
      key: keyof typeof threadIds,
      subject: string,
      from: { name: string; email: string },
      dates: string[],
      body: string,
    ) => {
      const threadId = await store.upsertThread({
        workspaceId,
        providerThreadId: key,
        subject,
        participants: [from, me],
        lastActivity: dates[dates.length - 1] ?? dates[0] ?? "",
      });
      threadIds[key] = threadId;
      for (const [i, date] of dates.entries()) {
        await store.upsertMessage({
          threadId,
          providerMessageId: `${key}-${i}`,
          from,
          to: [me],
          cc: [],
          date,
          headers: {},
          bodyText: `${body} (${i})`,
          bodyHtml: null,
          snippet: body.slice(0, 20),
        });
      }
    };
    await seed(
      "term",
      "Term sheet redline, v3",
      kenji,
      ["2026-09-16T08:15:00.000Z"],
      "the pro-rata clause",
    );
    await seed(
      "rust",
      "Re: Senior Rust engineer role",
      aoife,
      ["2026-09-14T14:02:00.000Z", "2026-09-16T09:41:00.000Z"],
      "take-home submitted",
    );
    await seed("old", "Quarterly numbers", aoife, ["2025-03-01T10:00:00.000Z"], "old numbers");
  }, 60_000);

  afterAll(async () => {
    await db.drop();
  });

  test("headersTsQuery prefix-matches every token and survives junk", () => {
    expect(headersTsQuery("Term she")).toBe("term:* & she:*");
    expect(headersTsQuery("kenji.w@meridianfund")).toBe("kenji:* & w:* & meridianfund:*");
    expect(headersTsQuery("  ")).toBe("");
    expect(headersTsQuery("!!! & | :*")).toBe("");
  });

  test("the headers index matches the subject prefix and participants without decrypting", async () => {
    const bySubject = await store.searchHeaders(workspaceId, { q: "term she", limit: 10 });
    expect(bySubject.hits.map((h) => h.threadId)).toEqual([threadIds.term]);
    expect(bySubject.hits[0]?.subjectSearch).toBe("term sheet redline, v3");
    expect(bySubject.hits[0]?.participants[0]).toEqual(kenji);
    expect(bySubject.hits[0]?.rank).toBeGreaterThan(0);

    const byName = await store.searchHeaders(workspaceId, { q: "aoife", limit: 10 });
    expect(new Set(byName.hits.map((h) => h.threadId))).toEqual(
      new Set([threadIds.rust, threadIds.old]),
    );
    // Newest activity first among equal ranks.
    expect(byName.hits[0]?.threadId).toBe(threadIds.rust);

    const byAddressPart = await store.searchHeaders(workspaceId, { q: "ridianfund", limit: 10 });
    expect(byAddressPart.hits.map((h) => h.threadId)).toEqual([threadIds.term]);

    expect((await store.searchHeaders(workspaceId, { q: "", limit: 10 })).hits).toEqual([]);
    expect((await store.searchHeaders(workspaceId, { q: "zzz", limit: 10 })).hits).toEqual([]);
    expect((await store.searchHeaders("other-ws", { q: "term", limit: 10 })).hits).toEqual([]);
    // Nothing in the index is body text.
    expect((await store.searchHeaders(workspaceId, { q: "pro-rata", limit: 10 })).hits).toEqual([]);
  });

  test("the headers index answers while locked", async () => {
    keys.lock();
    try {
      const r = await store.searchHeaders(workspaceId, { q: "rust", limit: 10 });
      expect(r.hits.map((h) => h.threadId)).toEqual([threadIds.rust]);
    } finally {
      await keys.unlock(root);
    }
  });

  test("bodies come back decrypted by date range, newest first, with a cursor", async () => {
    const all = await store.listBodies(workspaceId, { after: null, before: null, limit: 10 });
    expect(all.total).toBe(4);
    expect(all.cursor).toBeNull();
    expect(all.bodies.map((b) => b.date)).toEqual([
      "2026-09-16T09:41:00.000Z",
      "2026-09-16T08:15:00.000Z",
      "2026-09-14T14:02:00.000Z",
      "2025-03-01T10:00:00.000Z",
    ]);
    expect(all.bodies[1]).toMatchObject({
      threadId: threadIds.term,
      text: "the pro-rata clause (0)",
      html: null,
      snippet: "the pro-rata clause",
    });

    const page = await store.listBodies(workspaceId, {
      after: "2026-01-01T00:00:00.000Z",
      before: null,
      limit: 2,
    });
    expect(page.total).toBe(3);
    expect(page.bodies.length).toBe(2);
    expect(page.cursor).toBe("2026-09-16T08:15:00.000Z");
    const next = await store.listBodies(workspaceId, {
      after: "2026-01-01T00:00:00.000Z",
      before: page.cursor,
      limit: 2,
    });
    expect(next.bodies.map((b) => b.date)).toEqual(["2026-09-14T14:02:00.000Z"]);
    expect(next.cursor).toBeNull();
  });

  test("GET /search/headers and GET /messages/bodies over the app; bodies answer 423 when locked", async () => {
    const auth = { headers: { authorization: `Bearer ${SIDECAR_TOKEN}` } };
    const headers = await app.request(`/search/headers?workspace=${workspaceId}&q=term`, auth);
    expect(headers.status).toBe(200);
    const page = (await headers.json()) as HeaderSearchPage;
    expect(page.hits.map((h) => h.threadId)).toEqual([threadIds.term]);

    const bad = await app.request("/search/headers?q=term", auth);
    expect(bad.status).toBe(400);

    const bodies = await app.request(
      `/messages/bodies?workspace=${workspaceId}&after=2026-09-15T00:00:00.000Z&limit=5`,
      auth,
    );
    expect(bodies.status).toBe(200);
    const b = (await bodies.json()) as MessageBodiesPage;
    expect(b.total).toBe(2);
    expect(b.bodies.map((x) => x.threadId)).toEqual([threadIds.rust, threadIds.term]);

    const badDate = await app.request(
      `/messages/bodies?workspace=${workspaceId}&after=yesterday`,
      auth,
    );
    expect(badDate.status).toBe(400);

    keys.lock();
    try {
      const locked = await app.request(`/messages/bodies?workspace=${workspaceId}`, auth);
      expect(locked.status).toBe(423);
      expect(await locked.json()).toEqual({ error: "locked" });
      const stillHeaders = await app.request(
        `/search/headers?workspace=${workspaceId}&q=rust`,
        auth,
      );
      expect(stillHeaders.status).toBe(200);
    } finally {
      await keys.unlock(root);
    }
  });
});
