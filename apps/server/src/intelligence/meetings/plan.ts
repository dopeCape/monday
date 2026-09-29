// From a stored reading and the calendar as it is now to the chips
// (docs/spec/meetings.md, "The cases"): code decides everything here. It
// resolves the proposed times, checks each against the owner's busy spans
// (find_free_time's rules: declined, cancelled and all-day Events never
// block), looks for free slots with find_free_time's own search, and picks
// the case and its chips by the thresholds, which are Settings. Pure: the
// busy spans come in, MeetingOptions go out.

import type {
  MeetingCase,
  MeetingChip,
  MeetingFlag,
  MeetingOptions,
  MeetingProposal,
  MeetingSlot,
  PartOfDay,
  Person,
} from "@monday/shared";
import { MEETING_LENGTHS, zonedToUtc } from "@monday/shared";
import { freeSlots, type WorkDay } from "../agent/tools/calendar.ts";
import { NOT_STATED } from "./questions.ts";
import {
  insideWorkingHours,
  type MeetingReading,
  type ResolveContext,
  resolveReading,
  type WorkingHours,
} from "./resolve.ts";

/** One of the owner's Events that blocks time, as the calendar gave it. */
export interface BusySpan {
  start: string;
  end: string;
  title: string;
  /** The guests' addresses, lowercased. */
  attendees: string[];
}

export interface PlanSettings {
  offerThreshold: number;
  scheduleThreshold: number;
  timeConfidence: number;
  suggestThreshold: number;
  pickThreshold: number;
  lengthConfidence: number;
  recurringThreshold: number;
  nonEnglish: "unsure" | "trust";
  leadMinutes: number;
  slots: number;
  slotsPerDay: number;
  lookaheadDays: number;
  /** calendar.default_duration_minutes: the Meeting length Setting. */
  defaultLength: number;
  snapMinutes: number;
  work: WorkingHours;
  weekStartsMonday: boolean;
  partsOfDay: Record<PartOfDay, { start: number; end: number }>;
}

export interface PlanInput {
  reading: MeetingReading | null;
  threadId: string;
  now: Date;
  ownerZone: string;
  busy: readonly BusySpan[];
  /** Whether a calendar of the owner's could be read. */
  calendar: boolean;
  /** A calendar Invite is attached to the Thread: the invite bar owns it. */
  hasInvite: boolean;
  subject: string;
  /** The Event title when the subject is empty. */
  titleFallback: string;
  owner: Person;
  /** The people on the Thread. */
  people: readonly Person[];
  settings: PlanSettings;
  /** The agent's own window, length and count ("some times next week"). */
  override?:
    | {
        from?: Date | undefined;
        to?: Date | undefined;
        lengthMinutes?: number | undefined;
        count?: number | undefined;
      }
    | undefined;
}

const MINUTE = 60_000;
const DAY = 86_400_000;

/** The window the busy spans must cover for a reading: from now to past the latest proposal. */
export function planWindow(
  reading: MeetingReading | null,
  now: Date,
  settings: PlanSettings,
  override?: PlanInput["override"],
): { from: Date; to: Date } {
  let to = now.getTime() + settings.lookaheadDays * DAY;
  if (override?.to) to = Math.max(to, override.to.getTime());
  if (reading) {
    const written = Date.parse(reading.writtenAt);
    // A proposal can sit up to a year after the message; the plan looks a look-ahead past it.
    if (Number.isFinite(written))
      to = Math.max(to, Math.min(written + 400 * DAY, now.getTime() + 92 * DAY));
  }
  return {
    from: new Date(now.getTime() - DAY),
    to: new Date(Math.min(to, now.getTime() + 92 * DAY)),
  };
}

/** The subject as an Event title: "Re:" and "Fwd:" gone. */
export function eventTitle(subject: string, fallback: string): string {
  const t = subject.replace(/^\s*((re|fwd?|aw|wg|sv|tr)\s*:\s*)+/i, "").trim();
  return t || fallback;
}

function others(people: readonly Person[], owner: Person): Person[] {
  const me = owner.email.toLowerCase();
  const seen = new Set<string>();
  const out: Person[] = [];
  for (const p of people) {
    const email = p.email.toLowerCase();
    if (!email || email === me || seen.has(email) || /no-?reply|mailer-daemon/.test(email))
      continue;
    seen.add(email);
    out.push({ name: p.name, email: p.email });
  }
  return out;
}

const overlapping = (busy: readonly BusySpan[], start: number, end: number) =>
  busy.filter((b) => Date.parse(b.start) < end && Date.parse(b.end) > start);

/** Slots spread over days: at most `perDay` on one day, earliest first, `count` in all. */
export function spreadSlots(
  slots: readonly MeetingSlot[],
  count: number,
  perDay: number,
  zone: string,
): MeetingSlot[] {
  const byDay = new Map<string, number>();
  const out: MeetingSlot[] = [];
  const dayOf = (at: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(at));
  for (const s of slots) {
    const day = dayOf(s.start);
    const n = byDay.get(day) ?? 0;
    if (n >= perDay) continue;
    byDay.set(day, n + 1);
    out.push(s);
    if (out.length >= count) break;
  }
  return out;
}

/** The slots nearest a time, spread over days, returned in time order. */
export function nearestSlots(
  slots: readonly MeetingSlot[],
  target: number,
  count: number,
  perDay: number,
  zone: string,
): MeetingSlot[] {
  const ranked = [...slots].sort(
    (a, b) =>
      Math.abs(Date.parse(a.start) - target) - Math.abs(Date.parse(b.start) - target) ||
      Date.parse(a.start) - Date.parse(b.start),
  );
  return spreadSlots(ranked, count, perDay, zone).sort(
    (a, b) => Date.parse(a.start) - Date.parse(b.start),
  );
}

function search(
  input: PlanInput,
  from: number,
  to: number,
  length: number,
  hours?: { start: number; end: number },
): MeetingSlot[] {
  const s = input.settings;
  if (to <= from) return [];
  return freeSlots({
    from: new Date(from),
    to: new Date(to),
    durationMinutes: length,
    busy: input.busy,
    dayStartHour: hours?.start ?? s.work.startHour,
    dayEndHour: hours?.end ?? s.work.endHour,
    workDays: s.work.days as WorkDay[],
    stepMinutes: s.snapMinutes,
    timeZone: input.ownerZone,
    limit: 200,
  }).map((x) => ({ start: x.start, end: x.end }));
}

function civilOf(day: string): { y: number; mo: number; d: number } {
  const [y = "0", mo = "0", d = "0"] = day.split("-");
  return { y: Number(y), mo: Number(mo), d: Number(d) };
}

/** The case, the proposals with free or busy, the slots and the chips, likeliest first. */
export function planMeeting(input: PlanInput): MeetingOptions {
  const s = input.settings;
  const reading = input.reading;
  const now = input.now.getTime();
  const earliest = now + s.leadMinutes * MINUTE;
  const count = input.override?.count ?? s.slots;
  const lengthRead =
    reading?.length &&
    reading.length.choice !== NOT_STATED &&
    (MEETING_LENGTHS as readonly string[]).includes(reading.length.choice) &&
    reading.length.confidence >= s.lengthConfidence
      ? Number(reading.length.choice)
      : null;
  const lengthMinutes = input.override?.lengthMinutes ?? lengthRead ?? s.defaultLength;
  const attendees = others(input.people, input.owner);
  const base: Omit<MeetingOptions, "case" | "proposals" | "slots" | "chips" | "flags"> = {
    threadId: input.threadId,
    messageId: reading?.messageId ?? "",
    lengthMinutes,
    timeZone: input.ownerZone,
    title: eventTitle(input.subject, input.titleFallback),
    attendees,
    calendar: input.calendar,
    judgedBy: reading?.judgedBy ?? "none",
    model: reading?.model ?? "",
    judgedAt: reading?.judgedAt ?? null,
  };
  const flags: MeetingFlag[] = [];
  const done = (
    kase: MeetingCase,
    chips: MeetingChip[],
    proposals: MeetingProposal[] = [],
    slots: MeetingSlot[] = [],
  ): MeetingOptions => {
    // Without a calendar nothing can be checked: one chip says so instead.
    const shown =
      !input.calendar && chips.length > 0 ? [{ kind: "no_calendar" as const, flags: [] }] : chips;
    return { ...base, case: kase, proposals, slots, chips: shown, flags };
  };

  // The agent's own window ("some times next week"): slots whatever the reading says.
  const window = input.override?.from || input.override?.to;
  const offerIn = (from: number, to: number, hours?: { start: number; end: number }) =>
    spreadSlots(
      search(input, Math.max(from, earliest), to, lengthMinutes, hours),
      count,
      hours ? count : s.slotsPerDay,
      input.ownerZone,
    );
  const generalOffer = () =>
    offerIn(
      input.override?.from?.getTime() ?? earliest,
      input.override?.to?.getTime() ?? now + s.lookaheadDays * DAY,
    );

  if (input.hasInvite) return done("invite", []);
  if (!reading || reading.judgedBy === "none" || reading.judgedBy === "gate") {
    return done("none", [], [], window ? generalOffer() : []);
  }

  const ctx: ResolveContext = {
    ownerZone: input.ownerZone,
    weekStartsMonday: s.weekStartsMonday,
    lengthMinutes,
    timeConfidence: s.timeConfidence,
    work: s.work,
    partsOfDay: s.partsOfDay,
    now: input.now,
  };
  const resolved = resolveReading(reading, ctx);
  const incoming = !reading.ownerWroteNewest;
  const meet = (incoming ? reading.asksToMeet : reading.ownerAsked) ?? 0;
  const propose = reading.proposesTime ?? 0;
  const recurring = (reading.recurring ?? 0) >= s.recurringThreshold;
  const lowTrust = reading.notEnglish && s.nonEnglish === "unsure";
  if (lowTrust) flags.push("not_english");
  if (recurring) flags.push("recurring");

  // Free or busy for every timed proposal still ahead.
  const proposals = resolved.proposals.map((p) => {
    if (!p.start || !p.end || p.flags.includes("past")) return p;
    const hits = overlapping(input.busy, Date.parse(p.start), Date.parse(p.end));
    return { ...p, free: hits.length === 0, busyWith: hits.map((b) => b.title) };
  });
  const guesses = propose >= s.pickThreshold ? proposals : [];
  const firstGuess = guesses.find((p) => !p.flags.includes("past")) ?? guesses[0];
  const pick = (why: MeetingFlag[]): MeetingChip => ({
    kind: "pick_time",
    ...(firstGuess?.start ? { start: firstGuess.start, end: firstGuess.end ?? undefined } : {}),
    ...(firstGuess ? { day: firstGuess.day } : {}),
    flags: [...new Set([...why, ...flags])],
  });
  const likely = Math.max(meet, propose);

  // Not English: the answers count as unsure; the user picks, if a meeting is likely at all.
  if (lowTrust) {
    return likely >= s.pickThreshold
      ? done("unsure", [pick(["not_english"])], proposals)
      : done("none", []);
  }

  const future = proposals.filter((p) => !p.flags.includes("past"));
  const proposesSomething = propose >= s.pickThreshold && proposals.length > 0;
  // Parts read speculatively for a Message that proposes nothing are not proposals.
  const shown = propose >= s.pickThreshold ? proposals : [];

  if (proposesSomething && future.length > 0) {
    // The owner proposed these times: the other side answers next.
    if (!incoming) return done("owner_proposed", [], proposals);
    // An Event with the sender already there at a proposed time: nothing to do.
    const who = new Set(attendees.map((p) => p.email.toLowerCase()));
    const already = future.find(
      (p) =>
        p.start &&
        p.end &&
        overlapping(input.busy, Date.parse(p.start), Date.parse(p.end)).some((b) =>
          b.attendees.some((a) => who.has(a)),
        ),
    );
    if (already) return done("scheduled", [], proposals);
    if (recurring) return done("unsure", [pick(["recurring"])], proposals);
    const unsure = future.find(
      (p) => p.flags.includes("unsure") || p.flags.includes("zone_unclear"),
    );
    if (propose < s.scheduleThreshold || unsure) {
      return done("unsure", [pick(unsure ? unsure.flags : ["unsure"])], proposals);
    }
    const timed = future.filter((p) => p.start);
    if (timed.length > 0) {
      const free = timed.find((p) => p.free);
      if (free?.start && free.end) {
        return done(
          "proposes",
          [
            { kind: "schedule", start: free.start, end: free.end, flags: free.flags },
            { kind: "accept", start: free.start, end: free.end, flags: free.flags },
          ],
          proposals,
        );
      }
      const first = timed[0] as MeetingProposal;
      const target = Date.parse(first.start as string);
      const near = nearestSlots(
        search(
          input,
          Math.max(earliest, target - 3 * DAY),
          target + s.lookaheadDays * DAY,
          lengthMinutes,
        ),
        target,
        count,
        s.slotsPerDay,
        input.ownerZone,
      );
      if (propose < s.suggestThreshold || near.length === 0) {
        return done("proposes", [pick(["unsure"])], proposals, near);
      }
      return done(
        "proposes",
        [
          {
            kind: "suggest_time",
            start: first.start ?? undefined,
            end: first.end ?? undefined,
            slots: near,
            flags: [],
          },
        ],
        proposals,
        near,
      );
    }
    // A day with no time: free times on that day (in its part, when named).
    const dayOnly = future[0] as MeetingProposal;
    const c = civilOf(dayOnly.day);
    const hours = dayOnly.partOfDay ? s.partsOfDay[dayOnly.partOfDay] : undefined;
    const open = zonedToUtc(input.ownerZone, c.y, c.mo, c.d, 0, 0, 0).getTime();
    const onDay = offerIn(open, open + DAY, hours);
    if (onDay.length > 0) {
      return done(
        "proposes",
        [{ kind: "offer_times", day: dayOnly.day, slots: onDay, flags: ["day_only"] }],
        proposals,
        onDay,
      );
    }
    const near = nearestSlots(
      search(
        input,
        Math.max(earliest, open - 3 * DAY),
        open + s.lookaheadDays * DAY,
        lengthMinutes,
      ),
      open + (hours?.start ?? s.work.startHour) * 3_600_000,
      count,
      s.slotsPerDay,
      input.ownerZone,
    );
    return near.length > 0
      ? done(
          "proposes",
          [{ kind: "suggest_time", day: dayOnly.day, slots: near, flags: ["day_only"] }],
          proposals,
          near,
        )
      : done("proposes", [pick(["day_only"])], proposals);
  }

  // Asked to meet (by them, or the owner asked and nobody gave a time): offer free times.
  if (meet >= s.offerThreshold) {
    if (recurring) return done("unsure", [pick(["recurring"])], shown);
    let slots: MeetingSlot[] = [];
    if (!window && resolved.nextWeek) {
      // "Can we meet next week?": next week's free times, else the usual window.
      const w = resolved.nextWeek;
      const from = zonedToUtc(input.ownerZone, w.y, w.mo, w.d, 0, 0, 0).getTime();
      slots = offerIn(from, from + 7 * DAY);
    }
    if (slots.length === 0) slots = generalOffer();
    const kase: MeetingCase = incoming ? "asks" : "owner_asked";
    if (slots.length === 0) return done(kase, [pick([])], shown, []);
    return done(kase, [{ kind: "offer_times", slots, flags: [] }], shown, slots);
  }

  // A meeting is likely but not clearly asked for, or its time is unclear: the user picks.
  if (likely >= s.pickThreshold && incoming) return done("unsure", [pick(["unsure"])], shown);
  return done("none", [], shown, window ? generalOffer() : []);
}

/** Whether a proposed slot the user is about to write is still free and ahead (a re-check before a draft). */
export function stillFree(
  slot: { start: string; end: string },
  busy: readonly BusySpan[],
  now: Date,
  zone: string,
  work: WorkingHours,
): MeetingSlot | null {
  const start = Date.parse(slot.start);
  const end = Date.parse(slot.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < now.getTime()) {
    return null;
  }
  if (overlapping(busy, start, end).length > 0) return null;
  const inside = insideWorkingHours(new Date(start), new Date(end), zone, work);
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    ...(inside ? {} : { outsideHours: true }),
  };
}
