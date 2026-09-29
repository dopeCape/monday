// Recommended actions in the Store (docs/spec/actions.md) over the fake
// Server: the feed row carries headers only and the same sync warms the
// actions into the Cache, so a row's hover chip reads the Cache and never
// waits; a newer computation replaces them; the reader's open asks once and
// caches the answer; a removal drops the row.

import { describe, expect, test } from "bun:test";
import type { ThreadRecommendations } from "@monday/shared";
import { createStoreInbox } from "../screens/inbox/store-inbox.ts";
import { bunDriver } from "./bun-driver.ts";
import { createFakeStore, type FakeStore } from "./fake.ts";
import { rowToCachedThread, threadsByIdsSql } from "./queries.ts";
import { fixtureSeed } from "./seed.ts";

async function open(): Promise<FakeStore> {
  return createFakeStore({
    driver: bunDriver(),
    seed: fixtureSeed(),
    backoff: { minMs: 5, maxMs: 20 },
  });
}

const recs = (threadId: string, computedAt: string, email: string): ThreadRecommendations => ({
  threadId,
  messageCount: 3,
  latestMessageId: "m",
  computedAt,
  fromDomain: "northlight.dev",
  actions: [
    { kind: "forward", fit: 0.9, rank: 0.9, to: { name: "", email }, confidence: 0.9 },
    { kind: "reply", fit: 0.8, rank: 0.8 },
  ],
});

const row = async (store: FakeStore["store"], id: string) => {
  const rows = await store.query(threadsByIdsSql(1), [id]);
  const r = rows[0];
  return r ? rowToCachedThread(r, store.workspaceId).recommendations : null;
};

describe("Recommended actions in the Cache", () => {
  test("the seed carries the fixture chips; a feed row lands as headers and the same sync warms the actions", async () => {
    const { store, server } = await open();
    expect((await row(store, "e1"))?.actions.map((a) => a.kind)).toEqual(["reply", "forward"]);
    server.putRecommendations(recs("e1", "2026-09-29T10:00:00.000Z", "accounts@monday.test"));
    // The feed never carries the arguments.
    expect(JSON.stringify(server.changes)).not.toContain("accounts@monday.test");
    await store.sync();
    const held = await row(store, "e1");
    expect(held?.actions.map((a) => a.kind)).toEqual(["forward", "reply"]);
    expect(held?.actions[0]).toMatchObject({ to: { email: "accounts@monday.test" } });
    expect(held?.fromDomain).toBe("northlight.dev");
    const stale = await store.query(
      "select content_stale from thread_recommendations where thread_id = 'e1'",
    );
    expect(stale).toEqual([{ content_stale: 0 }]);
  });

  test("offline, the old actions stay until the fetch replaces them", async () => {
    const { store, server } = await open();
    server.putRecommendations(recs("e2", "2026-09-29T10:00:00.000Z", "a@monday.test"));
    await store.sync();
    server.putRecommendations(recs("e2", "2026-09-29T11:00:00.000Z", "b@monday.test"));
    server.offline = true;
    expect(await store.warmRecommendations()).toBe(0);
    expect((await row(store, "e2"))?.actions[0]).toMatchObject({ to: { email: "a@monday.test" } });
    server.offline = false;
    await store.sync();
    expect((await row(store, "e2"))?.actions[0]).toMatchObject({ to: { email: "b@monday.test" } });
  });

  test("the reader's open asks the Server and the answer reaches the reader seam", async () => {
    const { store, server, content } = await open();
    const inbox = await createStoreInbox(store, { content });
    server.recommendations.set("e3", recs("e3", "2026-09-29T12:00:00.000Z", "c@monday.test"));
    await inbox.askRecommendations?.("e3", "Europe/Dublin");
    expect(server.recommendationOpens).toEqual(["e3"]);
    const cached = await row(store, "e3");
    expect(cached?.actions[0]).toMatchObject({ to: { email: "c@monday.test" } });
    inbox.close();
  });
});
