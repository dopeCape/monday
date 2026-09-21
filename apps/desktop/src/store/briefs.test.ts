// Briefs in the Store (slice 13) over the fake Server: a brief feed row
// carries headers only and the Store warms the content into the Cache on
// the same sync, a stale flag dims without dropping the bullets, a newer
// Brief replaces them, and a removal drops the row.

import { describe, expect, test } from "bun:test";
import type { Brief } from "@monday/shared";
import { briefOf } from "@monday/ui/fixtures";
import { bunDriver } from "./bun-driver.ts";
import { createFakeStore, type FakeStore } from "./fake.ts";
import { BRIEF_OF_THREAD_SQL, rowToBrief } from "./queries.ts";
import { fixtureSeed } from "./seed.ts";
import { cachedBriefStatements, changeStatements } from "./store.ts";

async function open(seed: "fixtures" | "empty" = "fixtures"): Promise<FakeStore> {
  return createFakeStore({
    driver: bunDriver(),
    seed: seed === "fixtures" ? fixtureSeed() : null,
    backoff: { minMs: 5, maxMs: 20 },
  });
}

const cached = async (store: FakeStore["store"], threadId: string) => {
  const row = (await store.query(BRIEF_OF_THREAD_SQL, [threadId]))[0];
  return row ? { brief: rowToBrief(row), row } : null;
};

const brief = (threadId: string, text: string, computedAt: string, stale = false): Brief => ({
  threadId,
  bullets: [[text]],
  actions: [{ kind: "archive", label: "Archive" }],
  computedAt,
  stale,
});

describe("briefs in the Cache", () => {
  test("the seed carries every fixture Brief with its Thread version", async () => {
    const { store } = await open();
    const e1 = await cached(store, "e1");
    expect(e1?.brief).toEqual(briefOf("e1") ?? null);
    expect(e1?.row.message_count).toBe(3);
    expect(e1?.row.content_stale).toBe(0);
  });

  test("a brief feed row lands as headers and the same sync warms its content from the Server", async () => {
    const { store, server } = await open("empty");
    server.threads.set("t1", {
      id: "t1",
      workspaceId: store.workspaceId,
      subject: "",
      participants: [],
      lastActivity: "2026-09-17T09:00:00.000Z",
      messageCount: 2,
      unread: true,
      starred: false,
      archived: false,
      deleted: false,
      snoozedUntil: null,
      section: null,
      group: null,
      subgroup: null,
      tags: [],
      labels: [],
      hasAttachments: false,
      snippet: "",
      writes: {},
    });
    server.putBrief(brief("t1", "Aoife wants an answer.", "2026-09-17T09:05:00.000Z"));
    // The feed never carries bullets.
    expect(JSON.stringify(server.changes)).not.toContain("Aoife wants");
    const result = await store.sync();
    expect(result.pulled).toBe(1);
    const t1 = await cached(store, "t1");
    expect(t1?.row.content_stale).toBe(0);
    expect(t1?.row.message_count).toBe(2);
    expect(t1?.brief?.bullets).toEqual([["Aoife wants an answer."]]);
    expect(t1?.brief?.stale).toBe(false);
  });

  test("a stale flag keeps the bullets and dims them; a newer Brief replaces them", async () => {
    const { store, server } = await open("empty");
    server.putBrief(brief("t2", "First take.", "2026-09-17T09:00:00.000Z"), 1);
    await store.sync();
    server.staleBrief("t2");
    await store.sync();
    const dimmed = await cached(store, "t2");
    expect(dimmed?.brief?.stale).toBe(true);
    expect(dimmed?.brief?.bullets).toEqual([["First take."]]);
    expect(dimmed?.row.content_stale).toBe(0);

    server.putBrief(brief("t2", "Second take.", "2026-09-17T09:30:00.000Z"), 2);
    await store.sync();
    const fresh = await cached(store, "t2");
    expect(fresh?.brief?.stale).toBe(false);
    expect(fresh?.brief?.bullets).toEqual([["Second take."]]);
    expect(fresh?.row.message_count).toBe(2);
  });

  test("while the Server is unreachable the row waits with its old bullets, dimmed, and warms on the next sync", async () => {
    const { store, server } = await open("empty");
    server.putBrief(brief("t3", "Old.", "2026-09-17T09:00:00.000Z"), 1);
    await store.sync();
    server.putBrief(brief("t3", "New.", "2026-09-17T10:00:00.000Z"), 2);
    // The feed row lands; the content fetch is refused.
    const pulled = await store.sync();
    expect(pulled.pulled).toBe(1);
    server.offline = true;
    await store.write([{ sql: "update briefs set content_stale = 1 where thread_id = 't3'" }]);
    expect(await store.warmBriefs()).toBe(0);
    const waiting = await cached(store, "t3");
    expect(waiting?.brief?.stale).toBe(true);
    expect(waiting?.brief?.bullets).toEqual([["New."]]);
    server.offline = false;
    expect(await store.warmBriefs()).toBe(1);
    expect((await cached(store, "t3"))?.brief?.stale).toBe(false);
  });

  test("a removal drops the row, and a Brief the Server no longer has is dropped when warmed", async () => {
    const { store, server } = await open();
    server.removeBrief("e1");
    await store.sync();
    expect(await cached(store, "e1")).toBeNull();
    await store.write(cachedBriefStatements(brief("gone", "x", "2026-09-17T09:00:00.000Z")));
    await store.write([{ sql: "update briefs set content_stale = 1 where thread_id = 'gone'" }]);
    await store.warmBriefs();
    expect(await cached(store, "gone")).toBeNull();
  });

  test("a Brief with verdicts keeps them through the Cache: stored beside the bullets, read back per bullet (slice 27)", async () => {
    const seed = briefOf("e1");
    if (!seed) throw new Error("no fixture Brief");
    const brief: Brief = {
      ...seed,
      bullets: seed.bullets.slice(0, 2),
      verified: ["supported", "partly"],
    };
    const [statement] = cachedBriefStatements(brief);
    expect(statement?.params[1]).toEqual({
      bullets: brief.bullets,
      verified: ["supported", "partly"],
    });
    const { store } = await open();
    await store.write(cachedBriefStatements(brief));
    const read = await cached(store, "e1");
    expect(read?.brief?.bullets).toEqual(brief.bullets);
    expect(read?.brief?.verified).toEqual(["supported", "partly"]);
    // A Brief without verdicts is stored as the bullets alone, as before.
    const [plain] = cachedBriefStatements(seed);
    expect(plain?.params[1]).toEqual(seed.bullets);
  });

  test("the brief Change statements: insert with headers only, keep content on a stale flip, delete", () => {
    const payload = {
      threadId: "t",
      computedAt: "2026-09-17T09:00:00.000Z",
      stale: true,
      messageCount: 4,
      deleted: false,
    };
    const base = { seq: 1, workspaceId: "ws", entityId: "t", at: "2026-09-17T09:00:00.000Z" };
    const [upsert] = changeStatements({ ...base, kind: "brief", payload });
    expect(upsert?.sql).toContain("insert into briefs");
    expect(upsert?.params).toEqual(["t", payload.computedAt, true, 4]);
    const [remove] = changeStatements({
      ...base,
      kind: "brief",
      payload: { ...payload, deleted: true },
    });
    expect(remove?.sql).toBe("delete from briefs where thread_id = ?");
  });
});
