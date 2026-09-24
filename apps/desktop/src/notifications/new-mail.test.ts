/// <reference types="bun-types" />
// Which new Messages become a notification: recent ones, in unread Inbox
// Threads, not the Account's own sends, not bulk unless asked; one or several.

import { describe, expect, test } from "bun:test";
import { defaultSettings } from "@monday/shared";
import type { NewMessage } from "../store/store.ts";
import { newMailNotice } from "./new-mail.ts";

const NOW = new Date("2026-09-24T10:00:00Z");
const threads: Record<string, Record<string, unknown>> = {
  t1: {
    id: "t1",
    subject: "Lunch on Friday?",
    unread: 1,
    archived: 0,
    deleted: 0,
    snoozed_until: null,
    bulk: 0,
  },
  t2: {
    id: "t2",
    subject: "Weekly digest",
    unread: 1,
    archived: 0,
    deleted: 0,
    snoozed_until: null,
    bulk: 1,
  },
  t3: {
    id: "t3",
    subject: "Old and read",
    unread: 0,
    archived: 0,
    deleted: 0,
    snoozed_until: null,
    bulk: 0,
  },
  t4: {
    id: "t4",
    subject: "Invoice",
    unread: 1,
    archived: 0,
    deleted: 0,
    snoozed_until: null,
    bulk: 0,
  },
};
const store = {
  query: async <T>(_sql: string, ids?: unknown[]) =>
    (ids ?? []).map((id) => threads[String(id)]).filter(Boolean) as T[],
};
const msg = (
  id: string,
  threadId: string,
  minutesAgo: number,
  email = "aoife@x.test",
): NewMessage => ({
  id,
  threadId,
  from: { name: email === "me@x.test" ? "Me" : "Aoife", email },
  date: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
});
const run = (messages: NewMessage[], over: Record<string, unknown> = {}) =>
  newMailNotice({
    workspaceId: "ws",
    address: "me@x.test",
    messages,
    store,
    settings: { ...defaultSettings(), ...over } as never,
    now: NOW,
  });

describe("new mail notifications", () => {
  test("one recent unread Inbox message: its sender and subject", async () => {
    expect(await run([msg("m1", "t1", 1)])).toEqual({
      workspaceId: "ws",
      title: "Aoife",
      body: "Lunch on Friday?",
    });
  });

  test("old mail, read Threads, own sends and bulk stay quiet; bulk counts when asked", async () => {
    expect(await run([msg("m1", "t1", 60)])).toBeNull();
    expect(await run([msg("m3", "t3", 1)])).toBeNull();
    expect(await run([msg("m4", "t1", 1, "me@x.test")])).toBeNull();
    expect(await run([msg("m2", "t2", 1)])).toBeNull();
    expect(await run([msg("m2", "t2", 1)], { "notifications.new_mail_bulk": true })).toMatchObject({
      body: "Weekly digest",
    });
  });

  test("several at once are one notice; the Setting off is silence", async () => {
    expect(await run([msg("m1", "t1", 1), msg("m5", "t4", 2)])).toEqual({
      workspaceId: "ws",
      title: "2 new emails",
      body: "me@x.test",
    });
    expect(await run([msg("m1", "t1", 1)], { "notifications.new_mail": false })).toBeNull();
  });
});
