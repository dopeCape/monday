// The 21 built-in Templates (docs/spec/templates.md, "The built-ins"). Data,
// read-only: editing one saves a copy in the Workspace that replaces it in
// the picker, and "Restore the original" deletes the copy. Hiding one is the
// Setting templates.builtin.hidden. No built-in carries a signature (compose
// adds the Account's own), and none uses an em-dash.

import { tidyTemplate } from "./syntax.ts";
import type { Placeholder, PlaceholderType, Template, TemplateInput } from "./types.ts";

/** When the built-ins were last worded; their rows' updatedAt. */
export const BUILTIN_TEMPLATES_VERSION = "2026-09-29T00:00:00.000Z";

const p = (name: string, type: PlaceholderType, hint: string, optional = false): Placeholder => ({
  name,
  type,
  optional,
  hint,
});

const FIRST_NAME = p(
  "first_name",
  "first_name",
  "the first name of the person the owner writes to",
);

interface BuiltinSpec extends TemplateInput {
  id: string;
}

const SPECS: BuiltinSpec[] = [
  {
    id: "t_thanks_received",
    name: "Thanks, received",
    kind: "reply",
    fitsWhen:
      "Someone sent a file, document, payment or information the owner only needs to acknowledge",
    subject: null,
    body: "Hi {first_name},\n\nThanks for sending {thing}. I've got it and will take a look.\n\nThanks,",
    placeholders: [
      FIRST_NAME,
      p("thing", "text", "what the sender sent: the file, document, payment or information"),
    ],
  },
  {
    id: "t_confirm_time",
    name: "Confirm the time",
    kind: "reply",
    fitsWhen: "Someone proposed a time for a call or meeting and the owner accepts it",
    subject: null,
    body: "Hi {first_name},\n\n{time} on {date} works for me. I'll send an invite shortly.\n\nThanks,",
    placeholders: [
      FIRST_NAME,
      p("time", "time", "the time of day the sender proposed for the call or meeting"),
      p("date", "date", "the day the sender proposed for the call or meeting"),
    ],
  },
  {
    id: "t_offer_times",
    name: "Offer other times",
    kind: "reply",
    fitsWhen: "Someone proposed a time the owner cannot make",
    subject: null,
    body: "Hi {first_name},\n\nThanks for the invite. I can't make that time, but any of these would work for me: {times}.\n\nLet me know which suits you best.\n\nThanks,",
    placeholders: [FIRST_NAME, p("times", "text", "other times the owner can offer")],
  },
  {
    id: "t_decline",
    name: "Decline politely",
    kind: "reply",
    fitsWhen: "The owner says no to a request, invitation or offer",
    subject: null,
    body: "Hi {first_name},\n\nThank you for thinking of me. I'm going to pass on this one {reason?}.\n\nAll the best,",
    placeholders: [FIRST_NAME, p("reason", "text", "why the owner says no", true)],
  },
  {
    id: "t_need_more_time",
    name: "Need more time",
    kind: "reply",
    fitsWhen: "The owner cannot meet a deadline and proposes a later one",
    subject: null,
    body: "Hi {first_name},\n\nI need a little more time on this. Would {new_date} work instead?\n\nThanks for your patience,",
    placeholders: [FIRST_NAME, p("new_date", "date", "the later date the owner proposes")],
  },
  {
    id: "t_follow_up",
    name: "Follow up",
    kind: "reply",
    fitsWhen: "The owner wrote before and has had no answer",
    subject: null,
    body: "Hi {first_name},\n\nJust following up on {topic}. Is there anything you need from me?\n\nThanks,",
    placeholders: [FIRST_NAME, p("topic", "text", "what the owner wrote about before")],
  },
  {
    id: "t_here_is_the_file",
    name: "Here is the file",
    kind: "reply",
    fitsWhen: "Someone asked for a document the owner is attaching",
    subject: null,
    body: "Hi {first_name},\n\nHere is {document}, attached. Let me know if you need anything else.\n\nThanks,",
    placeholders: [FIRST_NAME, p("document", "text", "the document the sender asked for")],
  },
  {
    id: "t_ask_for_details",
    name: "Ask for details",
    kind: "reply",
    fitsWhen: "The owner needs one thing clarified before acting",
    subject: null,
    body: "Hi {first_name},\n\nBefore I go ahead, could you tell me {question}?\n\nThanks,",
    placeholders: [FIRST_NAME, p("question", "text", "the one thing the owner needs clarified")],
  },
  {
    id: "t_handing_over",
    name: "Handing this over",
    kind: "reply",
    fitsWhen: "The owner passes the request to a colleague who will handle it",
    subject: null,
    body: "Hi {first_name},\n\nThanks for reaching out. {colleague} is the best person for this, so I've copied them in ({colleague_email}). They'll take it from here.\n\nBest,",
    placeholders: [
      FIRST_NAME,
      p("colleague", "person", "the colleague who will handle the request"),
      p("colleague_email", "email", "the colleague's email address"),
    ],
  },
  {
    id: "t_payment_sent",
    name: "Payment sent",
    kind: "reply",
    fitsWhen: "The owner has paid an invoice and says so",
    subject: null,
    body: "Hi {first_name},\n\nI've paid {amount} for invoice {reference} on {date}. Please let me know if anything else is needed.\n\nThanks,",
    placeholders: [
      FIRST_NAME,
      p("amount", "amount", "the amount the invoice asks for"),
      p("reference", "reference", "the invoice number the sender quotes"),
      p("date", "date", "the day the owner paid"),
    ],
  },
  {
    id: "t_invoice_question",
    name: "Question about an invoice",
    kind: "reply",
    fitsWhen: "Something on an invoice looks wrong",
    subject: null,
    body: "Hi {first_name},\n\nI have a question about invoice {reference} for {amount}: {issue}. Could you take a look?\n\nThanks,",
    placeholders: [
      FIRST_NAME,
      p("reference", "reference", "the invoice number the sender quotes"),
      p("amount", "amount", "the amount on the invoice"),
      p("issue", "text", "what looks wrong on the invoice"),
    ],
  },
  {
    id: "t_not_interested",
    name: "Not interested, thanks",
    kind: "reply",
    fitsWhen: "Sales or recruiting outreach the owner declines",
    subject: null,
    body: "Hi {first_name},\n\nThanks for reaching out. I'm not interested at the moment, but I appreciate you thinking of me.\n\nBest,",
    placeholders: [FIRST_NAME],
  },
  {
    id: "t_thanks_for_applying",
    name: "Thanks for applying",
    kind: "reply",
    fitsWhen: "A candidate applied; the owner confirms and names the next step",
    subject: null,
    body: "Hi {first_name},\n\nThank you for applying for the {role} role. We've received your application, and the next step is {next_step}.\n\nBest,",
    placeholders: [
      FIRST_NAME,
      p("role", "text", "the role the candidate applied for"),
      p("next_step", "text", "what happens next in the process"),
    ],
  },
  {
    id: "t_reschedule",
    name: "Reschedule",
    kind: "reply",
    fitsWhen: "The owner moves an agreed meeting",
    subject: null,
    body: "Hi {first_name},\n\nSomething has come up and I can't make {old_time}. Could we move to {new_time} instead?\n\nSorry for the change,",
    placeholders: [
      FIRST_NAME,
      p("old_time", "time", "the time the meeting was agreed for"),
      p("new_time", "time", "the new time the owner proposes"),
    ],
  },
  {
    id: "t_slow_to_reply",
    name: "Slow to reply this week",
    kind: "reply",
    fitsWhen: "The owner is away or busy and sets expectations",
    subject: null,
    body: "Hi {first_name},\n\nThanks for your message. I'm slow to reply this week and will get back to you properly by {return_date}.\n\nThanks,",
    placeholders: [FIRST_NAME, p("return_date", "date", "when the owner will reply properly")],
  },
  {
    id: "t_thank_you",
    name: "Thank you",
    kind: "reply",
    fitsWhen: "The owner thanks someone for help, a favour or an introduction",
    subject: null,
    body: "Hi {first_name},\n\nThank you so much for {what_for}. I really appreciate it.\n\nBest,",
    placeholders: [FIRST_NAME, p("what_for", "text", "what the owner thanks them for")],
  },
  {
    id: "t_introduce",
    name: "Introduce two people",
    kind: "starter",
    fitsWhen: "The owner connects two people who should talk",
    subject: "Introduction: {person_a} and {person_b}",
    body: "Hi {person_a} and {person_b},\n\nI'd like to introduce you two. {reason}\n\n{person_b}, you can reach {person_a} here, and {person_a}, {person_b} is at {person_b_email}. I'll let you take it from here.\n\nBest,",
    placeholders: [
      p("person_a", "person", "the first person being introduced"),
      p("person_b", "person", "the second person being introduced"),
      p("reason", "text", "why the two should talk"),
      p("person_b_email", "email", "the second person's email address"),
    ],
  },
  {
    id: "t_schedule_call",
    name: "Schedule a call",
    kind: "starter",
    fitsWhen: "The owner asks someone for a short call",
    subject: "A quick call about {topic}",
    body: "Hi {first_name},\n\nWould you have 20 minutes for a call about {topic}? Any of these times work for me: {times}.\n\nThanks,",
    placeholders: [
      FIRST_NAME,
      p("topic", "text", "what the call is about"),
      p("times", "text", "the times the owner offers"),
    ],
  },
  {
    id: "t_checking_in",
    name: "Checking in",
    kind: "starter",
    fitsWhen: "The owner restarts a quiet conversation",
    subject: "Checking in on {topic}",
    body: "Hi {first_name},\n\nIt's been a while, so I wanted to check in on {topic}. How are things going on your side?\n\nBest,",
    placeholders: [FIRST_NAME, p("topic", "text", "the conversation the owner restarts")],
  },
  {
    id: "t_refund",
    name: "Ask for a refund",
    kind: "starter",
    fitsWhen: "The owner asks a company to refund an order",
    subject: "Refund request for order {reference}",
    body: "Hello {company},\n\nI'd like to ask for a refund of {amount} for order {reference}. The reason is {reason}.\n\nThank you,",
    placeholders: [
      p("reference", "reference", "the order number"),
      p("company", "text", "the company the order was placed with"),
      p("amount", "amount", "the amount paid for the order"),
      p("reason", "text", "why the owner wants a refund"),
    ],
  },
  {
    id: "t_remove_me",
    name: "Please remove me",
    kind: "starter",
    fitsWhen: "A list without an unsubscribe header keeps writing",
    subject: "Please remove me from your list",
    body: "Hello {company?},\n\nPlease remove my address from your mailing list. Thank you.",
    placeholders: [p("company", "text", "the company or list that keeps writing", true)],
  },
];

/** The built-ins as Templates: no Workspace, `builtIn` naming themselves, Placeholders in order of use. */
export const BUILTIN_TEMPLATES: readonly Template[] = SPECS.map(({ id, ...input }) => ({
  ...tidyTemplate(input),
  id,
  workspaceId: null,
  shareGroupId: null,
  builtIn: id,
  createdBy: "user",
  updatedAt: BUILTIN_TEMPLATES_VERSION,
}));

export const BUILTIN_TEMPLATE_IDS: readonly string[] = BUILTIN_TEMPLATES.map((t) => t.id);

export function findBuiltinTemplate(id: string): Template | undefined {
  return BUILTIN_TEMPLATES.find((t) => t.id === id);
}

/**
 * The library a Workspace sees, in the picker's order: its own Templates
 * first, then every built-in that is neither hidden nor replaced by a copy.
 */
export function templateLibrary(
  own: readonly Template[],
  hidden: readonly string[] = [],
): Template[] {
  const replaced = new Set(own.flatMap((t) => (t.builtIn ? [t.builtIn] : [])));
  const hide = new Set(hidden);
  return [...own, ...BUILTIN_TEMPLATES.filter((t) => !replaced.has(t.id) && !hide.has(t.id))];
}
