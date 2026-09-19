// The calendar tools through the tool server (slice 18, ADR 0002), with the
// real calendar module over the fake Provider's calendar as the seam. The
// done-when of the slice: "set up a call with Aoife Thursday 15:00" is one
// schedule_event call that asks first with the card, then creates one Event
// on Google with a Meet link, and Google sends the invite, not monday. Also
// the conflicts on the card, Undo cancelling the Event, rsvp on a Thread's
// Invite, and a host without a calendar refusing.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, ApprovalDecision, ToolPreview } from "@monday/shared";
import { writeICalendar } from "../src/calendar/ical.ts";
import { type CalendarModule, createCalendar } from "../src/calendar/index.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import {
  createMemoryActivityLog,
  createToolServer,
  type ToolServer,
} from "../src/intelligence/agent/index.ts";
import { createFakeToolHost } from "../src/intelligence/agent/tools/fake-host.ts";
import { createMailstore } from "../src/mailstore/index.ts";
import { createCredentialStore } from "../src/providers/credentials.ts";
import {
  createFakeProvider,
  type FakeProvider,
  fakeCredentials,
  generateFixture,
} from "../src/providers/fake/index.ts";
import { createProviderRegistry } from "../src/providers/index.ts";
import { createSyncEngine, defaultSyncSettings, type SyncEngine } from "../src/providers/sync.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const fixture = generateFixture();
// A Tuesday; "Thursday 15:00" is two days on.
const NOW = new Date("2026-09-15T09:00:00Z");
const THURSDAY_15 = "2026-09-17T15:00:00+01:00";
const THURSDAY_15_UTC = "2026-09-17T14:00:00.000Z";

const account: Account = {
  id: "acct-google-tools",
  provider: "gmail",
  address: fixture.address,
  displayName: fixture.owner.name,
  capabilities: {
    push: true,
    labels: true,
    snooze: false,
    mute: false,
    calendar: true,
    meetingLink: "meet",
  },
};

function approver(...answers: ApprovalDecision[]) {
  const asked: ToolPreview[] = [];
  return {
    asked,
    ask: async (_row: unknown, preview: ToolPreview) => {
      asked.push(preview);
      const next = answers.shift();
      if (!next) throw new Error("asked more than scripted");
      return next;
    },
  };
}

describe("schedule_event over the calendar module and the fake Google calendar", () => {
  let db: TestDatabase;
  let calendar: CalendarModule;
  let engine: SyncEngine;
  let fake: FakeProvider;
  let server: ToolServer;
  let workspaceId = "";
  const activity = createMemoryActivityLog({ now: () => NOW });

  beforeAll(async () => {
    db = await testDatabase();
    const keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    const store = createMailstore(db.handle.db, keys);
    const credentials = createCredentialStore(db.handle.db, store);
    fake = createFakeProvider(fixture, {
      threads: true,
      calendar: { source: "google", now: () => NOW },
    });
    workspaceId = (await store.createWorkspace(account)).id;
    await credentials.store(workspaceId, account.id, fakeCredentials(fixture.address));
    engine = createSyncEngine({
      db: db.handle.db,
      mailstore: store,
      providers: createProviderRegistry({ overrides: { gmail: fake } }),
      credentials,
      settings: async () => ({ ...defaultSyncSettings(), batchSize: 100 }),
      now: () => NOW,
    });
    calendar = createCalendar({
      db: db.handle.db,
      mailstore: store,
      sync: engine,
      credentials,
      now: () => NOW,
    });
    await calendar.syncAccount(account.id);
    const host = createFakeToolHost([], { workspaceId, now: () => NOW });
    server = createToolServer({
      host,
      activity,
      now: () => NOW,
      settings: async () => ({ previewAbove: 10, alwaysAsk: [], searchLimit: 100 }),
      extensions: { calendar },
    });
  }, 60_000);

  afterAll(async () => {
    await calendar.close();
    await engine.close();
    await db.drop();
  });

  test("set up a call with Aoife Thursday 15:00: the card, one Event on Google with a Meet link, Google sends the invite", async () => {
    const google = fake.calendar;
    if (!google) throw new Error("no fake calendar");
    const a = approver("approved");
    const outcome = await server.call(
      {
        name: "schedule_event",
        args: {
          title: "Call with Aoife",
          start: THURSDAY_15,
          attendees: ["Aoife Brennan <aoife@northwind.test>"],
        },
        callId: "c1",
        sessionId: "s1",
      },
      a,
    );
    expect(outcome.isError).toBe(false);
    // The card: the slot, the person, the link kind and who mails.
    expect(a.asked).toHaveLength(1);
    expect(a.asked[0]).toEqual({
      kind: "event",
      event: {
        action: "schedule",
        title: "Call with Aoife",
        start: THURSDAY_15_UTC,
        end: "2026-09-17T14:30:00.000Z",
        allDay: false,
        timeZone: null,
        attendees: [{ name: "Aoife Brennan", email: "aoife@northwind.test" }],
        link: "google-meet",
        invitesBy: "provider",
        conflicts: [],
      },
    });
    expect(outcome.activity).toMatchObject({
      tool: "schedule_event",
      tier: "always-ask",
      status: "done",
      decision: "approved",
      undoable: true,
    });
    // Exactly one Event on Google, with a Meet link, and Google mailed the invitation.
    const made = google.snapshot().filter((e) => e.title === "Call with Aoife");
    expect(made).toHaveLength(1);
    expect(made[0]?.link).toMatch(/^https:\/\/meet\.google\.com\//);
    expect(made[0]?.start).toBe(THURSDAY_15_UTC);
    expect(made[0]?.attendees.map((x) => x.email)).toEqual([
      fixture.address,
      "aoife@northwind.test",
    ]);
    expect(google.mailed).toEqual([
      { kind: "invite", eventId: made[0]?.id ?? "", to: ["aoife@northwind.test"] },
    ]);
    // monday sent no mail of its own.
    expect(fake.calls.send ?? 0).toBe(0);
    expect(outcome.text).toContain("Invitations to Aoife Brennan go out from your Google account");
    // The module holds it, marked as the Agent's.
    const events = await calendar.listEvents(workspaceId, {
      from: "2026-09-17T00:00:00Z",
      to: "2026-09-18T00:00:00Z",
    });
    expect(events.map((e) => [e.title, e.createdByAgent])).toEqual([["Call with Aoife", true]]);
  });

  test("a declined card creates nothing", async () => {
    const google = fake.calendar;
    if (!google) throw new Error("no fake calendar");
    const before = google.snapshot().length;
    const a = approver("declined");
    const outcome = await server.call(
      {
        name: "schedule_event",
        args: { title: "Nope", start: "2026-09-18T10:00:00Z", duration_minutes: 15 },
        callId: "c2",
        sessionId: "s1",
      },
      a,
    );
    expect(outcome.activity.decision).toBe("declined");
    expect(google.snapshot()).toHaveLength(before);
  });

  test("the card lists the user's own overlapping Events, and list_events reads the window", async () => {
    const a = approver("approved");
    await server.call(
      {
        name: "schedule_event",
        args: {
          title: "Focus",
          start: "2026-09-17T14:00:00Z",
          end: "2026-09-17T16:00:00Z",
          meeting_link: "none",
        },
        callId: "c3",
        sessionId: "s1",
      },
      a,
    );
    const b = approver("declined");
    await server.call(
      {
        name: "schedule_event",
        args: { title: "Clash", start: THURSDAY_15, duration_minutes: 30 },
        callId: "c4",
        sessionId: "s1",
      },
      b,
    );
    const preview = b.asked[0];
    if (preview?.kind !== "event") throw new Error("no event card");
    expect(preview.event.conflicts.sort()).toEqual(["Call with Aoife", "Focus"]);

    const listed = await server.call(
      { name: "list_events", args: { days: 7 }, callId: "c5", sessionId: "s1" },
      approver(),
    );
    expect(listed.text).toContain("Call with Aoife");
    expect(listed.text).toContain("Focus");
    expect(listed.text).toContain("with Aoife Brennan");
  });

  test("Undo cancels the Event the Agent scheduled; Google mails the cancellation", async () => {
    const google = fake.calendar;
    if (!google) throw new Error("no fake calendar");
    const row = activity.rows.find(
      (r) =>
        r.tool === "schedule_event" && r.undoable && r.inputSummary.startsWith("Call with Aoife"),
    );
    if (!row) throw new Error("no schedule row");
    const undone = await server.undo(row.id, "s1");
    expect(undone.isError).toBe(false);
    expect(undone.text).toContain("cancelled");
    expect(google.snapshot().some((e) => e.title === "Call with Aoife")).toBe(false);
    expect(google.mailed.at(-1)).toMatchObject({ kind: "cancel", to: ["aoife@northwind.test"] });
    expect(fake.calls.send ?? 0).toBe(0);
  });

  test("rsvp answers an Event by id through the Provider", async () => {
    const google = fake.calendar;
    if (!google) throw new Error("no fake calendar");
    google.place({
      id: "",
      uid: "podcast@lindqvist",
      title: "Podcast recording",
      description: "",
      location: "",
      start: "2026-09-19T13:00:00Z",
      end: "2026-09-19T14:00:00Z",
      allDay: false,
      timeZone: null,
      organizer: { name: "Sofia Lindqvist", email: "sofia@lindqvist.test" },
      attendees: [
        {
          name: "Sofia Lindqvist",
          email: "sofia@lindqvist.test",
          response: "accepted",
          organizer: true,
        },
        { ...fixture.owner, response: "needs-action", self: true },
      ],
      link: null,
      status: "tentative",
      recurrence: null,
      recurringEventId: null,
      response: "needs-action",
    });
    await calendar.syncAccount(account.id);
    const [event] = await calendar.listEvents(workspaceId, {
      from: "2026-09-19T00:00:00Z",
      to: "2026-09-20T00:00:00Z",
    });
    if (!event) throw new Error("not synced");
    const a = approver("approved");
    const outcome = await server.call(
      {
        name: "rsvp",
        args: { event_id: event.id, response: "accepted" },
        callId: "c6",
        sessionId: "s1",
      },
      a,
    );
    expect(outcome.isError).toBe(false);
    expect(a.asked[0]).toMatchObject({
      kind: "event",
      event: { action: "rsvp", response: "accepted" },
    });
    expect(google.mailed.at(-1)).toMatchObject({ kind: "reply", response: "accepted" });
    expect((await calendar.readEvent(event.id))?.response).toBe("accepted");
    // The iCalendar text the module would mail on a mail-only Account is well formed too.
    expect(
      writeICalendar(
        {
          uid: "x",
          sequence: 0,
          stamp: NOW,
          title: "t",
          description: "",
          location: "",
          start: NOW,
          end: NOW,
          allDay: false,
          zone: null,
          organizer: null,
          attendees: [],
          status: "confirmed",
          recurrence: null,
          link: null,
        },
        "REPLY",
      ),
    ).toContain("METHOD:REPLY");
  });

  test("a host without a calendar refuses the tools", async () => {
    const bare = createToolServer({
      host: createFakeToolHost([], { workspaceId, now: () => NOW }),
      activity: createMemoryActivityLog({ now: () => NOW }),
      now: () => NOW,
      settings: async () => ({ previewAbove: 10, alwaysAsk: [], searchLimit: 100 }),
    });
    const outcome = await bare.call(
      { name: "list_events", args: {}, callId: "c7", sessionId: "s2" },
      approver(),
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("not available");
  });
});
