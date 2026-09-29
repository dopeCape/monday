/// <reference types="bun-types" />
// Which new Messages become a notification: recent ones, in unread Inbox
// Threads, not the Account's own sends, not bulk unless asked; one or several.

import { describe, expect, test } from "bun:test";
import { defaultSettings } from "@monday/shared";
import type { NewMessage } from "../store/store.ts";
import { newMailNotice } from "./new-mail.ts";
import { loadSidecarTold, NOTHING_TOLD, sidecarToldOnce, toldBySidecar } from "./sidecar-told.ts";

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

  test("mail the Sidecar told while monday was closed is not told again; newer mail is", async () => {
    const told = {
      mailThrough: NOW.getTime() - 2 * 60_000,
      approvals: new Set<string>(),
    };
    const withTold = (messages: NewMessage[]) =>
      newMailNotice({
        workspaceId: "ws",
        address: "me@x.test",
        messages,
        store,
        settings: defaultSettings() as never,
        now: NOW,
        told,
      });
    expect(await withTold([msg("m1", "t1", 3)])).toBeNull();
    expect(await withTold([msg("m1", "t1", 2)])).toBeNull();
    expect(await withTold([msg("m1", "t1", 3), msg("m5", "t4", 1)])).toEqual({
      workspaceId: "ws",
      title: "Aoife",
      body: "Invoice",
    });
  });
});

describe("what the Sidecar told", () => {
  test("read once per connection; a Server that does not answer told nothing", async () => {
    let asked = 0;
    const api = {
      service: {
        status: async () => {
          asked++;
          return {
            notified: { mailThrough: "2026-09-24T09:58:00.000Z", approvals: ["r1:a1"] },
          };
        },
      },
    };
    const first = await sidecarToldOnce(api);
    const second = await sidecarToldOnce(api);
    expect(asked).toBe(1);
    expect(first).toBe(second);
    expect(first.mailThrough).toBe(Date.parse("2026-09-24T09:58:00.000Z"));
    expect([...first.approvals]).toEqual(["r1:a1"]);
    expect(toldBySidecar(first, "2026-09-24T09:57:00.000Z")).toBe(true);
    expect(toldBySidecar(first, "2026-09-24T09:59:00.000Z")).toBe(false);

    expect(await sidecarToldOnce(null)).toBe(NOTHING_TOLD);
    const broken = await loadSidecarTold(async () => {
      throw new Error("404");
    });
    expect(broken).toBe(NOTHING_TOLD);
    const silent = await loadSidecarTold(() => new Promise(() => {}), 20);
    expect(silent).toBe(NOTHING_TOLD);
    expect(toldBySidecar(NOTHING_TOLD, "2026-09-24T09:57:00.000Z")).toBe(false);
  });
});
