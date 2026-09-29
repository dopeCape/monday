// Meetings from mail on the Server (docs/spec/meetings.md): the routes over a
// real database with the fake judge and a fake calendar attached. The reading
// is sealed in thread_meetings with the Message it read, the feed carries the
// chip, the draft route writes the template when no language model answers,
// and nothing is created on the calendar.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, AiLevel, Calendar, MeetingChange, MeetingOptions } from "@monday/shared";
import type { Hono } from "hono";
import { type AppEnv, createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/index.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import { settings as settingsTable, threadMeetings } from "../src/db/schema.ts";
import type { CalendarSeam } from "../src/intelligence/agent/tools/calendar.ts";
import { createIntelligence, type Intelligence } from "../src/intelligence/index.ts";
import { createFakeJudge } from "../src/intelligence/runtime/fake/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const SIDECAR_TOKEN = "per-launch-token";
const NOW = new Date("2026-09-29T10:00:00Z");
const sam = { name: "Sam Okafor", email: "sam@monday.test" };
const aoife = { name: "Aoife Byrne", email: "aoife@example.com" };

const account: Account = {
  id: "acct-meetings",
  provider: "imap",
  address: sam.email,
  displayName: sam.name,
  capabilities: {
    push: false,
    labels: false,
    snooze: false,
    mute: false,
    calendar: false,
    meetingLink: null,
  },
};

describe("meeting routes", () => {
  let db: TestDatabase;
  let store: Mailstore;
  let intelligence: Intelligence;
  let app: Hono<AppEnv>;
  let workspaceId = "";
  let threadId = "";
  let level: AiLevel = "assist";
  const writes: string[] = [];
  const judge = createFakeJudge({
    asks_to_meet: 0.92,
    owner_asked: 0.02,
    proposes_time: 0.05,
    recurring: 0.01,
    length: "not_stated",
    p1_form: "none",
    p2_form: "none",
    p3_form: "none",
  });

  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${SIDECAR_TOKEN}` },
    });

  beforeAll(async () => {
    db = await testDatabase();
    const keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    intelligence = createIntelligence({
      level: async () => level,
      db: db.handle.db,
      mailstore: store,
      judge: judge.judge,
      // TypeSafe only: no language model, so the reply is the template.
      keys: async (provider) => (provider === "typesafe" ? "ts-fake" : null),
      now: () => NOW,
    });
    const own: Calendar = {
      id: "cal-own",
      workspaceId: "",
      source: "local",
      providerId: "local",
      name: "Sam",
      primary: true,
      writable: true,
      visible: true,
      color: null,
      sharedBy: null,
    };
    const refuse = (what: string) => async () => {
      writes.push(what);
      throw new Error(`${what} must not be called`);
    };
    const calendar: CalendarSeam = {
      info: refuse("info") as never,
      listCalendars: async () => [own],
      selfAddress: async () => sam.email,
      listEvents: async () => [],
      busy: refuse("busy") as never,
      readEvent: refuse("readEvent") as never,
      createEvent: refuse("createEvent") as never,
      updateEvent: refuse("updateEvent") as never,
      deleteEvent: refuse("deleteEvent") as never,
      respond: refuse("respond") as never,
      invitesOfThread: async () => [],
      applyInviteIntent: refuse("applyInviteIntent") as never,
    };
    app = createApp({
      db: db.handle.db,
      auth: createAuth({ db: db.handle.db, sidecarToken: SIDECAR_TOKEN }),
      mode: "sidecar",
      keys,
      mailstore: store,
      intelligence,
      calendar: calendar as never,
      remoteAddress: () => "127.0.0.1",
    });
    intelligence.attachCalendar(calendar);
    await db.handle.db.insert(settingsTable).values({
      scope: "global",
      deviceId: null,
      key: "calendar.time_zone",
      value: "Europe/London",
    });
    workspaceId = (await store.createWorkspace(account)).id;
    threadId = await store.upsertThread({
      workspaceId,
      providerThreadId: "thr-meet",
      subject: "Re: The proposal",
      participants: [aoife, sam],
      lastActivity: "2026-09-29T09:15:00.000Z",
    });
    await store.upsertMessage({
      threadId,
      providerMessageId: "msg-1",
      from: aoife,
      to: [sam],
      cc: [],
      date: "2026-09-29T09:15:00.000Z",
      headers: { date: "Tue, 29 Sep 2026 10:15:00 +0100" },
      bodyText:
        "Hi Sam, could we get on a call this week to go through the proposal? Around 3pm suits me.",
      bodyHtml: null,
      snippet: "Hi Sam, could we get on a call this week",
    });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  test("GET judges the newest Message once, seals the reading and tells the feed", async () => {
    const res = await request(`/meetings/${threadId}?workspace=${workspaceId}&zone=Europe/London`);
    expect(res.status).toBe(200);
    const o = (await res.json()) as MeetingOptions;
    expect(o.case).toBe("asks");
    expect(o.title).toBe("The proposal");
    expect(o.attendees).toEqual([aoife]);
    expect(o.chips.map((c) => c.kind)).toEqual(["offer_times"]);
    expect(o.slots).toHaveLength(3);
    expect(judge.calls).toHaveLength(1);

    const again = await request(`/meetings/${threadId}?workspace=${workspaceId}`);
    expect(again.status).toBe(200);
    expect(judge.calls).toHaveLength(1);

    const [row] = await db.handle.db.select().from(threadMeetings);
    expect(row?.judgedBy).toBe("typesafe");
    expect(row?.chip?.kind).toBe("offer_times");
    // The reading holds the clock span from the text; it is sealed, not stored in the clear.
    expect(Buffer.from(row?.readingEnc ?? new Uint8Array()).toString("utf8")).not.toContain("3pm");

    const changes = (
      await store.listChanges(workspaceId, { since: 0, limit: 1000 })
    ).changes.filter((c) => c.kind === "meeting");
    expect(changes).toHaveLength(1);
    const first = changes[0];
    expect(first ? (first.payload as MeetingChange).chip?.kind : null).toBe("offer_times");
  });

  test("POST draft writes the template reply with the re-checked slots; nothing is created", async () => {
    const o = (await (
      await request(`/meetings/${threadId}?workspace=${workspaceId}`)
    ).json()) as MeetingOptions;
    const res = await request(`/meetings/${threadId}/draft`, {
      method: "POST",
      body: JSON.stringify({
        workspace: workspaceId,
        kind: "offer",
        slots: o.slots.map(({ start, end }) => ({ start, end })),
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; written: boolean; slots: unknown[] };
    expect(body.written).toBe(false);
    expect(body.slots).toHaveLength(3);
    expect(body.text.startsWith("Happy to meet.")).toBe(true);
    expect(writes).toEqual([]);
  });

  test("AI level off: 409 ai_off; an unknown Thread: 404", async () => {
    level = "off";
    const off = await request(`/meetings/${threadId}?workspace=${workspaceId}`);
    expect(off.status).toBe(409);
    expect(await off.json()).toEqual({ error: "ai_off" });
    level = "assist";
    const missing = await request(`/meetings/nope?workspace=${workspaceId}`);
    expect(missing.status).toBe(404);
  });
});
