/// <reference types="bun-types" />
// The Mail folders over the Cache's rows, through the Store's Inbox seam and
// the pure filter under it: Starred is every starred Thread outside the
// trash wherever it sits, Snoozed the snoozed ones soonest to wake first,
// Sent the Threads whose newest Message is the owner's, Archive the archived
// ones newest first; each list is stable between changes and follows the
// Cache after an action.

import { describe, expect, test } from "bun:test";
import type { Thread } from "@monday/shared";
import { threads } from "@monday/ui/fixtures";
import { bunDriver } from "../../store/bun-driver.ts";
import { createFakeStore } from "../../store/fake.ts";
import { type FolderEntry, folderThreads, isStreamFolder } from "./folders.ts";
import { createStoreInbox, type StoreInbox } from "./store-inbox.ts";

const OWNER = "tejas@genai-labs.io";
const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

async function settled(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await tick();
  }
  throw new Error("seam did not settle");
}

function entry(id: string, over: Partial<Thread> = {}, extra: Partial<FolderEntry> = {}) {
  const base = threads[0] as Thread;
  return {
    thread: { ...base, id, starred: false, archived: false, snoozedUntil: null, ...over },
    deleted: false,
    lastSender: null,
    ...extra,
  };
}

describe("folderThreads", () => {
  const rows: FolderEntry[] = [
    entry("a", { starred: true }),
    entry("b", { starred: true, archived: true }),
    entry("c", { starred: true }, { deleted: true }),
    entry("d", { snoozedUntil: "2026-09-20T08:00:00.000Z" }),
    entry("e", { snoozedUntil: "2026-09-17T08:00:00.000Z" }),
    entry("f", { archived: true }, { lastSender: "Tejas@GenAI-labs.io" }),
    entry("g", {}, { lastSender: "someone@else.test" }),
    entry("h", { archived: true }, { deleted: true, lastSender: OWNER }),
  ];
  const ids = (key: Parameters<typeof folderThreads>[0]) =>
    folderThreads(key, rows, OWNER).map((t) => t.id);

  test("Starred is every starred Thread outside the trash, archived ones too", () => {
    expect(ids("starred")).toEqual(["a", "b"]);
  });
  test("Snoozed is soonest to wake first", () => {
    expect(ids("snoozed")).toEqual(["e", "d"]);
  });
  test("Sent is the Threads whose newest Message is the owner's, whatever the case", () => {
    expect(ids("sent")).toEqual(["f"]);
    expect(folderThreads("sent", rows, "")).toEqual([]);
  });
  test("Archive is every archived Thread outside the trash, in the rows' order", () => {
    expect(ids("archive")).toEqual(["b", "f"]);
  });
  test("only the four stream folders are lenses; Drafts has its own screen", () => {
    expect(["starred", "snoozed", "sent", "archive"].every(isStreamFolder)).toBe(true);
    expect(isStreamFolder("drafts")).toBe(false);
    expect(isStreamFolder("inbox")).toBe(false);
  });
});

describe("the Store's folders", () => {
  async function open(): Promise<
    StoreInbox & { store: Awaited<ReturnType<typeof createFakeStore>>["store"] }
  > {
    const fake = await createFakeStore({ driver: bunDriver(), backoff: { minMs: 5, maxMs: 20 } });
    const inbox = await createStoreInbox(fake.store, { owner: OWNER });
    return Object.assign(inbox, { store: fake.store });
  }

  test("each folder follows the Cache after an action, and hands out a stable list", async () => {
    const inbox = await open();
    // Each folder reads its own query on first use.
    for (const key of ["starred", "archive", "snoozed", "sent"] as const) inbox.folder(key);
    await settled(() => inbox.folder("starred").length > 0);
    const starredBefore = inbox.folder("starred").map((t) => t.id);
    expect(starredBefore).toEqual(threads.filter((t) => t.starred).map((t) => t.id));
    expect(inbox.folder("starred")).toBe(inbox.folder("starred"));
    const archivedBefore = inbox.folder("archive").map((t) => t.id);
    expect(archivedBefore).not.toContain("e4");
    expect(inbox.folder("snoozed")).toEqual([]);

    await inbox.star(["e3"]);
    await inbox.archive(["e4"]);
    const until = new Date(2026, 8, 17, 8, 0);
    await inbox.snooze(["e5"], until);
    await settled(() => inbox.folder("snoozed").length === 1);
    expect(inbox.folder("starred").map((t) => t.id)).toContain("e3");
    expect(inbox.folder("archive").map((t) => t.id)).toEqual(
      expect.arrayContaining(["e4", ...archivedBefore]),
    );
    expect(inbox.folder("snoozed")[0]?.snoozedUntil).toBe(until.toISOString());
    // Archived and snoozed Threads have left the Inbox for their folders.
    expect(inbox.threads().map((t) => t.id)).not.toContain("e4");
    expect(inbox.threads().map((t) => t.id)).not.toContain("e5");
    inbox.close();
  });

  test("Sent holds a Thread once the owner's Message is its newest", async () => {
    const inbox = await open();
    expect(inbox.folder("sent")).toEqual([]);
    await inbox.store.cacheMessages([
      {
        id: "m-sent",
        threadId: "e3",
        from: { name: "Tejas", email: OWNER },
        to: [{ name: "Ngozi", email: "ngozi.adeyemi@gmail.com" }],
        cc: [],
        date: "2026-09-16T11:00:00",
        hasAttachments: false,
        attachments: [],
      },
    ]);
    await inbox.store.query("update threads set last_activity = ? where id = ?", [
      "2026-09-16T11:00:00",
      "e3",
    ]);
    inbox.resection();
    await settled(() => inbox.folder("sent").length === 1);
    expect(inbox.folder("sent").map((t) => t.id)).toEqual(["e3"]);
    inbox.close();
  });
});
