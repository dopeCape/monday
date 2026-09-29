// Meeting chips on the Device (docs/spec/meetings.md): the words of each
// chip and its tooltip from strings.meetings.* Settings, which chips the
// reader and a list row show under the Settings and the AI level, the
// scheduling card's preview, and the runner that turns a click into the
// chip's ordinary tool call (ADR 0002): Schedule opens the approval card and
// creates nothing on its own; Offer times, Suggest another time and Works
// for me write a reply Draft and never send; Pick a time opens the event
// editor. Pure apart from the seams the runner is handed.

import type {
  EventPreview,
  MeetingChip,
  MeetingChipKind,
  MeetingDraftKind,
  MeetingDraftRequest,
  MeetingDraftResult,
  MeetingFlag,
  MeetingOptions,
  MeetingSlot,
  Person,
  Settings,
} from "@monday/shared";
import { formatWake } from "./snooze.ts";
import { fill } from "./triage.ts";

/** What the Inbox asks the Server through (platform/api.ts `meetings`). */
export interface MeetingsSeam {
  options(workspaceId: string, threadId: string, zone?: string): Promise<MeetingOptions | null>;
  draft(threadId: string, body: MeetingDraftRequest): Promise<MeetingDraftResult>;
}

/** A chip as the reader or a row draws it. */
export interface MeetingChipView {
  chip: MeetingChip;
  label: string;
  title: string;
  kind: MeetingChipKind;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-01" as the Device's local midnight, or null when malformed. */
function dayDate(day: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A day as a chip names it: "today", "tomorrow", "Thu" within the week, else "Oct 3". */
export function formatMeetingDay(day: string, now: Date): string {
  const d = dayDate(day);
  if (!d) return day;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.round((d.getTime() - start) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days > 1 && days < 7) return WEEKDAYS[d.getDay()] ?? day;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** An instant as a chip names it, in the Device's zone: "15:00", "Tomorrow 15:00", "Thu 15:00", "Oct 3 15:00". */
export function formatMeetingWhen(iso: string, now: Date): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : formatWake(at, now);
}

const FLAG_KEYS: Partial<Record<MeetingFlag, keyof Settings>> = {
  outside_hours: "strings.meetings.flag.outside_hours",
  zone_unclear: "strings.meetings.flag.zone_unclear",
  recurring: "strings.meetings.flag.recurring",
  unsure: "strings.meetings.flag.unsure",
  not_english: "strings.meetings.flag.not_english",
};

/** The chip's flags in words, joined; empty when none has words. */
export function flagWords(flags: readonly MeetingFlag[], settings: Settings): string {
  return flags
    .map((f) => {
      const key = FLAG_KEYS[f];
      return key ? String(settings[key]) : "";
    })
    .filter((w) => w !== "")
    .join(", ");
}

/** The slots a draft chip offers, in words, for its tooltip. */
function slotWords(slots: readonly MeetingSlot[] | undefined, now: Date): string {
  return (slots ?? []).map((s) => formatMeetingWhen(s.start, now)).join(", ");
}

/** The chip's label and tooltip, worded from strings.meetings.* Settings. */
export function describeMeetingChip(
  chip: MeetingChip,
  settings: Settings,
  now: Date,
): MeetingChipView {
  const flags = flagWords(chip.flags, settings);
  const withFlags = (title: string) => (flags ? `${title} (${flags})` : title);
  const day = chip.day
    ? formatMeetingDay(chip.day, now)
    : chip.start
      ? formatMeetingDay(localDay(new Date(chip.start)), now)
      : "";
  let label: string;
  let title: string;
  switch (chip.kind) {
    case "schedule":
      label = fill(settings["strings.meetings.chip.schedule"], {
        when: chip.start ? formatMeetingWhen(chip.start, now) : day,
      });
      title = settings["strings.meetings.chip.title_schedule"];
      break;
    case "accept":
      label = settings["strings.meetings.chip.accept"];
      title = fill(settings["strings.meetings.chip.title_draft"], {
        slots: chip.start ? formatMeetingWhen(chip.start, now) : day,
      });
      break;
    case "offer_times":
      label = chip.day
        ? fill(settings["strings.meetings.chip.offer_day"], { day })
        : settings["strings.meetings.chip.offer"];
      title = fill(settings["strings.meetings.chip.title_draft"], {
        slots: slotWords(chip.slots, now),
      });
      break;
    case "suggest_time":
      label = settings["strings.meetings.chip.suggest"];
      title = fill(settings["strings.meetings.chip.title_draft"], {
        slots: slotWords(chip.slots, now),
      });
      break;
    case "pick_time":
      label = settings["strings.meetings.chip.pick"];
      title = day
        ? fill(settings["strings.meetings.chip.title_pick"], { day })
        : settings["strings.meetings.chip.title_pick_any"];
      break;
    case "no_calendar":
      label = settings["strings.meetings.chip.no_calendar"];
      title = settings["strings.meetings.no_calendar"];
      break;
  }
  return { chip, label, title: withFlags(title), kind: chip.kind };
}

/** "2026-10-01" for an instant in the Device's zone. */
function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Whether meeting chips show at all: the feature on and some AI (CONTEXT.md "AI level"). */
export function meetingsOn(settings: Settings): boolean {
  return settings["ai.level"] !== "off" && settings["meetings.enabled"];
}

/** The reader's meeting chips: the options' chips in order, capped by meetings.max_in_reader. */
export function readerMeetingChips(
  options: MeetingOptions | null | undefined,
  settings: Settings,
  now: Date,
  hidden: ReadonlySet<MeetingChipKind> = new Set(),
): MeetingChipView[] {
  if (!options || !meetingsOn(settings)) return [];
  return options.chips
    .filter((c) => !hidden.has(c.kind))
    .slice(0, settings["meetings.max_in_reader"])
    .map((c) => describeMeetingChip(c, settings, now));
}

/** The row's meeting chip, when the Setting shows one: `hover` and `always` differ only in CSS. */
export function listMeetingChip(
  chip: MeetingChip | null | undefined,
  settings: Settings,
  now: Date,
): (MeetingChipView & { always: boolean }) | null {
  if (!chip || !meetingsOn(settings)) return null;
  const mode = settings["meetings.in_list"];
  if (mode === "off") return null;
  return { ...describeMeetingChip(chip, settings, now), always: mode === "always" };
}

/* ------------------------------ The scheduling card ------------------------------ */

/** The link the Event gets under the Settings: none, the Provider's own (minted on approval), or a fixed kind. */
export function meetingLinkOf(settings: Settings): EventPreview["link"] {
  if (!settings["meetings.add_link"]) return null;
  const link = settings["calendar.meeting_link"];
  return link === "provider" || link === "none" ? null : link;
}

/** The scheduling card's preview for a Schedule chip: the time, the Thread's title and people. */
export function meetingEventPreview(
  options: Pick<MeetingOptions, "title" | "attendees" | "lengthMinutes">,
  chip: MeetingChip,
  settings: Settings,
  zone: string | null,
): EventPreview | null {
  if (!chip.start) return null;
  const start = new Date(chip.start);
  const end = chip.end
    ? new Date(chip.end)
    : new Date(start.getTime() + options.lengthMinutes * 60_000);
  return {
    action: "schedule",
    title: options.title,
    start: start.toISOString(),
    end: end.toISOString(),
    allDay: false,
    timeZone: zone,
    attendees: options.attendees,
    link: meetingLinkOf(settings),
    invitesBy: options.attendees.length > 0 ? "provider" : "none",
    conflicts: [],
  };
}

/** What Pick a time opens: the event editor on the proposed time, or the day's working start. */
export function pickTarget(
  options: Pick<MeetingOptions, "title" | "attendees" | "lengthMinutes">,
  chip: MeetingChip,
  settings: Settings,
  now: Date,
): { start: string; end: string; title: string; attendees: Person[] } {
  let start: Date;
  if (chip.start) start = new Date(chip.start);
  else {
    const day = chip.day ? dayDate(chip.day) : null;
    start = day ?? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    start.setHours(settings["calendar.day_start_hour"], 0, 0, 0);
  }
  const end = chip.end
    ? new Date(chip.end)
    : new Date(start.getTime() + options.lengthMinutes * 60_000);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    title: options.title,
    attendees: options.attendees,
  };
}

/** The palette target that opens the Calendar's editor with a prefilled Event. */
export function calendarNewTarget(target: ReturnType<typeof pickTarget>): string {
  return `calendar-new:${encodeURIComponent(JSON.stringify(target))}`;
}

/** The Calendar's side: a `calendar-new:` target read back, or null. */
export function parseCalendarNewTarget(
  target: string,
): { start: string; end: string; title: string; attendees: Person[] } | null {
  if (!target.startsWith("calendar-new:")) return null;
  try {
    const v = JSON.parse(decodeURIComponent(target.slice("calendar-new:".length))) as Record<
      string,
      unknown
    >;
    if (typeof v.start !== "string" || typeof v.end !== "string") return null;
    const attendees = Array.isArray(v.attendees)
      ? v.attendees.filter(
          (p): p is Person =>
            typeof p === "object" && p !== null && typeof (p as Person).email === "string",
        )
      : [];
    return {
      start: v.start,
      end: v.end,
      title: typeof v.title === "string" ? v.title : "",
      attendees: attendees.map((p) => ({ name: p.name ?? "", email: p.email })),
    };
  } catch {
    return null;
  }
}

/* ------------------------------ The runner ------------------------------ */

/** The draft a chip writes, by its kind; null for the chips that write none. */
export function draftKindOf(kind: MeetingChipKind): MeetingDraftKind | null {
  switch (kind) {
    case "accept":
      return "accept";
    case "offer_times":
      return "offer";
    case "suggest_time":
      return "suggest";
    default:
      return null;
  }
}

/** The seams a chip acts through; each one is an existing surface with its own Tier. */
export interface MeetingRunDeps {
  settings: Settings;
  now: Date;
  /** Fresh options from the Server, for a chip read from the Cache. */
  refresh(): Promise<MeetingOptions | null>;
  /** The reply text for a draft chip (POST /meetings/:id/draft); sends nothing. */
  draft(
    kind: MeetingDraftKind,
    slots: Array<{ start: string; end: string }>,
  ): Promise<MeetingDraftResult>;
  /** Opens the reply on the Thread with the text; the user still sends (ADR 0002). */
  reply(text: string): void;
  /** Opens the scheduling card; approving it creates the Event, declining drops it. */
  schedule(preview: EventPreview, options: MeetingOptions): void;
  /** Opens the Calendar's event editor prefilled. */
  pick(target: ReturnType<typeof pickTarget>): void;
  toast(text: string): void;
  /** The Device's zone, for the card. */
  zone: string | null;
}

export type MeetingRunOutcome =
  | { ok: true; kind: MeetingChipKind; chip: MeetingChip }
  | { ok: false; reason: "gone" | "no_calendar" | "failed" };

const sameChip = (a: MeetingChip, b: MeetingChip) =>
  a.kind === b.kind &&
  a.start === b.start &&
  a.end === b.end &&
  a.day === b.day &&
  JSON.stringify(a.slots ?? []) === JSON.stringify(b.slots ?? []);

/**
 * Runs a chip as its tool call. `options` are the fresh ones the reader
 * holds; a chip from a list row (the Cache, maybe stale) passes null and the
 * options are fetched again first: the chip of the same kind is used, and
 * when it changed or went away the user is told before anything opens.
 */
export async function runMeetingChip(
  chip: MeetingChip,
  options: MeetingOptions | null,
  deps: MeetingRunDeps,
): Promise<MeetingRunOutcome> {
  const s = deps.settings;
  let current = options;
  let act = chip;
  if (!current) {
    current = await deps.refresh();
    const fresh = current?.chips.find((c) => c.kind === chip.kind) ?? current?.chips[0];
    if (!current || !fresh) {
      deps.toast(s["strings.meetings.changed"]);
      return { ok: false, reason: "gone" };
    }
    if (!sameChip(fresh, chip)) {
      deps.toast(s["strings.meetings.changed"]);
      if (fresh.kind !== chip.kind) return { ok: false, reason: "gone" };
    }
    act = fresh;
  }
  switch (act.kind) {
    case "no_calendar":
      deps.toast(s["strings.meetings.no_calendar"]);
      return { ok: false, reason: "no_calendar" };
    case "schedule": {
      const preview = meetingEventPreview(current, act, s, deps.zone);
      if (!preview) return { ok: false, reason: "failed" };
      deps.schedule(preview, current);
      return { ok: true, kind: act.kind, chip: act };
    }
    case "pick_time":
      deps.pick(pickTarget(current, act, s, deps.now));
      return { ok: true, kind: act.kind, chip: act };
    case "accept":
    case "offer_times":
    case "suggest_time": {
      const kind = draftKindOf(act.kind) as MeetingDraftKind;
      const slots =
        act.kind === "accept"
          ? act.start
            ? [{ start: act.start, end: act.end ?? act.start }]
            : []
          : (act.slots ?? []).map((x) => ({ start: x.start, end: x.end }));
      try {
        const written = await deps.draft(kind, slots);
        deps.reply(written.text);
        return { ok: true, kind: act.kind, chip: act };
      } catch (error) {
        deps.toast(
          fill(s["strings.meetings.failed"], {
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
        return { ok: false, reason: "failed" };
      }
    }
  }
}
