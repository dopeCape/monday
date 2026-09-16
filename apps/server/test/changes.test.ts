// The Changes feed and the write intents (slice 6): the changes table fills
// from Mailstore writes in order, /changes pages from a cursor, intents apply
// per-field last-writer-wins with the user beating automation, losers land in
// the Activity log, and the SSE stream wakes on insert through LISTEN/NOTIFY.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, Change, ChangesPage, IntentResult } from "@monday/shared";
import type { Hono } from "hono";
import { type AppEnv, createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/index.ts";
import { type ChangeBus, createChangeBus, listenForChanges } from "../src/changes/bus.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { type TestDatabase, testDatabase, waitFor } from "./harness.ts";

const SIDECAR_TOKEN = "per-launch-token";

const account: Account = {
  id: "acct-changes",
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

const T0 = "2026-09-16T10:00:00.000Z";
const T1 = "2026-09-16T10:01:00.000Z";
const T2 = "2026-09-16T10:02:00.000Z";

describe("changes feed and intents", () => {
  let db: TestDatabase;
  let store: Mailstore;
  let app: Hono<AppEnv>;
  let bus: ChangeBus;
  let listener: Awaited<ReturnType<typeof listenForChanges>>;
  let workspaceId = "";
  let threadId = "";
  let otherThreadId = "";

  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SIDECAR_TOKEN}`,
        ...(init.headers ?? {}),
      },
    });
  const post = (path: string, body: unknown, method = "POST") =>
    request(path, { method, body: JSON.stringify(body) });
  const feed = async (since = 0, limit = 500): Promise<ChangesPage> =>
    (await (
      await request(`/changes?workspace=${workspaceId}&since=${since}&limit=${limit}`)
    ).json()) as ChangesPage;

  beforeAll(async () => {
    db = await testDatabase();
    const keys = createKeys(db.handle.db);
    store = createMailstore(db.handle.db, keys);
    await keys.unlock(randomKey());
    bus = createChangeBus();
    listener = await listenForChanges(db.url, bus);
    const auth = createAuth({ db: db.handle.db, sidecarToken: SIDECAR_TOKEN });
    app = createApp({
      db: db.handle.db,
      auth,
      mode: "sidecar",
      keys,
      mailstore: store,
      changes: bus,
      sse: { heartbeatMs: 200, pollMs: 60_000 },
      remoteAddress: () => "127.0.0.1",
    });
    workspaceId = (await store.createWorkspace(account)).id;
  }, 60_000);

  afterAll(async () => {
    await listener.stop();
    await db.drop();
  });

  test("every Mailstore write appends a change row in seq order", async () => {
    threadId = await store.upsertThread({
      workspaceId,
      providerThreadId: "T1",
      subject: "Term sheet redline",
      participants: [{ name: "Kenji", email: "kenji@example.test" }],
      lastActivity: T0,
      unread: true,
    });
    const messageId = await store.upsertMessage({
      threadId,
      providerMessageId: "M1",
      from: { name: "Kenji", email: "kenji@example.test" },
      to: [{ name: "Tejas", email: "tejas@example.test" }],
      cc: [],
      date: T0,
      headers: {},
      bodyText: "Two changes from our side.",
      bodyHtml: null,
      snippet: "Two changes",
    });
    const tagId = await store.upsertTag(workspaceId, "investor");
    const labelId = await store.upsertLabel(workspaceId, { providerId: "INBOX", name: "Inbox" });
    await store.setTags(threadId, [tagId]);
    await store.setLabels(threadId, [labelId]);
    otherThreadId = await store.upsertThread({
      workspaceId,
      providerThreadId: "T2",
      subject: "Weekly digest",
      participants: [{ name: "Linear", email: "noreply@example.test" }],
      lastActivity: T0,
    });

    const page = await feed();
    const kinds = page.changes.map((c) => c.kind);
    expect(kinds).toEqual([
      "thread",
      "message",
      "thread",
      "tag",
      "label",
      "thread_tags",
      "thread_labels",
      "thread",
    ]);
    const seqs = page.changes.map((c) => c.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(page.cursor).toBe(seqs[seqs.length - 1] ?? 0);

    const message = page.changes[1] as Change & { kind: "message" };
    expect(message.entityId).toBe(messageId);
    expect(message.payload.threadId).toBe(threadId);
    expect(JSON.stringify(message.payload)).not.toContain("Two changes");

    const last = page.changes[page.changes.length - 1] as Change & { kind: "thread" };
    expect(last.payload.id).toBe(otherThreadId);
    expect(last.payload.subject).toBe("weekly digest");
    expect(last.payload.deleted).toBe(false);

    const links = page.changes[5] as Change & { kind: "thread_tags" };
    expect(links.payload).toEqual({ threadId, ids: [tagId] });
  });

  test("since pages from a cursor and limit caps a page", async () => {
    const all = await feed();
    const first = await feed(0, 3);
    expect(first.changes.length).toBe(3);
    expect(first.cursor).toBe(first.changes[2]?.seq ?? -1);
    const rest = await feed(first.cursor);
    expect(rest.changes.map((c) => c.seq)).toEqual(all.changes.slice(3).map((c) => c.seq));
    const nothing = await feed(all.cursor);
    expect(nothing.changes).toEqual([]);
    expect(nothing.cursor).toBe(all.cursor);
    expect(await store.latestSeq(workspaceId)).toBe(all.cursor);
    expect(await store.latestSeq("nowhere")).toBe(0);
  });

  test("a bad feed query is a 400 and the feed needs a token", async () => {
    expect((await request("/changes")).status).toBe(400);
    expect((await request(`/changes?workspace=${workspaceId}&since=-1`)).status).toBe(400);
    expect((await app.request(`/changes?workspace=${workspaceId}`)).status).toBe(401);
  });

  describe("last-writer-wins", () => {
    const apply = async (kind: string, at: string, actor: string, extra: object = {}) =>
      (await (
        await post(`/threads/${threadId}/${kind}`, { at, actor, ...extra })
      ).json()) as IntentResult;
    const row = async () => {
      const rows = await db.handle.sql`
        select archived, starred, unread, snoozed_until, group_id, subgroup_id, deleted, writes
        from threads where id = ${threadId}`;
      return rows[0] as {
        archived: boolean;
        starred: boolean;
        unread: boolean;
        snoozed_until: Date | null;
        group_id: string | null;
        subgroup_id: string | null;
        deleted: boolean;
        writes: Record<string, { at: string; by: string }>;
      };
    };

    test("a first write applies and stamps its field group", async () => {
      const before = await store.latestSeq(workspaceId);
      expect(await apply("archive", T1, "automation")).toEqual({ applied: true });
      const r = await row();
      expect(r.archived).toBe(true);
      expect(r.writes.archived).toEqual({ at: T1, by: "automation" });
      const page = await feed(before);
      expect(page.changes.length).toBe(1);
      expect(page.changes[0]?.kind).toBe("thread");
      expect((page.changes[0] as Change & { kind: "thread" }).payload.archived).toBe(true);
    });

    test("user beats automation whatever the clocks say", async () => {
      // Row: automation at T1. Intent: user at T0 (older). The user wins.
      expect(await apply("unarchive", T0, "user")).toEqual({ applied: true });
      const r = await row();
      expect(r.archived).toBe(false);
      expect(r.writes.archived).toEqual({ at: T0, by: "user" });
    });

    test("automation older than a user write loses and is logged", async () => {
      // Row: user at T0. Intent: automation at an earlier time. Loses.
      const result = await apply("archive", "2026-09-16T09:00:00.000Z", "automation");
      expect(result.applied).toBe(false);
      expect(result.reason).toContain("older than user write");
      expect((await row()).archived).toBe(false);
      const log = await db.handle.sql`select * from activity where workspace_id = ${workspaceId}`;
      expect(log.length).toBe(1);
      expect(log[0]).toMatchObject({ actor: "automation", tool: "thread.archive" });
      expect(String(log[0]?.summary)).toContain(threadId);
    });

    test("automation newer than a user write wins on time", async () => {
      expect(await apply("archive", T2, "automation")).toEqual({ applied: true });
      const r = await row();
      expect(r.archived).toBe(true);
      expect(r.writes.archived).toEqual({ at: T2, by: "automation" });
    });

    test("user older than a user write loses; the same instant replays", async () => {
      expect(await apply("star", T1, "user")).toEqual({ applied: true });
      const older = await apply("unstar", T0, "user");
      expect(older.applied).toBe(false);
      expect((await row()).starred).toBe(true);
      // A replayed intent (same at) is idempotent rather than a loser.
      expect(await apply("star", T1, "user")).toEqual({ applied: true });
      expect(await apply("unstar", T2, "user")).toEqual({ applied: true });
      expect((await row()).starred).toBe(false);
    });

    test("automation over automation is plain last-writer-wins", async () => {
      expect(await apply("read", T1, "automation")).toEqual({ applied: true });
      expect((await apply("unread", T0, "automation")).applied).toBe(false);
      expect((await row()).unread).toBe(false);
      expect(await apply("unread", T2, "automation")).toEqual({ applied: true });
      expect((await row()).unread).toBe(true);
    });

    test("field groups are independent: a move never contends with an archive", async () => {
      // archived was last written by automation at T2; a user move at T0 touches placement only.
      expect(await apply("move", T0, "user", { group: "hiring", subgroup: "candidates" })).toEqual({
        applied: true,
      });
      const r = await row();
      expect(r.group_id).toBe("hiring");
      expect(r.subgroup_id).toBe("candidates");
      expect(r.archived).toBe(true);
      expect(r.writes.placement).toEqual({ at: T0, by: "user" });
      expect(r.writes.archived).toEqual({ at: T2, by: "automation" });
    });

    test("snooze, unsnooze, delete and tags carry their arguments", async () => {
      const until = "2026-09-17T08:00:00.000Z";
      expect(await apply("snooze", T1, "user", { until })).toEqual({ applied: true });
      expect(new Date(String((await row()).snoozed_until)).toISOString()).toBe(until);
      expect(await apply("unsnooze", T2, "user")).toEqual({ applied: true });
      expect((await row()).snoozed_until).toBeNull();

      const tagA = await store.upsertTag(workspaceId, "a");
      const tagB = await store.upsertTag(workspaceId, "b");
      const before = await store.latestSeq(workspaceId);
      const tagged = (await (
        await post(
          `/threads/${threadId}/tags`,
          { at: T1, actor: "user", tags: [tagA, tagB, tagA] },
          "PUT",
        )
      ).json()) as IntentResult;
      expect(tagged).toEqual({ applied: true });
      const page = await feed(before);
      expect(page.changes.map((c) => c.kind)).toEqual(["thread_tags"]);
      expect((page.changes[0] as Change & { kind: "thread_tags" }).payload.ids).toEqual([
        tagA,
        tagB,
      ]);
      const listed = await store.listThreads(workspaceId, { limit: 10, includeArchived: true });
      expect(listed.threads.find((t) => t.id === threadId)?.tags).toEqual([tagA, tagB]);

      expect(await apply("delete", T1, "user")).toEqual({ applied: true });
      expect((await row()).deleted).toBe(true);
      const visible = await store.listThreads(workspaceId, { limit: 10, includeArchived: true });
      expect(visible.threads.map((t) => t.id)).toEqual([otherThreadId]);
    });

    test("a bad body is a 400 and an unknown thread is a 404", async () => {
      expect((await post(`/threads/${threadId}/archive`, { actor: "user" })).status).toBe(400);
      expect((await post(`/threads/${threadId}/snooze`, { at: T1, actor: "user" })).status).toBe(
        400,
      );
      expect((await post(`/threads/${threadId}/move`, { at: T1, actor: "user" })).status).toBe(400);
      expect((await post(`/threads/${threadId}/archive`, { at: T1, actor: "robot" })).status).toBe(
        400,
      );
      expect((await post("/threads/nope/archive", { at: T1, actor: "user" })).status).toBe(404);
    });
  });

  test("the SSE stream sends the current seq on connect and wakes on insert", async () => {
    const res = await request(`/changes/sse?workspace=${workspaceId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const decoder = new TextDecoder();
    let buffer = "";
    const events: number[] = [];
    const pump = async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (const m of buffer.matchAll(/data: (\{[^\n]*\})\n/g)) {
          const seq = (JSON.parse(m[1] ?? "{}") as { seq: number }).seq;
          if (!events.includes(seq)) events.push(seq);
        }
      }
    };
    const pumping = pump();

    const current = await store.latestSeq(workspaceId);
    await waitFor(() => events.length === 1);
    expect(events[0]).toBe(current);

    // A write anywhere in the Workspace reaches the stream through NOTIFY -> LISTEN -> bus.
    await store.upsertTag(workspaceId, "woken");
    const next = await store.latestSeq(workspaceId);
    expect(next).toBe(current + 1);
    await waitFor(() => events.includes(next));
    expect(events).toEqual([current, next]);

    // Keepalives arrive as comments, never as wake events.
    await new Promise((r) => setTimeout(r, 450));
    expect(buffer).toContain(": keepalive");
    expect(events.length).toBe(2);

    await reader.cancel();
    await pumping;
    await waitFor(() => bus.listenerCount(workspaceId) === 0);
  });
});
