// The calendar module's writes aimed at instances of a repeating Event, its
// per-Event reminders and its status, through the interface and the routes
// over the fake seams: a Google-shaped Account whose Provider expands the
// series (this one, this and following, all, delete all), an IMAP-only
// Account whose Local calendar keeps masters (an EXDATE, a cut with UNTIL,
// a shifted master), and an Account whose Google Calendar API is off.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, CalendarEvent, CalendarStatus } from "@monday/shared";
import { expandRecurrence, splitRecurrence } from "@monday/shared";
import type { Hono } from "hono";
import { type AppEnv, createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/index.ts";
import {
  type CalendarModule,
  classifyCalendarError,
  createCalendar,
  GOOGLE_CALENDAR_API_URL,
} from "../src/calendar/index.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import {
  createFakeIntegrations,
  createFakeMcpClients,
  createIntelligence,
} from "../src/intelligence/index.ts";
import { createFakeChat, createFakeConverse } from "../src/intelligence/runtime/fake/index.ts";
import { createJobs } from "../src/jobs/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { createCredentialStore } from "../src/providers/credentials.ts";
import {
  createFakeProvider,
  type FakeProvider,
  fakeCredentials,
  generateFixture,
} from "../src/providers/fake/index.ts";
import { GmailApiError } from "../src/providers/gmail/client.ts";
import { GraphApiError } from "../src/providers/graph/client.ts";
import { createProviderRegistry } from "../src/providers/index.ts";
import { createSyncEngine, defaultSyncSettings, type SyncEngine } from "../src/providers/sync.ts";
import { ProviderError } from "../src/providers/types.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const SIDECAR_TOKEN = "per-launch-token";
const fixture = generateFixture();
const NOW = new Date(fixture.recordedAt);
const DAY = 86_400_000;
const at = (days: number, hours = 0) =>
  new Date(NOW.getTime() + days * DAY + hours * 3_600_000).toISOString();

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

interface World {
  db: TestDatabase;
  store: Mailstore;
  engine: SyncEngine;
  fake: FakeProvider;
  calendar: CalendarModule;
  app: Hono<AppEnv>;
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
  const jobs = createJobs(db.handle.db, { now: () => NOW });
  const engine = createSyncEngine({
    db: db.handle.db,
    mailstore: store,
    providers: createProviderRegistry({ overrides: { [account.provider]: fake } }),
    credentials,
    settings: async () => ({ ...defaultSyncSettings(), batchSize: 100 }),
    now: () => NOW,
    watchDebounceMs: 50,
  });
  const calendar = createCalendar({
    db: db.handle.db,
    mailstore: store,
    sync: engine,
    credentials,
    now: () => NOW,
  });
  calendar.registerSteps(jobs);
  const intelligence = createIntelligence({
    db: db.handle.db,
    mailstore: store,
    chat: createFakeChat("ok").chat,
    converse: createFakeConverse().converse,
    integrations: createFakeIntegrations(),
    mcp: createFakeMcpClients(),
    now: () => NOW,
  });
  const app = createApp({
    db: db.handle.db,
    auth: createAuth({ db: db.handle.db, sidecarToken: SIDECAR_TOKEN }),
    mode: "sidecar",
    keys,
    mailstore: store,
    jobs,
    sync: engine,
    intelligence,
    calendar,
    remoteAddress: () => "127.0.0.1",
  });
  return { db, store, engine, fake, calendar, app, workspaceId, account };
}

const request = (w: World, path: string, init: RequestInit = {}) =>
  w.app.request(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${SIDECAR_TOKEN}`,
      ...(init.headers ?? {}),
    },
  });

async function close(w: World) {
  await w.calendar.close();
  await w.engine.close();
  await w.db.drop();
}

const list = (w: World) => w.calendar.listEvents(w.workspaceId, { from: at(-2), to: at(30) });

describe("a Google-shaped Account: the Provider expands the series", () => {
  let w: World;
  const account = accountFor("acct-google", "gmail", true);
  const me = { ...fixture.owner, response: "accepted" as const, self: true, organizer: true };

  /** A daily series of five from tomorrow at 09:00, placed the way Google hands it over. */
  function placeSeries(id: string, title: string) {
    const google = w.fake.calendar;
    if (!google) throw new Error("no fake calendar");
    const base = {
      uid: `${id}@google`,
      description: "",
      location: "",
      allDay: false,
      timeZone: "Etc/UTC",
      organizer: fixture.owner,
      attendees: [me],
      link: null,
      status: "confirmed" as const,
      response: "accepted" as const,
    };
    google.place({
      ...base,
      id,
      title,
      start: at(1, 9),
      end: at(1, 10),
      recurrence: "FREQ=DAILY;COUNT=5",
      recurringEventId: null,
    });
    for (let i = 0; i < 5; i++) {
      google.place({
        ...base,
        id: `${id}_${i}`,
        title,
        start: at(1 + i, 9),
        end: at(1 + i, 10),
        recurrence: null,
        recurringEventId: id,
      });
    }
  }

  beforeAll(async () => {
    w = await world(account, { calendar: { source: "google", now: () => NOW } });
  }, 60_000);
  afterAll(async () => close(w));

  test("the master never syncs as an Event; its instances do", async () => {
    placeSeries("daily", "Standup");
    await w.calendar.syncAccount(account.id);
    const events = (await list(w)).filter((e) => e.title === "Standup");
    expect(events).toHaveLength(5);
    expect(events.every((e) => e.recurringEventId === "daily")).toBe(true);
  });

  test("all events: moving one instance an hour moves the series an hour", async () => {
    const third = (await list(w)).find((e) => e.providerId === "daily_2") as CalendarEvent;
    await w.calendar.updateEvent(third.id, { start: at(3, 10), end: at(3, 11) }, { scope: "all" });
    const master = w.fake.calendar?.snapshot().find((e) => e.id === "daily");
    expect(master?.start).toBe(at(1, 10));
    const hours = (await list(w))
      .filter((e) => e.title === "Standup")
      .map((e) => new Date(e.start).getTime() - NOW.getTime());
    expect(hours.every((ms) => (ms % DAY) / 3_600_000 === 10)).toBe(true);
  });

  test("this and following: the series ends before the instance and a new one starts there", async () => {
    const fourth = (await list(w)).find((e) => e.providerId === "daily_3") as CalendarEvent;
    const res = await request(w, `/calendar/events/${fourth.id}`, {
      method: "PUT",
      body: JSON.stringify({ title: "Standup (new format)", scope: "following" }),
    });
    expect(res.status).toBe(200);
    const snapshot = w.fake.calendar?.snapshot() ?? [];
    const master = snapshot.find((e) => e.id === "daily");
    expect(master?.recurrence).toMatch(/UNTIL=/);
    expect(master?.recurrence).not.toMatch(/COUNT/);
    const next = snapshot.find((e) => e.title === "Standup (new format)" && e.recurrence);
    expect(next?.recurrence).toBe("FREQ=DAILY");
    expect(next?.start).toBe(fourth.start);
    // The instances from the fourth on left the old series.
    const left = (await list(w)).filter((e) => e.title === "Standup").map((e) => e.providerId);
    expect(left).toEqual(["daily_0", "daily_1", "daily_2"]);
  });

  test("delete all events: every instance goes", async () => {
    placeSeries("weekly", "Review");
    await w.calendar.syncAccount(account.id);
    const one = (await list(w)).find((e) => e.title === "Review") as CalendarEvent;
    const res = await request(w, `/calendar/events/${one.id}?scope=all`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect((await list(w)).filter((e) => e.title === "Review")).toHaveLength(0);
    expect(w.fake.calendar?.snapshot().some((e) => e.id === "weekly")).toBe(false);
  });

  test("reminders are written to the Provider, kept on the row and carried on the feed", async () => {
    const res = await request(w, "/calendar/events", {
      method: "POST",
      body: JSON.stringify({
        workspace: w.workspaceId,
        title: "Dentist",
        start: at(5, 8),
        end: at(5, 9),
        reminders: [30, 5],
      }),
    });
    expect(res.status).toBe(201);
    const made = (await res.json()) as CalendarEvent;
    expect(made.reminders).toEqual([30, 5]);
    expect(w.fake.calendar?.snapshot().find((e) => e.title === "Dentist")?.reminders).toEqual([
      30, 5,
    ]);
    const changes = await w.store.listChanges(w.workspaceId, { since: 0, limit: 1000 });
    const last = changes.changes.filter((c) => c.kind === "event" && c.entityId === made.id).at(-1);
    const payload = last?.payload as { reminders?: number[] } | undefined;
    expect(payload?.reminders).toEqual([30, 5]);
    const back = await w.calendar.updateEvent(made.id, { reminders: null });
    expect(back.reminders).toBeNull();
  });

  test("status: ok after a sync; the Calendar API turned off says so, with the page that fixes it", async () => {
    const ok = await w.calendar.status(w.workspaceId);
    expect(ok.source).toBe("google");
    expect(ok.problem).toBeNull();
    const google = w.fake.calendar;
    if (!google) throw new Error("no fake calendar");
    const real = google.listCalendars.bind(google);
    google.listCalendars = async () => {
      throw new GmailApiError(
        403,
        "accessNotConfigured",
        "Gmail 403: Google Calendar API has not been used in project 402113 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=402113 then retry.",
      );
    };
    const res = await request(w, "/calendar/sync", {
      method: "POST",
      body: JSON.stringify({ workspace: w.workspaceId }),
    });
    const { status } = (await res.json()) as { status: CalendarStatus };
    expect(status.problem?.kind).toBe("api-disabled");
    expect(status.problem?.fixUrl).toBe(
      "https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=402113",
    );
    expect(status.problem?.message.startsWith("Google Calendar API has not been used")).toBe(true);
    const again = await request(w, `/calendar/status?workspace=${w.workspaceId}`);
    expect(((await again.json()) as { status: CalendarStatus }).status.problem?.kind).toBe(
      "api-disabled",
    );
    google.listCalendars = real;
    expect((await w.calendar.syncNow(w.workspaceId)).problem).toBeNull();
  });
});

describe("an IMAP-only Account: the Local calendar keeps masters", () => {
  let w: World;
  const account = accountFor("acct-imap", "imap", false);
  const window = { from: new Date(at(-1)), to: new Date(at(20)) };
  const instances = (e: CalendarEvent) =>
    expandRecurrence(
      e.recurrence ?? "",
      new Date(e.start),
      new Date(e.end),
      e.timeZone,
      window,
    ).map((o) => o.start.toISOString());

  beforeAll(async () => {
    w = await world(account, {});
  }, 60_000);
  afterAll(async () => close(w));

  test("this event: the master leaves the instance out and a single Event takes its place", async () => {
    const master = await w.calendar.createEvent(w.workspaceId, {
      title: "Gym",
      start: at(1, 7),
      end: at(1, 8),
      timeZone: "Etc/UTC",
      recurrence: "FREQ=DAILY;COUNT=4",
    });
    const moved = await w.calendar.updateEvent(
      master.id,
      { start: at(2, 18), end: at(2, 19) },
      { scope: "this", occurrence: at(2, 7) },
    );
    expect(moved.id).not.toBe(master.id);
    expect(moved.recurrence).toBeNull();
    expect(moved.title).toBe("Gym");
    const after = (await w.calendar.readEvent(master.id)) as CalendarEvent;
    expect(splitRecurrence(after.recurrence ?? "").exdates.map((d) => d.toISOString())).toEqual([
      at(2, 7),
    ]);
    expect(instances(after)).toEqual([at(1, 7), at(3, 7), at(4, 7)]);
  });

  test("delete this and following: the rule ends before the instance", async () => {
    const master = await w.calendar.createEvent(w.workspaceId, {
      title: "Reading",
      start: at(1, 21),
      end: at(1, 22),
      timeZone: "Etc/UTC",
      recurrence: "FREQ=DAILY",
    });
    const res = await request(
      w,
      `/calendar/events/${master.id}?scope=following&occurrence=${encodeURIComponent(at(4, 21))}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(204);
    const after = (await w.calendar.readEvent(master.id)) as CalendarEvent;
    expect(after.recurrence).toMatch(/UNTIL=/);
    expect(instances(after)).toEqual([at(1, 21), at(2, 21), at(3, 21)]);
  });

  test("all events from an instance: the master moves by as much as the instance did", async () => {
    const master = await w.calendar.createEvent(w.workspaceId, {
      title: "Walk",
      start: at(1, 12),
      end: at(1, 13),
      timeZone: "Etc/UTC",
      recurrence: "FREQ=DAILY;COUNT=3",
    });
    const res = await request(w, `/calendar/events/${master.id}`, {
      method: "PUT",
      body: JSON.stringify({
        start: at(2, 13),
        end: at(2, 14),
        scope: "all",
        occurrence: at(2, 12),
      }),
    });
    expect(res.status).toBe(200);
    const after = (await w.calendar.readEvent(master.id)) as CalendarEvent;
    expect(after.start).toBe(at(1, 13));
    expect(instances(after)).toEqual([at(1, 13), at(2, 13), at(3, 13)]);
  });

  test("a Local calendar Event keeps its reminders; status is always readable", async () => {
    const made = await w.calendar.createEvent(w.workspaceId, {
      title: "Call mum",
      start: at(3, 18),
      end: at(3, 19),
      reminders: [60],
    });
    expect(made.reminders).toEqual([60]);
    expect((await w.calendar.updateEvent(made.id, { title: "Call mum back" })).reminders).toEqual([
      60,
    ]);
    const status = await w.calendar.status(w.workspaceId);
    expect(status.source).toBe("local");
    expect(status.problem).toBeNull();
  });
});

describe("classifyCalendarError", () => {
  test("the kinds the Calendar screen explains", () => {
    const off = classifyCalendarError(
      new GmailApiError(
        403,
        "SERVICE_DISABLED",
        "Gmail 403: Google Calendar API has not been used in project 77 before or it is disabled.",
      ),
      "google",
    );
    expect(off.kind).toBe("api-disabled");
    expect(off.fixUrl).toBe(`${GOOGLE_CALENDAR_API_URL}?project=77`);
    expect(
      classifyCalendarError(
        new GmailApiError(
          403,
          "insufficientPermissions",
          "Gmail 403: Request had insufficient authentication scopes.",
        ),
        "google",
      ).kind,
    ).toBe("scope");
    expect(
      classifyCalendarError(
        new GraphApiError(403, "ErrorAccessDenied", "Access is denied."),
        "graph",
      ).kind,
    ).toBe("scope");
    expect(
      classifyCalendarError(
        new GmailApiError(401, "authError", "Gmail 401: Invalid Credentials"),
        "google",
      ).kind,
    ).toBe("auth");
    expect(
      classifyCalendarError(new ProviderError("socket hang up", "network"), "caldav").kind,
    ).toBe("network");
    expect(
      classifyCalendarError(new GmailApiError(429, "rateLimitExceeded", "slow down"), "google")
        .kind,
    ).toBe("rate-limit");
    expect(classifyCalendarError(new Error("boom"), "caldav")).toEqual({
      kind: "other",
      message: "boom",
      fixUrl: null,
    });
  });
});
