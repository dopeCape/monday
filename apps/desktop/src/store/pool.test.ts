/// <reference types="bun-types" />
// The Store pool through its interface, with a fake open and connect: a
// Workspace opens once however often it is asked for, warming opens every one,
// a switch back finds it already open, a failure can be tried again, new mail
// is told with its Workspace, and closing stops every connection.

import { describe, expect, test } from "bun:test";
import { createStorePool } from "./pool.ts";
import type { NewMessage, Store } from "./store.ts";
import type { ContentTransport } from "./transport.ts";

function harness(options: { fail?: Set<string> } = {}) {
  const opened: string[] = [];
  const connected: string[] = [];
  const stopped: string[] = [];
  const closedStores: string[] = [];
  const hooks = new Map<string, (m: NewMessage[]) => void>();
  const pool = createStorePool({
    async open(workspaceId, h) {
      opened.push(workspaceId);
      hooks.set(workspaceId, h.onNewMessages);
      if (options.fail?.has(workspaceId)) throw new Error(`cannot open ${workspaceId}`);
      const store = {
        workspaceId,
        close: async () => {
          closedStores.push(workspaceId);
        },
      } as unknown as Store;
      return { store, content: {} as ContentTransport };
    },
    connect(store) {
      connected.push(store.workspaceId);
      return () => stopped.push(store.workspaceId);
    },
  });
  return { pool, opened, connected, stopped, closedStores, hooks };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe("the Store pool", () => {
  test("warming opens every Workspace once and keeps each connected; a switch finds it open", async () => {
    const h = harness();
    h.pool.warm(["ws-a", "ws-b"]);
    h.pool.acquire("ws-a");
    await settle();
    expect(h.opened).toEqual(["ws-a", "ws-b"]);
    expect(h.connected).toEqual(["ws-a", "ws-b"]);
    expect(h.pool.get("ws-b")?.status).toBe("open");
    // Switching away and back asks again: nothing reopens.
    h.pool.acquire("ws-b");
    h.pool.acquire("ws-a");
    await settle();
    expect(h.opened).toEqual(["ws-a", "ws-b"]);
  });

  test("a Workspace that fails says why and opens on Try again", async () => {
    const fail = new Set(["ws-x"]);
    const h = harness({ fail });
    h.pool.acquire("ws-x");
    await settle();
    expect(h.pool.get("ws-x")).toMatchObject({ status: "failed", error: "cannot open ws-x" });
    fail.clear();
    h.pool.retry("ws-x");
    await settle();
    expect(h.pool.get("ws-x")?.status).toBe("open");
  });

  test("new mail is told with its Workspace; a new Server target reconnects; close stops and closes all", async () => {
    const h = harness();
    const heard: string[] = [];
    h.pool.onNewMessages((ws, m) => heard.push(`${ws}:${m.length}`));
    h.pool.warm(["ws-a", "ws-b"]);
    await settle();
    h.hooks.get("ws-b")?.([
      {
        id: "m1",
        threadId: "t1",
        from: { name: "A", email: "a@x.test" },
        date: "2026-09-24T10:00:00Z",
      },
    ]);
    expect(heard).toEqual(["ws-b:1"]);
    h.pool.reconnect();
    expect(h.stopped).toEqual(["ws-a", "ws-b"]);
    expect(h.connected).toEqual(["ws-a", "ws-b", "ws-a", "ws-b"]);
    await h.pool.close();
    expect(h.closedStores.sort()).toEqual(["ws-a", "ws-b"]);
  });
});
