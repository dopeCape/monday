// The Agent's calendar tools beyond scheduling (ADR 0002), through the tool
// server with the real calendar module over the fake Provider: every
// calendar with its access and who shares it, the window with series
// expanded and a query, search, free time, a move and a delete aimed at
// instances of a repeating Event, and a calendar draft that writes nothing,
// lands on the Activity row as a card and reads back. Also the calendar
// module carrying a shared calendar's access and a calendar that cannot be
// read onto the feed.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  Account,
  ApprovalDecision,
  CalendarChange,
  CalendarDraft,
  CalendarEvent,
  ToolPreview,
} from "@monday/shared";
import { type CalendarModule, createCalendar } from "../src/calendar/index.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import {
  createMemoryActivityLog,
  createToolServer,
  type ToolServer,
} from "../src/intelligence/agent/index.ts";
import {
  createFakeToolHost,
  type FakeToolHost,
} from "../src/intelligence/agent/tools/fake-host.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
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
// A Tuesday.
const NOW = new Date("2026-09-15T09:00:00Z");
const at = (days: number, hours = 0, minutes = 0) =>
  new Date(Date.UTC(2026, 8, 15 + days, hours, minutes)).toISOString();

function accountFor(id: string, provider: Account["provider"], calendar: boolean): Account {
  return {
    id,
    provider,
    address: fixture.address,
    displayName: fixture.owner.name,
    capabilities: {
      push: true,
      labels: false,
      snooze: false,
      mute: false,
      calendar,
      meetingLink: calendar ? "meet" : null,
    },
  };
}

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

interface World {
  db: TestDatabase;
  store: Mailstore;
  engine: SyncEngine;
  fake: FakeProvider;
  calendar: CalendarModule;
  server: ToolServer;
  host: FakeToolHost;
  activity: ReturnType<typeof createMemoryActivityLog>;
  workspaceId: string;
  account: Account;
}

async function world(
  account: Account,
  fakeOptions: Parameters<typeof createFakeProvider>[1],
): Promise<World> {
  const db = await testDatabase();
  const keys = createKeys(db.handle.db);
  await keys.unlock(randomKey());
  const store = createMailstore(db.handle.db, keys);
  const credentials = createCredentialStore(db.handle.db, store);
  const fake = createFakeProvider(fixture, fakeOptions);
  const workspaceId = (await store.createWorkspace(account)).id;
  await credentials.store(workspaceId, account.id, fakeCredentials(fixture.address));
  const engine = createSyncEngine({
    db: db.handle.db,
    mailstore: store,
    providers: createProviderRegistry({ overrides: { [account.provider]: fake } }),
    credentials,
    settings: async () => ({ ...defaultSyncSettings(), batchSize: 100 }),
    now: () => NOW,
  });
  const calendar = createCalendar({
    db: db.handle.db,
    mailstore: store,
    sync: engine,
    credentials,
    now: () => NOW,
  });
  await calendar.syncAccount(account.id);
  const host = createFakeToolHost([], { workspaceId, now: () => NOW });
  const activity = createMemoryActivityLog({ now: () => NOW });
  const server = createToolServer({
    host,
    activity,
    now: () => NOW,
    settings: async () => ({ previewAbove: 10, alwaysAsk: [], searchLimit: 100 }),
    extensions: { calendar },
  });
  return { db, store, engine, fake, calendar, server, host, activity, workspaceId, account };
}

async function close(w: World) {
  await w.calendar.close();
  await w.engine.close();
  await w.db.drop();
}

let calls = 0;
const call = (w: World, name: string, args: unknown, ...answers: ApprovalDecision[]) => {
  const a = approver(...answers);
  calls += 1;
  return w.server
    .call({ name, args, callId: `call-${calls}`, sessionId: "s1" }, a)
    .then((outcome) => ({ ...outcome, asked: a.asked }));
};

const me = { ...fixture.owner, response: "accepted" as const, self: true, organizer: true };
const aoife = { name: "Aoife Brennan", email: "aoife@northwind.test" };

async function feedOf(w: World, kind: "calendar" | "event") {
  const page = await w.store.listChanges(w.workspaceId, { since: 0, limit: 5000 });
  return page.changes.filter((c) => c.kind === kind);
}

describe("a Google-shaped Account: calendars, search, free time, series and drafts", () => {
  let w: World;
  const account = accountFor("acct-google-agent", "gmail", true);

  function place(
    id: string,
    title: string,
    start: string,
    end: string,
    extra: Partial<Parameters<NonNullable<FakeProvider["calendar"]>["place"]>[0]> = {},
  ) {
    const google = w.fake.calendar;
    if (!google) throw new Error("no fake calendar");
    google.place({
      id,
      uid: `${id}@google`,
      title,
      description: "",
      location: "",
      start,
      end,
      allDay: false,
      timeZone: "Etc/UTC",
      organizer: fixture.owner,
      attendees: [me],
      link: null,
      status: "confirmed",
      recurrence: null,
      recurringEventId: null,
      response: "accepted",
      ...extra,
    });
  }

  const byTitle = async (title: string): Promise<CalendarEvent> => {
    const found = (await w.calendar.listEvents(w.workspaceId, { from: at(-2), to: at(30) })).find(
      (e) => e.title === title,
    );
    if (!found) throw new Error(`no ${title}`);
    return found;
  };

  beforeAll(async () => {
    w = await world(account, { calendar: { source: "google", now: () => NOW } });
    // Wednesday: a busy morning, a declined lunch, and a Team event on the shared calendar.
    place("focus", "Focus block", at(1, 8), at(1, 12), { description: "Quarterly planning notes" });
    place("lunch", "Lunch talk", at(1, 12), at(1, 13), {
      response: "declined",
      organizer: aoife,
      attendees: [
        { ...aoife, response: "accepted", organizer: true },
        { ...fixture.owner, response: "declined", self: true },
      ],
    });
    place("team", "Team offsite planning", at(1, 13), at(1, 14), { calendarId: "team" });
    place("aoife", "Sync with Aoife", at(2, 15), at(2, 15, 30), {
      location: "Room 4",
      attendees: [me, { ...aoife, response: "accepted" }],
    });
    place("dentist", "Dentist", at(20, 8), at(20, 9));
    await w.calendar.syncAccount(account.id);
  }, 60_000);
  afterAll(async () => close(w));

  test("list_calendars: the own calendar and the shared one, with access and who shares it", async () => {
    const out = await call(w, "list_calendars", {});
    expect(out.isError).toBe(false);
    expect(out.activity).toMatchObject({ tier: "read-only", decision: "auto" });
    const data = out.activity.resultData as {
      calendars: { name: string; access: string; sharedBy: unknown; primary: boolean }[];
    };
    expect(data.calendars.map((c) => [c.name, c.access, c.sharedBy, c.primary])).toEqual([
      [fixture.address, "owner", null, true],
      ["Team (shared)", "reader", { name: "Team", email: "team@northwind.test" }, false],
    ]);
    expect(out.text).toContain("shared by Team");
  });

  test("list_events: declined Events are left out unless asked for; a query keeps the matching ones", async () => {
    const out = await call(w, "list_events", { days: 3 });
    expect(out.text).toContain("Focus block");
    expect(out.text).toContain("Sync with Aoife");
    expect(out.text).not.toContain("Lunch talk");
    const withDeclined = await call(w, "list_events", { days: 3, include_declined: true });
    expect(withDeclined.text).toContain("Lunch talk");
    const query = await call(w, "list_events", { days: 3, query: "room aoife" });
    const events = (query.activity.resultData as { events: { title: string }[] }).events;
    expect(events.map((e) => e.title)).toEqual(["Sync with Aoife"]);
    const team = (await w.calendar.listCalendars(w.workspaceId)).find((c) => c.sharedBy);
    const narrowed = await call(w, "list_events", { days: 3, calendar_ids: [team?.id] });
    expect(
      (narrowed.activity.resultData as { events: { title: string }[] }).events.map((e) => e.title),
    ).toEqual(["Team offsite planning"]);
  });

  test("search_events looks through the whole synced window by title, notes and people", async () => {
    const out = await call(w, "search_events", { query: "dentist" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain('1 Event matching "dentist"');
    expect(out.text).toContain(at(20, 8).replace("T", " ").slice(0, 16));
    const notes = await call(w, "search_events", { query: "quarterly planning" });
    expect(
      (notes.activity.resultData as { events: { title: string }[] }).events.map((e) => e.title),
    ).toEqual(["Focus block"]);
    const none = await call(w, "search_events", { query: "podcast" });
    expect(none.text).toContain("No Events matching");
  });

  test("find_free_time: working hours, own busy Events only, declined ones do not block", async () => {
    const out = await call(w, "find_free_time", {
      from: at(1),
      to: at(2),
      duration_minutes: 60,
      limit: 3,
      attendees: ["Aoife Brennan <aoife@northwind.test>"],
    });
    expect(out.isError).toBe(false);
    const data = out.activity.resultData as {
      slots: { start: string; end: string }[];
      timeZone: string;
    };
    expect(data.timeZone).toBe("UTC");
    // 08:00 to 12:00 is the Focus block; the declined lunch and the shared Team event do not count.
    expect(data.slots).toEqual([
      { start: at(1, 12), end: at(1, 13) },
      { start: at(1, 13), end: at(1, 14) },
      { start: at(1, 14), end: at(1, 15) },
    ]);
    expect(out.text).toContain("Aoife Brennan may be busy");

    // Working hours read in the zone asked for: 08:00 in Dublin is 07:00Z in September.
    const dublin = await call(w, "find_free_time", {
      from: at(1),
      to: at(2),
      duration_minutes: 60,
      limit: 1,
      time_zone: "Europe/Dublin",
    });
    expect((dublin.activity.resultData as { slots: unknown[] }).slots).toEqual([
      { start: at(1, 7), end: at(1, 8) },
    ]);

    // The Settings shape the answer: a later working day and a shorter snap.
    await w.host.writeSetting("calendar.day_start_hour", 15);
    await w.host.writeSetting("calendar.snap_minutes", 20);
    const late = await call(w, "find_free_time", { from: at(2), to: at(3), limit: 2 });
    expect((late.activity.resultData as { slots: unknown[] }).slots).toEqual([
      // 15:00 to 15:30 is the Sync with Aoife; the next 20 minute step is 15:40.
      { start: at(2, 15, 40), end: at(2, 16, 10) },
      { start: at(2, 16, 20), end: at(2, 16, 50) },
    ]);
    await w.host.writeSetting("calendar.day_start_hour", 8);
    await w.host.writeSetting("calendar.snap_minutes", 15);

    const weekend = await call(w, "find_free_time", { from: at(4), to: at(6) });
    expect((weekend.activity.resultData as { slots: unknown[] }).slots).toEqual([]);
    const bad = await call(w, "find_free_time", { time_zone: "Mars/Olympus" });
    expect(bad.isError).toBe(true);
  });

  test("move_event with scope all moves the whole series; delete_event with scope following cuts it", async () => {
    place("daily", "Standup", at(3, 9), at(3, 9, 15), { recurrence: "FREQ=DAILY;COUNT=5" });
    for (let i = 0; i < 5; i++) {
      place(`daily_${i}`, "Standup", at(3 + i, 9), at(3 + i, 9, 15), { recurringEventId: "daily" });
    }
    await w.calendar.syncAccount(account.id);
    const instances = (await w.calendar.listEvents(w.workspaceId, { from: at(0), to: at(30) }))
      .filter((e) => e.title === "Standup")
      .sort((a, b) => a.start.localeCompare(b.start));
    expect(instances).toHaveLength(5);
    const second = instances[1] as CalendarEvent;

    const moved = await call(
      w,
      "move_event",
      { event_id: second.id, start: at(4, 10), scope: "all" },
      "approved",
    );
    expect(moved.isError).toBe(false);
    expect(moved.asked[0]).toMatchObject({
      kind: "event",
      event: { action: "update", title: "Standup", start: at(4, 10), end: at(4, 10, 15) },
    });
    expect(moved.activity).toMatchObject({ tier: "always-ask", decision: "approved" });
    expect(moved.text).toContain("the whole series");
    expect(w.fake.calendar?.snapshot().find((e) => e.id === "daily")?.start).toBe(at(3, 10));

    const after = (await w.calendar.listEvents(w.workspaceId, { from: at(0), to: at(30) }))
      .filter((e) => e.title === "Standup")
      .sort((a, b) => a.start.localeCompare(b.start));
    expect(after.every((e) => e.start.endsWith("T10:00:00.000Z"))).toBe(true);
    const fourth = after[3] as CalendarEvent;
    const cut = await call(
      w,
      "delete_event",
      { event_id: fourth.id, scope: "following" },
      "approved",
    );
    expect(cut.isError).toBe(false);
    expect(cut.asked[0]).toMatchObject({ kind: "event", event: { action: "cancel" } });
    expect(w.fake.calendar?.snapshot().find((e) => e.id === "daily")?.recurrence).toMatch(/UNTIL=/);
    const left = (await w.calendar.listEvents(w.workspaceId, { from: at(0), to: at(30) })).filter(
      (e) => e.title === "Standup",
    );
    expect(left).toHaveLength(3);
  });

  test("update_event carries reminders and a rename to one instance only by default", async () => {
    const first = (await w.calendar.listEvents(w.workspaceId, { from: at(0), to: at(30) }))
      .filter((e) => e.title === "Standup")
      .sort((a, b) => a.start.localeCompare(b.start))[0] as CalendarEvent;
    const out = await call(
      w,
      "update_event",
      { event_id: first.id, title: "Standup (demo day)", reminders: [5] },
      "approved",
    );
    expect(out.isError).toBe(false);
    const updated = await w.calendar.readEvent(first.id);
    expect(updated?.title).toBe("Standup (demo day)");
    expect(updated?.reminders).toEqual([5]);
    const titles = (await w.calendar.listEvents(w.workspaceId, { from: at(0), to: at(30) }))
      .filter((e) => e.recurringEventId === first.recurringEventId)
      .map((e) => e.title)
      .sort();
    expect(titles).toEqual(["Standup", "Standup", "Standup (demo day)"]);
  });

  test("propose_calendar_draft: one draft with before, after and guests; nothing written; the card on the row", async () => {
    const google = w.fake.calendar;
    if (!google) throw new Error("no fake calendar");
    const focus = await byTitle("Focus block");
    const sync = await byTitle("Sync with Aoife");
    const primary = (await w.calendar.listCalendars(w.workspaceId)).find((c) => c.primary);
    const before = JSON.stringify(google.snapshot());
    const mailed = google.mailed.length;

    const out = await call(w, "propose_calendar_draft", {
      title: "Wednesday and Thursday",
      summary: "Deep work Thursday morning, the Aoife sync an hour later, the focus block freed.",
      changes: [
        {
          kind: "create",
          title: "Deep work",
          start: at(2, 9),
          duration_minutes: 90,
          attendees: [fixture.address, "Aoife Brennan <aoife@northwind.test>"],
          reason: "Your mornings are free",
        },
        { kind: "update", event_id: sync.id, start: at(2, 16) },
        { kind: "delete", event_id: focus.id, reason: "Freed for the offsite" },
      ],
    });
    expect(out.isError).toBe(false);
    expect(out.asked).toHaveLength(0);
    expect(out.activity).toMatchObject({ tier: "read-only", decision: "auto", status: "done" });
    expect(out.text).toContain("1 to add, 1 to change, 1 to remove");
    expect(out.text).toContain("the user reviews it on the Calendar and applies it");

    const draft = (out.activity.resultData as { draft: CalendarDraft }).draft;
    expect(draft.workspaceId).toBe(w.workspaceId);
    expect(draft.createdAt).toBe(NOW.toISOString());
    expect(draft.from).toBe(at(1, 8));
    expect(draft.to).toBe(at(2, 16, 30));
    const [create, update, remove] = draft.changes;
    expect(create).toMatchObject({
      id: "c1",
      kind: "create",
      before: null,
      after: {
        title: "Deep work",
        start: at(2, 9),
        end: at(2, 10, 30),
        allDay: false,
        calendarId: primary?.id,
      },
      // The user is never a guest of their own draft.
      guests: [aoife],
      reason: "Your mornings are free",
    });
    expect(update).toMatchObject({
      kind: "update",
      eventId: sync.id,
      before: {
        title: "Sync with Aoife",
        start: at(2, 15),
        end: at(2, 15, 30),
        location: "Room 4",
      },
      after: { title: "Sync with Aoife", start: at(2, 16), end: at(2, 16, 30), location: "Room 4" },
      guests: [aoife],
    });
    expect(remove).toMatchObject({
      kind: "delete",
      eventId: focus.id,
      before: { title: "Focus block", start: at(1, 8), end: at(1, 12) },
      after: null,
      guests: [],
    });

    // The card rides on the Activity row, so the client gets it with the tool event.
    expect(out.activity.preview).toEqual({ kind: "calendar-draft", draft });
    // Nothing reached the calendar, nobody was mailed.
    expect(JSON.stringify(google.snapshot())).toBe(before);
    expect(google.mailed).toHaveLength(mailed);

    // A Dry run sees the same card.
    const dry = await w.server.preview({
      name: "propose_calendar_draft",
      args: {
        title: "Dry",
        summary: "",
        changes: [{ kind: "delete", event_id: focus.id }],
      },
    });
    expect(dry.kind).toBe("result");
    expect(dry.kind === "result" && dry.preview?.kind).toBe("calendar-draft");

    // get_calendar_draft reads it back, by id and as the latest.
    const back = await call(w, "get_calendar_draft", { draft_id: draft.id });
    expect((back.activity.resultData as { draft: CalendarDraft }).draft).toEqual(draft);
    const latest = await call(w, "get_calendar_draft", {});
    expect((latest.activity.resultData as { draft: CalendarDraft }).draft.id).toBe(draft.id);
    const missing = await call(w, "get_calendar_draft", { draft_id: "nope" });
    expect(missing.isError).toBe(true);
  });

  test("propose_calendar_draft refuses an unknown Event, a read-only calendar and a backwards Event", async () => {
    const unknown = await call(w, "propose_calendar_draft", {
      title: "x",
      summary: "",
      changes: [
        { kind: "create", title: "Fine", start: at(3, 9) },
        { kind: "delete", event_id: "no-such-event" },
      ],
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("Change 2: Event no-such-event not found.");
    expect(unknown.activity.preview).toBeNull();

    const team = await byTitle("Team offsite planning");
    const readOnly = await call(w, "propose_calendar_draft", {
      title: "x",
      summary: "",
      changes: [{ kind: "update", event_id: team.id, start: at(1, 15) }],
    });
    expect(readOnly.isError).toBe(true);
    expect(readOnly.text).toContain('the calendar "Team (shared)" is read-only');

    const teamCalendar = (await w.calendar.listCalendars(w.workspaceId)).find((c) => c.sharedBy);
    const onShared = await call(w, "propose_calendar_draft", {
      title: "x",
      summary: "",
      changes: [{ kind: "create", title: "Nope", start: at(3, 9), calendar_id: teamCalendar?.id }],
    });
    expect(onShared.isError).toBe(true);
    expect(onShared.text).toContain("read-only");

    const backwards = await call(w, "propose_calendar_draft", {
      title: "x",
      summary: "",
      changes: [{ kind: "create", title: "Back", start: at(3, 10), end: at(3, 9) }],
    });
    expect(backwards.isError).toBe(true);
    expect(backwards.text).toContain("would end before it starts");

    // The single-Event tools refuse a read-only calendar too.
    const move = await call(w, "move_event", { event_id: team.id, start: at(1, 16) });
    expect(move.isError).toBe(true);
    expect(move.text).toContain("read-only");
  });
});

describe("an IMAP-only Account: the Local calendar keeps masters", () => {
  let w: World;
  const account = accountFor("acct-imap-agent", "imap", false);
  let master: CalendarEvent;

  beforeAll(async () => {
    w = await world(account, {});
    master = await w.calendar.createEvent(w.workspaceId, {
      title: "Gym",
      start: at(1, 7),
      end: at(1, 8),
      timeZone: "Etc/UTC",
      recurrence: "FREQ=DAILY;COUNT=4",
    });
  }, 60_000);
  afterAll(async () => close(w));

  const gym = async () => {
    const out = await call(w, "list_events", { from: at(0), to: at(10), query: "gym" });
    return (
      out.activity.resultData as { events: { id: string; start: string; occurrence?: string }[] }
    ).events;
  };

  test("list_events expands the series into instances, each with an occurrence to pass back", async () => {
    const events = await gym();
    expect(events.map((e) => [e.id, e.start, e.occurrence])).toEqual([
      [master.id, at(1, 7), at(1, 7)],
      [master.id, at(2, 7), at(2, 7)],
      [master.id, at(3, 7), at(3, 7)],
      [master.id, at(4, 7), at(4, 7)],
    ]);
  });

  test("move_event on one occurrence moves that instance only", async () => {
    const out = await call(
      w,
      "move_event",
      { event_id: master.id, occurrence: at(2, 7), start: at(2, 18) },
      "approved",
    );
    expect(out.isError).toBe(false);
    expect(out.asked[0]).toMatchObject({
      kind: "event",
      event: { action: "update", start: at(2, 18), end: at(2, 19), invitesBy: "none" },
    });
    const events = await gym();
    expect(events.map((e) => e.start)).toEqual([at(1, 7), at(2, 18), at(3, 7), at(4, 7)]);
    // The moved one is its own Event now; the others are still the series'.
    expect(events.filter((e) => e.id === master.id)).toHaveLength(3);
  });

  test("an occurrence the series does not have is refused", async () => {
    const out = await call(w, "delete_event", { event_id: master.id, occurrence: at(2, 9) });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("has no instance starting");
  });

  test("delete_event on one occurrence removes that instance only", async () => {
    const out = await call(
      w,
      "delete_event",
      { event_id: master.id, occurrence: at(3, 7) },
      "approved",
    );
    expect(out.isError).toBe(false);
    expect(out.asked[0]).toMatchObject({ event: { action: "cancel", start: at(3, 7) } });
    expect((await gym()).map((e) => e.start)).toEqual([at(1, 7), at(2, 18), at(4, 7)]);
  });

  test("a draft change on an occurrence shows that instance's times before and after", async () => {
    const out = await call(w, "propose_calendar_draft", {
      title: "Gym later",
      summary: "",
      changes: [{ kind: "update", event_id: master.id, occurrence: at(4, 7), start: at(4, 19) }],
    });
    expect(out.isError).toBe(false);
    const draft = (out.activity.resultData as { draft: CalendarDraft }).draft;
    expect(draft.changes[0]).toMatchObject({
      kind: "update",
      eventId: master.id,
      scope: "this",
      occurrence: at(4, 7),
      before: { start: at(4, 7), end: at(4, 8), recurrence: expect.stringContaining("FREQ=DAILY") },
      after: { start: at(4, 19), end: at(4, 20) },
      guests: [],
    });
    expect(draft.from).toBe(at(4, 7));
    expect(draft.to).toBe(at(4, 20));
  });
});

describe("the calendar module: shared calendars and calendars that cannot be read", () => {
  let w: World;
  const account = accountFor("acct-google-sharing", "gmail", true);

  beforeAll(async () => {
    w = await world(account, { calendar: { source: "google", now: () => NOW } });
  }, 60_000);
  afterAll(async () => close(w));

  const lastOf = async (name: string): Promise<CalendarChange | undefined> =>
    (await feedOf(w, "calendar"))
      .map((c) => c.payload as CalendarChange)
      .filter((p) => p.name === name)
      .at(-1);

  test("a shared calendar's access and who shares it reach listCalendars and the feed", async () => {
    const calendars = await w.calendar.listCalendars(w.workspaceId);
    expect(calendars.map((c) => [c.name, c.access, c.sharedBy, c.error])).toEqual([
      [fixture.address, "owner", null, null],
      ["Team (shared)", "reader", { name: "Team", email: "team@northwind.test" }, null],
    ]);
    expect(await lastOf("Team (shared)")).toMatchObject({
      access: "reader",
      sharedBy: { name: "Team", email: "team@northwind.test" },
      error: null,
    });
    // The owner grants write access: the row and the feed follow on the next sync.
    const team = w.fake.calendar?.calendars.find((c) => c.id === "team");
    if (!team) throw new Error("no team calendar");
    team.access = "writer";
    team.writable = true;
    const before = (await feedOf(w, "calendar")).length;
    await w.calendar.syncAccount(account.id);
    expect((await feedOf(w, "calendar")).length).toBe(before + 1);
    expect(await lastOf("Team (shared)")).toMatchObject({ access: "writer", writable: true });
    // Nothing changed: no new feed row.
    await w.calendar.syncAccount(account.id);
    expect((await feedOf(w, "calendar")).length).toBe(before + 1);
  });

  test("a calendar whose read fails carries the Provider's words on the feed until it reads again", async () => {
    w.fake.calendar?.failing.set("team", "Not Found: the calendar is no longer shared with you");
    await w.calendar.syncAccount(account.id);
    expect((await lastOf("Team (shared)"))?.error).toBe(
      "Not Found: the calendar is no longer shared with you",
    );
    const listed = await w.calendar.listCalendars(w.workspaceId);
    expect(listed.find((c) => c.name === "Team (shared)")?.error).toBe(
      "Not Found: the calendar is no longer shared with you",
    );
    // The primary still reads, so the Account's status stays fine.
    expect((await w.calendar.status(w.workspaceId)).problem).toBeNull();
    const count = (await feedOf(w, "calendar")).length;
    await w.calendar.syncAccount(account.id);
    // The same failure again is not news.
    expect((await feedOf(w, "calendar")).length).toBe(count);
    w.fake.calendar?.failing.delete("team");
    await w.calendar.syncAccount(account.id);
    expect((await lastOf("Team (shared)"))?.error).toBeNull();
  });
});
