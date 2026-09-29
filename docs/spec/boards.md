# Boards

Behaviors a tester can check. Board, Lane, Signal, Fact and Unsure are defined in `CONTEXT.md`; the Board document follows ADR 0003's shape (a JSON document the Agent writes, validated against a schema monday owns, versioned); Signals are ADR 0014; every default is a Setting (ADR 0004) and every word a `strings.boards.*` Setting.

## What the user sees

- The user asks: "show today's support requests as red, yellow and green", "a board of invoices I still owe by due date", "which candidates are waiting on me". The Agent answers with a Board card (below) that has already been tried on the user's own mail. Nothing is saved until the user accepts it.
- An accepted Board is pinned in the nav under its own heading, Boards, above Groups, in the user's order, with a count (the Lane the Board names as its count, such as Red, else the total). Opening it shows the Board in the list area, like a Section; the reader opens beside or over it by the list knob as usual.
- A Board updates live: a new Thread in its scope lands in a Lane when its Signal request answers (a Thread not read yet sits in the Unsure Lane under "Not read yet"), and a Thread moves when its answers change.
- Every Board ends with an Unsure Lane. A Thread a Board's Signals could not decide goes there, never into a guessed Lane.

## The Board document

```jsonc
{
  "id": "b_support_today",
  "name": "Support today",
  "sentence": "show today's support requests as red, yellow and green",
  "version": 3,
  "scope": {                                   // code only: which Threads the Board looks at
    "facts": {
      "received": { "within": "today" },       // today, this week, last N days, since a date
      "to_any": ["support@acme.com"],          // exact addresses
      "from_domain_not": ["acme.com"],
      "folder": "inbox"                        // inbox, any, a Group, a Section
    },
    "limit": 500
  },
  "signals": [                                 // the Board's own Signals, asked only inside its scope
    { "id": "is_support_request", "kind": "noul",
      "question": { "type": "noul",
        "instructions": "The newest message from someone other than the owner asks for help with a problem using the owner's product or service.",
        "criteria": { "true": "A customer or user reports something broken, asks how to do something, or asks for an account change.",
                      "false": "Sales, partnerships, newsletters, internal mail, invoices, or a thank-you with no request." } } },
    { "id": "severity", "kind": "score",
      "question": { "type": "score",
        "instructions": "How badly is the person who wrote the newest message blocked by their problem?",
        "criteria": [ "Not blocked: a question or a small annoyance.",
                      "Slowed down: something works badly but they can continue.",
                      "Blocked: they cannot do what they need, or they are losing money or customers." ] } }
  ],
  "uses": ["frustrated"],                      // shipped Signals the Lanes also read
  "lanes": [
    { "id": "red", "label": "Red", "tone": "danger",
      "when": { "all": [ { "signal": "is_support_request", "holds": true },
                         { "any": [ { "signal": "severity", "at_least": 1.5 }, { "signal": "frustrated", "at_least": 2 } ] } ] } },
    { "id": "yellow", "label": "Yellow", "tone": "warning",
      "when": { "all": [ { "signal": "is_support_request", "holds": true }, { "signal": "severity", "at_least": 0.5 } ] } },
    { "id": "green", "label": "Green", "tone": "ok",
      "when": { "signal": "is_support_request", "holds": true } }
  ],
  "unsure": { "label": "Unsure" },
  "others": "hide",                            // Threads in scope that no Lane claims and none is unsure about: hide, or a Lane "Everything else"
  "layout": { "component": "lanes", "row": { "fields": ["sender", "subject", "snippet", "age"] }, "sort": "oldest_first" },
  "nav": { "icon": "lifebuoy", "count": "red" },
  "examples": { "is_support_request": [ { "threadId": "t_91", "holds": false } ] }
}
```

- **Schema** in `packages/shared` (`board/index.ts`), validated on the Server for every write, like a Workflow. Every edit is a new version; the old versions are kept, and the Board's Signals get new Question versions only when their words change.
- **Lane conditions** combine Facts and Signals with `all`, `any` and `not`. Signal tests: `holds` / `fails` (a Noul against the Unsure band, `signals.unsure.*`, or the Lane's own `at_least` probability), `at_least` / `at_most` (a Score's expectation), `is` (a Choice's pick, with its confidence above the floor). Fact tests: the same vocabulary as the scope plus `deadline_before`, `amount_at_least`, `known_sender`, `has_attachment`, `owner_wrote_last`, `in_group`, `in_section`.
- **Three-valued evaluation.** Each test is true, false or unknown (an Unsure answer, or a Signal not read yet). Lanes are tried in order: the first Lane whose condition is true takes the Thread, unless an earlier Lane was unknown, in which case the Thread goes to Unsure. So a Thread is never placed in Green because Red could not be decided.
- **Hysteresis** (`signals.hysteresis`) keeps a Thread in its Lane until an answer is clearly past the threshold the other way.

## The component catalog

A fixed catalog, like Panels: the Agent picks a component and fills its typed props; it never writes markup or code (json-render style: the document names components, monday renders them).

| Component | Shows | Props |
|---|---|---|
| `lanes` | columns side by side, one per Lane, Unsure last | `row`, `sort`, `collapse_empty` |
| `list` | one list with a heading per Lane | `row`, `sort` |
| `counts` | one line of Lane counts, each a button that filters | `lanes` shown |
| `table` | rows with columns of Facts and Signals ("Due", "Amount", "Severity") | `columns` (a Fact or a Signal each, with a label and format), `sort` |
| `timeline` | Threads placed by a date Fact (`deadline_at`, `received_at`) with Lanes as colours | `date`, `range` |

- `row.fields` come from a closed list: `sender`, `subject`, `snippet`, `age`, `time`, `group`, `deadline`, `amount`, `signal:<id>` (a small label with the answer, such as "Blocked"). Lane `tone` is one of the palette's semantic colours (`danger`, `warning`, `ok`, `info`, `muted`); no free colours.
- **Panels.** The Panel catalog gains `board`, which places a Board's `counts` in the Layout (for example beside the Today panel). A Board is the data; the Panel is one way to show it.
- Rows are ordinary Thread rows: every row action, key and Recommended action works on them.

## Making a Board: the Agent must test it

TypeSafe's guidance is that questions written without evidence read literally and miss. So a Board is never saved on the Agent's word alone.
1. **Draft.** `propose_board` (read-only): the language model (the `board` Task, main Role) writes the Board document from the sentence, with Facts for everything exact ("today", addresses, domains, dates, amounts) and Signals only for what needs reading. Code validates it; errors go back to the model at most twice. Reuse beats invention: when a shipped Signal already asks the question (`frustrated`, `money_involved`, `has_deadline`), the draft must use it.
2. **Try.** `test_board` (read-only, metered): code takes the newest `boards.test.pool` (30) Threads in scope; when the scope holds fewer (a quiet "today"), it widens only the date part of the scope to the last `boards.test.widen_days` (14) and says so ("Tried on earlier days: today has 4 threads so far"). It asks those Threads the Board's Signals (the ordinary Signal request, one Thread each) and evaluates the Lanes.
3. **Show.** The Board card shows `boards.test.shown` (10) of them, spread across the Lanes and including the least confident ones: each Thread's sender and subject, its Lane, and the answers behind it ("Red: support request 94%, blocked 2.1 of 2"), plus the counts over all 30.
4. **Correct.** Each row has "Move to" (another Lane or Unsure) and, per Signal, "Wrong" ("This is not a support request"). Corrections are stored as the Board's `examples`. The Agent then revises: it adds the corrected Threads as Examples in the Signal's instructions (as Sections' Examples work today), and if a correction shows the question itself is off, rewrites it; then tests again on the same Threads and shows "Agrees with your corrections on 9 of 10" and what changed.
5. **Accept.** "Pin board" saves version 1, pins it and starts the backfill of its scope (`signals.md`, Backfill; small scopes just run). "Not now" discards it. The card stays in the Session, so "try it with only paying customers" continues from it.

The card must show at least `boards.test.shown` Threads (or all there are) before "Pin board" is enabled. With no TypeSafe key, a Board whose Lanes use only Facts can be pinned; one with Signals says "Boards that read your mail need a TypeSafe key." and offers to keep only the Fact Lanes.

## Changing and removing

- **By talking.** "Make yellow only paying customers", "rename it to Support", "show it as a table with severity": `update_board` makes a new version; if any Lane or Signal changed, the card tests again and shows which Threads would move ("3 threads move: 2 Yellow to Green, 1 Green to Unsure") before Apply. A pure layout or name change applies with Undo and no test.
- **By hand.** The Board's header menu: Rename, Change icon, Move up or down in the nav, Show as (the components above), Show the source (read-only JSON, as for Workflows), Ask monday to change this board, Delete.
- **Correcting on the Board.** Dragging a Thread to another Lane, or "Move to" on its row, records an Example for the Lane's deciding Signal and keeps the Thread in the Lane the user chose (a user placement, like routing's) until the Thread changes. The Agent offers to fold repeated corrections into the question ("You moved 5 threads out of Red this week. Tighten the question?").
- **Delete** is reversible with Undo (`delete_board`); the Board's Signals lose their consumer and their answers are kept `signals.keep_inactive_days`.

## Limits

| Setting | Default | Why |
|---|---|---|
| `boards.max` | 12 | The nav stays short |
| `boards.max_lanes` | 6 | Plus Unsure; more is a table, not a Board |
| `boards.max_signals` | 6 | Each is paid on every Thread in scope |
| `boards.scope.max_threads` | 2,000 | Above this the Agent narrows the scope, or the user confirms the backfill estimate |
| `boards.test.pool` | 30 | Threads tried |
| `boards.test.shown` | 10 | Threads the user must see |
| `boards.test.widen_days` | 14 | How far back a quiet scope looks for test Threads |
| `boards.nav.show_counts` | on | Counts beside Boards in the nav |

A Board over the limits is refused before anything is saved, with the reason in the card. `signals.max_active` also applies.

## Data and sync

- Server: `boards` (workspace, id, name, current version, pinned, nav position) and `board_versions` (one immutable document per version); Examples live in the document. Board documents are sealed under the Workspace key (they may name people and domains).
- The Changes feed carries `board` changes; the Cache mirrors the current document. A Board's Lanes are computed on the Device from `thread_signals` and Facts in SQLite, so opening a Board never waits (ADR 0011) and works offline with the answers already there.
- Signals: each Board Signal is `board:<boardId>:<signalId>`, owned by the Board, scoped by the Board's scope Facts, so a Board about today's support mail costs a request per new support Thread and nothing else.

## Strings (examples)

"Boards", "Pin board", "Not now", "Unsure", "Not read yet", "Everything else", "Tried on earlier days: {when} has {count} threads so far", "{lane}: {reasons}", "Move to", "Wrong", "Agrees with your corrections on {n} of {m}", "{count} threads move: {moves}", "Boards that read your mail need a TypeSafe key.", "You moved {count} threads out of {lane} this week. Tighten the question?", "Ask monday to change this board", "Show the source".

## Edge cases

- The scope is empty even after widening: the card says so and offers to pin it anyway ("Nothing to try it on yet. Pin it and check back?"); the Signals are then tested live and the Board shows a "New board: check its first placements" bar until the user dismisses it.
- A Thread matches the scope but its Signals were never asked (arrived before the Board existed and outside the backfill): Unsure, "Not read yet", until the backfill reaches it.
- The user asks for something exact that Jev is weak at ("threads with more than 3 replies", "invoices over $500", "older than two weeks"): the draft must use Facts; the schema has no Signal-based count, amount or date comparison, so a draft that tries fails validation.
- A shipped Signal a Board uses is reworded: the Board keeps working on stale answers (lists may, `signals.md`), and its card on the Signals page says "Used by Support today".
- A Board and a Section ask the same statement: one Signal, two consumers.
- Moving a Thread to another Account's Workspace is impossible; Boards are per Workspace.

## Code, Jev, language model

| Code | Jev | Language model |
|---|---|---|
| Scope Facts, Lane evaluation, three-valued logic, hysteresis, layout rendering, counts, limits, the test sample | The Board's Signals and the shipped Signals it uses, per Thread | Drafting and revising the Board document and its questions from the sentence and the corrections |

## Acceptance criteria

1. "Show today's support requests as red, yellow and green" on the fixture mailbox yields a card with 10 tried Threads and their reasons; nothing is in the nav until Pin board.
2. A Thread whose `is_support_request` answer is 0.5 goes to Unsure, never to Green, even when Green's other tests pass.
3. Marking two tried Threads "not a support request" and testing again shows the agreement line and the revised question; pinning saves version 1 with those Examples.
4. A new support Thread arriving while the Board is open lands in its Lane within one Signal request, and the nav count updates without a reload.
5. "Only paying customers" shows the moves before Apply and saves version 2; Undo restores version 1.
6. A Board with only Fact Lanes works with no TypeSafe key.
7. A draft that asks Jev "has more than 3 replies" fails validation and the Agent's retry uses `message_count`.
8. Deleting a Board and Undo within 30 days brings it back with its answers, with no new requests.
