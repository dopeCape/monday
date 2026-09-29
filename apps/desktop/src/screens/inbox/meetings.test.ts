// Meeting chips on the Device (docs/spec/meetings.md): their words from the
// strings Settings, which chips show under the Settings and the AI level, and
// the runner over fake seams, which keeps ADR 0002: Schedule only opens the
// approval card, the reply chips only open a Draft, and a chip from the list
// (the Cache, maybe stale) is checked again before it acts.

import { describe, expect, test } from "bun:test";
import type {
  EventPreview,
  MeetingChip,
  MeetingDraftKind,
  MeetingOptions,
  Settings,
} from "@monday/shared";
import { defaultSettings } from "@monday/shared";
import {
  calendarNewTarget,
  describeMeetingChip,
  listMeetingChip,
  type MeetingRunDeps,
  meetingEventPreview,
  parseCalendarNewTarget,
  readerMeetingChips,
  runMeetingChip,
} from "./meetings.ts";

// Tuesday 29 September 2026, 10:00 on the Device's clock.
const NOW = new Date(2026, 8, 29, 10, 0, 0);
const at = (d: number, h: number, mi = 0) => new Date(2026, 8, d, h, mi, 0).toISOString();
const aoife = { name: "Aoife Byrne", email: "aoife@byrne.test" };

// The shipped AI level is `off`; these chips are an `assist` and `automate` thing.
const settings = (over: Partial<Settings> = {}): Settings => ({
  ...defaultSettings(),
  "ai.level": "assist",
  ...over,
});

const thursday: MeetingChip = {
  kind: "schedule",
  start: new Date(2026, 9, 1, 15, 0).toISOString(),
  end: new Date(2026, 9, 1, 15, 30).toISOString(),
  flags: [],
};
const accept: MeetingChip = { ...thursday, kind: "accept" };
const offer: MeetingChip = {
  kind: "offer_times",
  slots: [
    { start: at(30, 10), end: at(30, 10, 30) },
    {
      start: new Date(2026, 9, 1, 11).toISOString(),
      end: new Date(2026, 9, 1, 11, 30).toISOString(),
    },
  ],
  flags: [],
};

function options(chips: MeetingChip[]): MeetingOptions {
  return {
    threadId: "t1",
    messageId: "m2",
    case: "proposes",
    lengthMinutes: 30,
    timeZone: "Europe/Dublin",
    proposals: [],
    slots: [],
    chips,
    title: "Take-home review",
    attendees: [aoife],
    calendar: true,
    judgedBy: "typesafe",
    model: "jev-1.13.0",
    judgedAt: NOW.toISOString(),
    flags: [],
  };
}

/** Fake seams that record what a chip asked for. */
function fakeDeps(over: Partial<MeetingRunDeps> = {}, fresh: MeetingOptions | null = null) {
  const seen = {
    drafts: [] as Array<{ kind: MeetingDraftKind; slots: Array<{ start: string; end: string }> }>,
    replies: [] as string[],
    cards: [] as EventPreview[],
    picks: [] as string[],
    toasts: [] as string[],
    refreshes: 0,
    created: 0,
  };
  const deps: MeetingRunDeps = {
    settings: settings(),
    now: NOW,
    zone: "Europe/Dublin",
    refresh: async () => {
      seen.refreshes += 1;
      return fresh;
    },
    draft: async (kind, slots) => {
      seen.drafts.push({ kind, slots });
      return { text: "Would Thursday 15:00 work?", slots: [], written: true, voice: false };
    },
    reply: (text) => seen.replies.push(text),
    schedule: (preview) => seen.cards.push(preview),
    pick: (target) => seen.picks.push(calendarNewTarget(target)),
    toast: (text) => seen.toasts.push(text),
    ...over,
  };
  return { deps, seen };
}

describe("chip words", () => {
  test("Schedule names the time on the Device's clock; flags go in the tooltip, no em-dashes", () => {
    const s = settings();
    const view = describeMeetingChip({ ...thursday, flags: ["outside_hours"] }, s, NOW);
    expect(view.label).toBe("Schedule Thu 15:00");
    expect(view.title).toContain("outside your working hours");
    expect(`${view.label}${view.title}`).not.toContain("—");
  });

  test("Offer times names the day when one was proposed, and lists the slots in the tooltip", () => {
    const s = settings();
    expect(describeMeetingChip(offer, s, NOW).label).toBe("Offer times");
    expect(describeMeetingChip({ ...offer, day: "2026-10-01" }, s, NOW).label).toBe(
      "Offer times Thu",
    );
    expect(describeMeetingChip(offer, s, NOW).title).toContain("Tomorrow 10:00");
  });

  test("the words are the Settings' own", () => {
    const s = settings({ "strings.meetings.chip.suggest": "Another time?" });
    expect(describeMeetingChip({ kind: "suggest_time", flags: [] }, s, NOW).label).toBe(
      "Another time?",
    );
  });
});

describe("which chips show", () => {
  test("the reader caps at meetings.max_in_reader and hides a scheduled chip", () => {
    const opts = options([thursday, accept]);
    expect(readerMeetingChips(opts, settings(), NOW).map((c) => c.kind)).toEqual([
      "schedule",
      "accept",
    ]);
    expect(
      readerMeetingChips(opts, settings({ "meetings.max_in_reader": 1 }), NOW).map((c) => c.kind),
    ).toEqual(["schedule"]);
    expect(
      readerMeetingChips(opts, settings(), NOW, new Set(["schedule"])).map((c) => c.kind),
    ).toEqual(["accept"]);
  });

  test("AI level off, or meetings off, shows no chip anywhere", () => {
    const opts = options([thursday]);
    for (const s of [settings({ "ai.level": "off" }), settings({ "meetings.enabled": false })]) {
      expect(readerMeetingChips(opts, s, NOW)).toEqual([]);
      expect(listMeetingChip(thursday, s, NOW)).toBeNull();
    }
  });

  test("the list chip follows meetings.in_list", () => {
    expect(listMeetingChip(thursday, settings(), NOW)?.always).toBe(false);
    expect(listMeetingChip(thursday, settings({ "meetings.in_list": "always" }), NOW)?.always).toBe(
      true,
    );
    expect(listMeetingChip(thursday, settings({ "meetings.in_list": "off" }), NOW)).toBeNull();
    expect(listMeetingChip(null, settings(), NOW)).toBeNull();
  });
});

describe("runMeetingChip", () => {
  test("Schedule opens the card with the Thread's title and people and creates nothing", async () => {
    const { deps, seen } = fakeDeps();
    const out = await runMeetingChip(thursday, options([thursday]), deps);
    expect(out.ok).toBe(true);
    expect(seen.cards).toHaveLength(1);
    expect(seen.cards[0]).toMatchObject({
      action: "schedule",
      title: "Take-home review",
      start: thursday.start,
      end: thursday.end,
      attendees: [aoife],
      conflicts: [],
    });
    expect(seen.created).toBe(0);
    expect(seen.drafts).toHaveLength(0);
  });

  test("the card's link follows meetings.add_link and the Meeting link Setting", () => {
    const opts = options([thursday]);
    const jitsi = settings({ "calendar.meeting_link": "jitsi" });
    expect(meetingEventPreview(opts, thursday, jitsi, null)?.link).toBe("jitsi");
    expect(
      meetingEventPreview(opts, thursday, { ...jitsi, "meetings.add_link": false }, null)?.link,
    ).toBeNull();
  });

  test("Offer times writes a reply Draft from the offered slots and never sends", async () => {
    const { deps, seen } = fakeDeps();
    await runMeetingChip(offer, options([offer]), deps);
    expect(seen.drafts).toEqual([
      { kind: "offer", slots: (offer.slots ?? []).map((x) => ({ start: x.start, end: x.end })) },
    ]);
    expect(seen.replies).toEqual(["Would Thursday 15:00 work?"]);
    expect(seen.cards).toHaveLength(0);
  });

  test("Works for me drafts an accept over the proposed time", async () => {
    const { deps, seen } = fakeDeps();
    await runMeetingChip(accept, options([thursday, accept]), deps);
    expect(seen.drafts).toEqual([
      { kind: "accept", slots: [{ start: accept.start as string, end: accept.end as string }] },
    ]);
  });

  test("a draft that fails says why and opens nothing", async () => {
    const { deps, seen } = fakeDeps({
      draft: async () => {
        throw new Error("no language model");
      },
    });
    const out = await runMeetingChip(offer, options([offer]), deps);
    expect(out.ok).toBe(false);
    expect(seen.replies).toHaveLength(0);
    expect(seen.toasts[0]).toContain("no language model");
  });

  test("Pick a time opens the editor prefilled with the day, title and people", async () => {
    const { deps, seen } = fakeDeps();
    const pick: MeetingChip = { kind: "pick_time", day: "2026-10-01", flags: ["unsure"] };
    await runMeetingChip(pick, options([pick]), deps);
    const target = parseCalendarNewTarget(seen.picks[0] ?? "");
    expect(target?.title).toBe("Take-home review");
    expect(target?.attendees).toEqual([aoife]);
    const start = new Date(target?.start ?? "");
    expect(start.getDate()).toBe(1);
    expect(start.getHours()).toBe(settings()["calendar.day_start_hour"]);
  });

  test("no calendar explains itself", async () => {
    const { deps, seen } = fakeDeps();
    const out = await runMeetingChip({ kind: "no_calendar", flags: [] }, options([]), deps);
    expect(out).toEqual({ ok: false, reason: "no_calendar" });
    expect(seen.toasts).toEqual([settings()["strings.meetings.no_calendar"]]);
  });

  test("a list chip is checked again first, and the fresh one is used", async () => {
    const moved: MeetingChip = { ...thursday, start: at(30, 16), end: at(30, 16, 30) };
    const { deps, seen } = fakeDeps({}, options([moved]));
    await runMeetingChip(thursday, null, deps);
    expect(seen.refreshes).toBe(1);
    expect(seen.toasts).toEqual([settings()["strings.meetings.changed"]]);
    expect(seen.cards[0]?.start).toBe(moved.start);
  });

  test("a list chip whose kind changed (now busy) opens nothing and says so", async () => {
    const suggest: MeetingChip = { kind: "suggest_time", slots: offer.slots, flags: [] };
    const { deps, seen } = fakeDeps({}, options([suggest]));
    const out = await runMeetingChip(thursday, null, deps);
    expect(out.ok).toBe(false);
    expect(seen.cards).toHaveLength(0);
    expect(seen.toasts).toEqual([settings()["strings.meetings.changed"]]);
  });

  test("an unchanged list chip acts without a toast", async () => {
    const { deps, seen } = fakeDeps({}, options([thursday]));
    await runMeetingChip(thursday, null, deps);
    expect(seen.toasts).toEqual([]);
    expect(seen.cards).toHaveLength(1);
  });
});
