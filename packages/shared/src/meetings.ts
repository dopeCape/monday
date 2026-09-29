// Meetings from mail (docs/spec/meetings.md): when a Thread asks the owner to
// meet, or proposes a time, monday reads it with one Judgment request (the
// meeting questions), code resolves the proposed times and checks the
// owner's calendar, and the reader offers a Recommended action as a chip:
// Offer times, Schedule, Works for me, Suggest another time, Pick a time.
// Types only, plus the few pure helpers both ends need. Runtime-neutral.

import type { Id, IsoDate, Person } from "./domain.ts";

/** What a Thread is about, meeting-wise, as the plan decided it. */
export type MeetingCase =
  /** Nothing about meeting, or the judge was not asked. */
  | "none"
  /** A calendar Invite is attached: the invite bar handles it. */
  | "invite"
  /** Someone asks the owner to meet and gives no usable time. */
  | "asks"
  /** The owner asked to meet and no time is settled. */
  | "owner_asked"
  /** The newest Message proposes one or more times. */
  | "proposes"
  /** The owner's own newest Message proposes times: waiting on the other side. */
  | "owner_proposed"
  /** A proposed time is already on the owner's calendar with the sender. */
  | "scheduled"
  /** A meeting is likely but the reading is unsure: the user picks the time. */
  | "unsure";

/** Why a proposal or a chip carries a warning. */
export type MeetingFlag =
  /** The time is before now. */
  | "past"
  /** Outside the working hours or working days Settings. */
  | "outside_hours"
  /** No zone was stated and the people on the Thread seem to be in different zones. */
  | "zone_unclear"
  /** The reading is below the confidence the chip needs. */
  | "unsure"
  /** The meeting repeats; monday does not guess a series. */
  | "recurring"
  /** The Thread is not in English; answers count as unsure. */
  | "not_english"
  /** A day was proposed without a time of day. */
  | "day_only";

/** A free span on the owner's calendar, as code found it. */
export interface MeetingSlot {
  start: IsoDate;
  end: IsoDate;
  /** Set when the slot falls outside working hours (only a proposed time can). */
  outsideHours?: boolean | undefined;
}

/** One time the newest Message proposes, as code resolved it from the judge's date parts. */
export interface MeetingProposal {
  /** The instant it starts; null when only a day was named. */
  start: IsoDate | null;
  end: IsoDate | null;
  /** The day in `timeZone`, "2026-10-01". */
  day: string;
  /** The zone the wall-clock time was read in: the stated one, else the owner's. */
  timeZone: string;
  /** Morning, afternoon or evening, when that is all the Message says about the time. */
  partOfDay: "morning" | "afternoon" | "evening" | null;
  /** The lowest confidence among the parts code used. */
  confidence: number;
  /** Whether the owner is free for it; null when it was not checked (a day only, a past time). */
  free: boolean | null;
  /** The titles of the owner's Events it overlaps. */
  busyWith: string[];
  flags: MeetingFlag[];
}

export type MeetingChipKind =
  /** Create the Event: schedule_event with its approval card. */
  | "schedule"
  /** A reply Draft accepting the proposed time. */
  | "accept"
  /** A reply Draft offering free slots. */
  | "offer_times"
  /** A reply Draft offering slots near a proposed time the owner is busy for. */
  | "suggest_time"
  /** The event editor, prefilled, for the user to choose. */
  | "pick_time"
  /** The chip explains that no calendar is connected. */
  | "no_calendar";

/** A chip as the plan made it; the client words it from strings Settings. */
export interface MeetingChip {
  kind: MeetingChipKind;
  /** The time a schedule, accept or pick chip names. */
  start?: IsoDate | undefined;
  end?: IsoDate | undefined;
  /** The day an offer or pick chip is about, "2026-10-01", when one was named. */
  day?: string | undefined;
  /** The slots an offer or suggest chip would write into the reply. */
  slots?: MeetingSlot[] | undefined;
  flags: MeetingFlag[];
}

/** Who read the Thread. */
export type MeetingJudgedBy = "typesafe" | "llm" | "gate" | "none";

/**
 * What monday knows about meeting on a Thread right now: the case, the
 * proposals with free or busy, the slots code found and the chips, likeliest
 * first. Computed on the Server from the stored reading and the calendar
 * as it is now (GET /meetings/:threadId, the agent's meeting_options).
 */
export interface MeetingOptions {
  threadId: Id;
  /** The Message the reading is of; a newer Message re-judges. */
  messageId: string;
  case: MeetingCase;
  /** Minutes the meeting would last: what the Message implies, else the Meeting length Setting. */
  lengthMinutes: number;
  /** The owner's zone the slots and chips were worked out in. */
  timeZone: string;
  proposals: MeetingProposal[];
  slots: MeetingSlot[];
  chips: MeetingChip[];
  /** The Event's title and guests, from the Thread. */
  title: string;
  attendees: Person[];
  /** Whether a calendar could be read at all. */
  calendar: boolean;
  judgedBy: MeetingJudgedBy;
  model: string;
  judgedAt: IsoDate | null;
  flags: MeetingFlag[];
}

/**
 * A Thread's meeting chip as the Changes feed carries it to the Cache, so a
 * list row can show it on hover without asking. The reader asks for the
 * fresh MeetingOptions on open; a click re-checks before it acts.
 */
export interface MeetingChange {
  threadId: Id;
  messageId: string;
  chip: MeetingChip | null;
  judgedAt: IsoDate;
  deleted?: boolean | undefined;
}

export type MeetingDraftKind = "offer" | "suggest" | "accept";

/** POST /meetings/:threadId/draft: the reply text for an offer, suggest or accept chip. */
export interface MeetingDraftRequest {
  workspace: Id;
  kind: MeetingDraftKind;
  /** The slots the chip showed; the Server checks each is still free before it writes them. */
  slots: Array<{ start: IsoDate; end: IsoDate }>;
  /** The Device's zone, used when the calendar.time_zone Setting is empty. */
  zone?: string | undefined;
}

export interface MeetingDraftResult {
  /** The reply body, plain text, paragraphs split by blank lines. Never sent from here. */
  text: string;
  /** The slots it offers, as checked now (a slot that became busy is left out). */
  slots: MeetingSlot[];
  /** The language model wrote it and it names only the offered times; false means the Setting's template. */
  written: boolean;
  /** The Voice profile shaped it. */
  voice: boolean;
}

/** Parts of the day and the hours they cover, in the owner's zone. */
export type PartOfDay = "morning" | "afternoon" | "evening";

/** The meeting lengths the length question offers, in minutes. */
export const MEETING_LENGTHS = ["15", "30", "45", "60", "90"] as const;

/** A chip that sends nothing and writes nothing without the user: all of them (ADR 0002). */
export function meetingChipTool(kind: MeetingChipKind): string {
  switch (kind) {
    case "schedule":
      return "schedule_event";
    case "accept":
    case "offer_times":
    case "suggest_time":
      return "compose.reply";
    case "pick_time":
      return "calendar.editor";
    case "no_calendar":
      return "none";
  }
}
