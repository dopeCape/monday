// "Your inbox is ready" through the watcher's seams: the Accounts and their
// first sync progress are fakes, the notifier and the note are recorders. An
// Account whose first sync finishes while watched is told once, by a desktop
// notification or, with the window in front, a note; one already synced when
// first seen is recorded without a word; the Setting turns it off; an Account
// already told is never read again.

import { describe, expect, test } from "bun:test";
import { defaultSettings, type FirstSyncProgress } from "@monday/shared";
import { type ReadyNotice, type ReadySettings, readyNotice, watchInboxReady } from "./ready.ts";

function progress(accountId: string, done: number, complete: boolean): FirstSyncProgress {
  return {
    accountId,
    workspaceId: `ws-${accountId}`,
    provider: "imap",
    address: `${accountId}@monday.test`,
    headers: { done, total: 1200, complete },
    bodies: { done, total: done, complete },
    pacing: false,
    error: null,
    at: "2026-09-24T10:00:00Z",
  };
}

async function until(probe: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

function harness(opts: {
  reads: Record<string, FirstSyncProgress[]>;
  inFront?: boolean;
  settings?: Partial<ReadySettings>;
}) {
  const base = defaultSettings();
  let settings: ReadySettings = {
    ...base,
    // Fast polls for the test; the shipped defaults are seconds.
    "sync.first_run_poll_seconds": 0.01,
    "accounts.status_poll_seconds": 0.01,
    ...opts.settings,
  };
  const reads: string[] = [];
  const notified: Array<[string, string]> = [];
  const notes: ReadyNotice[] = [];
  const queues = Object.fromEntries(Object.entries(opts.reads).map(([k, v]) => [k, [...v]]));
  const stop = watchInboxReady({
    list: async () => Object.keys(opts.reads).map((id) => ({ id })),
    read: async (id) => {
      reads.push(id);
      const q = queues[id] ?? [];
      const next = q.length > 1 ? q.shift() : q[0];
      if (!next) throw new Error("no progress");
      return next;
    },
    settings: () => settings,
    record: (announced) => {
      settings = { ...settings, "sync.first_run_announced": announced };
    },
    notify: async (title, body) => {
      notified.push([title, body]);
    },
    note: (n) => notes.push(n),
    inFront: () => opts.inFront ?? false,
    now: () => new Date("2026-09-24T10:00:00Z"),
  });
  return { stop, reads, notified, notes, settings: () => settings };
}

describe("inbox ready", () => {
  test("told once with the count synced when the first sync finishes while watched; an Account already synced is recorded silently", async () => {
    const h = harness({
      reads: {
        a1: [progress("a1", 300, false), progress("a1", 640, false), progress("a1", 1000, true)],
        a2: [progress("a2", 50, true)],
      },
    });
    await until(() => Object.keys(h.settings()["sync.first_run_announced"]).length === 2);
    await Bun.sleep(40);
    h.stop();
    expect(h.notified).toEqual([
      ["Your inbox is ready", "1,000 emails synced for a1@monday.test."],
    ]);
    expect(h.notes).toEqual([]);
    expect(h.settings()["sync.first_run_announced"]).toEqual({
      a1: "2026-09-24T10:00:00.000Z",
      a2: "2026-09-24T10:00:00.000Z",
    });
    // Once told, neither Account is read again.
    const before = h.reads.length;
    expect(h.reads.filter((r) => r === "a2")).toHaveLength(1);
    await Bun.sleep(40);
    expect(h.reads.length).toBe(before);
  });

  test("with the window in front, a note instead of a desktop notification", async () => {
    const h = harness({
      reads: { a1: [progress("a1", 10, false), progress("a1", 20, true)] },
      inFront: true,
    });
    await until(() => h.notes.length === 1);
    h.stop();
    expect(h.notified).toEqual([]);
    expect(h.notes[0]).toEqual({
      accountId: "a1",
      title: "Your inbox is ready",
      body: "20 emails synced for a1@monday.test.",
    });
  });

  test("the Setting off, or notifications off: nothing is shown, and it is still recorded", async () => {
    for (const settings of [
      { "notifications.inbox_ready": false },
      { "notifications.enabled": false },
    ] as Partial<ReadySettings>[]) {
      const h = harness({
        reads: { a1: [progress("a1", 10, false), progress("a1", 20, true)] },
        settings,
      });
      await until(() => h.settings()["sync.first_run_announced"].a1 !== undefined);
      h.stop();
      expect(h.notified).toEqual([]);
      expect(h.notes).toEqual([]);
    }
  });

  test("an Account connected after the watch began is told even when its first look finds it done", async () => {
    const accounts: string[] = [];
    let settings: ReadySettings = {
      ...defaultSettings(),
      "sync.first_run_poll_seconds": 0.01,
      "accounts.status_poll_seconds": 0.01,
    };
    const notified: string[] = [];
    const stop = watchInboxReady({
      list: async () => accounts.map((id) => ({ id })),
      read: async (id) => progress(id, 42, true),
      settings: () => settings,
      record: (announced) => {
        settings = { ...settings, "sync.first_run_announced": announced };
      },
      notify: async (_t, body) => {
        notified.push(body);
      },
      note: () => {},
      inFront: () => false,
    });
    await Bun.sleep(30);
    accounts.push("fresh");
    await until(() => notified.length === 1);
    stop();
    expect(notified).toEqual(["42 emails synced for fresh@monday.test."]);
  });

  test("an Account told before is never read", async () => {
    const h = harness({
      reads: { a1: [progress("a1", 10, false)] },
      settings: { "sync.first_run_announced": { a1: "2026-09-01T00:00:00Z" } },
    });
    await Bun.sleep(40);
    h.stop();
    expect(h.reads).toEqual([]);
  });

  test("the words come from the strings Settings", () => {
    const s = {
      ...defaultSettings(),
      "strings.first_sync.ready_body": "{address}: {count} in.",
    };
    expect(readyNotice(progress("a9", 12345, true), s).body).toBe("a9@monday.test: 12,345 in.");
  });
});
