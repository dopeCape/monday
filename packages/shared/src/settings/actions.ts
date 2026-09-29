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

  /* ------------------------------ RSVP (slice 35) ------------------------------ */
  "actions.recommended.rsvp.enabled": enabled("Accept, Maybe, Decline"),
  "actions.recommended.rsvp.muted_senders": muted("RSVP"),

  /* ------------------------------ Add to calendar ------------------------------ */
  "actions.recommended.calendar.enabled": enabled("Add to calendar"),
  "actions.recommended.calendar.threshold": threshold(
    "Add to calendar",
    0.75,
    "A wrong event on the calendar misleads.",
  ),
  "actions.recommended.calendar.time_confidence": setting({
    type: confidence,
    default: 0.7,
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "more",
    label: "Add to calendar: how sure of the time",
    help: "Below this the chip names the day only and opens the event form; a wrong time is worse than no time.",
  }),
  "actions.recommended.calendar.muted_senders": muted("Add to calendar"),
  "actions.recommended.calendar.question": question(
    "add to calendar",
    "The thread proposes or confirms a specific meeting, call, appointment or event for the mailbox owner, with a day, and no calendar invite for it is attached.",
  ),
  "actions.recommended.calendar.arguments": setting({
    type: argumentWords,
    default: {
      form: {
        instructions: "How is the day of that event written?",
        criteria: {
          absolute: "A calendar date naming a month, such as '3 October' or '10/03'.",
          relative: "Relative to when it was written, such as 'tomorrow', 'Thursday', 'next week'.",
          none: "The thread names no day for the event.",
        },
      },
      month: {
        instructions: "If the day the event happens names a month, which one?",
        criteria: { none: "No month is stated." },
      },
      day: {
        instructions: "If the day the event happens names a day of the month, which day (1 to 31)?",
        criteria: { none: "No day of the month is stated." },
      },
      year: {
        instructions: "If the day the event happens names a year, which one?",
        criteria: { none: "No year is stated.", other: "A year other than these is stated." },
      },
      anchor: {
        instructions: "If the day the event happens is relative, what is it relative to?",
        criteria: {
          today: null,
          tomorrow: null,
          weekday: "A named day of the week.",
          end_of_week: null,
          next_week: "Some time next week, no day named.",
          end_of_month: null,
          none: "It is not relative.",
        },
      },
      weekday: {
        instructions: "If the day the event happens names a day of the week, which one?",
        criteria: { none: "No weekday is named." },
      },
      week: {
        instructions: "If the event's day is a weekday, which week is meant?",
        criteria: {
          this: "This week, or the next such day.",
          next: "The week after this one, as in 'next Thursday' said to mean the following week.",
          none: "No weekday is named.",
        },
      },
      hour: {
        instructions:
          "If the event names a time of day, in which hour of the day does it start, on a 24-hour clock?",
        criteria: { none: "No time of day is stated." },
      },
      minute: {
        instructions: "If the event names a time, at which minute past the hour does it start?",
        criteria: { "00": null, "15": null, "30": null, "45": null, other: null, none: null },
      },
    },
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: "Questions: when the event happens",
    help: "Asked with the calendar question, read only when it holds: the day and time of the event, in parts. Code puts the date together in your zone.",
  }),
  "actions.calendar.default_minutes": setting({
    type: z
      .int()
      .min(5)
      .max(24 * 60),
    default: 30,
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: "Add to calendar: length",
    help: "How long an event added from a chip lasts.",
  }),

  /* ------------------------------ Pay or file ------------------------------ */
  "actions.recommended.pay.enabled": enabled("Pay or file"),
  "actions.recommended.pay.threshold": threshold(
    "Pay or file",
    0.8,
    "Money; the amount must be right.",
  ),
  "actions.recommended.pay.amount_confidence": setting({
    type: confidence,
    default: 0.8,
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "more",
    label: "Pay: how sure of the amount",
    help: "The pay chip shows only when monday is at least this sure of the amount it names.",
  }),
  "actions.recommended.pay.muted_senders": muted("Pay or file"),
  "actions.recommended.pay.question": question(
    "pay",
    "The thread asks the mailbox owner to pay an amount that is still due: an invoice, bill or payment request, not a receipt for something already paid.",
  ),
  "actions.recommended.pay.link_question": setting({
    type: z.string().min(1),
    default: "Which of these links opens the page where the owner pays this amount?",
    scope: "global",
    section: "routing",
    group: GROUP,
    control: "sentence",
    tier: "advanced",
    label: "Question: which link pays",
    help: "Asked when the Thread has links; the options are its links with their domains. Code refuses a link whose domain is not the sender's or a trusted payment processor's.",
  }),
  "actions.recommended.pay.link_none": setting({
    type: z.string().min(1),
    default: "None of these is a payment page.",
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: "Question: which link pays, none",
    help: "The option that says no link is a payment page.",
  }),
  "actions.pay.remind_days_before": setting({
    type: z.int().min(0).max(60),
    default: 2,
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: "Remind me to pay: days before",
    help: "Remind me to pay brings the Thread back this many days before it is due.",
  }),
  "actions.pay.trusted_domains": setting({
    type: z.array(z.string().min(1).max(253)).max(200),
    default: [
      "stripe.com",
      "paypal.com",
      "squareup.com",
      "square.link",
      "gocardless.com",
      "paddle.com",
      "chargebee.com",
      "recurly.com",
      "braintreegateway.com",
      "adyen.com",
      "mollie.com",
      "wise.com",
      "bill.com",
      "invoice.xero.com",
      "quickbooks.intuit.com",
      "freshbooks.com",
    ],
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: "Pay: trusted payment sites",
    help: "Besides the sender's own domain, a pay chip may open links on these domains (and the domains under them). Any other link is never offered.",
  }),
  "actions.pay.file_action": setting({
    type: z.string().max(80),
    default: "",
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: "Pay: the File action",
    help: "The id of the Custom action the pay chip's File runs (the one that files invoices). Empty leaves File out.",
  }),

  /* ------------------------------ Unsubscribe ------------------------------ */
  "actions.recommended.unsubscribe.enabled": enabled("Unsubscribe"),
  "actions.recommended.unsubscribe.muted_senders": muted("Unsubscribe"),
  "actions.unsubscribe.unread_streak": setting({
    type: z.int().min(1).max(100),
    default: 5,
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "more",
    label: "Unsubscribe after unread issues",
    help: "Suggest leaving a mailing list once you left this many of its newest issues unread in a row.",
  }),

  /* ------------------------------ Track a package ------------------------------ */
  "actions.recommended.track.enabled": enabled("Track a package"),
  "actions.recommended.track.threshold": threshold("Track a package", 0.7, "It only opens a page."),
  "actions.recommended.track.muted_senders": muted("Track a package"),
  "actions.recommended.track.question": question(
    "track a package",
    "The thread is a shipping or delivery notice for a package on its way to the mailbox owner.",
  ),
  "actions.recommended.track.number_question": setting({
    type: z.string().min(1),
    default: "Which of these is the tracking number of that package?",
    scope: "global",
    section: "routing",
    group: GROUP,
    control: "sentence",
    tier: "advanced",
    label: "Question: which tracking number",
    help: "Asked when code finds numbers that look like a carrier's.",
  }),
  "actions.recommended.track.number_none": setting({
    type: z.string().min(1),
    default: "None of these is the tracking number.",
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: "Question: which tracking number, none",
    help: "The option that says none is the tracking number.",
  }),
  "actions.track.carrier_urls": setting({
    type: z.record(z.string(), z.string().min(1).max(500)),
    default: {
      ups: "https://www.ups.com/track?tracknum={number}",
      usps: "https://tools.usps.com/go/TrackConfirmAction?tLabels={number}",
      fedex: "https://www.fedex.com/fedextrack/?trknbr={number}",
      dhl: "https://www.dhl.com/global-en/home/tracking/tracking-express.html?tracking-id={number}",
    },
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: "Track: carrier pages",
    help: "The page each carrier tracks a number on; {number} is replaced by the tracking number.",
  }),

  /* ------------------------------ Run a Workflow ------------------------------ */
  "actions.recommended.workflow.enabled": enabled("Run a Workflow"),
  "actions.recommended.workflow.threshold": threshold(
    "Run a Workflow",
    0.8,
    "It starts automation; each Step still asks.",
  ),
  "actions.recommended.workflow.confidence": setting({
    type: confidence,
    default: 0.6,
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: "Run a Workflow: how sure of the pick",
    help: "The chip shows only when monday is at least this sure which Workflow fits.",
  }),
  "actions.recommended.workflow.muted_senders": muted("Run a Workflow"),
  "actions.recommended.workflow.question": question(
    "run a workflow",
    "Which of the owner's workflows would the owner start on this thread by hand?",
  ),
  "actions.recommended.workflow.none": setting({
    type: z.string().min(1),
    default: "None of these workflows is meant for this thread.",
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: "Question: which workflow, none",
    help: "The option that says no Workflow fits.",
  }),

  /* ------------------------------ Learning ------------------------------ */
  "actions.learning.enabled": setting({
    type: z.boolean(),
    default: true,
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "more",
    label: "Learn from what you use",
    help: "An action you rarely use is suggested only when monday is surer; one you use a lot, a little sooner, never below its shipped threshold. Each change shows in the Activity log with Undo.",
  }),
  "actions.learning.window": setting({
    type: z.int().min(5).max(1000),
    default: 50,
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: "Learning: outcomes counted",
    help: "How many of an action's latest outcomes decide whether its threshold moves.",
  }),
  "actions.learning.min_use_rate": setting({
    type: confidence,
    default: 0.1,
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: "Learning: raise below",
    help: "When fewer than this share of an action's chips were used, its threshold rises one step.",
  }),
  "actions.learning.high_use_rate": setting({
    type: confidence,
    default: 0.6,
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: "Learning: lower above",
    help: "When more than this share were used, its threshold falls one step, never below its shipped default.",
  }),
  "actions.learning.step": setting({
    type: z.number().min(0.01).max(0.5),
    default: 0.05,
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: "Learning: step",
    help: "How far a threshold moves at a time.",
  }),
  "actions.learning.max_threshold": setting({
    type: confidence,
    default: 0.95,
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: "Learning: highest threshold",
    help: "Learning never raises a threshold above this.",
  }),

  /* ------------------------------ Words ------------------------------ */
  "strings.actions.recommended.reply": s("reply", "Reply"),
  "strings.actions.recommended.archive": s("archive", "Archive"),
  "strings.actions.recommended.snooze": s("snooze, no time", "Snooze"),
  "strings.actions.recommended.snooze_until": s("snooze until", "Snooze until {when}"),
  "strings.actions.recommended.forward_to": s("forward", "Forward to {name}"),
  "strings.actions.recommended.hand_to": s("hand to someone", "Hand to {name}"),
  "strings.actions.recommended.accept": s("RSVP accept", "Accept"),
  "strings.actions.recommended.maybe": s("RSVP maybe", "Maybe"),
  "strings.actions.recommended.decline": s("RSVP decline", "Decline"),
  "strings.actions.recommended.clashes": s("RSVP clash", "Clashes with {event}"),
  "strings.actions.recommended.calendar": s("add to calendar", "Add {when} to calendar"),
  "strings.actions.recommended.calendar_added": s(
    "added to calendar",
    "Added {title} to your calendar",
  ),
  "strings.actions.recommended.pay_by": s("pay by", "Pay {amount} by {date}"),
  "strings.actions.recommended.pay": s("pay, no date", "Pay {amount}"),
  "strings.actions.recommended.pay_opens": s(
    "pay opens a page",
    "Opens {domain} in your browser. Press again to go there.",
  ),
  "strings.actions.recommended.remind_pay": s("remind me to pay", "Remind me to pay"),
  "strings.actions.recommended.file": s("file", "File"),
  "strings.actions.recommended.unsubscribe": s("unsubscribe", "Unsubscribe"),
  "strings.actions.recommended.unsubscribe_card": s("unsubscribe card title", "Leave {list}?"),
  "strings.actions.recommended.unsubscribe_post": s(
    "unsubscribe one-click",
    "monday sends a one-click unsubscribe request (RFC 8058) to {target}. Nothing else is sent.",
  ),
  "strings.actions.recommended.unsubscribe_mail": s(
    "unsubscribe by mail",
    "monday sends an unsubscribe email from your account to {target}.",
  ),
  "strings.actions.recommended.unsubscribe_browser": s(
    "unsubscribe in the browser",
    "This list has no one-click way out. monday opens {target} in your browser and fetches nothing itself.",
  ),
  "strings.actions.recommended.unsubscribe_approve": s("unsubscribe approve", "Unsubscribe"),
  "strings.actions.recommended.unsubscribe_cancel": s("unsubscribe cancel", "Cancel"),
  "strings.actions.recommended.unsubscribed": s("unsubscribed", "Unsubscribed from {list}"),
  "strings.actions.recommended.unsubscribe_failed": s(
    "unsubscribe failed",
    "The list did not take the request. Try its page instead.",
  ),
  "strings.actions.recommended.archive_issues": s(
    "archive the list's issues",
    "Archive the {count} issues from this list",
  ),
  "strings.actions.recommended.track": s("track", "Track package"),
  "strings.actions.recommended.track_snooze": s(
    "snooze until delivery",
    "Snooze until the delivery day",
  ),
  "strings.actions.recommended.run_workflow": s("run a workflow", "Run {workflow}"),
  "strings.actions.recommended.workflow_started": s("workflow started", "Started {workflow}"),
  "strings.actions.recommended.menu": s("chip menu", "More for this suggestion"),
  "strings.actions.recommended.not_this": s("not this", "Not this"),
  "strings.actions.recommended.not_for": s("not for a sender", "Not for mail from {domain}"),
  "strings.actions.recommended.learned": s(
    "learned threshold",
    "{action} suggestions: shown {shown} times, used {used}; now shown only when {percent} sure",
  ),
  "strings.actions.recommended.stats": s(
    "a row of the stats",
    "{action}: shown {shown}, used {used}, shown at {percent} sure",
  ),
  "strings.actions.recommended.name.reply": s("name: reply", "Reply"),
  "strings.actions.recommended.name.archive": s("name: archive", "Archive"),
  "strings.actions.recommended.name.snooze": s("name: snooze", "Snooze"),
  "strings.actions.recommended.name.forward": s("name: forward", "Forward"),
  "strings.actions.recommended.name.delegate": s("name: hand to someone", "Hand to someone"),
  "strings.actions.recommended.name.rsvp": s("name: RSVP", "RSVP"),
  "strings.actions.recommended.name.calendar": s("name: add to calendar", "Add to calendar"),
  "strings.actions.recommended.name.pay": s("name: pay or file", "Pay or file"),
  "strings.actions.recommended.name.unsubscribe": s("name: unsubscribe", "Unsubscribe"),
  "strings.actions.recommended.name.track": s("name: track a package", "Track a package"),
  "strings.actions.recommended.name.workflow": s("name: run a workflow", "Run a Workflow"),
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
