// The Store-backed Inbox seam through the same interface actions.test.ts
// exercises over fixtures: every action is an intent applied to the Cache
// before the Server answers, undo reverses it, and the rows never flicker.

import { describe, expect, test } from "bun:test";
import { DEFAULT_SECTION_RULES } from "@monday/shared";
import { threads } from "@monday/ui/fixtures";
import { bunDriver } from "../../store/bun-driver.ts";
import { createFakeStore, type FakeStore } from "../../store/fake.ts";
import { fixtureSeed } from "../../store/seed.ts";
import { createStoreInbox, type StoreInbox } from "./store-inbox.ts";

const ids = () => threads.map((t) => t.id);
const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

async function open(): Promise<FakeStore & { inbox: StoreInbox }> {
  const fake = await createFakeStore({ driver: bunDriver(), backoff: { minMs: 5, maxMs: 20 } });
  const inbox = await createStoreInbox(fake.store);
  return { ...fake, inbox };
}

/** Waits until the seam has re-read the Cache after an intent. */
async function settled(inbox: StoreInbox, check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await tick();
  }
  throw new Error(`seam did not settle; inbox has ${inbox.threads().length} rows`);
}

describe("storeInbox", () => {
  test("starts with every fixture Thread newest first and hands out a stable array", async () => {
    const { inbox } = await open();
    expect(inbox.threads().map((t) => t.id)).toEqual(ids());
    expect(inbox.threads()).toBe(inbox.threads());
    expect(inbox.thread("e1")?.subject).toBe(threads[0]?.subject);
  });

  test("archive leaves the Inbox at once, reaches the Server, and undo restores it", async () => {
    const { inbox, store, server } = await open();
    let notified = 0;
    inbox.subscribe(() => notified++);
    const token = await inbox.archive(["e2"]);
    await settled(inbox, () => inbox.thread("e2")?.archived === true);
    expect(inbox.threads().map((t) => t.id)).not.toContain("e2");
    expect(notified).toBeGreaterThan(0);
    // Applied locally first: the Outbox holds it until sync.
    expect(await store.query("select kind, thread_id from outbox")).toEqual([
      { kind: "archive", thread_id: "e2" },
    ]);
    await store.sync();
    expect(server.threads.get("e2")?.archived).toBe(true);

    await inbox.undo(token);
    await settled(inbox, () => inbox.thread("e2")?.archived === false);
    expect(inbox.threads().map((t) => t.id)).toEqual(ids());
    await store.sync();
    expect(server.threads.get("e2")?.archived).toBe(false);
    expect(server.received.map((i) => i.kind)).toEqual(["archive", "unarchive"]);
  });

  test("snooze, delete, star, read and move each have an inverse", async () => {
    const { inbox } = await open();
    const until = new Date(2026, 8, 17, 8, 0);
    const snoozed = await inbox.snooze(["e3"], until);
    await settled(inbox, () => inbox.thread("e3")?.snoozedUntil === until.toISOString());
    expect(inbox.threads().map((t) => t.id)).not.toContain("e3");
    await inbox.undo(snoozed);
    await settled(inbox, () => inbox.thread("e3")?.snoozedUntil === null);
    expect(inbox.threads().map((t) => t.id)).toContain("e3");

    const deleted = await inbox.delete(["e4", "e5"]);
    await settled(inbox, () => !inbox.threads().some((t) => t.id === "e5"));
    expect(inbox.threads().map((t) => t.id)).not.toContain("e4");
    await inbox.undo(deleted);
    await settled(inbox, () => inbox.threads().some((t) => t.id === "e5"));
    expect(inbox.threads().map((t) => t.id)).toEqual(ids());

    const starred = await inbox.star(["e1"]);
    await settled(inbox, () => inbox.thread("e1")?.starred === true);
    await inbox.undo(starred);
    await settled(inbox, () => inbox.thread("e1")?.starred === false);

    const read = await inbox.markRead(["e1"]);
    await settled(inbox, () => inbox.thread("e1")?.unread === false);
    await inbox.undo(read);
    await settled(inbox, () => inbox.thread("e1")?.unread === true);
    await inbox.markUnread(["e6"]);
    await settled(inbox, () => inbox.thread("e6")?.unread === true);

    const before = inbox.thread("e1");
    const moved = await inbox.moveToGroup(["e1"], "finance");
    await settled(inbox, () => inbox.thread("e1")?.group === "finance");
    expect(inbox.thread("e1")?.subgroup).toBeNull();
    await inbox.undo(moved);
    await settled(inbox, () => inbox.thread("e1")?.group === before?.group);
    expect(inbox.thread("e1")?.subgroup).toBe(before?.subgroup ?? null);
  });

  test("unknown ids and used tokens are ignored", async () => {
    const { inbox, store } = await open();
    const token = await inbox.archive(["nope"]);
    expect(await store.query("select count(*) as n from outbox")).toEqual([{ n: 0 }]);
    await inbox.undo(token);
    await inbox.undo("never");
    const real = await inbox.archive(["e1"]);
    await inbox.undo(real);
    await inbox.undo(real);
    await settled(inbox, () => inbox.thread("e1")?.archived === false);
    expect(await store.query("select kind from outbox order by seq")).toEqual([
      { kind: "archive" },
      { kind: "unarchive" },
    ]);
  });

  test("a change from the Server reaches the seam", async () => {
    const { inbox, store, server } = await open();
    server.write({
      threadId: "e7",
      actor: "automation",
      at: "2026-09-16T10:00:00.000Z",
      patch: { archived: true },
    });
    await store.sync();
    await settled(inbox, () => inbox.thread("e7")?.archived === true);
    expect(inbox.threads().map((t) => t.id)).not.toContain("e7");
    inbox.close();
  });
});

describe("Section rules in the Store", () => {
  const owner = "tejas@genai-labs.io";
  const rules = () => DEFAULT_SECTION_RULES;
  const order = () => ["needs-reply", "waiting", "fyi", "newsletters"];

  test("Threads the Server left unsectioned land by the rules over state and the newest sender; a Server Section stays", async () => {
    const seed = fixtureSeed();
    // Strip the fixture's Sections from a few Threads so the rules decide them.
    seed.threads = seed.threads.map((t) =>
      ["e1", "e4", "e10", "e7"].includes(t.id)
        ? {
            ...t,
            section: null,
            ...(t.id === "e10" ? { bulk: true } : {}),
            ...(t.id === "e4" ? { messageCount: 5 } : {}),
          }
        : t,
    );
    const fake = await createFakeStore({ driver: bunDriver(), seed });
    const inbox = await createStoreInbox(fake.store, { sections: { rules, order, owner } });
    const section = (id: string) => inbox.thread(id)?.section;
    // e1: unread, Aoife wrote last.
    expect(section("e1")).toBe("needs-reply");
    // e4: read, five Messages, Mateus wrote last.
    expect(section("e4")).toBe("waiting");
    // e10: list mail.
    expect(section("e10")).toBe("newsletters");
    // e7: read, one Message: for your information.
    expect(section("e7")).toBe("fyi");
    // e2 kept the Section the seed gave it.
    expect(section("e2")).toBe(threads.find((t) => t.id === "e2")?.section);
    inbox.close();
  });

  test("resection applies changed rules without waiting for the Cache", async () => {
    const seed = fixtureSeed();
    seed.threads = seed.threads.map((t) => (t.id === "e1" ? { ...t, section: null } : t));
    const fake = await createFakeStore({ driver: bunDriver(), seed });
    let current = DEFAULT_SECTION_RULES;
    const inbox = await createStoreInbox(fake.store, {
      sections: { rules: () => current, order, owner },
    });
    expect(inbox.thread("e1")?.section).toBe("needs-reply");
    current = [{ id: "fyi", when: {} }];
    inbox.resection();
    expect(inbox.thread("e1")?.section).toBe("fyi");
    inbox.close();
  });
});
