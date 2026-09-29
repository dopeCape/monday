// The Recommended actions Settings (docs/spec/actions.md; slices 34 and 35):
// every behavior a Setting with its default (ADR 0004), every fit question
// and argument question worded here so the user or the Agent can reword it
// (ADR 0012), every word a strings.actions.recommended.* Setting. Kept in
// their own file and spread into the schema in one line.

import { z } from "zod";
import type { SettingEntry, SettingSection } from "./schema.ts";

function setting<T extends z.ZodType>(entry: SettingEntry<T>): SettingEntry<T> {
  return entry;
}

const confidence = z.number().min(0).max(1);
const GROUP = "Recommended actions";

/** An action's fit threshold, by risk (docs/spec/actions.md, "Thresholds by risk"). */
function threshold(action: string, value: number, why: string) {
  return setting({
    type: confidence,
    default: value,
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "more",
    label: `${action}: how sure first`,
    help: `The chip shows when monday is at least this sure it fits. ${why} Learning may raise it; it never falls below this default on its own.`,
  });
}

function enabled(action: string) {
  return setting({
    type: z.boolean(),
    default: true,
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "more",
    label: `Suggest ${action}`,
    help: `Off: monday never suggests ${action} as a chip.`,
  });
}

function muted(action: string) {
  return setting({
    type: z.array(z.string().min(1).max(253)).max(500),
    default: [],
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: `${action}: not for mail from`,
    help: `Sender domains "Not for mail from" added: mail from them never gets this suggestion.`,
  });
}

/** A fit question's words (ADR 0012: the user's to reword; a new wording is a new Question version). */
function question(action: string, value: string) {
  return setting({
    type: z.string().min(1),
    default: value,
    scope: "global",
    section: "routing",
    group: GROUP,
    control: "sentence",
    tier: "advanced",
    label: `Question: ${action}`,
    help: "What the judge is asked about every Thread for this action. It reads it literally. A reworded question is read again in the background.",
  });
}

function criterion(action: string, side: "true" | "false", value: string) {
  return setting({
    type: z.string().min(1),
    default: value,
    scope: "global",
    section: "routing",
    group: GROUP,
    control: "sentence",
    tier: "advanced",
    label: `Question: ${action}, when ${side === "true" ? "yes" : "no"}`,
    help: `What makes the answer ${side === "true" ? "yes" : "no"}, stated exactly.`,
  });
}

/** Argument Choices' words: per question, its instructions and its described options. */
const argumentWords = z.record(
  z.string(),
  z.object({
    instructions: z.string().min(1),
    criteria: z.record(z.string(), z.string().nullable()).optional(),
  }),
);

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

const s = (label: string, value: string) => str("routing", `Recommended action: ${label}`, value);

export const ACTION_SETTINGS = {
  /* ------------------------------ The row ------------------------------ */
  "actions.recommended.enabled": setting({
    type: z.boolean(),
    default: true,
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "more",
    label: "Suggest actions",
    help: "Chips under the Brief and on a row's hover that do the likely next thing: reply, archive, snooze, forward. Each is an ordinary action with its own approval.",
  }),
  "actions.recommended.max_in_reader": setting({
    type: z.int().min(0).max(6),
    default: 3,
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "more",
    label: "Chips in the reader",
    help: "The most chips the reader shows under the Brief, your own Custom actions first.",
  }),
  "actions.recommended.max_in_list": setting({
    type: z.int().min(0).max(2),
    default: 1,
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "more",
    label: "Chips on a row",
    help: "The most suggested actions a row shows beside archive and snooze.",
  }),
  "actions.recommended.in_list": setting({
    type: z.enum(["hover", "always", "off"]),
    default: "hover",
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "more",
    label: "On rows",
    help: "Hover: a row shows its top suggestion only on hover and when selected, so the list stays calm. Always: every row shows it. Off: only the reader shows suggestions.",
  }),
  "actions.recommended.keys": setting({
    type: z.array(z.string().min(1).max(40)).max(6),
    default: ["alt+1", "alt+2", "alt+3"],
    scope: "global",
    section: "shortcuts",
    group: "Keymap",
    tier: "more",
    label: "Run a suggested action",
    help: "The keys that run the chips in the reader's order; in the list, the hovered or selected row's chip.",
  }),

  /* ------------------------------ Reply ------------------------------ */
  "actions.recommended.reply.enabled": enabled("Reply"),
  "actions.recommended.reply.threshold": threshold(
    "Reply",
    0.7,
    "It only opens the reply; a wrong one costs a click.",
  ),
  "actions.recommended.reply.muted_senders": muted("Reply"),

  /* ------------------------------ Archive ------------------------------ */
  "actions.recommended.archive.enabled": enabled("Archive"),
  "actions.recommended.archive.threshold": threshold(
    "Archive",
    0.85,
    "It hides mail; Undo exists but a wrong one may go unnoticed.",
  ),
  "actions.recommended.archive.muted_senders": muted("Archive"),
  "actions.recommended.archive.question": question(
    "archive",
    "The mailbox owner can archive this thread now: nothing on it needs them and they will not need to find it in the inbox again.",
  ),
  "actions.recommended.archive.question.true": criterion(
    "archive",
    "true",
    "A receipt, notification, confirmation, finished exchange or announcement that asks nothing and is complete.",
  ),
  "actions.recommended.archive.question.false": criterion(
    "archive",
    "false",
    "Anything that asks the owner for something, is still in progress, has a date still ahead, or that the owner is likely to come back to.",
  ),

  /* ------------------------------ Snooze ------------------------------ */
  "actions.recommended.snooze.enabled": enabled("Snooze"),
  "actions.recommended.snooze.threshold": threshold("Snooze", 0.75, "It hides mail until a time."),
  "actions.recommended.snooze.muted_senders": muted("Snooze"),
  "actions.recommended.snooze.question": question(
    "snooze",
    "This thread needs the mailbox owner later, not now: it names a later day when something happens, or it waits on something that has not happened yet.",
  ),
  "actions.recommended.snooze.question.true": criterion(
    "snooze",
    "true",
    "Examples: a delivery due Thursday, a meeting next week that needs preparing the day before, 'let's pick this up after the launch'.",
  ),
  "actions.recommended.snooze.question.false": criterion(
    "snooze",
    "false",
    "It needs the owner now, or never.",
  ),
  "actions.recommended.snooze.arguments": setting({
    type: argumentWords,
    default: {
      anchor: {
        instructions:
          "If the owner puts this thread aside, when should it come back? Use the day the thread itself points to.",
        criteria: {
          tomorrow: null,
          weekday: "A named day this week or next.",
          next_week: "Next week, no day named.",
          deadline: "Shortly before the date the owner has to act by.",
          date: "A calendar date named in the thread.",
          none: "The thread points to no day.",
        },
      },
      weekday: {
        instructions: "If it should come back on a named day of the week, which one?",
        criteria: {
          monday: null,
          tuesday: null,
          wednesday: null,
          thursday: null,
          friday: null,
          saturday: null,
          sunday: null,
          none: null,
        },
      },
      part: {
        instructions: "If the thread points to a part of that day, which one?",
        criteria: { morning: null, afternoon: null, evening: null, none: null },
      },
    },
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: "Questions: when a snooze ends",
    help: "Asked with the snooze question, read only when it holds: the day and the part of the day the Thread points to. Code turns them into a time.",
  }),
  "actions.snooze.before_deadline_hours": setting({
    type: z
      .int()
      .min(0)
      .max(24 * 14),
    default: 24,
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: "Snooze: back before a deadline",
    help: "A Thread with a deadline comes back this many hours before it.",
  }),
  "actions.snooze.afternoon_hour": setting({
    type: z.int().min(0).max(23),
    default: 14,
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: "Snooze: afternoon",
    help: "The hour a snooze to the afternoon ends. The morning is the Inbox's morning hour.",
  }),
  "actions.snooze.evening_hour": setting({
    type: z.int().min(0).max(23),
    default: 18,
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: "Snooze: evening",
    help: "The hour a snooze to the evening ends.",
  }),

  /* ------------------------------ Forward and Hand to someone ------------------------------ */
  "actions.recommended.forward.enabled": enabled("Forward"),
  "actions.recommended.forward.threshold": threshold(
    "Forward",
    0.8,
    "A wrong recipient is embarrassing even though it asks first.",
  ),
  "actions.recommended.forward.to_confidence": setting({
    type: confidence,
    default: 0.8,
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "more",
    label: "Forward: how sure of the person",
    help: "Forward to and Hand to show a person only when monday is at least this sure it is the right one.",
  }),
  "actions.recommended.forward.muted_senders": muted("Forward"),
  "actions.recommended.forward.question": question(
    "forward",
    "The mailbox owner will want to send this thread on to someone else so they have it, such as an accountant, an assistant or a colleague who keeps records.",
  ),
  "actions.recommended.delegate.enabled": enabled("Hand to someone"),
  "actions.recommended.delegate.threshold": threshold(
    "Hand to someone",
    0.85,
    "It passes responsibility on.",
  ),
  "actions.recommended.delegate.muted_senders": muted("Hand to someone"),
  "actions.recommended.delegate.question": question(
    "hand to someone",
    "The mailbox owner will want someone else to handle what this thread asks, rather than doing it themselves.",
  ),
  "actions.recommended.forward.to_question": setting({
    type: z.string().min(1),
    default:
      "If the owner sends this thread on, to whom? Choose from the people listed; use what the owner did with earlier mail from this sender.",
    scope: "global",
    section: "routing",
    group: GROUP,
    control: "sentence",
    tier: "advanced",
    label: "Question: to whom",
    help: "Asked when code finds people to offer: those you forwarded this sender's mail to, people named in the Thread, and your hand-off list.",
  }),
  "actions.recommended.forward.to_none": setting({
    type: z.string().min(1),
    default: "None of these people.",
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: "Question: to whom, none",
    help: "The option that says no one listed fits.",
  }),
  "actions.delegate.people": setting({
    type: z.array(z.string().min(3).max(320)).max(50),
    default: [],
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "more",
    label: "People you hand work to",
    help: "Addresses (or Name <address>) monday may suggest for Forward and Hand to, beside the people it learns from your mail.",
  }),
  "actions.delegate.follow_up_days": setting({
    type: z.int().min(0).max(60),
    default: 3,
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: "Hand to: follow up after",
    help: "After a hand-off is sent, offer to snooze the Thread this many days so you see whether it was done. 0 offers nothing.",
  }),

  /* ------------------------------ Words ------------------------------ */
  "strings.actions.recommended.reply": s("reply", "Reply"),
  "strings.actions.recommended.archive": s("archive", "Archive"),
  "strings.actions.recommended.snooze": s("snooze, no time", "Snooze"),
  "strings.actions.recommended.snooze_until": s("snooze until", "Snooze until {when}"),
  "strings.actions.recommended.forward_to": s("forward", "Forward to {name}"),
  "strings.actions.recommended.hand_to": s("hand to someone", "Hand to {name}"),
  "strings.actions.recommended.follow_up": s(
    "hand-off follow-up",
    "Snooze until {when} to check it was done?",
  ),
  "strings.actions.recommended.changed": s(
    "thread changed",
    "This thread changed. {label} still? Press it again.",
  ),
  "strings.actions.recommended.needs_typesafe": s(
    "needs TypeSafe",
    "Suggested actions beyond Reply need a TypeSafe key.",
  ),
  "strings.actions.recommended.candidate.named": s(
    "person line: named in the thread",
    "Named in this thread",
  ),
  "strings.actions.recommended.candidate.handoff": s(
    "person line: hand-off list",
    "On your hand-off list",
  ),
  "strings.actions.recommended.candidate.forwarded": s(
    "person line: forwarded before",
    "Forwarded {count} threads from {sender}",
  ),
  "strings.actions.recommended.page.title": s("page title", "Recommended actions"),
  "strings.actions.recommended.page.intro": s(
    "page intro",
    "Chips that do the likely next thing on a thread. Each asks or offers Undo like the action itself.",
  ),
  "strings.actions.recommended.palette": s("palette row", "{label}"),
};
