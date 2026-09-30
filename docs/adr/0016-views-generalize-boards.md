---
status: accepted
---

# Views generalize Boards: Fields per Thread, code-only queries, a Block catalog, and Extractions that select instead of generate

A Board was one scope, the Agent's own Signals, Lanes and one of five layouts (docs/spec/boards.md, slices 39 and 40). Users asked for more than a kanban: a table of invoices by due date, total spend per month, who writes most, travel on a calendar, buttons on the items. We decided that a Board becomes a **View**: the same sealed, versioned JSON document the Agent writes and code validates (ADR 0003's shape), with three layers. **Fields** per Thread: the existing Facts, Signals (the Agent's own Jev questions and shipped ones), and **Extractions**, where code finds candidate values in the text (amounts, dates, reference numbers, tracking numbers, names, links, line items), a Jev Choice picks the one the Agent's question asks for, or `none`, and code copies and normalizes it. **Queries**, code only: filters with three-valued logic, dedupe, group by a Field or a time bucket, count, sum, average, minimum and maximum with money kept per currency, sort and limit. **Blocks** from a fixed catalog (lanes, list, counts, table, stat, chart, timeline, calendar, cards, people, checklist, heatmap, text), each drawing one query, plus **actions** on items drawn from a closed catalog that reuses the existing tool, approval, Undo and Workflow paths. A Board is a View with one `lanes` Block; every Board migrates losslessly.

TypeSafe's guidance drove the Extraction shape (the pre-parsed value extraction cookbook): a model that selects among spans code found cannot invent a value or transpose a digit, and its confidence says when to show Unsure instead. It is the same shape the shipped `money_amount` and the recipient and link Choices already use (per-Thread options, ADR 0014), so an Extraction is just another Signal in the one Signal request per Thread: no second request, no new pipeline.

## Considered options

- Let the Agent generate markup or React for a View. Rejected: generated code cannot be sandboxed or themed, and contradicts "the Agent edits data, never code" (ADR 0003).
- Let the language model extract values in the draft or on arrival. Rejected: it generates text, so a total can come back mistyped, and it has no calibrated confidence; an Extraction by selection costs one more question in a request the Thread already pays for.
- Ask Jev to compare or add ("orders over $500", "total spend"). Rejected: Jev reads literally and does no arithmetic (ADR 0012); code owns every comparison and sum, and the schema has no way to express one inside a question.
- Keep Boards and add a separate "Dashboard" concept. Rejected: two documents, two drafting prompts, two nav headings, and a Board is exactly a View with one Block.
- Convert amounts to one currency. Rejected: it needs rates from the network and quietly changes numbers; sums stay per currency.

## Amendment: many values and Rows

A real session asked for "a chart of all the vulnerabilities my GitHub repos have gotten" and "how much I bought per month" and could not have either: one Dependabot digest lists seventy packages, a thread of advisories holds one per Message, and one order confirmation bundles nine orders, while a View had one value per Extraction per Thread. We kept selection over generation and code over arithmetic, and added two things. An Extraction may pick **many**: code finds the candidates, Jev answers one Noul per candidate ("does this span answer?"), independent questions in the Thread's one request, and code keeps every one above a threshold, marks the Unsure band and caps them; sums and counts take every value. A View's **grain** makes a Row of each value of a many-Extraction or of each Message, and a View Signal may be asked **each** Row, with the item or the Message in its question, still one request per Thread. We rejected asking Jev to list the values (generation), letting it add them up (arithmetic), batching Threads into one request, and pairing a sibling list of severities with a list of packages (two independent lists cannot be matched item by item).

## Consequences

- The glossary's View (a saved Layout) is renamed Layout shortcut; View now means this document. The Setting that stores Layout shortcuts keeps its key `views` in the config file (ADR 0001) and is unrelated to `views.*` keys for the document.
- Storage keeps what older data was written with: the content kind `board` (bound as associated data in every sealed document), the stored Signal prefix `board:<viewId>:` (so answers asked before the rename and the Device's cached rows keep their ids), the `board` Task and its `judge.board` meter line. The tables, the feed kind, the Signal owner kind, the Settings and the tools are renamed, with the old tool names kept as aliases and the old Setting keys as config file aliases.
- Extracted values are mail content, so they stay sealed with the Thread's Facts on the Server; the feed carries only which Thread changed, and the Device reads the values through the API into the Cache, where every Block is computed (ADR 0011).
- Every Extraction is paid on every Thread in scope whose text holds a candidate of its kind, and counts against `signals.max_active` like a Signal.
- Actions on items are ordinary Tool calls with their Tiers; nothing an action does leaves the mailbox without asking (ADR 0002). A Workflow trigger on "a Thread enters a Lane" is left for later.
