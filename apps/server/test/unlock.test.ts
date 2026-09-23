import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, Thread } from "@monday/shared";
import type { Hono } from "hono";
import { type AppEnv, createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/index.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys, encodeKey, type Keys } from "../src/crypto/keys.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { RECOVERY_FILE_NAME } from "../src/routes/unlock.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const SIDECAR_TOKEN = "per-launch-token";
const auth = (extra: RequestInit = {}): RequestInit => ({
  ...extra,
  headers: { authorization: `Bearer ${SIDECAR_TOKEN}`, ...(extra.headers ?? {}) },
});
const post = (body: unknown): RequestInit =>
  auth({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const account: Account = {
  id: "acct-1",
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

describe("key provisioning over HTTP", () => {
  let db: TestDatabase;
  let keys: Keys;
  let store: Mailstore;
  let app: Hono<AppEnv>;
  const root = randomKey();
  let workspaceId = "";
  let threadId = "";
  let messageId = "";
  let attachmentId = "";

  beforeAll(async () => {
    db = await testDatabase();
    keys = createKeys(db.handle.db);
    store = createMailstore(db.handle.db, keys);
    app = createApp({
      db: db.handle.db,
      auth: createAuth({ db: db.handle.db, sidecarToken: SIDECAR_TOKEN }),
      mode: "sidecar",
      keys,
      mailstore: store,
      remoteAddress: () => "127.0.0.1",
    });

    // Seed through the Mailstore while unlocked, then lock: the "restart while
    // the laptop is closed" state.
    await keys.unlock(root);
    workspaceId = (await store.createWorkspace(account)).id;
    threadId = await store.upsertThread({
      workspaceId,
      providerThreadId: "T1",
      subject: "Lunch on Thursday?",
      participants: [{ name: "Aoife", email: "aoife@example.test" }],
      lastActivity: "2026-09-10T12:00:00.000Z",
    });
    messageId = await store.upsertMessage({
      threadId,
      providerMessageId: "M1",
      from: { name: "Aoife", email: "aoife@example.test" },
      to: [{ name: "Me", email: "me@example.test" }],
      cc: [],
      date: "2026-09-10T12:00:00.000Z",
      headers: {},
      bodyText: "Thursday works for me.",
      bodyHtml: null,
      snippet: "Thursday works",
    });
    attachmentId = await store.putAttachment(messageId, {
      name: "menu.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("soup, bread"),
    });
    keys.lock();
  }, 60_000);

  afterAll(async () => {
    await db.drop();
  });

  test("unlock, lock and recovery need a principal", async () => {
    expect((await app.request("/unlock", { method: "POST" })).status).toBe(401);
    expect((await app.request("/lock", { method: "POST" })).status).toBe(401);
    expect((await app.request("/recovery")).status).toBe(401);
    expect((await app.request(`/messages/${messageId}/body`)).status).toBe(401);
  });

  test("a locked server reports it, serves headers, and 423s every content read", async () => {
    const caps = (await (await app.request("/capabilities")).json()) as { unlocked: boolean };
    expect(caps.unlocked).toBe(false);

    const list = await app.request(`/threads?workspace=${workspaceId}&limit=10`, auth());
    expect(list.status).toBe(200);
    const page = (await list.json()) as { threads: Thread[]; cursor: string | null };
    expect(page.threads).toHaveLength(1);
    expect(page.threads[0]).toMatchObject({
      id: threadId,
      subject: "lunch on thursday?",
      snippet: "",
      messageCount: 1,
      hasAttachments: true,
    });

    for (const path of [
      `/messages/${messageId}/body`,
      `/threads/${threadId}/subject`,
      `/attachments/${attachmentId}`,
      "/recovery",
    ]) {
      const res = await app.request(path, auth());
      expect(res.status).toBe(423);
      expect(await res.json()).toEqual({ error: "locked" });
    }
  });

  test("bad and wrong root keys are refused without unlocking", async () => {
    const short = await app.request("/unlock", post({ rootKey: encodeKey(new Uint8Array(8)) }));
    expect(short.status).toBe(400);
    const junk = await app.request("/unlock", post({ rootKey: "***" }));
    expect(junk.status).toBe(400);
    const wrong = await app.request("/unlock", post({ rootKey: encodeKey(randomKey()) }));
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toEqual({ error: "wrong_root_key" });
    expect(keys.isUnlocked()).toBe(false);
  });

  test("unlock via the endpoint makes content readable and the recovery file downloadable", async () => {
    const res = await app.request("/unlock", post({ rootKey: encodeKey(root) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unlocked: true });
    const caps = (await (await app.request("/capabilities")).json()) as { unlocked: boolean };
    expect(caps.unlocked).toBe(true);

    const body = await app.request(`/messages/${messageId}/body`, auth());
    expect(body.status).toBe(200);
    expect(await body.json()).toEqual({
      text: "Thursday works for me.",
      html: null,
      snippet: "Thursday works",
      bodyState: "fetched",
      display: { html: "<p>Thursday works for me.</p>", quoted: false, blockedImages: 0 },
    });
    const subject = await app.request(`/threads/${threadId}/subject`, auth());
    expect(await subject.json()).toEqual({ subject: "Lunch on Thursday?" });

    const attachment = await app.request(`/attachments/${attachmentId}`, auth());
    expect(attachment.status).toBe(200);
    expect(attachment.headers.get("content-type")).toBe("text/plain");
    expect(attachment.headers.get("content-disposition")).toContain("menu.txt");
    expect(await attachment.text()).toBe("soup, bread");

    const recovery = await app.request("/recovery", auth());
    expect(recovery.status).toBe(200);
    expect(recovery.headers.get("content-type")).toContain("text/plain");
    expect(recovery.headers.get("content-disposition")).toContain(RECOVERY_FILE_NAME);
    expect(recovery.headers.get("cache-control")).toBe("no-store");
    const lines = (await recovery.text()).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("monday root key");
    expect(lines[1]).toBe(encodeKey(root));

    const missing = await app.request("/messages/nope/body", auth());
    expect(missing.status).toBe(404);
  });

  test("lock drops the key again", async () => {
    const res = await app.request("/lock", auth({ method: "POST" }));
    expect(await res.json()).toEqual({ unlocked: false });
    expect((await app.request(`/messages/${messageId}/body`, auth())).status).toBe(423);
    const caps = (await (await app.request("/capabilities")).json()) as { unlocked: boolean };
    expect(caps.unlocked).toBe(false);
  });

  test("createApp without a key holder starts locked", async () => {
    const bare = createApp({
      db: db.handle.db,
      auth: createAuth({ db: db.handle.db, sidecarToken: SIDECAR_TOKEN }),
      mode: "container",
    });
    const caps = (await (await bare.request("/capabilities")).json()) as { unlocked: boolean };
    expect(caps.unlocked).toBe(false);
  });
});
