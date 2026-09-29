// The meeting request (docs/spec/meetings.md, "The questions"): one state,
// the newest Message and the one before it, and every meeting question in one
// request (speculative fan-out). Three Nouls say what the Thread is about
// (asks to meet, the owner asked, proposes a time) plus one for a repeating
// meeting; a Choice reads the length; per proposed time, Choices read the
// day's parts and pick the clock time and zone among the spans code found.
// Code reads only the answers the Nouls call for. Every word is a Setting.

import type {
  ChoiceQuestion,
  JsonValue,
  MeetingNoulWords,
  NoulQuestion,
  Person,
} from "@monday/shared";
import { MEETING_LENGTHS } from "@monday/shared";
import type { ClockCandidate, ZoneCandidate } from "./extract.ts";

export interface MeetingQuestionWords {
  asksToMeet: MeetingNoulWords;
  ownerAsked: MeetingNoulWords;
  proposesTime: MeetingNoulWords;
  recurring: MeetingNoulWords;
  length: string;
  zone: string;
  parts: {
    form: string;
    relative: string;
    weekday: string;
    week: string;
    month: string;
    day: string;
    clock: string;
    meridiem: string;
    part: string;
  };
}

export const ORDINALS = ["first", "second", "third"] as const;
export const WEEKDAY_OPTIONS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
export const MONTH_OPTIONS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

export const NONE = "none";
export const NOT_STATED = "not_stated";

const noul = (w: MeetingNoulWords): NoulQuestion => ({
  type: "noul",
  instructions: w.instructions,
  criteria: { true: w.true, false: w.false },
});

const choice = (instructions: string, criteria: Record<string, string | null>): ChoiceQuestion => ({
  type: "choice",
  instructions,
  criteria,
});

const nth = (text: string, n: number) => text.replaceAll("{nth}", ORDINALS[n] ?? "first");

/** The question ids of one proposed time's parts. */
export function partIds(n: number) {
  const p = `p${n + 1}`;
  return {
    form: `${p}_form`,
    relative: `${p}_relative`,
    weekday: `${p}_weekday`,
    week: `${p}_week`,
    month: `${p}_month`,
    day: `${p}_day`,
    clock: `${p}_clock`,
    meridiem: `${p}_meridiem`,
    part: `${p}_part`,
  } as const;
}

/**
 * Every meeting question for one state. The clock Choice is asked only when
 * code found clock times, the zone Choice only when it found zones (a gate:
 * the model is never asked to invent a value).
 */
export function meetingQuestions(
  words: MeetingQuestionWords,
  candidates: { clocks: readonly ClockCandidate[]; zones: readonly ZoneCandidate[] },
  proposalsMax: number,
): Record<string, ChoiceQuestion | NoulQuestion> {
  const q: Record<string, ChoiceQuestion | NoulQuestion> = {
    asks_to_meet: noul(words.asksToMeet),
    owner_asked: noul(words.ownerAsked),
    proposes_time: noul(words.proposesTime),
    recurring: noul(words.recurring),
    length: choice(words.length, {
      ...Object.fromEntries(MEETING_LENGTHS.map((m) => [m, `${m} minutes`])),
      [NOT_STATED]: "The message names no length and implies none.",
    }),
  };
  if (candidates.zones.length > 0) {
    q.zone = choice(words.zone, {
      ...Object.fromEntries(candidates.zones.map((z) => [z.text, null])),
      [NOT_STATED]: "The proposed time is given in no zone.",
    });
  }
  for (let n = 0; n < Math.min(3, Math.max(1, proposalsMax)); n++) {
    const id = partIds(n);
    const w = words.parts;
    q[id.form] = choice(nth(w.form, n), {
      absolute: "A calendar date naming a month, such as '3 October' or '10/03'.",
      relative:
        "Relative to when the message was written: 'today', 'tomorrow', 'the day after tomorrow', or 'next week' with no day named.",
      weekday: "A named day of the week, such as 'Thursday' or 'next Tuesday'.",
      time_only: "Only a time of day with no day, such as 'how about 3pm?'.",
      [NONE]: "The message proposes fewer days or times than that, or none.",
    });
    q[id.relative] = choice(nth(w.relative, n), {
      today: null,
      tomorrow: null,
      day_after: "The day after tomorrow.",
      next_week: "Some time next week, no day named.",
      [NONE]: "It is not written relative to the message.",
    });
    q[id.weekday] = choice(nth(w.weekday, n), {
      ...Object.fromEntries(WEEKDAY_OPTIONS.map((d) => [d, null])),
      [NONE]: "No weekday is named.",
    });
    q[id.week] = choice(nth(w.week, n), {
      this: "This week, as in 'this Thursday'.",
      next: "The week after this one, as in 'next Thursday' meaning the following week, or 'Thursday next week'.",
      [NONE]: "A bare weekday with no qualifier, such as 'on Thursday', or no weekday at all.",
    });
    q[id.month] = choice(nth(w.month, n), {
      ...Object.fromEntries(MONTH_OPTIONS.map((m) => [m, null])),
      [NONE]: "No month is named.",
    });
    q[id.day] = choice(nth(w.day, n), {
      ...Object.fromEntries(Array.from({ length: 31 }, (_, i) => [String(i + 1), null])),
      [NONE]: "No day of the month is named.",
    });
    if (candidates.clocks.length > 0) {
      q[id.clock] = choice(nth(w.clock, n), {
        ...Object.fromEntries(candidates.clocks.map((c) => [c.text, null])),
        [NONE]: "No time of day is given for that day.",
      });
      q[id.meridiem] = choice(nth(w.meridiem, n), {
        am: "In the morning, before noon.",
        pm: "At noon or later: the afternoon or evening.",
        [NOT_STATED]: "The message does not make it clear.",
      });
    }
    q[id.part] = choice(nth(w.part, n), {
      morning: null,
      afternoon: null,
      evening: null,
      [NONE]: "No part of the day is named, or a clock time is.",
    });
  }
  return q;
}

export interface MeetingStateInput {
  owner: Person;
  subject: string;
  ownerWroteNewest: boolean;
  newest: { from: Person; to: Person[]; written: string; text: string };
  earlier: { from: Person; written: string; text: string } | null;
  clocks: readonly ClockCandidate[];
  zones: readonly ZoneCandidate[];
}

const person = (p: Person): JsonValue => ({ name: p.name || null, email: p.email });

/** The state: the owner, the newest Message and the one before it, and the spans code found. Nothing else. */
export function meetingState(input: MeetingStateInput): JsonValue {
  return {
    owner: person(input.owner),
    thread: {
      subject: input.subject,
      owner_wrote_newest: input.ownerWroteNewest,
      newest_message: {
        from: person(input.newest.from),
        to: input.newest.to.map(person),
        written: input.newest.written,
        text: input.newest.text,
      },
      ...(input.earlier
        ? {
            message_before: {
              from: person(input.earlier.from),
              written: input.earlier.written,
              text: input.earlier.text,
            },
          }
        : {}),
    },
    clock_times: input.clocks.map((c) => c.text),
    zone_mentions: input.zones.map((z) => z.text),
  };
}

/** "Tuesday 29 September 2026, 10:15", the written date in words in a zone; the model reads it, never computes with it. */
export function writtenIn(at: Date, zone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: zone,
    }).format(at);
  } catch {
    return at.toUTCString();
  }
}
