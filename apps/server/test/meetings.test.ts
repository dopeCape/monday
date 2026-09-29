// Meetings from mail (docs/spec/meetings.md) through the module's interface
// with fakes at every seam: a fixture Thread source, an in-memory store, a
// fake calendar, and the real Hosted runtime over the fake judge and the fake
// chat. Covers the candidates code finds, the date parts resolved across
// zones and DST, free and busy by find_free_time's rules, the slot search,
// every case and its chip, the one Jev request, the language model's path,
// the grounded reply, the approvals (nothing is created or sent here), the
// AI level, and the agent's meeting_options tool.

import { describe, expect, test } from "bun:test";
import type {
  AiLevel,
  Calendar,
  CalendarEvent,
  Invite,
  JudgeAnswer,
  MeetingChange,
  MeetingChip,
  Person,
} from "@monday/shared";
import { defaultSettings } from "@monday/shared";
import type { CalendarSeam } from "../src/intelligence/agent/tools/calendar.ts";
import { MEETING_TOOLS, type MeetingsSeam } from "../src/intelligence/agent/tools/meetings.ts";
import { groundedIn } from "../src/intelligence/meetings/draft.ts";
import {
  clockCandidates,
  hasGateWord,
  offsetOfDateHeader,
  zoneCandidates,
} from "../src/intelligence/meetings/extract.ts";
import {
  createMeetings,
  MEETING_STEP,
  type MeetingSettings,
  type MeetingStore,
  type MeetingThread,
} from "../src/intelligence/meetings/index.ts";
import type { MeetingReading, ProposalParts } from "../src/intelligence/meetings/resolve.ts";
import { resolveReading } from "../src/intelligence/meetings/resolve.ts";
import {
  MEETING_SETTING_KEYS,
  type MeetingSettingValues,
  meetingSettingsFrom,
} from "../src/intelligence/meetings/settings.ts";
import { readPromptJudgeOutput } from "../src/intelligence/prompt-judge.ts";
import { createFakeRuntime } from "../src/intelligence/runtime/fake/index.ts";
import { AiOffError } from "../src/intelligence/runtime/index.ts";

const ZONE = "Europe/London";
/** Tuesday 29 September 2026, 11:00 in London (BST, UTC+1). */
const NOW = new Date("2026-09-29T10:00:00Z");
const OWNER: Person = { name: "Sam Okafor", email: "sam@monday.test" };
const AOIFE: Person = { name: "Aoife Byrne", email: "aoife@example.com" };

function settings(patch: Partial<Record<string, unknown>> = {}): MeetingSettings {
  const all = defaultSettings() as unknown as Record<string, unknown>;
  const picked = Object.fromEntries(MEETING_SETTING_KEYS.map((k) => [k, all[k]]));
  return meetingSettingsFrom({
    ...picked,
    "calendar.time_zone": ZONE,
    ...patch,
  } as unknown as MeetingSettingValues);
}

interface Msg {
  id: string;
  from: Person;
  text: string;
  date: string;
  headers?: Record<string, string>;
  attachments?: Array<{ mediaType: string }>;
}

function source(subject: string, messages: Msg[]) {
  const thread: MeetingThread = {
    workspaceId: "ws",
    subject,
    owner: OWNER,
    participants: [AOIFE, OWNER],
    messages: messages.map((m) => ({
      id: m.id,
      from: m.from,
      to: [m.from.email === OWNER.email ? AOIFE : OWNER],
      cc: [],
      date: m.date,
      headers: m.headers ?? {},
      attachments: m.attachments ?? [],
    })),
  };
  const texts = new Map(messages.map((m) => [m.id, m.text]));
  return {
    thread,
    add(m: Msg) {
      thread.messages.push({
        id: m.id,
        from: m.from,
        to: [OWNER],
        cc: [],
        date: m.date,
        headers: m.headers ?? {},
        attachments: [],
      });
      texts.set(m.id, m.text);
    },
    seam: {
      read: async (id: string) => (id === "t1" ? thread : null),
      text: async (id: string) => texts.get(id) ?? "",
    },
  };
}

function memoryStore(): MeetingStore & {
  rows: Map<string, { reading: MeetingReading; chip: MeetingChip | null }>;
} {
  const rows = new Map<string, { reading: MeetingReading; chip: MeetingChip | null }>();
  return {
    rows,
    get: async (id) => rows.get(id) ?? null,
    put: async (reading, chip) => {
      rows.set(reading.threadId, { reading, chip });
    },
    setChip: async (id, chip) => {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, chip });
    },
  };
}

function event(
  id: string,
  start: string,
  end: string,
  extra: Partial<CalendarEvent> = {},
): CalendarEvent {
  return {
    id,
    workspaceId: "ws",
    calendarId: "cal-own",
    providerId: id,
    uid: null,
    title: id,
    description: "",
    location: "",
    start,
    end,
    allDay: false,
    timeZone: ZONE,
    organizer: null,
    attendees: [],
    link: null,
    status: "confirmed",
    recurrence: null,
    recurringEventId: null,
    response: "accepted",
    createdByAgent: false,
    etag: null,
    updatedAt: NOW.toISOString(),
    ...extra,
  };
}

function fakeCalendar(events: CalendarEvent[], invites: Invite[] = []) {
  const calendars: Calendar[] = [
    {
      id: "cal-own",
      workspaceId: "ws",
      source: "google",
      providerId: "primary",
      name: "Sam",
      primary: true,
      writable: true,
      visible: true,
      color: null,
      sharedBy: null,
    },
    {
      id: "cal-shared",
      workspaceId: "ws",
      source: "google",
      providerId: "team",
      name: "Team",
      primary: false,
      writable: false,
      visible: true,
      color: null,
      sharedBy: { name: "Priya", email: "priya@monday.test" },
    },
  ];
  const writes: string[] = [];
  const refuse = (what: string) => async () => {
    writes.push(what);
    throw new Error(`${what} must not be called`);
  };
  const seam: CalendarSeam = {
    info: refuse("info") as never,
    listCalendars: async () => calendars,
    selfAddress: async () => OWNER.email,
    listEvents: async (_ws, o) =>
      events.filter(
        (e) =>
          (!o.calendarIds || o.calendarIds.includes(e.calendarId)) &&
          Date.parse(e.end) > Date.parse(o.from) &&
          Date.parse(e.start) < Date.parse(o.to),
      ),
    busy: refuse("busy") as never,
    readEvent: refuse("readEvent") as never,
    createEvent: refuse("createEvent") as never,
    updateEvent: refuse("updateEvent") as never,
    deleteEvent: refuse("deleteEvent") as never,
    respond: refuse("respond") as never,
    invitesOfThread: async () => invites,
    applyInviteIntent: refuse("applyInviteIntent") as never,
  };
  return { seam, writes };
}

const choice = (c: string, confidence = 0.95): JudgeAnswer => ({
  type: "choice",
  choice: c,
  probabilities: { [c]: confidence },
  confidence,
});

/** The parts of one proposed time, scripted as the judge would answer them. */
function parts(n: number, p: Record<string, JudgeAnswer | number>) {
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [`p${n}_${k}`, v]));
}

interface Setup {
  subject?: string;
  messages: Msg[];
  events?: CalendarEvent[];
  invites?: Invite[];
  judgments?: Record<string, JudgeAnswer | number | string>;
  level?: AiLevel;
  patch?: Partial<Record<string, unknown>>;
  noCalendar?: boolean;
  keys?: Record<string, string>;
  answer?: string | ((call: { system: string; prompt: string }) => string);
}

function setup(o: Setup) {
  const fake = createFakeRuntime({
    // What the judge says of parts a Message does not have; a test scripts the ones it has.
    judgments: {
      asks_to_meet: 0.05,
      owner_asked: 0.05,
      proposes_time: 0.05,
      recurring: 0.02,
      length: "not_stated",
      zone: "not_stated",
      p1_form: "none",
      p2_form: "none",
      p3_form: "none",
      ...(o.judgments ?? {}),
    },
    ...(o.keys ? { keys: o.keys } : {}),
    ...(o.answer ? { answer: o.answer as never } : {}),
  });
  const src = source(o.subject ?? "Catch up", o.messages);
  const store = memoryStore();
  const cal = fakeCalendar(o.events ?? [], o.invites ?? []);
  const changes: MeetingChange[] = [];
  const s = settings(o.patch);
  const meetings = createMeetings({
    runtime: fake.runtime,
    thread: src.seam,
    store,
    calendar: () => (o.noCalendar ? null : cal.seam),
    voice: async () => null,
    settings: async () => s,
    level: async () => o.level ?? "assist",
    record: async (_ws, change) => {
      changes.push(change);
    },
    now: () => NOW,
  });
  return { meetings, fake, store, cal, changes, src };
}

const asksNoTime: Msg = {
  id: "m1",
  from: AOIFE,
  text: "Hi Sam, would you have time for a call to go over the proposal? Let me know what works.",
  date: "2026-09-29T09:15:00Z",
};

const ASKS = { asks_to_meet: 0.93, proposes_time: 0.1, owner_asked: 0.05, recurring: 0.02 };

/* ------------------------------ Candidates ------------------------------ */

describe("candidates code finds", () => {
  test("clock times: am and pm, 24-hour, noon, a bare hour after 'at'", () => {
    const found = clockCandidates(
      "How about Thursday at 3pm, or Friday 10:30? Otherwise at 4, or noon Monday. 09:15 also.",
      8,
    );
    expect(found.map((c) => c.text)).toEqual(["3pm", "10:30", "at 4", "noon", "09:15"]);
    expect(found[0]).toMatchObject({ hour24: 15, minute: 0, meridiem: "pm" });
    expect(found[1]).toMatchObject({ hour24: null, hour: 10, minute: 30 });
    expect(found[2]).toMatchObject({ hour24: null, hour: 4 });
    expect(found[3]).toMatchObject({ hour24: 12 });
    expect(found[4]).toMatchObject({ hour24: 9, minute: 15 });
  });

  test("zones: abbreviations, a UTC offset and a city's time map to IANA zones", () => {
    const found = zoneCandidates(
      "3pm ET works, that is 9pm CET, or 14:00 UTC+2, London time is fine",
      8,
    );
    expect(found).toEqual([
      { text: "ET", zone: "America/New_York" },
      { text: "CET", zone: "Europe/Paris" },
      { text: "UTC+2", zone: "Etc/GMT-2" },
      { text: "London time", zone: "Europe/London" },
    ]);
  });

  test("the gate words and the Date header's offset", () => {
    expect(hasGateWord("Shall we catch up next week?", ["catch up"])).toBe(true);
    expect(hasGateWord("Your receipt is attached", ["meet", "call"])).toBe(false);
    // "recall" holds "call" but is not the word.
    expect(hasGateWord("I recall the invoice", ["call"])).toBe(false);
    expect(offsetOfDateHeader("Tue, 29 Sep 2026 10:15:00 -0700 (PDT)")).toBe(-420);
    expect(offsetOfDateHeader("Tue, 29 Sep 2026 10:15:00 +0100")).toBe(60);
    expect(offsetOfDateHeader(undefined)).toBeNull();
  });
});

/* ------------------------------ Date parts to times ------------------------------ */

const NONE_PART = { choice: "none", confidence: 0.99 };
function proposal(
  p: Partial<Record<keyof ProposalParts, { choice: string; confidence: number } | null>>,
): ProposalParts {
  return {
    form: NONE_PART,
    relative: NONE_PART,
    weekday: NONE_PART,
    week: NONE_PART,
    month: NONE_PART,
    day: NONE_PART,
    clock: null,
    meridiem: null,
    part: NONE_PART,
    ...p,
  } as ProposalParts;
}

function reading(proposals: ProposalParts[], patch: Partial<MeetingReading> = {}): MeetingReading {
  return {
    threadId: "t1",
    workspaceId: "ws",
    messageId: "m1",
    messageCount: 1,
    judgedBy: "typesafe",
    model: "jev-test",
    judgedAt: NOW.toISOString(),
    ownerWroteNewest: false,
    writtenAt: "2026-09-29T09:15:00Z",
    senderOffsetMinutes: null,
    notEnglish: false,
    asksToMeet: 0.2,
    ownerAsked: 0,
    proposesTime: 0.95,
    recurring: 0,
    length: null,
    zone: null,
    clocks: clockCandidates("3pm 15:00 10:30 at 4", 8),
    proposals,
    ...patch,
  };
}

const ctx = (now = NOW) => ({
  ownerZone: ZONE,
  weekStartsMonday: true,
  lengthMinutes: 30,
  timeConfidence: 0.7,
  work: { startHour: 8, endHour: 19, days: ["mon", "tue", "wed", "thu", "fri"] },
  partsOfDay: {
    morning: { start: 8, end: 12 },
    afternoon: { start: 12, end: 17 },
    evening: { start: 17, end: 20 },
  },
  now,
});
const hi = (choice: string) => ({ choice, confidence: 0.95 });

describe("date parts resolved by code", () => {
  test("'tomorrow' counts from the day the Message was written in the owner's zone, not UTC", () => {
    // Written at 00:30 on Wednesday in London, 23:30 on Tuesday in UTC.
    const r = resolveReading(
      reading([proposal({ form: hi("relative"), relative: hi("tomorrow"), clock: hi("3pm") })], {
        writtenAt: "2026-09-29T23:30:00Z",
      }),
      ctx(),
    );
    expect(r.proposals[0]?.day).toBe("2026-10-01");
    expect(r.proposals[0]?.start).toBe("2026-10-01T14:00:00.000Z");
  });

  test("a bare weekday, 'this' and 'next' Tuesday from a Tuesday", () => {
    const one = (week: string, weekday: string) =>
      resolveReading(
        reading([
          proposal({
            form: hi("weekday"),
            weekday: hi(weekday),
            week: hi(week),
            clock: hi("10:30"),
          }),
        ]),
        ctx(),
      ).proposals[0];
    expect(one("none", "thursday")?.day).toBe("2026-10-01");
    expect(one("this", "thursday")?.day).toBe("2026-10-01");
    expect(one("next", "tuesday")?.day).toBe("2026-10-06");
    // A bare weekday on the same weekday is that day.
    expect(one("none", "tuesday")?.day).toBe("2026-09-29");
    // "10:30" with no am or pm: working hours decide (22:30 is outside them).
    expect(one("none", "thursday")?.start).toBe("2026-10-01T09:30:00.000Z");
  });

  test("DST: 15:00 London is 14:00 UTC before the change and 15:00 UTC after it", () => {
    const at = (day: string) =>
      resolveReading(
        reading([
          proposal({
            form: hi("absolute"),
            month: hi("october"),
            day: hi(day),
            clock: hi("15:00"),
          }),
        ]),
        ctx(),
      ).proposals[0]?.start;
    expect(at("23")).toBe("2026-10-23T14:00:00.000Z");
    expect(at("26")).toBe("2026-10-26T15:00:00.000Z");
  });

  test("a stated zone wins over the owner's: 3pm ET is 19:00 UTC", () => {
    const r = resolveReading(
      reading(
        [
          proposal({
            form: hi("weekday"),
            weekday: hi("thursday"),
            week: hi("none"),
            clock: hi("3pm"),
          }),
        ],
        { zone: { choice: "ET", confidence: 0.9, iana: "America/New_York" } },
      ),
      ctx(),
    );
    expect(r.zone).toBe("America/New_York");
    expect(r.proposals[0]?.start).toBe("2026-10-01T19:00:00.000Z");
  });

  test("no zone stated and the sender is seven hours behind: the zone is unclear", () => {
    const r = resolveReading(
      reading(
        [
          proposal({
            form: hi("weekday"),
            weekday: hi("thursday"),
            week: hi("none"),
            clock: hi("3pm"),
          }),
        ],
        {
          senderOffsetMinutes: -420,
        },
      ),
      ctx(),
    );
    expect(r.proposals[0]?.flags).toContain("zone_unclear");
  });

  test("a month and day already well past this year means next year; 31 February is unsure", () => {
    const december = reading(
      [proposal({ form: hi("absolute"), month: hi("january"), day: hi("5"), clock: hi("10:30") })],
      { writtenAt: "2026-12-20T10:00:00Z" },
    );
    expect(resolveReading(december, ctx(new Date("2026-12-20T11:00:00Z"))).proposals[0]?.day).toBe(
      "2027-01-05",
    );
    const bad = resolveReading(
      reading([
        proposal({ form: hi("absolute"), month: hi("february"), day: hi("31"), clock: hi("3pm") }),
      ]),
      ctx(),
    );
    expect(bad.proposals[0]?.flags).toContain("unsure");
  });

  test("past times are flagged, outside working hours too", () => {
    const r = resolveReading(
      reading([
        proposal({ form: hi("absolute"), month: hi("september"), day: hi("28"), clock: hi("3pm") }),
        proposal({
          form: hi("weekday"),
          weekday: hi("thursday"),
          week: hi("none"),
          clock: { choice: "at 4", confidence: 0.9 },
          meridiem: hi("am"),
        }),
      ]),
      ctx(),
    );
    expect(r.proposals[0]?.flags).toContain("past");
    expect(r.proposals[1]?.flags).toContain("outside_hours");
  });
});

/* ------------------------------ The cases ------------------------------ */

describe("the cases and their chips", () => {
  test("asked to meet with no time: Offer times, three slots spread over days, clear of busy Events", async () => {
    const { meetings, fake, changes } = setup({
      messages: [asksNoTime],
      judgments: ASKS,
      events: [
        // Wednesday morning is taken on the owner's calendar.
        event("standup", "2026-09-30T07:00:00Z", "2026-09-30T11:00:00Z"),
        // A declined Event, an all-day one and a shared calendar's never block.
        event("declined", "2026-09-29T12:00:00Z", "2026-09-29T17:00:00Z", { response: "declined" }),
        event("offsite", "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z", { allDay: true }),
        event("team", "2026-10-01T07:00:00Z", "2026-10-01T18:00:00Z", { calendarId: "cal-shared" }),
      ],
    });
    const o = await meetings.options("ws", "t1", {});
    expect(o.case).toBe("asks");
    expect(o.chips.map((c) => c.kind)).toEqual(["offer_times"]);
    // Lead time 2 hours from 11:00 London: 13:00 today; Wednesday from 12:00 after the standup; Thursday at 08:00.
    expect(o.slots.map((s) => s.start)).toEqual([
      "2026-09-29T12:00:00.000Z",
      "2026-09-30T11:00:00.000Z",
      "2026-10-01T07:00:00.000Z",
    ]);
    expect(fake.judge.calls).toHaveLength(1);
    expect(changes[0]?.chip?.kind).toBe("offer_times");
  });

  test("one Jev request carries every meeting question over one Thread's state", async () => {
    const { meetings, fake } = setup({
      messages: [{ ...asksNoTime, text: "Could we meet Thursday at 3pm or Friday 10:30 CET?" }],
      judgments: ASKS,
    });
    await meetings.options("ws", "t1", {});
    expect(fake.judge.calls).toHaveLength(1);
    const ids = fake.judge.calls[0]?.questions ?? [];
    for (const id of [
      "asks_to_meet",
      "owner_asked",
      "proposes_time",
      "recurring",
      "length",
      "zone",
    ]) {
      expect(ids).toContain(id);
    }
    for (const n of [1, 2, 3]) {
      for (const p of [
        "form",
        "relative",
        "weekday",
        "week",
        "month",
        "day",
        "clock",
        "meridiem",
        "part",
      ]) {
        expect(ids).toContain(`p${n}_${p}`);
      }
    }
    const state = fake.judge.calls[0]?.state as {
      thread: { newest_message: { text: string; written: string } };
      clock_times: string[];
      zone_mentions: string[];
    };
    expect(state.clock_times).toEqual(["3pm", "10:30"]);
    expect(state.zone_mentions).toEqual(["CET"]);
    expect(state.thread.newest_message.written).toContain("Tuesday 29 September 2026");
    expect(fake.meter.rows.map((r) => r.task)).toEqual(["judge.meeting"]);
  });

  const proposes = (extra: Record<string, JudgeAnswer | number>) => ({
    asks_to_meet: 0.6,
    proposes_time: 0.95,
    owner_asked: 0,
    recurring: 0,
    ...extra,
  });
  const thursday3pm = parts(1, {
    form: choice("weekday"),
    weekday: choice("thursday"),
    week: choice("none"),
    clock: choice("3pm"),
    meridiem: choice("pm"),
  });
  const thursdayMsg: Msg = {
    ...asksNoTime,
    text: "Can we meet on Thursday at 3pm or Friday at 10:30?",
  };

  test("a proposed time the owner is free for: Schedule and Works for me", async () => {
    const { meetings } = setup({ messages: [thursdayMsg], judgments: proposes(thursday3pm) });
    const o = await meetings.options("ws", "t1", {});
    expect(o.case).toBe("proposes");
    expect(o.chips.map((c) => c.kind)).toEqual(["schedule", "accept"]);
    expect(o.chips[0]).toMatchObject({
      start: "2026-10-01T14:00:00.000Z",
      end: "2026-10-01T14:30:00.000Z",
    });
    expect(o.title).toBe("Catch up");
    expect(o.attendees).toEqual([AOIFE]);
  });

  test("busy then: Suggest another time with the nearest free slots, none overlapping", async () => {
    const busy = event("review", "2026-10-01T13:00:00Z", "2026-10-01T16:00:00Z");
    const { meetings } = setup({
      messages: [thursdayMsg],
      judgments: proposes(thursday3pm),
      events: [busy],
    });
    const o = await meetings.options("ws", "t1", {});
    expect(o.proposals[0]).toMatchObject({ free: false, busyWith: ["review"] });
    expect(o.chips.map((c) => c.kind)).toEqual(["suggest_time"]);
    const slots = o.chips[0]?.slots ?? [];
    expect(slots).toHaveLength(3);
    for (const s of slots) {
      expect(
        Date.parse(s.end) <= Date.parse(busy.start) || Date.parse(s.start) >= Date.parse(busy.end),
      ).toBe(true);
    }
    // The nearest free time on the day (just before the review), then the nearest on the days around it,
    // one a day under meetings.slots_per_day.
    expect(slots.map((s) => s.start)).toEqual([
      "2026-09-30T17:30:00.000Z",
      "2026-10-01T12:30:00.000Z",
      "2026-10-02T07:00:00.000Z",
    ]);
  });

  test("several proposals: the first free one is the chip, the busy one is kept as a proposal", async () => {
    const { meetings } = setup({
      messages: [thursdayMsg],
      events: [event("review", "2026-10-01T13:00:00Z", "2026-10-01T16:00:00Z")],
      judgments: proposes({
        ...thursday3pm,
        ...parts(2, {
          form: choice("weekday"),
          weekday: choice("friday"),
          week: choice("none"),
          clock: choice("10:30"),
          meridiem: choice("am"),
        }),
      }),
    });
    const o = await meetings.options("ws", "t1", {});
    expect(o.proposals.map((p) => p.free)).toEqual([false, true]);
    expect(o.chips[0]).toMatchObject({ kind: "schedule", start: "2026-10-02T09:30:00.000Z" });
  });

  test("an unsure time or an unclear zone: Pick a time, never a guess", async () => {
    const low = setup({
      messages: [thursdayMsg],
      judgments: proposes({ ...thursday3pm, p1_clock: choice("3pm", 0.4) }),
    });
    const o = await low.meetings.options("ws", "t1", {});
    expect(o.chips.map((c) => c.kind)).toEqual(["pick_time"]);
    expect(o.chips[0]?.flags).toContain("unsure");

    const zone = setup({
      messages: [{ ...thursdayMsg, headers: { date: "Tue, 29 Sep 2026 02:15:00 -0700" } }],
      judgments: proposes(thursday3pm),
    });
    const z = await zone.meetings.options("ws", "t1", {});
    expect(z.chips.map((c) => c.kind)).toEqual(["pick_time"]);
    expect(z.chips[0]?.flags).toContain("zone_unclear");
    // Unsure of the proposal itself, even with a clean time.
    const band = setup({
      messages: [thursdayMsg],
      judgments: proposes({ ...thursday3pm, proposes_time: 0.6 }),
    });
    expect((await band.meetings.options("ws", "t1", {})).chips.map((c) => c.kind)).toEqual([
      "pick_time",
    ]);
  });

  test("a day with no time: Offer times on that day, in the part of the day named", async () => {
    const { meetings } = setup({
      messages: [{ ...asksNoTime, text: "Are you free for a call Thursday afternoon?" }],
      judgments: proposes(
        parts(1, {
          form: choice("weekday"),
          weekday: choice("thursday"),
          week: choice("none"),
          part: choice("afternoon"),
        }),
      ),
    });
    const o = await meetings.options("ws", "t1", {});
    expect(o.chips[0]).toMatchObject({ kind: "offer_times", day: "2026-10-01" });
    for (const s of o.chips[0]?.slots ?? []) {
      expect(Date.parse(s.start)).toBeGreaterThanOrEqual(Date.parse("2026-10-01T11:00:00Z"));
      expect(Date.parse(s.end)).toBeLessThanOrEqual(Date.parse("2026-10-01T16:00:00Z"));
    }
  });

  test("a proposed time outside working hours shows, flagged", async () => {
    const { meetings } = setup({
      messages: [{ ...asksNoTime, text: "Could we meet Thursday at 8pm?" }],
      judgments: proposes(
        parts(1, {
          form: choice("weekday"),
          weekday: choice("thursday"),
          week: choice("none"),
          clock: choice("8pm"),
        }),
      ),
    });
    const o = await meetings.options("ws", "t1", {});
    expect(o.chips[0]?.kind).toBe("schedule");
    expect(o.chips[0]?.flags).toContain("outside_hours");
  });

  test("the owner said 'let's meet' and nobody answered: Offer times; the owner proposed times: nothing", async () => {
    const ownMsg: Msg = {
      id: "m1",
      from: OWNER,
      text: "Great chatting. Let's meet to go through it.",
      date: asksNoTime.date,
    };
    const asked = setup({
      messages: [ownMsg],
      judgments: { owner_asked: 0.9, asks_to_meet: 0.1, proposes_time: 0.05 },
    });
    const o = await asked.meetings.options("ws", "t1", {});
    expect(o.case).toBe("owner_asked");
    expect(o.chips.map((c) => c.kind)).toEqual(["offer_times"]);

    const proposed = setup({
      messages: [{ ...ownMsg, text: "Let's meet Thursday at 3pm?" }],
      judgments: { owner_asked: 0.9, proposes_time: 0.95, ...thursday3pm },
    });
    const p = await proposed.meetings.options("ws", "t1", {});
    expect(p.case).toBe("owner_proposed");
    expect(p.chips).toEqual([]);
  });

  test("the reply arrives with a time: the same logic reads the new Message", async () => {
    const own: Msg = {
      id: "m1",
      from: OWNER,
      text: "Let's meet next week, when suits you?",
      date: "2026-09-28T09:00:00Z",
    };
    const t = setup({ messages: [own], judgments: { owner_asked: 0.9 } });
    expect((await t.meetings.options("ws", "t1", {})).case).toBe("owner_asked");
    expect(t.fake.judge.calls).toHaveLength(1);
    // Asking again for the same Message asks nothing.
    await t.meetings.options("ws", "t1", {});
    expect(t.fake.judge.calls).toHaveLength(1);
    t.src.add({
      id: "m2",
      from: AOIFE,
      text: "Thursday at 3pm works for a call?",
      date: asksNoTime.date,
    });
    t.fake.judge.answer("proposes_time", 0.95);
    for (const [k, v] of Object.entries(thursday3pm)) t.fake.judge.answer(k, v);
    const o = await t.meetings.options("ws", "t1", {});
    expect(t.fake.judge.calls).toHaveLength(2);
    expect(o.messageId).toBe("m2");
    expect(o.chips[0]?.kind).toBe("schedule");
  });

  test("an Invite in the mail: the invite bar owns it and the judge is never asked", async () => {
    const t = setup({
      messages: [{ ...thursdayMsg, attachments: [{ mediaType: "text/calendar" }] }],
      judgments: proposes(thursday3pm),
    });
    const o = await t.meetings.options("ws", "t1", {});
    expect(o.case).toBe("invite");
    expect(o.chips).toEqual([]);
    expect(t.fake.judge.calls).toHaveLength(0);
  });

  test("no meeting words: the gate keeps the judge off", async () => {
    const t = setup({
      subject: "Invoice INV-2291",
      messages: [
        { ...asksNoTime, text: "Your invoice INV-2291 is attached. Thanks for your business." },
      ],
    });
    const o = await t.meetings.options("ws", "t1", {});
    expect(o.case).toBe("none");
    expect(t.fake.judge.calls).toHaveLength(0);
  });

  test("not English: the answers count as unsure, so only Pick a time", async () => {
    const t = setup({
      messages: [
        {
          ...asksNoTime,
          text: "Hola Sam, ¿podríamos tener una llamada el jueves por la tarde para revisar la propuesta del proyecto con el equipo?",
        },
      ],
      judgments: { ...ASKS, call: 1 } as never,
      patch: { "meetings.gate_words": ["llamada"] },
    });
    const o = await t.meetings.options("ws", "t1", {});
    expect(o.chips.map((c) => c.kind)).toEqual(["pick_time"]);
    expect(o.flags).toContain("not_english");
  });

  test("a repeating meeting: Pick a time", async () => {
    const t = setup({ messages: [asksNoTime], judgments: { ...ASKS, recurring: 0.9 } });
    const o = await t.meetings.options("ws", "t1", {});
    expect(o.chips.map((c) => c.kind)).toEqual(["pick_time"]);
    expect(o.chips[0]?.flags).toContain("recurring");
  });

  test("no calendar connected: one chip that says so", async () => {
    const t = setup({ messages: [asksNoTime], judgments: ASKS, noCalendar: true });
    const o = await t.meetings.options("ws", "t1", {});
    expect(o.calendar).toBe(false);
    expect(o.chips.map((c) => c.kind)).toEqual(["no_calendar"]);
  });

  test("a length the Message implies, when the judge is sure of it", async () => {
    const t = setup({ messages: [asksNoTime], judgments: { ...ASKS, length: choice("60", 0.9) } });
    const o = await t.meetings.options("ws", "t1", {});
    expect(o.lengthMinutes).toBe(60);
    const s = o.slots[0];
    expect(s && Date.parse(s.end) - Date.parse(s.start)).toBe(60 * 60_000);
    const unsure = setup({
      messages: [asksNoTime],
      judgments: { ...ASKS, length: choice("60", 0.3) },
    });
    expect((await unsure.meetings.options("ws", "t1", {})).lengthMinutes).toBe(30);
  });
});

/* ------------------------------ The AI level and the paths ------------------------------ */

describe("the AI level, the judge and the language model", () => {
  test("AI off: no options, no Job; meetings off: no chips", async () => {
    const off = setup({ messages: [asksNoTime], judgments: ASKS, level: "off" });
    await expect(off.meetings.options("ws", "t1", {})).rejects.toBeInstanceOf(AiOffError);
    const enqueued: string[] = [];
    off.meetings.registerSteps({
      registerStep: () => {},
      enqueue: async (s: string) => {
        enqueued.push(s);
      },
    } as never);
    await off.meetings.threadReady("ws", "t1");
    expect(enqueued).toEqual([]);
    expect(off.fake.judge.calls).toHaveLength(0);

    const disabled = setup({
      messages: [asksNoTime],
      judgments: ASKS,
      patch: { "meetings.enabled": false },
    });
    expect((await disabled.meetings.options("ws", "t1", {})).chips).toEqual([]);
    expect(disabled.fake.judge.calls).toHaveLength(0);
  });

  test("automate: a new Message queues one meeting Job per Message", async () => {
    const t = setup({ messages: [asksNoTime], judgments: ASKS, level: "automate" });
    const enqueued: Array<{ step: string; id: string }> = [];
    let step:
      | ((job: {
          id: string;
          payload: { workspaceId: string; threadId: string };
        }) => Promise<string>)
      | null = null;
    t.meetings.registerSteps({
      registerStep: (_name: string, fn: typeof step) => {
        step = fn;
      },
      enqueue: async (s: string, _p: unknown, o: { id: string }) => {
        enqueued.push({ step: s, id: o.id });
      },
    } as never);
    await t.meetings.threadReady("ws", "t1");
    expect(enqueued).toEqual([{ step: MEETING_STEP, id: "meeting:t1:m1" }]);
    await (step as unknown as (j: unknown) => Promise<string>)({
      id: "meeting:t1:m1",
      payload: { workspaceId: "ws", threadId: "t1" },
    });
    expect(t.store.rows.get("t1")?.chip?.kind).toBe("offer_times");
    await t.meetings.threadReady("ws", "t1");
    expect(enqueued).toHaveLength(1);
  });

  test("without TypeSafe the language model answers the same questions; without either, nothing", async () => {
    const llm = setup({
      messages: [asksNoTime],
      keys: { anthropic: "sk-ant-fake" },
      answer: (call) => {
        expect(call.prompt).toContain("asks_to_meet");
        expect(call.prompt).toContain("p1_form");
        return JSON.stringify({
          asks_to_meet: 0.9,
          proposes_time: 0.1,
          owner_asked: 0,
          recurring: 0,
        });
      },
    });
    const o = await llm.meetings.options("ws", "t1", {});
    expect(o.judgedBy).toBe("llm");
    expect(o.chips.map((c) => c.kind)).toEqual(["offer_times"]);
    expect(llm.fake.judge.calls).toHaveLength(0);

    const none = setup({ messages: [asksNoTime], keys: {} });
    const n = await none.meetings.options("ws", "t1", {});
    expect(n.case).toBe("none");
    expect(n.chips).toEqual([]);
  });

  test("the prompt path reads garbled answers as unsure, never as yes", () => {
    const q = {
      a: { type: "noul" as const, instructions: "x" },
      b: { type: "choice" as const, instructions: "y", criteria: { one: null, none: null } },
    };
    const read = readPromptJudgeOutput(
      '{"a": "yes", "b": {"choice": "seven", "confidence": 1}}',
      q,
    );
    expect(read.a.noul).toBe(0.5);
    expect(read.b).toMatchObject({ choice: "none", confidence: 0 });
  });
});

/* ------------------------------ The reply and the approvals ------------------------------ */

describe("the reply is grounded and nothing leaves without the user", () => {
  test("the model's reply is used only when it names just the offered times", async () => {
    const t = setup({
      messages: [asksNoTime],
      judgments: ASKS,
      events: [event("standup", "2026-09-30T07:00:00Z", "2026-09-30T11:00:00Z")],
    });
    const o = await t.meetings.options("ws", "t1", {});
    const slots = o.slots.map((s) => ({ start: s.start, end: s.end }));
    t.fake.chat.answer(
      "Happy to talk. Would one of these suit you?\n\nTuesday 29 September, 13:00 to 13:30 BST\nWednesday 30 September, 12:00 to 12:30 BST\nThursday 1 October, 08:00 to 08:30 BST",
    );
    const good = await t.meetings.draft("ws", "t1", { kind: "offer", slots });
    expect(good.written).toBe(true);
    expect(good.text).toContain("13:00");

    // A time that was never offered: the template instead, with only the offered times.
    t.fake.chat.answer("How about Friday at 4pm instead?");
    const bad = await t.meetings.draft("ws", "t1", { kind: "offer", slots });
    expect(bad.written).toBe(false);
    expect(bad.text).toContain("Happy to meet.");
    expect(groundedIn(bad.text, bad.slots, ZONE, null)).toBe(true);
    expect(bad.text).not.toContain("16:00");
    expect(bad.text).not.toContain("\u2014");
  });

  test("a slot that became busy is left out; none left means no text", async () => {
    const t = setup({ messages: [asksNoTime], judgments: ASKS });
    const taken = { start: "2026-09-30T12:00:00.000Z", end: "2026-09-30T12:30:00.000Z" };
    const free = { start: "2026-10-01T09:00:00.000Z", end: "2026-10-01T09:30:00.000Z" };
    const cal = t.cal;
    t.fake.chat.answer("nothing grounded");
    const events = [event("new", taken.start, taken.end)];
    const later = setup({ messages: [asksNoTime], judgments: ASKS, events });
    const result = await later.meetings.draft("ws", "t1", { kind: "offer", slots: [taken, free] });
    expect(result.slots.map((s) => s.start)).toEqual([free.start]);
    const none = await later.meetings.draft("ws", "t1", { kind: "offer", slots: [taken] });
    expect(none).toMatchObject({ text: "", slots: [] });
    expect(cal.writes).toEqual([]);
  });

  test("an accept names the one time; the Schedule chip creates nothing on the Server before approval", async () => {
    const t = setup({
      messages: [{ ...asksNoTime, text: "Can we meet on Thursday at 3pm?" }],
      judgments: {
        asks_to_meet: 0.6,
        proposes_time: 0.95,
        ...parts(1, {
          form: choice("weekday"),
          weekday: choice("thursday"),
          week: choice("none"),
          clock: choice("3pm"),
        }),
      },
    });
    const o = await t.meetings.options("ws", "t1", {});
    const accept = o.chips.find((c) => c.kind === "accept");
    t.fake.chat.answer("Thursday at 15:00 works for me. Speak then.");
    const reply = await t.meetings.draft("ws", "t1", {
      kind: "accept",
      slots: [{ start: accept?.start as string, end: accept?.end as string }],
    });
    expect(reply.written).toBe(true);
    // Options and drafts read the calendar; they never write to it.
    expect(t.cal.writes).toEqual([]);
  });
});

/* ------------------------------ The agent ------------------------------ */

describe("meeting_options", () => {
  test("the agent reads the case, the free and busy proposals and slots in its own window", async () => {
    const t = setup({ messages: [asksNoTime], judgments: ASKS });
    const seam: MeetingsSeam = { options: (ws, id, r) => t.meetings.options(ws, id, r) };
    const tool = MEETING_TOOLS[0] as unknown as {
      name: string;
      tier: string;
      run(input: unknown, ctx: unknown): Promise<{ kind: string; text: string; data: unknown }>;
    };
    expect(tool.name).toBe("meeting_options");
    expect(tool.tier).toBe("read");
    const result = await tool.run(
      {
        thread_id: "t1",
        from: "2026-10-05T00:00:00+01:00",
        to: "2026-10-10T00:00:00+01:00",
        count: 2,
      },
      { host: { workspaceId: "ws" }, extensions: { meetings: seam } },
    );
    expect(result.kind).toBe("result");
    const data = result.data as { case: string; slots: Array<{ start: string }> };
    expect(data.case).toBe("asks");
    expect(data.slots).toHaveLength(2);
    for (const s of data.slots)
      expect(Date.parse(s.start)).toBeGreaterThanOrEqual(Date.parse("2026-10-04T23:00:00Z"));
    expect(result.text).toContain("Free slots:");
    const refused = await tool.run(
      { thread_id: "t1" },
      { host: { workspaceId: "ws" }, extensions: {} },
    );
    expect(refused.kind).toBe("refused");
  });
});
