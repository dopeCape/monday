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

const DRAFT_PROMPT = `You write a View for monday, an email client, from the owner's sentence. A View is a JSON document that code validates, queries and draws; you never write markup or code. It has: a scope of threads chosen by exact Facts; the Fields read about each thread (Facts, the View's own questions called Signals, shipped Signals it uses, and Extractions that pick a value from the text); optional Lanes that classify the threads; a stack of Blocks from a fixed catalog, each drawing a small query; optional action buttons on the items; the nav entry.

Code owns everything exact, the judge owns reading:
- Dates ("today", "this quarter", "last 14 days"), addresses, domains, counts of messages, attachments and who wrote last are Facts. Amounts, due dates, order numbers, tracking numbers, names, companies, links and quantities written in the mail are Extractions. Comparisons, sums, counts and date buckets are the query's, done by code. A question (Signal) never asks for a count, an amount, a date or a comparison, and an Extraction never asks to add or compare: it names the one value it wants, or with "many": true every value of that one role. Picking many values is allowed; adding or counting them stays in code.
- Reuse beats invention: when a shipped Signal already asks the question, list it in "uses" and read it by its id. Shipped: needs_reply, waiting_on_me, waiting_on_others, newsletter, automated, personal, has_deadline, money_involved, owner_promised, they_promised (yes or no); frustrated, urgency (scores 0 to 3); money_direction (choice: owner_pays, owner_is_paid, already_settled, unclear).

Signals (the View's own questions), the TypeSafe way: each is ONE narrow judgment a person makes in a second about the thread. Put the judgment in "instructions" and the exact condition and its boundary in "criteria": a noul {"true": ..., "false": ...}; a score an ordered list of levels, each a concrete situation; a choice an object of options each with a description, always with a "none" option for when nothing fits. Phrase a noul so yes is the rare, interesting case.
- Good: {"id": "is_support_request", "kind": "noul", "label": "support request", "question": {"type": "noul", "instructions": "The newest message from someone other than the owner asks for help with a problem using the owner's product.", "criteria": {"true": "A customer reports something broken or asks how to do something.", "false": "Sales, newsletters, invoices, internal mail, or a thank-you with no request."}}}
- Good: {"id": "status", "kind": "choice", "question": {"type": "choice", "instructions": "Where does the newest message say this order stands?", "criteria": {"ordered": "Placed or confirmed, nothing shipped.", "shipped": "On its way.", "delivered": "It arrived.", "none": "Not about the state of an order."}}}
- Bad: "Is this an important support email with more than 3 replies?" (two judgments in one, and a count: use the Fact message_count).
- Bad: "What is the order total?" as a Signal (a value is an Extraction with find money).
- Bad: "Is the invoice over $500?" (a comparison: extract the amount and test it with at_least).

Extractions (select, don't generate): {"id": "order_total", "label": "Total", "find": "money", "question": "The total the customer paid for the whole order, including tax and shipping.", "none": "The message states no order total."}. Code finds every candidate of the kind in the thread, the judge picks the one the question describes or none, code copies and normalizes it. find is one of: money, date, reference (order, invoice, booking numbers), tracking, email, person, company, link, quantity, item (a line item), sentence (a sentence someone wrote, such as a promise). The question names exactly one role ("the date the payment is due", not "the dates"). Add "min_confidence" (0 to 1) only when a wrong value would be costly.
Many values: when one thread can hold several values of the role (an order confirmation bundling several orders, a digest listing many packages, a statement of many charges), add "many": true (and "max": n to keep at most n): the judge answers yes or no for each candidate and every yes is kept. The question still names one role ("each order's total", "each line naming a package with an advisory"), and "none" says which spans are not it ("an item's price or the grand total of all orders"). Sums, averages and counts over a many Extraction take every value: {"op": "sum", "field": "x:order_total"} adds each order total, {"op": "count", "field": "x:advisory"} counts each advisory.

Rows ("grain"): a View's rows are threads by default. "grain": "item" with "item_of": <a many Extraction> makes each value it picks its own row (one row per package in a digest, each with that value, its message's date and its own answers); "grain": "message" makes each message of a thread its own row (a thread whose every message is a different advisory), each Extraction then being one value per message. A Signal with "each": true (only with grain item or message) is asked once per row with the item or the message in its question: use it for a judgment about each item ("how severe is this one advisory"), never a sibling many Extraction, since two lists cannot be paired. Every row opens its thread. Use grain item or message only when the owner counts or lists things inside threads.

Fields, by reference: Facts message_count, participant_count, attachment_count, amount_count, amount (numbers); known_sender, has_attachment, owner_wrote_last, owner_ever_wrote, to_me_directly, has_invite, deadline_unclear, unread, starred (flags); deadline_at, received_at, last_activity_at (dates); from_address, from_domain, list_id, in_group, in_section (text). Row fields: subject, snippet, sender, person (the correspondent), company (the correspondent's organisation from the domain), group, lane. "signal:<id>" for a Signal, "x:<id>" for an Extraction.

Conditions (a Lane's "when", a query's "where", an action's "when"), three-valued, combined with {"all": [...]}, {"any": [...]}, {"not": ...}:
- Signal tests: {"signal": id, "holds": true} or {"fails": true} for a noul; {"signal": id, "at_least": n} or "at_most" for a score (0 to levels - 1); {"signal": id, "is": option} for a choice.
- Fact tests: {"fact": "message_count", "at_least": 4}; {"fact": "has_attachment", "is": true}; {"fact": "deadline_at", "before": "end_of_week"}; {"fact": "received_at", "after": {"days": -90}}; {"fact": "from_domain", "in": ["acme.com"]}; {"fact": "in_group", "is": "<group id>"}. Dates: now, today, tomorrow, end_of_week, end_of_next_week, end_of_month, {"days": n}, or YYYY-MM-DD.
- Extraction tests: {"extract": id, "present": true}; {"extract": id, "at_least": 500} for money or a quantity; {"extract": id, "before": "end_of_month"} for a date; {"extract": id, "in": ["Acme"]} for text.
- Lane tests (not inside a Lane's own condition): {"lane": "shipped"} or {"lane": ["red", "yellow"]}.

Scope facts, all of which must hold (list alternatives inside one fact): "received" or "active" as {"within": "today"}, {"within": "this_week"}, {"last_days": n} or {"since": "YYYY-MM-DD"}; "from_any" and "to_any" as whole addresses (orders@shop.com); "from_domain" and "from_domain_not" as domains (shop.com); "subject_any" as words or phrases the subject holds, case aside ("order confirmation", "dependabot"); "folder" as inbox, any, archive, group:<id> or section:<id> (use any for mail the owner may have archived, such as receipts). "limit" is the most threads looked at, newest first. Narrow the scope to the mail that holds what the sentence asks for: the test tries the newest threads in it, and a View of orders tried on newsletters reads nothing.

Lanes (only when the sentence asks for groups like red, yellow and green, or statuses): tried in order, the first whose condition holds takes the thread, a thread that cannot be decided goes to Unsure by itself; order them from the most specific. "tone" is danger, warning, ok, info or muted. A View without lanes has "lanes": [].

Queries (every Block may have one): {"where": condition, "lanes": [ids], "dedupe": field (one row per value, such as "x:order_number": several threads of one order merge), "group_by": {"field": field, "bucket": "day" | "week" | "month" | "year" | "weekday" | "hour"} (bucket only for a date), "aggregate": {"op": "count" | "sum" | "avg" | "min" | "max", "field": a number or money field}, "sort": {"by": field or "value" or "key", "dir": "asc" | "desc"}, "limit": n, "period": {"field": date field, "bucket": "day" | "week" | "month" | "year"} (only this period)}.

Blocks, each {"id", "type", "title"?, "width"?: full | half | third | two_thirds, "query"?, "actions"?: [action ids], ...props}:
- lanes: columns side by side, one per Lane (props: row {"fields": [...]}, sort newest_first | oldest_first | deadline_first, collapse_empty). Needs Lanes.
- list: one list with a heading per Lane or per "group_by".
- counts: one line of Lane counts ("lanes": [ids]).
- table: "columns": [{"label", "field", "format": money | number | date | relative | percent | text | chip}].
- stat: one number: its query has "aggregate" (and "period" with "compare": "previous" for the change from the previous period); "format".
- chart: "chart": bar | stacked_bar | line | area | donut over the query's "group_by" (a stacked_bar also takes "series": a second group_by); "format".
- timeline: threads by a date field ("date").
- calendar: a month grid by a date field ("date"), such as an extracted travel date.
- cards: a gallery: "card_title", "subtitle", "badges" (fields), "value" and "value_format".
- people: "by": person or company, with counts and last activity.
- checklist: one checkable item per thread ("item": a field, such as an Extraction with find sentence).
- heatmap: counts by "date" in a "grid": weekday_hour or week_weekday.
- text: a short note ("text", at most 280 characters, "tone").

Actions (optional buttons on items; the Blocks list them by id): {"id", "label" (two or three words), "icon": archive | clock | truck | package | arrow-u-up-left | share | paper-plane-tilt | link | calendar-plus | check | check-circle | tag | envelope-open | envelope | folder | play | flow-arrow | sparkle | currency-dollar | receipt | arrow-right | star, "on": row | group | both, "when"?: condition, "do": ...}. "do" is one of: {"kind": "run_workflow", "workflow": <workflow id>, "inputs": {"name": field}}, {"kind": "archive"}, {"kind": "mark_read"}, {"kind": "mark_unread"}, {"kind": "snooze", "until": a date field or tomorrow | next_week | weekend}, {"kind": "move", "group": <group id>}, {"kind": "tag", "tag": name}, {"kind": "reply_template", "template": <template id>}, {"kind": "forward", "to": an address field or an address}, {"kind": "open_link", "link": a link Extraction}, {"kind": "add_to_calendar", "date": a date field, "title"?: field}, {"kind": "custom_action", "action": <custom action id>}, {"kind": "set_lane", "lane": id}, {"kind": "mark_done"} (a checklist), {"kind": "ask_agent", "prompt": "..."}. Name only Workflows, Groups, Templates and Custom actions listed below. Add actions only when the owner asks for buttons or the sentence clearly wants one ("with a button to track the package").

"nav" has an "icon" (lifebuoy, receipt, users-three, user-plus, handshake, calendar, check-circle, scales, briefcase, house, heart, tag, folder, code, bell, warning, users, shopping-bag, shield, megaphone, chat-circle, rocket, currency-dollar, graduation-cap, chart-line, truck, kanban) and "count": the Lane whose count shows in the nav, or "total".

At most {lanes} Lanes, {signals} Signals of the View's own, {extractions} Extractions, {blocks} Blocks and {actions} actions. Keep it small: the fewest questions that answer the sentence.

Worked example, "my orders with a chart of how much I bought per month" (rows are threads; a confirmation may bundle several orders, so the total is many; each order counted once by its number):
{"name": "Orders", "sentence": "my orders with a chart of how much I bought per month", "scope": {"facts": {"from_domain": ["amazon.in", "myntra.com", "hm.com"], "subject_any": ["order", "ordered"], "folder": "any", "received": {"last_days": 365}}, "limit": 1000}, "signals": [], "uses": [], "extractions": [{"id": "order_total", "label": "Total", "find": "money", "many": true, "question": "Each order's total: what one whole order cost, shown beside the word Total or Order Total.", "none": "An item's price, a discount, a shipping fee on its own, or a grand total of several orders."}, {"id": "order_number", "label": "Order", "find": "reference", "question": "The order number this message is about."}], "lanes": [], "unsure": {"label": "Unsure"}, "others": "hide", "blocks": [{"id": "this_month", "type": "stat", "title": "Spent this month", "width": "third", "query": {"dedupe": "x:order_number", "aggregate": {"op": "sum", "field": "x:order_total"}, "period": {"field": "received_at", "bucket": "month"}}, "compare": "previous"}, {"id": "per_month", "type": "chart", "chart": "bar", "title": "Spend per month", "width": "two_thirds", "query": {"dedupe": "x:order_number", "group_by": {"field": "received_at", "bucket": "month"}, "aggregate": {"op": "sum", "field": "x:order_total"}, "sort": {"by": "key", "dir": "asc"}}}, {"id": "orders", "type": "table", "columns": [{"label": "Order", "field": "subject"}, {"label": "Total", "field": "x:order_total", "format": "money"}, {"label": "Date", "field": "received_at", "format": "date"}], "query": {"dedupe": "x:order_number", "sort": {"by": "received_at", "dir": "desc"}}}], "actions": [], "nav": {"icon": "shopping-bag", "count": "total"}}

Worked example, "a chart of all the vulnerabilities my GitHub repos have gotten, by severity per month" (a digest lists many advisories, so each is a row with its own severity; when every advisory is its own message in a thread, use "grain": "message" and a one-value Extraction instead):
{"name": "Vulnerabilities", "sentence": "a chart of all the vulnerabilities my GitHub repos have gotten, by severity per month", "scope": {"facts": {"from_domain": ["github.com"], "subject_any": ["dependabot", "security", "vulnerab"], "folder": "any", "received": {"last_days": 365}}, "limit": 1000}, "grain": "item", "item_of": "advisory", "signals": [{"id": "severity", "kind": "choice", "label": "severity", "each": true, "question": {"type": "choice", "instructions": "How severe does the message say this one advisory is?", "criteria": {"critical": "Marked critical.", "high": "Marked high.", "moderate": "Marked moderate or medium.", "low": "Marked low.", "none": "The line is not a security advisory."}}}], "uses": [], "extractions": [{"id": "advisory", "label": "Advisory", "find": "item", "many": true, "question": "Each line that names a package with a security advisory or vulnerability.", "none": "A heading, a link, a repository name or any line that is not one advisory."}], "lanes": [], "unsure": {"label": "Unsure"}, "others": "hide", "blocks": [{"id": "per_month", "type": "chart", "chart": "stacked_bar", "title": "Vulnerabilities per month", "query": {"group_by": {"field": "received_at", "bucket": "month"}, "aggregate": {"op": "count"}}, "series": {"field": "signal:severity"}}, {"id": "by_severity", "type": "chart", "chart": "donut", "title": "By severity", "width": "third", "query": {"group_by": {"field": "signal:severity"}, "aggregate": {"op": "count"}}}, {"id": "advisories", "type": "table", "columns": [{"label": "Advisory", "field": "x:advisory"}, {"label": "Severity", "field": "signal:severity", "format": "chip"}, {"label": "Received", "field": "received_at", "format": "date"}]}], "actions": [], "nav": {"icon": "shield", "count": "total"}}

Answer with the JSON document only, in this shape:
{"name": "...", "sentence": "...", "scope": {"facts": {...}, "limit": 500}, "grain": "thread", "signals": [], "uses": [], "extractions": [], "lanes": [], "unsure": {"label": "Unsure"}, "others": "hide", "blocks": [{"id": "...", "type": "...", ...}], "actions": [], "nav": {"icon": "...", "count": "total"}}`;

const REVISE_PROMPT = `You revise a View for monday after the owner corrected its test, or asked for a change. You get the View document, the threads the owner corrected (who wrote, the subject, what the owner said: a Lane it belongs in, a question that read it wrong, or the right value of an Extraction), and what the View read on them. Code adds the corrected threads to each question as Examples; you decide whether a question itself is off. When a correction shows a Signal's question reads the owner wrong, rewrite its instructions and criteria so the exact condition and its boundary match what the owner meant; when an Extraction picked the wrong value, make its question name the value's role more exactly (never add the value itself). When the Agent's words say an Extraction found no candidates on many threads, its find kind does not match this mail or the scope holds the wrong mail: change the find or narrow the scope (senders, subject words). When one thread holds several values of the role, give the Extraction "many": true; when the owner counts things inside threads, use a grain of item or message. Otherwise leave the questions as they are. Keep ids, Lanes, Blocks and actions unless the owner's words ask otherwise; when they ask for a Block, a chart, a column or a button, add it from the same catalog as the draft. Never ask the judge for a count, an amount, a date or a comparison; those are Facts, Extractions and code. Answer with the whole revised JSON document only.`;

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
  "views.backfill.enabled": setting({
    type: z.boolean(),
    default: true,
    scope: "global",
    section: "routing",
    group: GROUP,
    label: "Read a pinned view's mail",
    help: "When you pin a View, or change what it asks, monday reads the threads in its scope (archived and older ones too, newest first, up to its limit) in the background, under the monthly background budget.",
  }),
  "views.backfill.page_size": limit(
    "Threads per step of a view's reading",
    40,
    1,
    500,
    "How many threads of a pinned view's scope are read, one request each and several at once, before its place is saved.",
  ),
  "views.test.prefer_readable": setting({
    type: z.boolean(),
    default: true,
    scope: "global",
    section: "routing",
    group: GROUP,
    label: "Try a new view on threads it can read",
    help: "When a View adds up a value (a total, an amount), its test prefers the threads in its scope where code finds that kind of value, and says how many it passed over.",
  }),
  "views.test.scan": limit(
    "Threads looked through to find readable ones",
    120,
    10,
    1000,
    "How many of the newest threads in scope code looks through, without asking anything, for ones whose text holds the values the View adds up.",
  ),
  "views.card.warn_below": setting({
    type: z.number().min(0).max(1),
    default: 0.5,
    scope: "global",
    section: "routing",
    group: GROUP,
    label: "Warn when a value reads on few tried threads",
    help: "On a new view's card, a value or question its Blocks show is marked when it read on less than this share of the tried threads, with the reasons beside it.",
  }),
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
  "views.max_extractions": limit(
    "Most values taken per view",
    6,
    0,
    12,
    "Each Extraction is a question on every thread in the view's scope whose text holds a candidate of its kind.",
  ),
  "views.max_blocks": limit(
    "Most blocks per view",
    8,
    1,
    20,
    "A view is read at a glance: its tables, numbers, charts and lanes together.",
  ),
  "views.max_actions": limit(
    "Most buttons per view",
    8,
    0,
    20,
    "The action buttons a view's items may carry.",
  ),
  "views.query.max_rows": limit(
    "Rows a block draws",
    500,
    10,
    5000,
    "The most rows or groups one block of a view draws.",
  ),
  "views.chart.max_groups": limit(
    "Bars in a chart",
    12,
    3,
    50,
    "A chart with more groups shows the largest and one Other.",
  ),
  "views.extract.min_confidence": setting({
    type: z.number().min(0).max(1),
    default: 0.6,
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: "Confidence for a taken value",
    help: "Below this, a value a view took from the text (a total, a date) shows as Unsure and is left out of sums.",
  }),
  "views.extract.candidates_max": limit(
    "Candidates per value",
    20,
    2,
    60,
    "How many amounts, dates or numbers code offers the judge to pick from, per thread.",
  ),
  "views.extract.item_chars": limit(
    "Longest line item",
    300,
    40,
    2000,
    "A line item (a product on a receipt) longer than this many characters is not offered as one.",
  ),
  "views.extract.date_order": setting({
    type: z.enum(["mdy", "dmy"]),
    default: "mdy",
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: "How 10/03/2026 reads",
    help: "Month first (October 3) or day first (10 March), for dates a view takes from the text.",
  }),
  "views.extract.none": setting({
    type: z.string().min(1),
    default: "None of these is the requested value.",
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: "The no-match option",
    help: "What the judge picks when none of the candidates code found is the value a view asks for.",
  }),
  "views.extract.many.threshold": setting({
    type: z.number().min(0).max(1),
    default: 0.7,
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: "Probability for each of many values",
    help: "A view that takes many values from one thread (every order total in a confirmation) keeps each candidate the judge says answers with at least this probability; below it, down to the Unsure band, it is Unsure.",
  }),
  "views.extract.many.max": limit(
    "Candidates asked per thread for many values",
    30,
    2,
    200,
    "How many candidates of one kind code offers the judge, one question each, when a view takes many values from a thread. The rest are left out and the test says so.",
  ),
  "views.extract.many.note": setting({
    type: z.string().min(1),
    default:
      "This thread may hold several of the values the question asks for. Judge only this one span.",
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: "Many values: the note",
    help: "What each question says when a view asks the judge about each candidate of many.",
  }),
  "views.extract.many.yes": setting({
    type: z.string().min(1),
    default: "This span is one of the values the question asks for.",
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: "Many values: what yes means",
    help: "The yes of the question asked about each candidate of many.",
  }),
  "views.each.item_note": setting({
    type: z.string().min(1),
    default: "Judge only this one item of the thread.",
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: "Per item: the note",
    help: "What a view's question says when it is asked once per item (a package in a digest).",
  }),
  "views.each.message_note": setting({
    type: z.string().min(1),
    default: "Judge only this one message of the thread.",
    scope: "global",
    section: "routing",
    group: GROUP,
    tier: "advanced",
    label: "Per message: the note",
    help: "What a view's question says when it is asked once per message of a thread.",
  }),
  "views.grain.max_messages": limit(
    "Messages read per thread in a message view",
    20,
    1,
    200,
    "A view with a row per message reads at most this many of a thread's newest messages, each its own question.",
  ),
  "views.grain.message_chars": limit(
    "Characters of a message per question",
    1500,
    200,
    20_000,
    "How much of one message rides in a question asked about that message.",
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
    help: "The instructions the language model drafts a View with: the Block catalog, the Fields, the Extractions and the actions. {lanes}, {signals}, {extractions}, {blocks} and {actions} are the limits.",
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
  "strings.views.loading": str("loading view", "Loading this view"),
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
  "strings.views.reading": str("reading bar", "Reading {done} of {total}"),
  "strings.views.reading_budget": str(
    "reading bar, budget spent",
    "Reading paused at {done} of {total}: this month's background budget is spent",
  ),
  "strings.views.reading_no_judge": str(
    "reading bar, no judge",
    "Reading waits for a TypeSafe key: {done} of {total}",
  ),
  "strings.views.reading_paused": str("reading bar, paused", "Reading paused at {done} of {total}"),
  "strings.views.reading_pause": str("pause reading", "Pause"),
  "strings.views.reading_resume": str("resume reading", "Resume"),
  "strings.views.reading_stop": str("stop reading", "Stop"),
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

  /* Values and Blocks (docs/spec/views.md, "Fields", "The Block catalog") */
  "strings.views.value.yes": str("value: yes", "Yes"),
  "strings.views.value.no": str("value: no", "No"),
  "strings.views.value.today": str("value: today", "today"),
  "strings.views.value.tomorrow": str("value: tomorrow", "tomorrow"),
  "strings.views.value.yesterday": str("value: yesterday", "yesterday"),
  "strings.views.value.in_days": str("value: in days", "in {n} days"),
  "strings.views.value.days_ago": str("value: days ago", "{n} days ago"),
  "strings.views.unsure_count": str("unsure line", "{count} unsure"),
  "strings.views.none": str("group with no value", "None"),
  "strings.views.other": str("folded groups", "Other"),
  "strings.views.change.up": str("stat: up", "up {pct}"),
  "strings.views.change.down": str("stat: down", "down {pct}"),
  "strings.views.change.same": str("stat: no change", "no change"),
  "strings.views.change.previous": str("stat: compared with", "on the previous {period}"),
  "strings.views.period.day": str("period: day", "day"),
  "strings.views.period.week": str("period: week", "week"),
  "strings.views.period.month": str("period: month", "month"),
  "strings.views.period.year": str("period: year", "year"),
  "strings.views.calendar.previous": str("calendar: previous month", "Previous month"),
  "strings.views.calendar.next": str("calendar: next month", "Next month"),
  "strings.views.people.threads": str("people: count", "{count} threads"),
  "strings.views.checklist.done": str("checklist: done", "Done"),
  "strings.views.checklist.done_count": str("checklist: done count", "{count} done"),
  "strings.views.block_empty": str("empty block", "Nothing here yet."),
  "strings.views.heatmap.title": str("heatmap cell", "{when}: {count}"),
  "strings.views.wrong_value": str("wrong value", "Wrong value"),
  "strings.views.not_stated": str("not stated", "Not stated"),
  "strings.views.value_title": str("value on the card", "{label}: {value}"),
  "strings.views.card.blocks": str("card: blocks heading", "What it shows"),
  "strings.views.card.actions": str("card: actions line", "Buttons: {actions}"),
  "strings.views.card.coverage": str("card: coverage heading", "How each value read"),
  "strings.views.card.read": str("card: a value read", "{label}: {resolved} of {tried} read"),
  "strings.views.card.read_values": str(
    "card: many values read",
    "{label}: {values} values on {resolved} of {tried}",
  ),
  "strings.views.card.read_signal": str(
    "card: a question read",
    "{label}: {resolved} of {tried} clear",
  ),
  "strings.views.card.read_rows": str(
    "card: a per-row question read",
    "{label}: clear on {resolved} rows",
  ),
  "strings.views.card.reason.none": str("card: reason none of these", "{count} none of these"),
  "strings.views.card.reason.unsure": str("card: reason unsure", "{count} unsure"),
  "strings.views.card.reason.no_candidates": str(
    "card: reason no candidates",
    "{count} had no {kind}",
  ),
  "strings.views.card.reason.not_read": str("card: reason not read", "{count} not read"),
  "strings.views.card.reason.capped": str("card: reason capped", "{count} cut at the limit"),
  "strings.views.card.reason.resolved": str("card: reason read", "{count} read"),
  "strings.views.card.kind.money": str("card: kind money", "amounts"),
  "strings.views.card.kind.date": str("card: kind date", "dates"),
  "strings.views.card.kind.reference": str("card: kind reference", "reference numbers"),
  "strings.views.card.kind.tracking": str("card: kind tracking", "tracking numbers"),
  "strings.views.card.kind.email": str("card: kind email", "addresses"),
  "strings.views.card.kind.person": str("card: kind person", "names"),
  "strings.views.card.kind.company": str("card: kind company", "company names"),
  "strings.views.card.kind.link": str("card: kind link", "links"),
  "strings.views.card.kind.quantity": str("card: kind quantity", "quantities"),
  "strings.views.card.kind.item": str("card: kind item", "item lines"),
  "strings.views.card.kind.sentence": str("card: kind sentence", "sentences"),
  "strings.views.card.examples": str("card: example values", "For example: {examples}"),
  "strings.views.card.pool": str(
    "card: how the threads were chosen",
    "Tried on {tried} of {count} matching threads, newest first",
  ),
  "strings.views.card.pool_at_least": str(
    "card: how the threads were chosen, a floor",
    "Tried on {tried} of at least {count} matching threads, newest first",
  ),
  "strings.views.card.pool_query": str(
    "card: how a search scope's threads were chosen",
    "Tried on the newest {tried} of {count} threads its search matched",
  ),
  "strings.views.card.pool_query_at_least": str(
    "card: how a search scope's threads were chosen, a floor",
    "Tried on the newest {tried} of at least {count} threads its search matched",
  ),
  "strings.views.card.pool_prefer": str("card: preferred threads", "preferring ones with {kinds}"),
  "strings.views.card.pool_kept": str("card: kept threads", "{count} tried before"),
  "strings.views.card.pool_skipped": str("card: passed over", "passed over {count} without them"),
  "strings.views.card.senders": str("card: senders", "Mostly from {senders}"),
  "strings.views.card.sender": str("card: one sender", "{from} ({count})"),
  "strings.views.card.warn": str(
    "card: few reads",
    "{label} read on fewer than {pct} of the tried threads",
  ),
  "strings.views.card.filtered": str(
    "card: rows filtered",
    "Showing {count} threads: {label}, {reason}",
  ),
  "strings.views.card.filter_clear": str("card: clear the filter", "Show all"),
  "strings.views.card.filter_title": str("card: filter by a reason", "Show these threads"),

  /* Actions on items (docs/spec/views.md, "Actions on items") */
  "strings.views.action.archive": str("action: archive", "Archive"),
  "strings.views.action.snooze": str("action: snooze", "Snooze"),
  "strings.views.action.move": str("action: move", "Move"),
  "strings.views.action.tag": str("action: tag", "Tag"),
  "strings.views.action.mark_read": str("action: mark read", "Mark read"),
  "strings.views.action.mark_unread": str("action: mark unread", "Mark unread"),
  "strings.views.action.done": str("action: done toast", "{label}: done"),
  "strings.views.action.all": str("action on a group", "{label} ({count})"),
  "strings.views.action.opens": str("action: open a link", "Open {domain}?"),
  "strings.views.action.open": str("action: open", "Open"),
  "strings.views.action.cancel": str("action: cancel", "Cancel"),
  "strings.views.action.workflow_started": str("action: Workflow started", "{workflow} started"),
  "strings.views.action.unavailable": str(
    "action: unavailable",
    "This button cannot run here. Ask monday to do it.",
  ),
  "strings.views.action.ask_prompt": str("action: ask the Agent", "{prompt} (threads: {threads})"),
  "strings.views.action.calendar_added": str("action: added to calendar", "Added to your calendar"),
} satisfies Record<string, SettingEntry>;
