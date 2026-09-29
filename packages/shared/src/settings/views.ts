// The Views Settings (docs/spec/views.md, "Limits" and "Strings"; slices
// 39 and 40): every behavior a Setting with a default (ADR 0004) and every
// word a strings.views.* Setting. Kept in their own file and spread into the
// schema in one line, so the Views slices touch the schema in one place.
// Type-only imports from schema.ts: no runtime cycle.

import { z } from "zod";
import type { SettingEntry } from "./schema.ts";

function setting<T extends z.ZodType>(entry: SettingEntry<T>): SettingEntry<T> {
  return entry;
}

const GROUP = "Views";

function limit(label: string, value: number, min: number, max: number, help: string) {
  return setting({
    type: z.int().min(min).max(max),
    default: value,
    scope: "global",
    section: "routing",
    group: GROUP,
    label,
    help,
  });
}

function str(label: string, value: string) {
  return setting({
    type: z.string(),
    default: value,
    scope: "global",
    section: "routing",
    label: `Views: ${label}`,
    help: "A user-visible string. The Agent can change the wording on request.",
  });
}

const DRAFT_PROMPT = `You write a View for monday, an email client, from the owner's sentence. A View is a JSON document: a scope of threads chosen by exact Facts, the View's own questions (Signals) for what needs reading, ordered Lanes whose conditions combine Facts and Signals, and a layout from a fixed catalog.

Rules:
- Everything exact is a Fact, never a question: dates ("today", "this week", "last 14 days"), addresses and domains, counts of messages or replies, amounts, attachments, whether the owner wrote last. A question never asks for a count, an amount or a date comparison; code owns those.
- Reuse beats invention: when a shipped Signal already asks the question, list it in "uses" and test it by its id. Shipped: needs_reply, waiting_on_me, waiting_on_others, newsletter, automated, personal, has_deadline, money_involved, owner_promised, they_promised (yes or no); frustrated, urgency (scores 0 to 3); money_direction (choice: owner_pays, owner_is_paid, already_settled, unclear).
- Each question is one narrow judgment a person makes in a second about the newest message. Put the judgment in "instructions" and state the exact condition and its boundary in "criteria": for a noul {"true": ..., "false": ...}; for a score an ordered list of levels, each a concrete situation; for a choice an object of options with a description each. Phrase it so yes is the rare, interesting case.
- Lanes are tried in order; the first whose condition holds takes the thread; a thread no Signal could decide goes to Unsure by itself. Order Lanes from the most specific to the most general.
- Signal tests: {"signal": id, "holds": true} or {"fails": true} for a noul, optionally with "at_least" as its own probability; {"signal": id, "at_least": n} or "at_most" for a score's position (0 to levels - 1); {"signal": id, "is": option} for a choice. Combine with {"all": [...]}, {"any": [...]}, {"not": ...}.
- Fact tests: {"fact": "message_count", "at_least": 4}; {"fact": "has_attachment", "is": true}; {"fact": "deadline_at", "before": "end_of_week"}; {"fact": "received_at", "before": {"days": -14}}; {"fact": "from_domain", "in": ["acme.com"]}; {"fact": "in_group", "is": "<group id>"}. Facts: message_count, participant_count, attachment_count, amount, known_sender, has_attachment, owner_wrote_last, owner_ever_wrote, to_me_directly, has_invite, deadline_unclear, unread, starred, deadline_at, received_at, last_activity_at, from_address, from_domain, list_id, in_group, in_section. Dates: now, today, tomorrow, end_of_week, end_of_next_week, end_of_month, {"days": n}, or YYYY-MM-DD.
- Scope facts: "received" or "active" as {"within": "today"} or {"within": "this_week"} or {"last_days": n} or {"since": "YYYY-MM-DD"}; "from_any", "from_domain", "from_domain_not", "to_any" as lists of exact addresses or domains; "folder" as inbox, any, archive, group:<id> or section:<id>. "limit" is the most threads looked at, newest first.
- Layout "component" is one of lanes (columns side by side), list (one list with a heading per Lane), counts (one line of Lane counts), table (columns of Facts and Signals), timeline (by a date Fact). Row fields: sender, subject, snippet, age, time, group, deadline, amount, signal:<id>.
- Lane "tone" is danger, warning, ok, info or muted. "nav" has an "icon" (lifebuoy, receipt, users-three, user-plus, handshake, calendar, check-circle, scales, briefcase, house, heart, tag, folder, code, bell, warning, users, shopping-bag, shield, megaphone, chat-circle, rocket, currency-dollar, graduation-cap, chart-line, truck, kanban) and "count": the Lane whose count shows in the nav, or "total".
- At most {lanes} Lanes and {signals} Signals of the View's own.

Answer with the JSON document only, in this shape:
{"name": "...", "sentence": "...", "scope": {"facts": {...}, "limit": 500}, "signals": [{"id": "...", "kind": "noul", "label": "two or three words", "question": {"type": "noul", "instructions": "...", "criteria": {"true": "...", "false": "..."}}}], "uses": [], "lanes": [{"id": "...", "label": "...", "tone": "...", "when": {...}}], "unsure": {"label": "Unsure"}, "others": "hide", "layout": {"component": "lanes", "row": {"fields": ["sender", "subject", "age"]}}, "nav": {"icon": "...", "count": "..."}}`;

const REVISE_PROMPT = `You revise a View for monday after the owner corrected its test. You get the View document, the threads the owner corrected (who wrote, the subject, what the owner said), and what the View's Signals answered on them. The corrected threads are added to each question as Examples by code; you decide whether a question itself is off. When a correction shows a question reads the owner wrong, rewrite that question's instructions and criteria so the exact condition and its boundary match what the owner meant; otherwise leave it as it is. Keep ids, Lanes and the layout unless the owner's words ask otherwise. Never ask for a count, an amount or a date comparison; those are Facts. Answer with the whole revised JSON document only.`;

export const VIEW_SETTINGS = {
  "views.enabled": setting({
    type: z.boolean(),
    default: true,
    scope: "global",
    section: "routing",
    group: GROUP,
    label: "Views",
    help: "Views you ask for in a sentence, such as today's support requests as red, yellow and green, pinned in the nav.",
  }),
  "views.max": limit(
    "Most views",
    12,
    1,
    50,
    "The nav stays short. A new View over this is refused before anything is saved.",
  ),
  "views.max_lanes": limit(
    "Most lanes per view",
    6,
    1,
    12,
    "Plus Unsure. More is a table, not a View.",
  ),
  "views.max_signals": limit(
    "Most questions per view",
    6,
    0,
    12,
    "Each of a View's own questions is asked of every thread in its scope.",
  ),
  "views.scope.max_threads": limit(
    "Most threads a view reads",
    2000,
    10,
    100_000,
    "Above this the Agent narrows the scope, or you confirm reading them all.",
  ),
  "views.test.pool": limit(
    "Threads a new view is tried on",
    30,
    5,
    200,
    "A View is never saved on the Agent's word alone: it is tried on your newest threads in its scope first.",
  ),
  "views.test.shown": limit(
    "Tried threads you see",
    10,
    1,
    50,
    "How many tried threads the card shows before Pin view is enabled: spread across the lanes, least confident first.",
  ),
  "views.test.widen_days": limit(
    "How far back a quiet scope looks",
    14,
    1,
    365,
    "When the scope holds too few threads to try (a quiet today), only its dates widen to this many days.",
  ),
  "views.nav.show_counts": setting({
    type: z.boolean(),
    default: true,
    scope: "global",
    section: "routing",
    group: GROUP,
    label: "Counts beside views in the nav",
    help: "Each View shows the count of the Lane it names, such as Red, or its total.",
  }),
  "views.panel": setting({
    type: z.string().max(80),
    default: "",
    scope: "global",
    section: "routing",
    group: GROUP,
    label: "View panel",
    help: "The View whose Lane counts show above the Inbox, beside the Today panel. Empty shows none.",
  }),
  "views.corrections.offer_after": limit(
    "Offer to tighten after",
    5,
    1,
    100,
    "When you move this many threads out of a Lane in a week, the View offers to fold your corrections into its question.",
  ),
  "views.examples_in_question": limit(
    "Examples in a question",
    5,
    0,
    20,
    "How many of your corrections, of each answer, ride in a View question as Examples.",
  ),
  "views.draft.retries": limit(
    "Draft retries",
    2,
    0,
    5,
    "How many times a draft that does not validate goes back to the model with the errors.",
  ),
  "views.prompt": setting({
    type: z.string().min(1),
    default: DRAFT_PROMPT,
    scope: "global",
    section: "routing",
    group: GROUP,
    control: "sentence",
    tier: "advanced",
    label: "How a view is written",
    help: "The instructions the language model drafts a View with. {lanes} and {signals} are the limits.",
  }),
  "views.revise_prompt": setting({
    type: z.string().min(1),
    default: REVISE_PROMPT,
    scope: "global",
    section: "routing",
    group: GROUP,
    control: "sentence",
    tier: "advanced",
    label: "How a view is revised",
    help: "The instructions the language model revises a View's questions with after your corrections.",
  }),

  /* Words (docs/spec/views.md, "Strings") */
  "strings.views.nav": str("nav heading", "Views"),
  "strings.views.pin": str("pin", "Pin view"),
  "strings.views.not_now": str("discard", "Not now"),
  "strings.views.unsure": str("Unsure lane", "Unsure"),
  "strings.views.not_read": str("not read yet", "Not read yet"),
  "strings.views.everything_else": str("others lane", "Everything else"),
  "strings.views.widened": str(
    "widened test",
    "Tried on earlier days: {when} has {count} threads so far",
  ),
  "strings.views.when.today": str("today", "today"),
  "strings.views.when.this_week": str("this week", "this week"),
  "strings.views.when.scope": str("the scope", "the scope"),
  "strings.views.reasons": str("reasons", "{lane}: {reasons}"),
  "strings.views.move_to": str("move to", "Move to"),
  "strings.views.wrong": str("wrong", "Wrong"),
  "strings.views.wrong_title": str("wrong answer title", "Not {signal}"),
  "strings.views.right_title": str("right answer title", "It is {signal}"),
  "strings.views.agrees": str("agreement", "Agrees with your corrections on {n} of {m}"),
  "strings.views.moves": str("moves", "{count} threads move: {moves}"),
  "strings.views.move_line": str("one move", "{count} {from} to {to}"),
  "strings.views.no_moves": str("no moves", "No thread changes lane."),
  "strings.views.needs_typesafe": str(
    "needs TypeSafe",
    "Views that read your mail need a TypeSafe key.",
  ),
  "strings.views.keep_facts": str("keep Fact lanes", "Keep only the lanes that need no reading"),
  "strings.views.tighten": str(
    "tighten offer",
    "You moved {count} threads out of {lane} this week. Tighten the question?",
  ),
  "strings.views.tighten_action": str("tighten action", "Tighten it"),
  "strings.views.tighten_prompt": str(
    "tighten prompt",
    "Fold my corrections on the view {view} into its questions",
  ),
  "strings.views.ask_change": str("ask to change", "Ask monday to change this view"),
  "strings.views.ask_change_prompt": str("ask to change prompt", "Change the view {view}: "),
  "strings.views.show_source": str("show the source", "Show the source"),
  "strings.views.source_title": str("source title", "{view}, version {version}"),
  "strings.views.rename": str("rename", "Rename"),
  "strings.views.change_icon": str("change icon", "Change icon"),
  "strings.views.move_up": str("move up", "Move up in the nav"),
  "strings.views.move_down": str("move down", "Move down in the nav"),
  "strings.views.show_as": str("show as", "Show as"),
  "strings.views.show_as.lanes": str("show as lanes", "Lanes"),
  "strings.views.show_as.list": str("show as list", "List"),
  "strings.views.show_as.counts": str("show as counts", "Counts"),
  "strings.views.show_as.table": str("show as table", "Table"),
  "strings.views.show_as.timeline": str("show as timeline", "Timeline"),
  "strings.views.delete": str("delete", "Delete"),
  "strings.views.deleted": str("deleted toast", "View {view} deleted"),
  "strings.views.undo": str("undo", "Undo"),
  "strings.views.menu": str("header menu", "View menu"),
  "strings.views.unpin": str("unpin", "Unpin"),
  "strings.views.pin_again": str("pin again", "Pin"),
  "strings.views.empty_scope": str(
    "empty scope",
    "Nothing to try it on yet. Pin it and check back?",
  ),
  "strings.views.check_bar": str("first placements bar", "New view: check its first placements"),
  "strings.views.dismiss": str("dismiss", "Dismiss"),
  "strings.views.lane_empty": str("empty lane", "Nothing here"),
  "strings.views.empty": str("empty view", "No threads in this view's scope yet."),
  "strings.views.tried": str("tried line", "Tried on {count} threads"),
  "strings.views.counts_over": str("counts over the tried", "Over all {count}: {counts}"),
  "strings.views.apply": str("apply", "Apply"),
  "strings.views.revise": str("revise", "Revise with my corrections"),
  "strings.views.revise_prompt": str(
    "revise prompt",
    "Revise the view draft {draft} with my corrections",
  ),
  "strings.views.revised": str("revised line", "Revised: {changes}"),
  "strings.views.change.reworded": str("revision: reworded", "rewrote the question for {signal}"),
  "strings.views.change.examples": str(
    "revision: Examples",
    "added {count} of your corrections to {signal}",
  ),
  "strings.views.change.none": str("revision: nothing", "kept the questions as they were"),
  "strings.views.pin_needs_test": str(
    "pin before the test",
    "Try it on your mail first: the card shows the tried threads before Pin view.",
  ),
  "strings.views.corrected": str("corrected row", "Corrected"),
  "strings.views.over_limit": str(
    "over the thread limit",
    "{count} threads in scope, above the {max} a View reads. Pinning reads them all.",
  ),
  "strings.views.too_many": str(
    "too many views",
    "You have {max} views, the most there can be. Delete one first.",
  ),
  "strings.views.pinned": str("pinned line", "Pinned in the nav."),
  "strings.views.discarded": str("discarded line", "Not saved."),
  "strings.views.applied": str("applied line", "Saved as version {version}."),
  "strings.views.card_title": str("card title", "View"),
  "strings.views.read_progress": str(
    "reading progress",
    "Reading your mail for {view}: {done} of {total}",
  ),
  "strings.views.settings.title": str("Settings panel title", "Your Views"),
  "strings.views.settings.intro": str(
    "Settings panel intro",
    "Views you pinned, in nav order. Ask monday for a new one in a sentence.",
  ),
  "strings.views.settings.empty": str(
    "no views",
    "No views yet. Ask monday: show today's support requests as red, yellow and green.",
  ),
  "strings.views.settings.version": str("version", "Version {version}"),
  "strings.views.panel_title": str("panel title", "{view}"),
  "strings.views.column.thread": str("table thread column", "Thread"),
} satisfies Record<string, SettingEntry>;
