// The Boards Settings (docs/spec/boards.md, "Limits" and "Strings"; slices
// 39 and 40): every behavior a Setting with a default (ADR 0004) and every
// word a strings.boards.* Setting. Kept in their own file and spread into the
// schema in one line, so the Boards slices touch the schema in one place.
// Type-only imports from schema.ts: no runtime cycle.

import { z } from "zod";
import type { SettingEntry } from "./schema.ts";

function setting<T extends z.ZodType>(entry: SettingEntry<T>): SettingEntry<T> {
  return entry;
}

const GROUP = "Boards";

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
    label: `Boards: ${label}`,
    help: "A user-visible string. The Agent can change the wording on request.",
  });
}

const DRAFT_PROMPT = `You write a Board for monday, an email client, from the owner's sentence. A Board is a JSON document: a scope of threads chosen by exact Facts, the Board's own questions (Signals) for what needs reading, ordered Lanes whose conditions combine Facts and Signals, and a layout from a fixed catalog.

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
- At most {lanes} Lanes and {signals} Signals of the Board's own.

Answer with the JSON document only, in this shape:
{"name": "...", "sentence": "...", "scope": {"facts": {...}, "limit": 500}, "signals": [{"id": "...", "kind": "noul", "label": "two or three words", "question": {"type": "noul", "instructions": "...", "criteria": {"true": "...", "false": "..."}}}], "uses": [], "lanes": [{"id": "...", "label": "...", "tone": "...", "when": {...}}], "unsure": {"label": "Unsure"}, "others": "hide", "layout": {"component": "lanes", "row": {"fields": ["sender", "subject", "age"]}}, "nav": {"icon": "...", "count": "..."}}`;

const REVISE_PROMPT = `You revise a Board for monday after the owner corrected its test. You get the Board document, the threads the owner corrected (who wrote, the subject, what the owner said), and what the Board's Signals answered on them. The corrected threads are added to each question as Examples by code; you decide whether a question itself is off. When a correction shows a question reads the owner wrong, rewrite that question's instructions and criteria so the exact condition and its boundary match what the owner meant; otherwise leave it as it is. Keep ids, Lanes and the layout unless the owner's words ask otherwise. Never ask for a count, an amount or a date comparison; those are Facts. Answer with the whole revised JSON document only.`;

export const BOARD_SETTINGS = {
  "boards.enabled": setting({
    type: z.boolean(),
    default: true,
    scope: "global",
    section: "routing",
    group: GROUP,
    label: "Boards",
    help: "Views you ask for in a sentence, such as today's support requests as red, yellow and green, pinned in the nav.",
  }),
  "boards.max": limit(
    "Most boards",
    12,
    1,
    50,
    "The nav stays short. A new Board over this is refused before anything is saved.",
  ),
  "boards.max_lanes": limit(
    "Most lanes per board",
    6,
    1,
    12,
    "Plus Unsure. More is a table, not a Board.",
  ),
  "boards.max_signals": limit(
    "Most questions per board",
    6,
    0,
    12,
    "Each of a Board's own questions is asked of every thread in its scope.",
  ),
  "boards.scope.max_threads": limit(
    "Most threads a board reads",
    2000,
    10,
    100_000,
    "Above this the Agent narrows the scope, or you confirm reading them all.",
  ),
  "boards.test.pool": limit(
    "Threads a new board is tried on",
    30,
    5,
    200,
    "A Board is never saved on the Agent's word alone: it is tried on your newest threads in its scope first.",
  ),
  "boards.test.shown": limit(
    "Tried threads you see",
    10,
    1,
    50,
    "How many tried threads the card shows before Pin board is enabled: spread across the lanes, least confident first.",
  ),
  "boards.test.widen_days": limit(
    "How far back a quiet scope looks",
    14,
    1,
    365,
    "When the scope holds too few threads to try (a quiet today), only its dates widen to this many days.",
  ),
  "boards.nav.show_counts": setting({
    type: z.boolean(),
    default: true,
    scope: "global",
    section: "routing",
    group: GROUP,
    label: "Counts beside boards in the nav",
    help: "Each Board shows the count of the Lane it names, such as Red, or its total.",
  }),
  "boards.panel": setting({
    type: z.string().max(80),
    default: "",
    scope: "global",
    section: "routing",
    group: GROUP,
    label: "Board panel",
    help: "The Board whose Lane counts show above the Inbox, beside the Today panel. Empty shows none.",
  }),
  "boards.corrections.offer_after": limit(
    "Offer to tighten after",
    5,
    1,
    100,
    "When you move this many threads out of a Lane in a week, the Board offers to fold your corrections into its question.",
  ),
  "boards.examples_in_question": limit(
    "Examples in a question",
    5,
    0,
    20,
    "How many of your corrections, of each answer, ride in a Board question as Examples.",
  ),
  "boards.draft.retries": limit(
    "Draft retries",
    2,
    0,
    5,
    "How many times a draft that does not validate goes back to the model with the errors.",
  ),
  "boards.prompt": setting({
    type: z.string().min(1),
    default: DRAFT_PROMPT,
    scope: "global",
    section: "routing",
    group: GROUP,
    control: "sentence",
    tier: "advanced",
    label: "How a board is written",
    help: "The instructions the language model drafts a Board with. {lanes} and {signals} are the limits.",
  }),
  "boards.revise_prompt": setting({
    type: z.string().min(1),
    default: REVISE_PROMPT,
    scope: "global",
    section: "routing",
    group: GROUP,
    control: "sentence",
    tier: "advanced",
    label: "How a board is revised",
    help: "The instructions the language model revises a Board's questions with after your corrections.",
  }),

  /* Words (docs/spec/boards.md, "Strings") */
  "strings.boards.nav": str("nav heading", "Boards"),
  "strings.boards.pin": str("pin", "Pin board"),
  "strings.boards.not_now": str("discard", "Not now"),
  "strings.boards.unsure": str("Unsure lane", "Unsure"),
  "strings.boards.not_read": str("not read yet", "Not read yet"),
  "strings.boards.everything_else": str("others lane", "Everything else"),
  "strings.boards.widened": str(
    "widened test",
    "Tried on earlier days: {when} has {count} threads so far",
  ),
  "strings.boards.when.today": str("today", "today"),
  "strings.boards.when.this_week": str("this week", "this week"),
  "strings.boards.when.scope": str("the scope", "the scope"),
  "strings.boards.reasons": str("reasons", "{lane}: {reasons}"),
  "strings.boards.move_to": str("move to", "Move to"),
  "strings.boards.wrong": str("wrong", "Wrong"),
  "strings.boards.wrong_title": str("wrong answer title", "Not {signal}"),
  "strings.boards.right_title": str("right answer title", "It is {signal}"),
  "strings.boards.agrees": str("agreement", "Agrees with your corrections on {n} of {m}"),
  "strings.boards.moves": str("moves", "{count} threads move: {moves}"),
  "strings.boards.move_line": str("one move", "{count} {from} to {to}"),
  "strings.boards.no_moves": str("no moves", "No thread changes lane."),
  "strings.boards.needs_typesafe": str(
    "needs TypeSafe",
    "Boards that read your mail need a TypeSafe key.",
  ),
  "strings.boards.keep_facts": str("keep Fact lanes", "Keep only the lanes that need no reading"),
  "strings.boards.tighten": str(
    "tighten offer",
    "You moved {count} threads out of {lane} this week. Tighten the question?",
  ),
  "strings.boards.tighten_action": str("tighten action", "Tighten it"),
  "strings.boards.tighten_prompt": str(
    "tighten prompt",
    "Fold my corrections on the board {board} into its questions",
  ),
  "strings.boards.ask_change": str("ask to change", "Ask monday to change this board"),
  "strings.boards.ask_change_prompt": str("ask to change prompt", "Change the board {board}: "),
  "strings.boards.show_source": str("show the source", "Show the source"),
  "strings.boards.source_title": str("source title", "{board}, version {version}"),
  "strings.boards.rename": str("rename", "Rename"),
  "strings.boards.change_icon": str("change icon", "Change icon"),
  "strings.boards.move_up": str("move up", "Move up in the nav"),
  "strings.boards.move_down": str("move down", "Move down in the nav"),
  "strings.boards.show_as": str("show as", "Show as"),
  "strings.boards.show_as.lanes": str("show as lanes", "Lanes"),
  "strings.boards.show_as.list": str("show as list", "List"),
  "strings.boards.show_as.counts": str("show as counts", "Counts"),
  "strings.boards.show_as.table": str("show as table", "Table"),
  "strings.boards.show_as.timeline": str("show as timeline", "Timeline"),
  "strings.boards.delete": str("delete", "Delete"),
  "strings.boards.deleted": str("deleted toast", "Board {board} deleted"),
  "strings.boards.undo": str("undo", "Undo"),
  "strings.boards.menu": str("header menu", "Board menu"),
  "strings.boards.unpin": str("unpin", "Unpin"),
  "strings.boards.pin_again": str("pin again", "Pin"),
  "strings.boards.empty_scope": str(
    "empty scope",
    "Nothing to try it on yet. Pin it and check back?",
  ),
  "strings.boards.check_bar": str("first placements bar", "New board: check its first placements"),
  "strings.boards.dismiss": str("dismiss", "Dismiss"),
  "strings.boards.lane_empty": str("empty lane", "Nothing here"),
  "strings.boards.empty": str("empty board", "No threads in this board's scope yet."),
  "strings.boards.tried": str("tried line", "Tried on {count} threads"),
  "strings.boards.counts_over": str("counts over the tried", "Over all {count}: {counts}"),
  "strings.boards.apply": str("apply", "Apply"),
  "strings.boards.revise": str("revise", "Revise with my corrections"),
  "strings.boards.revise_prompt": str(
    "revise prompt",
    "Revise the board draft {draft} with my corrections",
  ),
  "strings.boards.revised": str("revised line", "Revised: {changes}"),
  "strings.boards.change.reworded": str("revision: reworded", "rewrote the question for {signal}"),
  "strings.boards.change.examples": str(
    "revision: Examples",
    "added {count} of your corrections to {signal}",
  ),
  "strings.boards.change.none": str("revision: nothing", "kept the questions as they were"),
  "strings.boards.pin_needs_test": str(
    "pin before the test",
    "Try it on your mail first: the card shows the tried threads before Pin board.",
  ),
  "strings.boards.corrected": str("corrected row", "Corrected"),
  "strings.boards.over_limit": str(
    "over the thread limit",
    "{count} threads in scope, above the {max} a Board reads. Pinning reads them all.",
  ),
  "strings.boards.too_many": str(
    "too many boards",
    "You have {max} boards, the most there can be. Delete one first.",
  ),
  "strings.boards.pinned": str("pinned line", "Pinned in the nav."),
  "strings.boards.discarded": str("discarded line", "Not saved."),
  "strings.boards.applied": str("applied line", "Saved as version {version}."),
  "strings.boards.card_title": str("card title", "Board"),
  "strings.boards.read_progress": str(
    "reading progress",
    "Reading your mail for {board}: {done} of {total}",
  ),
  "strings.boards.settings.title": str("Settings panel title", "Your Boards"),
  "strings.boards.settings.intro": str(
    "Settings panel intro",
    "Boards you pinned, in nav order. Ask monday for a new one in a sentence.",
  ),
  "strings.boards.settings.empty": str(
    "no boards",
    "No boards yet. Ask monday: show today's support requests as red, yellow and green.",
  ),
  "strings.boards.settings.version": str("version", "Version {version}"),
  "strings.boards.panel_title": str("panel title", "{board}"),
  "strings.boards.column.thread": str("table thread column", "Thread"),
} satisfies Record<string, SettingEntry>;
