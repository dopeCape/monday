/// <reference types="bun-types" />
// The fixture-backed InboxActions through the interface: every action moves
// the Thread the way inbox.md says and its undo token restores it.

import { describe, expect, test } from "bun:test";
import { threads } from "@monday/ui/fixtures";
import { fixtureInbox } from "./actions.ts";

const ids = () => threads.map((t) => t.id);

describe("fixtureInbox", () => {
  test("starts with every fixture Thread newest first, and does not share them", () => {
    const inbox = fixtureInbox();
    expect(inbox.threads().map((t) => t.id)).toEqual(ids());
    const first = inbox.threads()[0];
    expect(first).not.toBe(threads[0]);
    const again = inbox.threads();
    expect(again).toBe(inbox.threads());
  });

  test("archive removes from the Inbox and undo restores it in place", async () => {
    const inbox = fixtureInbox();
    const token = await inbox.archive(["e2"]);
    expect(inbox.threads().map((t) => t.id)).not.toContain("e2");
    expect(inbox.thread("e2")?.archived).toBe(true);
    await inbox.undo(token);
    expect(inbox.threads().map((t) => t.id)).toEqual(ids());
    expect(inbox.thread("e2")?.archived).toBe(false);
  });

  test("unarchive brings a Thread back", async () => {
    const inbox = fixtureInbox();
    await inbox.archive(["e1"]);
    await inbox.unarchive(["e1"]);
    expect(inbox.threads().map((t) => t.id)).toEqual(ids());
  });

  test("snooze stores the wake time and leaves the Inbox", async () => {
    const inbox = fixtureInbox();
    const until = new Date(2026, 8, 17, 8, 0);
    const token = await inbox.snooze(["e3"], until);
    expect(inbox.thread("e3")?.snoozedUntil).toBe(until.toISOString());
    expect(inbox.threads().map((t) => t.id)).not.toContain("e3");
    await inbox.undo(token);
    expect(inbox.thread("e3")?.snoozedUntil).toBeNull();
  });

  test("delete leaves the Inbox and undo restores", async () => {
    const inbox = fixtureInbox();
    const token = await inbox.delete(["e4", "e5"]);
    expect(inbox.threads().map((t) => t.id)).not.toContain("e4");
    expect(inbox.threads().map((t) => t.id)).not.toContain("e5");
    await inbox.undo(token);
    expect(inbox.threads().map((t) => t.id)).toEqual(ids());
  });

  test("star, read and move flip their fields and undo flips them back", async () => {
    const inbox = fixtureInbox();
    const t1 = await inbox.star(["e1"]);
    expect(inbox.thread("e1")?.starred).toBe(true);
    const t2 = await inbox.unstar(["e2"]);
    expect(inbox.thread("e2")?.starred).toBe(false);
    const t3 = await inbox.markRead(["e1"]);
    expect(inbox.thread("e1")?.unread).toBe(false);
    const t4 = await inbox.markUnread(["e3"]);
    expect(inbox.thread("e3")?.unread).toBe(true);
    const t5 = await inbox.moveToGroup(["e4"], "finance");
    expect(inbox.thread("e4")?.group).toBe("finance");
    for (const t of [t5, t4, t3, t2, t1]) await inbox.undo(t);
    expect(inbox.thread("e1")?.starred).toBe(false);
    expect(inbox.thread("e2")?.starred).toBe(true);
    expect(inbox.thread("e1")?.unread).toBe(true);
    expect(inbox.thread("e3")?.unread).toBe(false);
    expect(inbox.thread("e4")?.group).toBeNull();
  });

  test("mark-all-read is one undoable action", async () => {
    const inbox = fixtureInbox();
    const all = inbox.threads().map((t) => t.id);
    const token = await inbox.markRead(all);
    expect(inbox.threads().every((t) => !t.unread)).toBe(true);
    await inbox.undo(token);
    expect(
      inbox
        .threads()
        .filter((t) => t.unread)
        .map((t) => t.id),
    ).toEqual(["e1", "e2"]);
  });

  test("a token undoes once; unknown tokens are ignored", async () => {
    const inbox = fixtureInbox();
    const token = await inbox.archive(["e1"]);
    await inbox.undo(token);
    await inbox.archive(["e1"]);
    await inbox.undo(token);
    expect(inbox.thread("e1")?.archived).toBe(true);
    await inbox.undo("nope");
    expect(inbox.thread("e1")?.archived).toBe(true);
  });

  test("subscribers hear every change", async () => {
    const inbox = fixtureInbox();
    let n = 0;
    const off = inbox.subscribe(() => n++);
    const token = await inbox.archive(["e1"]);
    await inbox.undo(token);
    off();
    await inbox.archive(["e2"]);
    expect(n).toBe(2);
  });
});
