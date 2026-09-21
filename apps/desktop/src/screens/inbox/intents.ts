// The palette's typed sentence on the Device (ADR 0012, slice 27): the seam
// the palette asks through, the intent's wording for the "Do" and "Did you
// mean" rows, the Threads a set intent names (decided here, over the Cache,
// never by the model), and the scheduling card's arguments. Pure apart from
// the seam; Inbox.tsx runs what comes out through InboxActions.

import type {
  EventPreview,
  IntentReading,
  IntentRequest,
  Person,
  Settings,
  Thread,
  ToolCall,
  TypedIntent,
} from "@monday/shared";
import { formatSpan } from "@monday/ui";
import { formatWake } from "./snooze.ts";
import { fill } from "./triage.ts";

/** What the palette asks: the Server's one Judgment, or null when no judge answers. */
export interface IntentJudge {
  intent(request: IntentRequest): Promise<IntentReading | null>;
}

/** The Threads a set intent names, from the list the palette can see. */
export function targetsOf(
  intent: Pick<TypedIntent, "scope" | "threadKind" | "olderThan" | "person">,
  threads: readonly Thread[],
  focus: string | null,
): string[] {
  if (intent.scope === "one") return focus ? [focus] : [];
  const cutoff = intent.olderThan?.getTime() ?? null;
  const email = intent.person?.email.toLowerCase() ?? null;
  return threads
    .filter((t) => {
      if (cutoff !== null && new Date(t.lastActivity).getTime() >= cutoff) return false;
      switch (intent.threadKind) {
        case "newsletter":
          return t.section === "newsletters" || t.bulk === true;
        case "unread":
          return t.unread;
        case "starred":
          return t.starred;
        case "from_person":
          return email !== null && t.participants.some((p) => p.email.toLowerCase() === email);
        default:
          return true;
      }
    })
    .map((t) => t.id);
}

/** Contacts by recency from what the palette can see: the composer's list, else the Threads' participants. */
export function contactsOf(
  participants: readonly Person[],
  threads: readonly Thread[],
  max: number,
): Person[] {
  const out: Person[] = [];
  const seen = new Set<string>();
  const add = (p: Person) => {
    const key = p.email.toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ name: p.name, email: p.email });
  };
  for (const p of participants) add(p);
  if (out.length === 0) for (const t of threads) for (const p of t.participants) add(p);
  return out.slice(0, max);
}

/** The intent in the user's words, for the palette row. */
export function describeIntent(
  intent: TypedIntent,
  count: number,
  settings: Settings,
  now: Date,
): string {
  const what =
    intent.scope === "one"
      ? settings["strings.palette.intent.this_thread"]
      : count === 0
        ? settings["strings.palette.intent.no_threads"]
        : count === 1
          ? settings["strings.palette.intent.thread"]
          : fill(settings["strings.palette.intent.threads"], { n: count });
  const when = intent.when
    ? formatWake(intent.when, now)
    : settings["strings.palette.intent.no_time"];
  switch (intent.kind) {
    case "archive":
    case "tag":
    case "star":
    case "mark_read":
      return fill(settings[`strings.palette.intent.${intent.kind}`], { what });
    case "snooze":
      return fill(settings["strings.palette.intent.snooze"], { what, when });
    case "move":
      return fill(settings["strings.palette.intent.move"], {
        what,
        group: intent.group?.name ?? "",
      });
    case "schedule_event":
      return fill(settings["strings.palette.intent.schedule_event"], {
        title: eventTitle(intent, settings),
        when,
      });
    case "search":
      return fill(settings["strings.palette.intent.search"], { text: intent.text });
    case "compose":
      return fill(settings["strings.palette.intent.compose"], {
        person: intent.person?.name || intent.person?.email || "",
      });
    case "open_group":
      return fill(settings["strings.palette.intent.open_group"], {
        group: intent.group?.name ?? "",
      });
    case "open_section":
      return fill(settings["strings.palette.intent.open_section"], {
        section: intent.section?.name ?? "",
      });
    default:
      return intent.text;
  }
}

export function eventTitle(intent: Pick<TypedIntent, "person">, settings: Settings): string {
  return intent.person
    ? fill(settings["strings.palette.intent.event_title"], {
        person: intent.person.name || intent.person.email,
      })
    : settings["strings.palette.intent.event_title_alone"];
}

/** The scheduling card as the composer shows it before the Event exists, with the sentence's arguments filled. */
export function eventPreviewOf(intent: TypedIntent, settings: Settings, now: Date): EventPreview {
  const start = intent.when ?? now;
  const end = new Date(start.getTime() + settings["calendar.default_duration_minutes"] * 60_000);
  return {
    action: "schedule",
    title: eventTitle(intent, settings),
    start: start.toISOString(),
    end: end.toISOString(),
    allDay: false,
    timeZone: typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : null,
    attendees: intent.person ? [intent.person] : [],
    // The Provider's own link is minted on approval; the card names a fixed kind only.
    link:
      settings["calendar.meeting_link"] === "provider" ||
      settings["calendar.meeting_link"] === "none"
        ? null
        : settings["calendar.meeting_link"],
    invitesBy: intent.person ? "provider" : "none",
    conflicts: [],
  };
}

/** The card's ToolCall shell: the scheduling tool, waiting for the user, straight from the palette. */
export function eventCall(preview: EventPreview, id: string): ToolCall {
  return {
    id,
    sessionId: null,
    runId: null,
    tool: "schedule_event",
    tier: "always-ask",
    inputSummary: `${preview.title}, ${formatSpan(preview.start, preview.end, preview.allDay)}`,
    status: "waiting",
    approvedBy: null,
    undoable: false,
  };
}
