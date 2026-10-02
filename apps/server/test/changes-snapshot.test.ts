// The snapshot a new Cache fills from (GET /changes/snapshot): the newest
// Threads first, paged backwards by last activity, each as the feed rows that
// say what it is now: the newest row per full-state kind and entity, every
// row of the kinds that add answers, Messages that moved away left out, and
// the Workspace's names on the first page only.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, Change, ChangesSnapshot } from "@monday/shared";
import type { Hono } from "hono";
import { type AppEnv, createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/index.ts";
import { createChangeBus } from "../src/changes/bus.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const TOKEN = "snapshot-token";

const account: Account = {
  id: "acct-snapshot",
  provider: "jmap",
  address: "tejas@example.test",
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

const at = (day: number) => `2026-09-${String(day).padStart(2, "0")}T10:00:00.000Z`;

describe("the changes snapshot", () => {
  let db: TestDatabase;
  let store: Mailstore;
  let app: Hono<AppEnv>;
  let workspaceId = "";
  const threadIds: string[] = [];
  const messageIds: string[] = [];
  const t = (i: number) => threadIds[i] as string;
  const m = (i: number) => messageIds[i] as string;

  const snapshot = async (query = ""): Promise<ChangesSnapshot> => {
    const res = await app.request(`/changes/snapshot?workspace=${workspaceId}${query}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as ChangesSnapshot;
  };
  const of = (s: ChangesSnapshot, kind: Change["kind"]) => s.changes.filter((c) => c.kind === kind);

  beforeAll(async () => {
    db = await testDatabase();
    const keys = createKeys(db.handle.db);
    store = createMailstore(db.handle.db, keys);
    await keys.unlock(randomKey());
    app = createApp({
      db: db.handle.db,
      auth: createAuth({ db: db.handle.db, sidecarToken: TOKEN }),
      mode: "sidecar",
      keys,
      mailstore: store,
      changes: createChangeBus(),
      remoteAddress: () => "127.0.0.1",
    });
    workspaceId = (await store.createWorkspace(account)).id;
    // Five Threads, one a day: the fifth is the newest.
    for (let day = 1; day <= 5; day++) {
      const threadId = await store.upsertThread({
        workspaceId,
        providerThreadId: `T${day}`,
        subject: `Thread ${day}`,
        participants: [{ name: "Kenji", email: "kenji@example.test" }],
        lastActivity: at(day),
      });
      threadIds.push(threadId);
      messageIds.push(
        await store.upsertMessage({
          threadId,
          providerMessageId: `M${day}`,
          from: { name: "Kenji", email: "kenji@example.test" },
          to: [{ name: "Tejas", email: "tejas@example.test" }],
          cc: [],
          date: at(day),
          headers: {},
          bodyText: `Body ${day}`,
          bodyHtml: null,
          snippet: `Body ${day}`,
        }),
      );
    }
    const tagId = await store.upsertTag(workspaceId, "investor");
    const newest = t(4) as string;
    // The newest Thread changes twice more: only its last header row counts.
    await store.setTags(newest, [tagId]);
    await store.upsertThread({
      workspaceId,
      providerThreadId: "T5",
      subject: "Thread 5",
      participants: [{ name: "Kenji", email: "kenji@example.test" }],
      lastActivity: at(6),
      unread: true,
    });
    // Answers arrive in two rows; both are carried.
    for (const signalId of ["needs_reply", "urgency"]) {
      await store.recordChange(db.handle.db, {
        workspaceId,
        kind: "signals",
        entityId: newest,
        payload: {
          threadId: newest,
          answers: [
            {
              signalId,
              version: 1,
              noul: 0.9,
              choice: null,
              score: null,
              confidence: null,
              stale: false,
              lowTrust: null,
              judgedAt: at(6),
            },
          ],
        },
      });
    }
    // The fourth Thread's Message moved to the first Thread (a fold): it is not the fourth's any more.
    const moved = m(3) as string;
    await store.recordChange(db.handle.db, {
      workspaceId,
      kind: "message",
      entityId: moved,
      payload: {
        id: moved,
        threadId: t(0) as string,
        from: { name: "Kenji", email: "kenji@example.test" },
        to: [],
        cc: [],
        date: at(4),
        hasAttachments: false,
      },
    });
  }, 60_000);

  afterAll(async () => {
    await db.drop();
  });

  test("the first page is the newest Threads as they are now, in feed order", async () => {
    const s = await snapshot("&limit=2");
    expect(s.threads).toEqual([t(4), t(3)]);
    expect(s.head).toBe(await store.latestSeq(workspaceId));
    expect(s.before).not.toBeNull();
    const seqs = s.changes.map((c) => c.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    // One header row per Thread: the newest, which says unread and the sixth.
    const headers = of(s, "thread");
    expect(headers.map((c) => c.entityId).sort()).toEqual([t(4), t(3)].sort() as string[]);
    const newest = headers.find((c) => c.entityId === t(4)) as Change & { kind: "thread" };
    expect(newest.payload.unread).toBe(true);
    expect(newest.payload.lastActivity).toBe(at(6));
    expect(of(s, "thread_tags").map((c) => c.entityId)).toEqual([t(4) as string]);
    expect(of(s, "signals")).toHaveLength(2);
    // The fifth Thread's Message is here; the fourth's moved away, so it is not.
    expect(of(s, "message").map((c) => c.entityId)).toEqual([m(4) as string]);
    // The Workspace's names come with the first page.
    expect(of(s, "tag")).toHaveLength(1);
  });

  test("the next page goes back in time, without the Workspace's names", async () => {
    const first = await snapshot("&limit=2");
    const second = await snapshot(`&limit=2&before=${first.before}`);
    expect(second.threads).toEqual([t(2), t(1)]);
    expect(of(second, "tag")).toHaveLength(0);
    const third = await snapshot(`&limit=2&before=${second.before}`);
    expect(third.threads).toEqual([t(0)]);
    expect(third.before).toBeNull();
    // The moved Message is the first Thread's now, at its newest row.
    const messages = of(third, "message").map((c) => c.entityId);
    expect(messages.sort()).toEqual([m(0), m(3)].sort() as string[]);
  });

  test("a bad cursor is a 400", async () => {
    const res = await app.request(`/changes/snapshot?workspace=${workspaceId}&before=%%%`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
  });
});
