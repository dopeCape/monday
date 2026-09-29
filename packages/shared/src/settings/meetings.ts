// The Settings behind meetings from mail (docs/spec/meetings.md): every
// behavior, threshold, question and word is a Setting with a default (ADR
// 0004). Spread into settingsSchema; kept apart so the schema file stays
// readable.

import { z } from "zod";
import type { SettingEntry, SettingSection } from "./schema.ts";

function setting<T extends z.ZodType>(entry: SettingEntry<T>): SettingEntry<T> {
  return entry;
}

function str(section: SettingSection, label: string, value: string) {
  return setting({
    type: z.string(),
    default: value,
    scope: "global",
    section,
    label,
    help: "A user-visible string. The Agent can change the wording on request.",
  });
}

const confidence = z.number().min(0).max(1);
const hours = z.object({ start: z.int().min(0).max(23), end: z.int().min(1).max(24) });
const noulWords = z.object({
  instructions: z.string().min(1),
  true: z.string().min(1),
  false: z.string().min(1),
});

/** A Noul's words as the Setting holds them: the statement and what yes and no mean. */
export type MeetingNoulWords = z.output<typeof noulWords>;

const behavior = (label: string, help: string, tier: "primary" | "more" | "advanced" = "more") => ({
  scope: "global" as const,
  section: "routing" as const,
  group: "Meetings",
  tier,
  label,
  help,
});

const question = (label: string, help: string) => ({
  scope: "global" as const,
  section: "ai" as const,
  group: "TypeSafe",
  tier: "advanced" as const,
  label,
  help,
});

export const MEETING_SETTINGS = {
  "meetings.enabled": setting({
    type: z.boolean(),
    default: true,
    ...behavior(
      "Meeting suggestions",
      "When mail asks you to meet or proposes a time, the reader offers to answer with free times, schedule it, or suggest another time. Nothing is sent or added without you.",
      "primary",
    ),
  }),
  "meetings.on_arrival": setting({
    type: z.boolean(),
    default: true,
    ...behavior(
      "Read new mail for meetings",
      "At the automate AI level, new mail is read for meeting requests as it arrives; otherwise when you open a Thread.",
    ),
  }),
  "meetings.lead_minutes": setting({
    type: z
      .int()
      .min(0)
      .max(7 * 24 * 60),
    default: 120,
    ...behavior("Lead time", "No time is offered sooner than this many minutes from now."),
  }),
  "meetings.slots": setting({
    type: z.int().min(1).max(6),
    default: 3,
    ...behavior("Times to offer", "How many free times a reply offers."),
  }),
  "meetings.slots_per_day": setting({
    type: z.int().min(1).max(6),
    default: 1,
    ...behavior(
      "Times per day",
      "At most this many of the offered times fall on one day, so the other side has a choice of days.",
    ),
  }),
  "meetings.lookahead_days": setting({
    type: z.int().min(1).max(60),
    default: 7,
    ...behavior("Look ahead", "Free times are looked for within this many days."),
  }),
  "meetings.busy_calendars": setting({
    type: z.enum(["own", "shown"]),
    default: "own",
    ...behavior(
      "Calendars that count as busy",
      "Your own calendars only, or every calendar shown in the Calendar (shared ones included). Declined, cancelled and all-day Events never count.",
    ),
  }),
  "meetings.add_link": setting({
    type: z.boolean(),
    default: true,
    ...behavior(
      "Add a meeting link",
      "A scheduled meeting gets the link your Meeting link Setting names (Google Meet, Teams, Jitsi or your own).",
    ),
  }),
  "meetings.parts_of_day": setting({
    type: z.object({ morning: hours, afternoon: hours, evening: hours }),
    default: {
      morning: { start: 8, end: 12 },
      afternoon: { start: 12, end: 17 },
      evening: { start: 17, end: 20 },
    },
    ...behavior(
      "Parts of the day",
      "The hours 'Thursday morning', 'afternoon' and 'evening' mean when free times are looked for on that day.",
      "advanced",
    ),
  }),
  "meetings.in_list": setting({
    type: z.enum(["hover", "always", "off"]),
    default: "hover",
    ...behavior(
      "Meeting chip in the list",
      "Show a row's meeting chip when the row is hovered or selected, always, or never.",
    ),
  }),
  "meetings.max_in_reader": setting({
    type: z.int().min(1).max(3),
    default: 2,
    ...behavior("Meeting chips in the reader", "At most this many meeting chips in the reader."),
  }),
  "meetings.offer.threshold": setting({
    type: confidence,
    default: 0.7,
    ...behavior(
      "Offer times: how sure",
      "Offer times shows when the judge is at least this sure the Thread asks to meet. It opens a reply draft, so a wrong one costs a click.",
      "advanced",
    ),
  }),
  "meetings.schedule.threshold": setting({
    type: confidence,
    default: 0.8,
    ...behavior(
      "Schedule: how sure",
      "Schedule shows when the judge is at least this sure the newest message proposes a time. It asks before the Event is made.",
      "advanced",
    ),
  }),
  "meetings.schedule.time_confidence": setting({
    type: confidence,
    default: 0.7,
    ...behavior(
      "Schedule: how sure of the time",
      "Every part of the proposed time (day, hour, minute, zone) must be read at least this confidently; otherwise the chip is Pick a time.",
      "advanced",
    ),
  }),
  "meetings.suggest.threshold": setting({
    type: confidence,
    default: 0.75,
    ...behavior(
      "Suggest another time: how sure",
      "Suggest another time shows when you are busy at a proposed time and the judge is at least this sure it was proposed.",
      "advanced",
    ),
  }),
  "meetings.pick.threshold": setting({
    type: confidence,
    default: 0.5,
    ...behavior(
      "Pick a time: how sure",
      "Below the other thresholds but at least this sure of a meeting, the chip is Pick a time, which opens the event editor for you to choose.",
      "advanced",
    ),
  }),
  "meetings.length_confidence": setting({
    type: confidence,
    default: 0.6,
    ...behavior(
      "Meeting length: how sure",
      "A length the message implies (15, 30, 45, 60 or 90 minutes) is used at this confidence; otherwise the Meeting length Setting.",
      "advanced",
    ),
  }),
  "meetings.recurring_threshold": setting({
    type: confidence,
    default: 0.7,
    ...behavior(
      "Repeating meetings",
      "At or above this, the request is for a repeating meeting and the chip is Pick a time.",
      "advanced",
    ),
  }),
  "meetings.non_english": setting({
    type: z.enum(["unsure", "trust"]),
    default: "unsure",
    ...behavior(
      "Mail not in English",
      "The judge reads English best: its answers on other mail count as unsure (only Pick a time), or are trusted as they are.",
      "advanced",
    ),
  }),
  "meetings.llm_fallback": setting({
    type: z.boolean(),
    default: true,
    ...behavior(
      "Without TypeSafe",
      "Ask the language model the same meeting questions when no TypeSafe key is set. Slower and costs more.",
      "advanced",
    ),
  }),
  "meetings.proposals_max": setting({
    type: z.int().min(1).max(3),
    default: 3,
    ...behavior(
      "Proposed times read",
      "How many proposed times the judge reads from one message.",
      "advanced",
    ),
  }),
  "meetings.candidates_max": setting({
    type: z.int().min(1).max(16),
    default: 8,
    ...behavior(
      "Time and zone options",
      "At most this many clock times and time zones found in the message are offered to the judge to pick from.",
      "advanced",
    ),
  }),
  "meetings.state.newest_chars": setting({
    type: z.int().min(200).max(20_000),
    default: 3000,
    ...behavior(
      "Newest message read",
      "Characters of the newest message the judge reads.",
      "advanced",
    ),
  }),
  "meetings.state.earlier_chars": setting({
    type: z.int().min(0).max(5000),
    default: 600,
    ...behavior(
      "Earlier message read",
      "Characters of the message before it the judge reads, for context.",
      "advanced",
    ),
  }),
  "meetings.gate_words": setting({
    type: z.array(z.string().min(1)).max(200),
    default: [
      "meet",
      "meeting",
      "call",
      "chat",
      "catch up",
      "catch-up",
      "coffee",
      "lunch",
      "demo",
      "interview",
      "sync",
      "zoom",
      "teams",
      "hangout",
      "available",
      "availability",
      "free",
      "schedule",
      "slot",
      "works for",
      "work for you",
      "calendar",
      "when suits",
      "talk",
    ],
    ...behavior(
      "Words that mean a meeting",
      "Mail is read for meetings only when it holds one of these words or names a time. Keeps the judge off receipts and newsletters.",
      "advanced",
    ),
  }),
  "meetings.draft_prompt": setting({
    type: z.string().min(1),
    default:
      "You write a short email reply for the mailbox owner about meeting. Write only the body: no subject, no greeting line if the thread uses none, no signature. Offer exactly the times listed, written exactly as given, and mention no other day, date or time. Do not promise anything else. Keep it to a few sentences.",
    ...behavior(
      "Reply instructions",
      "What the language model is told when it writes a meeting reply. Code checks the reply names only the offered times; otherwise the template is used.",
      "advanced",
    ),
  }),

  /* The questions (TypeSafe's Jev, or the language model's prompt path). */
  "meetings.questions.asks_to_meet": setting({
    type: noulWords,
    default: {
      instructions:
        "In `thread.newest_message`, written by someone other than the mailbox owner, the writer asks the owner to meet, have a call or talk live, or agrees to meet and asks when.",
      true: "The newest message asks for a meeting, call, video call, coffee, demo or interview with the owner, or accepts one the owner suggested and asks which time suits.",
      false:
        "The newest message asks for no meeting: it only answers, informs, or mentions a meeting that is already arranged, past, or between other people.",
    },
    ...question("Question: asks to meet", "A yes or no statement about the newest message."),
  }),
  "meetings.questions.owner_asked": setting({
    type: noulWords,
    default: {
      instructions:
        "In `thread.newest_message`, written by the mailbox owner, the owner suggests meeting, having a call or talking live with the other people on the thread.",
      true: "The owner's newest message suggests meeting or talking, such as 'let's meet', 'shall we get on a call', 'happy to chat next week'.",
      false: "The owner's newest message suggests no meeting.",
    },
    ...question(
      "Question: the owner asked to meet",
      "A yes or no statement about the owner's own message.",
    ),
  }),
  "meetings.questions.proposes_time": setting({
    type: noulWords,
    default: {
      instructions:
        "`thread.newest_message` proposes one or more specific days or times for that meeting.",
      true: "The newest message names a day ('Thursday', '3 October', 'tomorrow') or a time ('3pm', '15:00') at which the writer offers or asks to meet.",
      false:
        "No day or time is offered for the meeting. Dates about other things (a deadline, a delivery, a past event) do not count; 'sometime next week' with no day does not count.",
    },
    ...question("Question: proposes a time", "A yes or no statement about the newest message."),
  }),
  "meetings.questions.recurring": setting({
    type: noulWords,
    default: {
      instructions:
        "The meeting asked for in `thread.newest_message` repeats, such as a weekly call or a regular sync, rather than happening once.",
      true: "The message asks for a meeting that happens every day, week, fortnight or month.",
      false: "The meeting happens once, or no meeting is asked for.",
    },
    ...question("Question: repeating meeting", "A yes or no statement about the newest message."),
  }),
  "meetings.questions.length": setting({
    type: z.string().min(1),
    default:
      "How long a meeting does `thread.newest_message` ask for, in minutes? Pick not_stated when it names no length and implies none.",
    ...question(
      "Question: meeting length",
      "A Choice over 15, 30, 45, 60 and 90 minutes, or not stated.",
    ),
  }),
  "meetings.questions.zone": setting({
    type: z.string().min(1),
    default:
      "In which of the time zones in `zone_mentions` is the proposed meeting time in `thread.newest_message` given? Pick not_stated when the message gives the time in no zone.",
    ...question("Question: time zone", "A Choice over the zones code found in the message."),
  }),
  "meetings.questions.parts": setting({
    type: z.object({
      form: z.string().min(1),
      relative: z.string().min(1),
      weekday: z.string().min(1),
      week: z.string().min(1),
      month: z.string().min(1),
      day: z.string().min(1),
      clock: z.string().min(1),
      meridiem: z.string().min(1),
      part: z.string().min(1),
    }),
    default: {
      form: "How is the {nth} day the newest message proposes for the meeting written? Pick none when the message proposes fewer days than that.",
      relative:
        "If the {nth} proposed day is written relative to when the message was written, which day is it?",
      weekday: "If the {nth} proposed day names a day of the week, which one?",
      week: "If the {nth} proposed day names a weekday, which week is meant?",
      month: "If the {nth} proposed day names a month, which one?",
      day: "If the {nth} proposed day names a day of the month, which day (1 to 31)?",
      clock:
        "Which of the times in `clock_times` is the time of day proposed for the {nth} proposed day? Pick none when that day has no time of day.",
      meridiem:
        "Is the time of day proposed for the {nth} proposed day in the morning (am) or the afternoon or evening (pm)?",
      part: "If the {nth} proposed day names only a part of the day and no clock time, which part?",
    },
    ...question(
      "Questions: the proposed time's parts",
      "One Choice per part of each proposed time; {nth} becomes first, second or third. Code assembles the date and does all the date maths.",
    ),
  }),

  /* Words. */
  "strings.meter.judge.meeting": str("ai", "Meter line: meeting requests", "Meeting requests"),
  "strings.meetings.chip.offer": str("routing", "Meeting chip: offer times", "Offer times"),
  "strings.meetings.chip.offer_day": str(
    "routing",
    "Meeting chip: offer times on a day",
    "Offer times {day}",
  ),
  "strings.meetings.chip.schedule": str("routing", "Meeting chip: schedule", "Schedule {when}"),
  "strings.meetings.chip.accept": str("routing", "Meeting chip: accept", "Reply: works for me"),
  "strings.meetings.chip.suggest": str(
    "routing",
    "Meeting chip: suggest another time",
    "Suggest another time",
  ),
  "strings.meetings.chip.pick": str("routing", "Meeting chip: pick a time", "Pick a time"),
  "strings.meetings.chip.no_calendar": str(
    "routing",
    "Meeting chip: no calendar",
    "No calendar to check",
  ),
  "strings.meetings.flag.outside_hours": str(
    "routing",
    "Meeting chip: outside working hours",
    "outside your working hours",
  ),
  "strings.meetings.flag.zone_unclear": str(
    "routing",
    "Meeting chip: zone unclear",
    "the time zone is not clear",
  ),
  "strings.meetings.flag.recurring": str(
    "routing",
    "Meeting chip: a repeating meeting",
    "a repeating meeting",
  ),
  "strings.meetings.flag.unsure": str("routing", "Meeting chip: unsure", "the time is not clear"),
  "strings.meetings.flag.not_english": str(
    "routing",
    "Meeting chip: not English",
    "monday reads English best",
  ),
  "strings.meetings.chip.title_draft": str(
    "routing",
    "Meeting chip tooltip: opens a draft",
    "Opens a reply draft with {slots}. Nothing is sent.",
  ),
  "strings.meetings.chip.title_schedule": str(
    "routing",
    "Meeting chip tooltip: schedule",
    "Asks before the Event is made and anyone is invited.",
  ),
  "strings.meetings.chip.title_pick": str(
    "routing",
    "Meeting chip tooltip: pick a time",
    "Opens the event editor on {day} for you to choose.",
  ),
  "strings.meetings.chip.title_pick_any": str(
    "routing",
    "Meeting chip tooltip: pick a time, no day read",
    "Opens the event editor for you to choose.",
  ),
  "strings.meetings.no_calendar": str(
    "routing",
    "Meeting chip: why there is no calendar",
    "monday needs a calendar to see when you are free. Connect one in Settings, Accounts.",
  ),
  "strings.meetings.changed": str(
    "routing",
    "Meeting chip: the time changed under it",
    "Your calendar changed. Here is what fits now.",
  ),
  "strings.meetings.writing": str(
    "routing",
    "Meeting chip: writing the reply",
    "Writing the reply",
  ),
  "strings.meetings.failed": str(
    "routing",
    "Meeting chip: the reply could not be written",
    "Could not write the reply: {reason}",
  ),
  "strings.meetings.no_slots": str(
    "routing",
    "Meeting chip: no free time",
    "No free time in the next {days} days within your working hours.",
  ),
  "strings.meetings.scheduled": str(
    "routing",
    "Meeting chip: scheduled, reply offered",
    "Scheduled {title}. Reply that it works?",
  ),
  "strings.meetings.event_title": str(
    "routing",
    "Meeting: the Event title when the subject is empty",
    "Meeting with {name}",
  ),
  "strings.meetings.draft.offer": str(
    "routing",
    "Meeting reply template: offer times",
    "Happy to meet. Would one of these work for you?\n\n{slots}\n\nLet me know which suits you best.",
  ),
  "strings.meetings.draft.suggest": str(
    "routing",
    "Meeting reply template: suggest another time",
    "I'm not free at {proposed}, sorry. Would one of these work instead?\n\n{slots}",
  ),
  "strings.meetings.draft.accept": str(
    "routing",
    "Meeting reply template: accept",
    "{when} works for me. Talk then.",
  ),
  "strings.meetings.draft.slot": str(
    "routing",
    "Meeting reply template: one offered time",
    "- {day}, {start} to {end} {zone}",
  ),
} as const;
