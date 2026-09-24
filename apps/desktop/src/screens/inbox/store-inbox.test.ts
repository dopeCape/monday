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

  test("undo of a mixed batch restores only the Threads the action changed", async () => {
    const { inbox, store } = await open();
    // e1 is unread, e3 is read: mark both read, undo, and e3 must stay read.
    expect(inbox.thread("e1")?.unread).toBe(true);
    expect(inbox.thread("e3")?.unread).toBe(false);
    const token = await inbox.markRead(["e1", "e3"]);
    await settled(inbox, () => inbox.thread("e1")?.unread === false);
    await inbox.undo(token);
    await settled(inbox, () => inbox.thread("e1")?.unread === true);
    expect(inbox.thread("e3")?.unread).toBe(false);
    expect(await store.query("select kind, thread_id from outbox order by seq")).toEqual([
      { kind: "read", thread_id: "e1" },
      { kind: "read", thread_id: "e3" },
      { kind: "unread", thread_id: "e1" },
    ]);
    // The same for stars: e2 is starred already.
    const starred = await inbox.star(["e1", "e2"]);
    await settled(inbox, () => inbox.thread("e1")?.starred === true);
    await inbox.undo(starred);
    await settled(inbox, () => inbox.thread("e1")?.starred === false);
    expect(inbox.thread("e2")?.starred).toBe(true);
  });

  test("the seam hands out the Workspace's Groups and Tags from the Cache", async () => {
    const { inbox } = await open();
    expect(inbox.groups().map((g) => g.id)).toContain("hiring");
    expect(inbox.groups().find((g) => g.id === "candidates")?.parentId).toBe("hiring");
    expect(inbox.tags().find((t) => t.id === "candidate")?.name).toBe("Candidate");
    expect(inbox.groups()).toBe(inbox.groups());
    expect(inbox.tags()).toBe(inbox.tags());
  });
});

describe("storeInbox at the speed of the key", () => {
  test("read, unread and star show on the row at once, before the Cache write lands", async () => {
    const { inbox } = await open();
    const unread = inbox.threads().find((t) => t.unread);
    if (!unread) throw new Error("no unread fixture");
    let told = 0;
    const stop = inbox.subscribe(() => told++);
    const pending = inbox.markRead([unread.id]);
    // Not awaited: the row already reads as read, and the list was told.
    expect(inbox.thread(unread.id)?.unread).toBe(false);
    expect(inbox.threads().find((t) => t.id === unread.id)?.unread).toBe(false);
    expect(told).toBeGreaterThan(0);
    await pending;
    const star = inbox.star([unread.id]);
    expect(inbox.thread(unread.id)?.starred).toBe(true);
    await star;
    // The live query confirms both.
    await settled(inbox, () => inbox.thread(unread.id)?.starred === true);
    expect(inbox.thread(unread.id)?.unread).toBe(false);
    stop();
    inbox.close();
  });

  test("prefetch reads a neighbour's Messages ahead, and lets go of the ones not named again", async () => {
    const fake = await createFakeStore({ driver: bunDriver(), backoff: { minMs: 5, maxMs: 20 } });
    const inbox = await createStoreInbox(fake.store, { content: fake.content });
    const [a, b] = inbox.threads();
    if (!a || !b) throw new Error("fixtures");
    inbox.prefetch?.([a.id, b.id]);
    await settled(inbox, () => inbox.messages(a.id).length > 0 && inbox.messages(b.id).length > 0);
    // Opening the neighbour finds its Messages already read.
    let first: number | null = null;
    const stop = inbox.watchMessages(b.id, () => {});
    first = inbox.messages(b.id).length;
    expect(first).toBeGreaterThan(0);
    stop();
    inbox.prefetch?.([]);
    inbox.close();
  });
});

describe("storeInbox bodies", () => {
  test("an open that finds no Server says why the bodies are missing, and the next open clears it", async () => {
    const fake = await createFakeStore({ driver: bunDriver(), backoff: { minMs: 5, maxMs: 20 } });
    const inbox = await createStoreInbox(fake.store, { content: fake.content });
    await fake.store.write([
      {
        sql: "update messages set body_text = null, body_html = null, body_at = null where thread_id = 'e1'",
      },
    ]);
    let notified = 0;
    const stop = inbox.watchMessages("e1", () => notified++);
    expect(inbox.unavailable("e1")).toBeNull();
    fake.server.offline = true;
    await inbox.openThread("e1");
    expect(inbox.unavailable("e1")).toBe("offline");
    expect(notified).toBeGreaterThan(0);
    expect(inbox.messages("e1").every((m) => m.bodyText === undefined)).toBe(true);
    fake.server.offline = false;
    await inbox.openThread("e1");
    expect(inbox.unavailable("e1")).toBeNull();
    await settled(inbox, () => inbox.messages("e1").some((m) => m.bodyText !== undefined));
    stop();
    inbox.close();
  });

  test("a body the Server has not fetched stays Loading, and paints when a pull brings it", async () => {
    // The user's case: Gmail refused the body (quota) and the Server answered
    // the header-only stand-in. The Cache used to keep that empty body, so the
    // reader showed nothing forever and never asked again.
    const fake = await createFakeStore({ driver: bunDriver(), backoff: { minMs: 5, maxMs: 20 } });
    const inbox = await createStoreInbox(fake.store, { content: fake.content });
    await fake.store.write([
      {
        sql: "update messages set body_text = null, body_html = null, body_at = null where thread_id = 'e1'",
      },
    ]);
    fake.server.pendingBodies.add("m1c");
    const stop = inbox.watchMessages("e1", () => {});
    await inbox.openThread("e1");
    await settled(
      inbox,
      () => inbox.messages("e1").find((m) => m.id === "m1a")?.bodyText !== undefined,
    );
    const waitingRow = inbox.messages("e1").find((m) => m.id === "m1c");
    // Neither text nor html: the reader's Loading line.
    expect(waitingRow?.bodyText).toBeUndefined();
    expect(waitingRow?.bodyHtml).toBeUndefined();
    expect(await fake.store.query("select body_text from messages where id = 'm1c'")).toEqual([
      { body_text: null },
    ]);
    // The sync fetched it; the next pull (a wake, a change) asks again and the body lands.
    fake.server.pendingBodies.delete("m1c");
    await fake.store.sync();
    await settled(
      inbox,
      () => inbox.messages("e1").find((m) => m.id === "m1c")?.bodyText !== undefined,
    );
    expect(inbox.messages("e1").find((m) => m.id === "m1c")?.bodyText).toContain("Aoife");
    stop();
    inbox.close();
  });

  test("an empty body an earlier build cached is not a body: the open clears it and asks again", async () => {
    const fake = await createFakeStore({ driver: bunDriver(), backoff: { minMs: 5, maxMs: 20 } });
    const inbox = await createStoreInbox(fake.store, { content: fake.content });
    await fake.store.write([
      {
        sql: "update messages set body_text = '', body_html = null where thread_id = 'e1'",
      },
    ]);
    const stop = inbox.watchMessages("e1", () => {});
    await settled(inbox, () => inbox.messages("e1").length > 0);
    expect(inbox.messages("e1").every((m) => m.bodyText === "")).toBe(true);
    await inbox.openThread("e1");
    await settled(inbox, () => inbox.messages("e1").every((m) => (m.bodyText ?? "") !== ""));
    stop();
    inbox.close();
  });
});

describe("storeInbox Briefs (slice 13)", () => {
  const openWithContent = async () => {
    const fake = await createFakeStore({ driver: bunDriver(), backoff: { minMs: 5, maxMs: 20 } });
    const inbox = await createStoreInbox(fake.store, { content: fake.content });
    return { ...fake, inbox };
  };

  test("the reader gets the Cache's Brief before open and opening asks the Server for nothing", async () => {
    const { inbox, server } = await openWithContent();
    const stop = inbox.watchMessages("e1", () => {});
    await settled(inbox, () => inbox.brief("e1") !== undefined);
    expect(inbox.brief("e1")?.bullets[0]?.[0]).toEqual({ b: "Aoife submitted the take-home" });
    expect(inbox.brief("e1")).toBe(inbox.brief("e1"));
    await inbox.openThread("e1");
    expect(server.briefRequests).toEqual([]);
    stop();
    inbox.close();
  });

  test("a Thread with no Brief asks on open; the Server's answer arrives through the feed", async () => {
    const { inbox, store, server } = await openWithContent();
    server.onBriefRequest = (threadId) =>
      server.putBrief({
        threadId,
        bullets: [["Weekly digest, nothing to do."]],
        actions: [{ kind: "archive", label: "Archive" }],
        computedAt: "2026-09-16T10:00:00.000Z",
        stale: false,
      });
    // e11 is the fixture newsletter; the fixtures give it a Brief, the policy would not have.
    server.removeBrief("e11");
    await store.sync();
    const stop = inbox.watchMessages("e11", () => {});
    await settled(inbox, () => inbox.brief("e11") === undefined);
    expect(await store.query("select * from briefs where thread_id = 'e11'")).toEqual([]);
    await inbox.openThread("e11");
    expect(server.briefRequests).toEqual([{ threadId: "e11", trigger: "open" }]);
    await store.sync();
    await settled(inbox, () => inbox.brief("e11") !== undefined);
    expect(inbox.brief("e11")?.bullets).toEqual([["Weekly digest, nothing to do."]]);
    // Opening again finds it fresh.
    await inbox.openThread("e11");
    expect(server.briefRequests).toHaveLength(1);
    stop();
    inbox.close();
  });

  test("a stale Brief asks on open, shows dimmed meanwhile, and the user can ask by hand", async () => {
    const { inbox, store, server } = await openWithContent();
    server.staleBrief("e2");
    await store.sync();
    const stop = inbox.watchMessages("e2", () => {});
    await settled(inbox, () => inbox.brief("e2")?.stale === true);
    expect(inbox.brief("e2")?.bullets[0]?.[0]).toEqual({ b: "Two redlines" });
    await inbox.openThread("e2");
    expect(server.briefRequests).toEqual([{ threadId: "e2", trigger: "open" }]);
    await inbox.requestBrief("e2");
    expect(server.briefRequests.at(-1)).toEqual({ threadId: "e2", trigger: "user" });
    // An unreachable Server never throws out of the seam.
    server.offline = true;
    await inbox.requestBrief("e2");
    stop();
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
    // e4: read, five Messages, Mateus wrote last: reading it did not answer it.
    expect(section("e4")).toBe("needs-reply");
    // e10: list mail.
    expect(section("e10")).toBe("newsletters");
    // e7: read, one Message, someone else wrote last: still waiting for the owner's reply.
    expect(section("e7")).toBe("needs-reply");
    // e2 kept the Section the seed gave it.
    expect(section("e2")).toBe(threads.find((t) => t.id === "e2")?.section);
    inbox.close();
  });

  test("a judgments row on the feed lands in the Cache, moves the Thread by the judged rule, and reaches the reader seam; a deleted row takes it back", async () => {
    const seed = fixtureSeed();
    // e7 as list mail: Newsletters by the headers, until the judge says otherwise.
    seed.threads = seed.threads.map((t) =>
      t.id === "e7" ? { ...t, section: null, bulk: true } : t,
    );
    const fake = await createFakeStore({ driver: bunDriver(), seed });
    const { inbox, server, store } = {
      ...fake,
      inbox: await createStoreInbox(fake.store, { sections: { rules, order, owner } }),
    };
    expect(inbox.thread("e7")?.section).toBe("newsletters");
    expect(inbox.judgments?.("e7")).toBeUndefined();
    const judged = {
      threadId: "e7",
      needsReply: 0.82,
      waitingOnOthers: 0.1,
      newsletter: 0.05,
      automated: 0.03,
      briefWorth: 1.2,
      urgency: 1.5,
      chips: {
        reply: 0.9,
        call: 0.2,
        review_link: 0.1,
        open_attachment: 0.1,
        pay_or_file: 0.05,
        snooze: 0.3,
      },
      model: "jev-1.13.0",
      judgedAt: "2026-09-16T10:00:00.000Z",
    };
    server.record({ kind: "judgments", entityId: "e7", payload: judged });
    await store.sync();
    await settled(inbox, () => inbox.thread("e7")?.section === "needs-reply");
    expect(inbox.judgments?.("e7")).toEqual(judged);
    expect(await store.query("select thread_id, needs_reply from thread_judgments")).toEqual([
      { thread_id: "e7", needs_reply: 0.82 },
    ]);
    // A re-judge replaces the row; a removal takes the Thread back to the header rules.
    server.record({
      kind: "judgments",
      entityId: "e7",
      payload: { ...judged, needsReply: 0.3, judgedAt: "2026-09-16T11:00:00.000Z" },
    });
    await store.sync();
    await settled(inbox, () => inbox.thread("e7")?.section === "fyi");
    expect(inbox.judgments?.("e7")?.needsReply).toBe(0.3);
    server.record({ kind: "judgments", entityId: "e7", payload: { ...judged, deleted: true } });
    await store.sync();
    await settled(inbox, () => inbox.judgments?.("e7") === undefined);
    expect(await store.query("select thread_id from thread_judgments")).toEqual([]);
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
