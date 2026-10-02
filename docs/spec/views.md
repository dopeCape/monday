# Views

Behaviors a tester can check. View, Block, Field, Extraction, Lane, Signal, Fact and Unsure are defined in `CONTEXT.md`; the decision is ADR 0016 (on ADR 0003's shape: a JSON document the Agent writes, validated against a schema monday owns, versioned); Signals are ADR 0014; every default is a Setting (ADR 0004) and every word a `strings.views.*` Setting.

A View is what Boards were, generalized. A Board was one scope, the Agent's own Signals, Lanes and one of five layouts. A View is a scope, a set of **Fields** per Thread (Facts, Signals and Extractions), and a stack of **Blocks** from a fixed catalog, each drawing the answer to a small query over those Fields: a kanban, a table, a number, a chart, a calendar, a gallery. The Agent writes the document from the user's sentence, including its own Jev questions; code finds, compares, counts and adds; nothing is saved until the user has seen it work on their own mail.

## What the user sees

- The user asks in a sentence: "all my Amazon orders with shipped and delivered lanes and total spend per month", "invoices I owe as a table with amount, due date and vendor, sorted by due date", "who emails me most this quarter", "my travel bookings on a calendar", "show today's support requests as red, yellow and green". The Agent answers with a View card that has already been tried on the user's own mail (below). Nothing is saved until the user clicks Pin view.
- A pinned View sits in the nav under **Views**, above Groups, in the user's order, with a count (the Lane the View names, or its total). Opening it shows the View in the list area like a Section: its Blocks top to bottom (some side by side), the reader beside or over it by the list knob. Every Thread row, card, cell, bar and calendar entry opens the Thread in the reader.
- A View updates live on the Device: a new Thread in its scope appears when its Signal request answers, a Thread moves when its answers change, a number and a chart change with it. A Thread not read yet shows as "Not read yet"; an answer the Signals could not decide shows as Unsure, never as a guess.
- Items carry the View's **action buttons** ("Track package", "Run refund workflow", "Archive all delivered"): per row or card, and in a Lane's or group's header for all its Threads.
- Existing Boards are Views: each became a View with one `lanes` Block (or the Block its layout named), with nothing lost and nothing asked again.

## The View document

```jsonc
{
  "id": "v_amazon_orders",
  "name": "Amazon orders",
  "sentence": "all my Amazon orders with shipped and delivered lanes and total spend per month",
  "version": 1,
  "scope": { "facts": { "from_domain": ["amazon.com"], "folder": "any", "received": { "last_days": 365 } }, "limit": 1000 },
  // Other scope facts: from_any (whole addresses), from_domain_not, to_any, active,
  // subject_any (words or phrases the subject holds, case and spacing aside), and
  // query (a full search over subjects, people and bodies, "Scope by a search").

  // Fields: Facts need no declaring; Signals and Extractions do.
  "signals": [                                   // the View's own Jev questions (Noul, Choice, Score)
    { "id": "status", "kind": "choice", "label": "status",
      "question": { "type": "choice",
        "instructions": "Where does the newest message say this order stands?",
        "criteria": { "ordered": "The order was placed or confirmed; nothing has shipped.",
                      "shipped": "Some or all of the order is on its way.",
                      "delivered": "The order arrived.",
                      "none": "The message is not about the state of an order (an ad, a review request)." } } }
  ],
  "uses": ["money_involved"],                    // shipped Signals the View also reads
  "extractions": [                               // select, don't generate
    { "id": "order_total", "label": "Total", "find": "money",
      "question": "The total the customer paid for the whole order, including tax and shipping.",
      "none": "The message states no order total, such as a shipping notice without prices." },
    { "id": "order_number", "label": "Order", "find": "reference",
      "question": "The Amazon order number this message is about." },
    { "id": "tracking_link", "label": "Tracking", "find": "link",
      "question": "The link that shows where the package is." }
  ],

  // The Lanes: a classification of every Thread in scope, read by the lanes, list and counts Blocks and by the `lane` Field.
  "lanes": [
    { "id": "delivered", "label": "Delivered", "tone": "ok", "when": { "signal": "status", "is": "delivered" } },
    { "id": "shipped", "label": "Shipped", "tone": "info", "when": { "signal": "status", "is": "shipped" } },
    { "id": "ordered", "label": "Ordered", "tone": "muted", "when": { "signal": "status", "is": "ordered" } }
  ],
  "unsure": { "label": "Unsure" },
  "others": "hide",

  "blocks": [
    { "id": "spend", "type": "stat", "title": "Spent this month", "width": "third",
      "query": { "dedupe": "x:order_number", "aggregate": { "op": "sum", "field": "x:order_total" },
                 "period": { "field": "received_at", "bucket": "month" } },
      "compare": "previous" },
    { "id": "by_month", "type": "chart", "chart": "bar", "title": "Spend per month", "width": "two_thirds",
      "query": { "dedupe": "x:order_number", "group_by": { "field": "received_at", "bucket": "month" },
                 "aggregate": { "op": "sum", "field": "x:order_total" }, "sort": { "by": "key", "dir": "asc" } } },
    { "id": "orders", "type": "lanes", "row": { "fields": ["subject", "x:order_total", "age"] },
      "query": { "dedupe": "x:order_number" }, "actions": ["track"] }
  ],
  "actions": [
    { "id": "track", "label": "Track package", "icon": "truck", "on": "row",
      "when": { "all": [ { "lane": "shipped" }, { "extract": "tracking_link", "present": true } ] },
      "do": { "kind": "open_link", "link": "x:tracking_link" } }
  ],
  "nav": { "icon": "shopping-bag", "count": "shipped" },
  "examples": {}
}
```

- **Schema** in `packages/shared` (`view/`), validated on the Server for every write, like a Workflow. Every edit is a new version; old versions are kept; a View's Signals and Extractions get new Question versions only when their words change.
- **Scope by words in the subject.** `subject_any` admits a Thread whose subject holds one of the words or phrases, case and spacing aside, within its first 80 characters: the Server's one clear subject derivative (`subject_search`, ADR 0015), so the scope runs in SQL on the Server with nothing decrypted, and on the Device over the Cache's subjects. It is how a search the Agent ran ("order confirmation" found exactly the right 15 Threads) becomes a View's scope, beside the senders the results share. When the words are only inside the messages, the search itself is the scope (below).
- **Scope by a search.** `query` is a full search in the search box's language (ADR 0011, ADR 0015; `search_threads` with `full` runs the same one): a Thread is in scope when the search matches its subject, people or bodies **and** every other fact holds. So when the Agent's search found exactly the right Threads, it puts that search in the scope as `query` (`"refund approved" -cancelled` with `folder: any`), and the View holds every Thread it matches, the old and archived ones whose words are only in a body included. A query says only what the mail says: words, quoted phrases, `from:`, `to:`, `subject:`, `has:attachment` and `-word`. Validation refuses dates (`before:`, `after:`, `older_than:`, `newer_than:`: they would move every day; use `received` or `active`), state that changes as mail is read and filed (`is:`, `in:`, `tag:`, `label:`; use `folder`), and a query with nothing to look for (only `-words`), each with the reason, so the draft's retry fixes it. Prefer `subject_any` when the words are in the subject: it needs no reading.
  - **Members.** Bodies are sealed and the Server keeps no plaintext index (ADR 0015), so a search scope is not SQL. The Server finds the View's **Members** by reading the mail in memory with the full search's own matcher, and keeps only which Threads matched (`view_members`: the View, the Thread, its version when it matched, when; ids only, migration 0034). A Member is matched within every other fact but the folder (filing mail moves no Message, so the folder is applied when the View is read); a new query, or new facts around it, empties the Members and finds them again.
  - **Found by the View's own walk.** On Pin view and on a version whose query or facts moved, the walk that reads a pinned View (below) first searches: newest first through the Threads the other facts admit, `views.query.page_size` (200) at a time and at most `views.query.scan_max` (20,000), each page matched and its Members recorded, and in the same pass each Member asked the View's questions it lacks. Finding Members needs no judge and no budget, only an unlocked Server; when the walk may not ask (no judge, the budget, the AI level) it keeps searching and holds the questions, then walks the Members alone to ask them. A walk stops at the scope's `limit` Members. A later walk (a reworded question) reads only the Members. Locked, the walk waits with the reason "locked".
  - **Kept current on arrival.** When a Thread's bodies land (a new Thread, or a new Message), a Job per Thread version tests it against every pinned search View of its Workspace and records who joined or left. The Signal request's scope check answers a View's query from its Members, and matches there and then a Thread it has not seen at this version, so an arriving Member is asked the View's questions in its one request; a Thread that is not a Member is never asked them.
  - **On the Device.** The Changes feed's `view_members` rows (ids only: who joined, who left, or a reset) keep the Cache's `view_members`, and `GET /views/:id/members` reads them whole once per version. `viewThreadsSql` joins them in place of the search, so the open View, its Blocks and its nav count work offline from the Cache; the Device never runs the search.
  - **The try.** The test runs the full search with the scope's other facts as its clear filters, counts the matches up to `views.query.count_max` (500; past it, or past `views.query.scan_max` Threads, the card and the Agent say "at least N"), and tries the newest of them; a Thread tried before is matched again on its own. Nothing on a UI path decrypts the mailbox: only the Agent's tool call, the background walk and the per-Thread Job read the mail.
  - `inspect_view_thread` says whether the search matches a Thread and what it matched ("refund approved in a message's text; shop in the sender").
- **Lanes are optional.** A View without a `lanes`, `list` (by Lane) or `counts` Block may have none; `lanes: []` is valid then.

## Fields

A Field is one value per Thread a Block can show, filter, group, sort, dedupe or add up. Every reference is a string:

| Reference | Kind | Where it comes from | Type |
|---|---|---|---|
| `received_at`, `last_activity_at`, `deadline_at` | Fact | code (`thread_facts`, the Thread row) | date |
| `message_count`, `participant_count`, `attachment_count`, `amount_count` | Fact | code | number |
| `amount` | Fact | the shipped money pick, parsed by code | money |
| `known_sender`, `has_attachment`, `owner_wrote_last`, `owner_ever_wrote`, `to_me_directly`, `has_invite`, `deadline_unclear`, `unread`, `starred` | Fact | code | flag |
| `from_address`, `from_domain`, `list_id`, `in_group`, `in_section` | Fact | code | text |
| `subject`, `snippet`, `sender`, `group` | Fact | the Thread row | text |
| `person` | Fact | the correspondent: the newest sender who is not the owner, else the first | person |
| `company` | Fact | the correspondent's domain as an organisation (`acme.com` is Acme; a personal mail domain is the person) | text |
| `lane` | Lane | the Lane the Thread is in | lane |
| `signal:<id>` | Signal | the View's own, or a shipped one in `uses` | probability (Noul), score, choice |
| `x:<id>` | Extraction | code finds candidates, Jev picks one, code copies and normalizes it | by `find` (below) |

**Exact things are code.** Counts, amounts, dates and comparisons between them are Facts or Extractions with code comparisons. A Jev question never asks for a count, an amount or a date comparison; the schema has no way to compare a Signal against a number of messages, a sum or a date, and a question whose words ask for one fails validation ("has more than 3 replies" must be `{"fact": "message_count", "at_least": 4}`).

### Extractions: select, don't generate

An Extraction is a value the View needs from the text that code cannot pick alone ("the order total the customer paid", "the expected delivery date", "the vendor I owe"). It follows TypeSafe's pre-parsed value extraction cookbook:

1. **Code finds the candidates** of the Extraction's `find` kind in the Thread's text, over-finding, deduplicated, in order, at most `views.extract.candidates_max` (20), each with a few words of context.
2. **Jev picks one** in a Choice whose options are those candidates plus `none` ("None of these is the requested value.", or the Extraction's own `none` words). The question is the Agent's own words.
3. **Code copies the pick** and normalizes it. The value is always one of the spans code found, copied unchanged; Jev never writes a value.
4. **Below the floor** (the Extraction's `min_confidence`, else `views.extract.min_confidence`, 0.6) the value is Unsure: shown as Unsure, left out of sums and counted in the Block's Unsure line. `none` above the floor means "not stated": the Field is empty.

| `find` | Candidates code finds | Normalized to | Type |
|---|---|---|---|
| `money` | amounts with a currency symbol or code (`$1,315.50`, `EUR 40`, `12,00 €`, `2900 INR`, `Rs. 799`) | `{ value, currency }` | money |
| `date` | written dates (`3 October 2026`, `Oct 3`, `2026-10-03`, `10/03/2026` by `views.extract.date_order`, `Tue, Oct 3`), the year from the Message's own date when not written | `YYYY-MM-DD` in the Workspace's zone | date |
| `reference` | order, invoice, booking, confirmation, ticket and reference numbers (`#113-4567890-1234567`, `INV-2291`, `Booking ref ABC123`) | the span without a leading `#` | text |
| `tracking` | carrier tracking numbers by pattern (UPS, USPS, FedEx, DHL), only near a word about shipping | the number, with its carrier | text |
| `email` | addresses in the text and on the Messages | lowercased | text |
| `person` | people's names on the Messages and in greetings and sign-offs | the name | text |
| `company` | organisation names: senders' display names, names ending in Inc, LLC, Ltd, GmbH and the like, and senders' domains | the name | text |
| `link` | links, each shown by where it goes (`pay.stripe.com/i/2291`) | `{ url, domain }` | link |
| `quantity` | counts of items (`Qty: 2`, `2 x`, `3 items`) | a number | number |
| `item` | line items: bulleted or numbered lines, lines led by a count (`1x`), lines naming a thing beside its price, and lines followed (after short attributes such as `Size: M`) by their count or price; never a line that is only a count or a price, never a total, tax or fee; at most `views.extract.item_chars` (300) characters | the line | text |
| `sentence` | the sentences of the Messages (the owner's own when the question says "I" or "the owner") | the sentence | text |

Extractions are Signals: each is stored as a Choice Signal owned by the View (`board:<viewId>:x_<id>`, the stored prefix predates Views), gated on its kind's candidates, with per-Thread options built by code (`signals.md`, per-Thread options). Its answer row says only "picked" or "none" and the confidence; the picked value stays sealed on the Server with the Thread's Facts and reaches the Device only through `GET /views/values` (below).

### Many values

A Thread may hold many of the values a View wants: an order confirmation bundling nine orders has nine totals, a Dependabot digest lists seventy packages. An Extraction with `"many": true` (and at most `max` values, never more than `views.extract.many.max`) picks every one:

1. **Code finds the candidates** as for one value, up to `views.extract.many.max` (30); past it the rest are not asked and the test says so.
2. **Jev answers one Noul per candidate**: "does this span answer the question?", with the span and the words around it in the question (`views.extract.many.note`, `views.extract.many.yes`), `false` meaning the Extraction's own `none` words. The Nouls are independent questions over the same state, so they ride together in the Thread's one Signal request; a Thread is never batched with another.
3. **Code keeps every candidate at or above `views.extract.many.threshold`** (0.7), in order of appearance, at most `max`. One in the Unsure band (from `signals.unsure.noul_low` up to the threshold) is kept as Unsure: it is never a value, and a Thread with only Unsure ones reads Unsure. None above the band: not stated.
4. **Code adds and counts.** A Thread row reads a many-Extraction as the total of its values (money in the currency most of them use, and each currency kept apart in a Block's aggregate), shows them listed, and every aggregate takes each value: a sum adds all nine totals into the confirmation's month, `count` of the Field counts values (70 packages), `avg`, `min` and `max` over the values. Picking many is allowed; a question that asks Jev to add or count still fails validation.

The answer row says only "picked" or "none" (with the least probability kept, or how clearly the best one was not it); the values stay sealed with the Thread's Facts beside the rest (`items`), reach the Device through the same routes and sit in the Cache's `view_values.items`.

### Rows

A View's `grain` says what one Row of its Blocks is:

| `grain` | A Row is | Its values and answers | Its date |
|---|---|---|---|
| `thread` (default) | a Thread | as above | the Thread's |
| `item` | each value the `item_of` many-Extraction picked | that one value, and each per-row Signal's answer for it | the Message it was found in |
| `message` | each Message of a Thread that holds a value or an answer | each Extraction's value in that Message (one Choice per Message over that Message's candidates, up to `views.grain.max_messages` Messages), each per-row Signal's answer for it | that Message's |

- **Per-row questions.** A View Signal with `"each": true` is asked once per Row instead of once per Thread, with the item (its span and the words around it) or the Message (its sender, date and first `views.grain.message_chars` characters) in the question (`views.each.item_note`, `views.each.message_note`), in the Thread's one request. For grain `item` it is asked of every candidate of the `item_of` kind, speculatively beside the Nouls that pick them (TypeSafe: independent questions ride together; code reads only the answers of the candidates picked), so one request still carries everything. This is how "vulnerabilities by severity" works: the digest's rows are its packages, and each package's severity is its own Choice.
- A Thread whose `item_of` values are Unsure or not read yet stays one Row, counted Unsure or Not read yet; one with none has no Rows. A Thread with no Message Rows stays one Row.
- Every Row keeps its Thread's id, so a table row, a bar or a card opens its Thread; a Message Row opens it on that Message, unfolded and scrolled to. Lanes, `where`, dedupe, groups, aggregates and sorts work on Rows exactly as on Threads; the scope and its `limit` count Threads.
- The card shows the tried Threads (once each, whatever their Rows), and its Blocks are drawn over the Rows.
- **Decided, severity per item.** A per-item judgment is a per-row Signal (`each`) whose question carries the item, not a sibling many-Extraction: two independent lists could not be paired item by item, and a question per item keeps each answer attached to its Row. Its cost is one question per candidate, bounded by `views.extract.many.max`.
- A user placement ("Move to") and a checklist mark are per Thread, so they apply to all of a Thread's Rows.

### One request per Thread

All of a View's Jev questions for one Thread (its Signals, the shipped ones it uses and lacks, its Extractions, and for many values and per-row Signals one question per candidate or Message) ride in the **one Signal request** for that Thread (ADR 0014), beside every other Signal that applies: independent questions over the same state, answered in parallel (split into parts, all in flight, only when they outgrow TypeSafe's request budget). Many Threads are asked concurrently (the limiter's pool); nothing walks Threads one after another, and questions of two Threads never share a request.

## Queries

Every Block has a `query` over the Threads in the View's scope. Code only.

```jsonc
{
  "where": { "all": [ { "fact": "deadline_at", "after": "today" }, { "extract": "amount_due", "at_least": 100 } ] },
  "lanes": ["red", "yellow"],                   // only Threads in these Lanes
  "dedupe": "x:order_number",                   // one row per value; rows without one are kept
  "group_by": { "field": "received_at", "bucket": "month" },
  "aggregate": { "op": "sum", "field": "x:order_total" },
  "sort": { "by": "x:due_date", "dir": "asc" },  // a Field, or "value" / "key" when grouped
  "limit": 50,
  "period": { "field": "received_at", "bucket": "month" }   // stat: the current period only
}
```

- **Conditions** (`where`, a Lane's `when`, an action's `when`) combine with `all`, `any` and `not`. Tests: a Fact (`{"fact": ..., "is" | "in" | "at_least" | "at_most" | "before" | "after"}`), a Signal (`holds`, `fails`, `at_least`, `at_most`, `is`, as for Boards), an Extraction (`{"extract": id, "present": true}`, or the Fact tests on its value: `at_least` for money and numbers, `before` / `after` for dates, `is` / `in` for text), a Lane (`{"lane": id}`), and the scope's own filters.
- **Three-valued.** Every test is true, false or unknown (an Unsure answer, an Extraction below its floor, a Signal not read yet). `where` keeps a Thread only when true; an unknown Thread is counted in the Block's Unsure line ("3 unsure"), never dropped silently and never guessed in. Lanes are tried in order and an unknown earlier Lane sends a Thread to Unsure, as before.
- **Dedupe** merges the rows sharing a value of the Field (every order's confirmation, shipping and delivery mail): the merged row is the newest Thread, each Field its newest known value (the total from the confirmation, the Lane from the delivery). The merged row opens its newest Thread.
- **Group by** a Field's value (`from_domain`, `x:vendor`, `signal:status`, `lane`, `person`, `company`), or a date Field's `day`, `week`, `month`, `year`, `weekday` or `hour` in the Workspace's zone. Groups with no rows are not shown, except time buckets between the first and the last, which show as zero so a chart has no gaps.
- **Aggregates:** `count` (Threads, after dedupe), `sum`, `avg`, `min`, `max` over a number or money Field. Unsure and empty values are left out and the Unsure ones counted. **Money** adds up per currency: the Block shows the currency most rows use and lists the others under it ("+ EUR 40.00"); amounts are never converted.
- **Sort** by a Field (dates and numbers by value, text alphabetically, Unsure last) or, grouped, by `value` or `key`; **limit** caps rows or groups (`views.query.max_rows`, 500).
- **Period** (for `stat`): only rows whose date Field falls in the current bucket (this month); `compare: "previous"` computes the same over the previous bucket and shows the change ("up 12% on last month").

## The Block catalog

A fixed catalog, like Panels: the Agent picks a Block and fills its typed props; it never writes markup, styles or code (json-render style). Blocks stack top to bottom; `width` (`full`, `half`, `third`, `two_thirds`) lets two or three sit side by side on a wide list area and stack on a narrow one.

| Block | Shows | Props |
|---|---|---|
| `lanes` | columns side by side, one per Lane, Unsure last (the Board kanban) | `row`, `sort`, `collapse_empty`, `query`, `actions` |
| `list` | one list with a heading per group (the Lane by default) | `row`, `group_by`, `sort`, `query`, `actions` |
| `counts` | one line of Lane counts, each a button that filters the rows below | `lanes` |
| `table` | rows with columns of any Fields | `columns` (`{ "label", "field", "format" }`), `query`, `actions` |
| `stat` | one number tile, with the change from the previous period | `title`, `query` (with `aggregate`), `format`, `compare` |
| `chart` | `bar`, `stacked_bar`, `line`, `area` or `donut` over a `group_by` (plain SVG) | `chart`, `title`, `query` (with `group_by`), `series` (a second grouping, stacked bars) |
| `timeline` | Threads placed by a date Field, Lanes as colours | `date`, `range`, `query` |
| `calendar` | a month grid with each Thread on the day of a date Field | `date`, `title`, `query` |
| `cards` | a gallery, one card per row: a title, a subtitle, badges, a value | `card_title`, `subtitle`, `badges`, `value`, `value_format`, `query`, `actions` |
| `people` | people or companies with their Thread count and last activity | `by` (`person` or `company`), `query` |
| `checklist` | one checkable item per Thread (an Extraction or the subject); checked items fold away | `item`, `query`, `actions` |
| `heatmap` | counts in a grid: weekday by hour, or week by weekday | `date`, `grid`, `query` |
| `text` | a short heading or note the Agent writes (at most 280 characters) | `text`, `tone` |

- **Formats** for a table column or a value: `money`, `number`, `date`, `relative` ("in 3 days"), `percent`, `text`, `chip` (a small label, a Lane's tone for `lane`).
- **Rows** in `lanes`, `list` and `counts` are the Inbox's own Thread rows: every row action, key, drag and Recommended action works on them. Rows elsewhere (a table row, a card, a bar, a calendar entry, a person) open the Thread, or, for a group, the list of its Threads.
- **Checklist.** Checking an item marks it done for that Thread version (kept beside the View like a placement, sealed); a Thread that changes comes back unchecked. When the checklist reads a Noul the user has not answered ("things I promised" over `owner_promised`), checking it also records an Example that the promise was kept.
- Lane `tone` and a `text` Block's tone are the palette's semantic colours (`danger`, `warning`, `ok`, `info`, `muted`); no free colours. Charts use the palette's chart tokens.
- **Panels.** The Panel catalog's `board` Panel is the `view` Panel: a View's first `counts` or `stat` Blocks, placed in the Layout (`views.panel`).

## Actions on items

A View may declare **actions**, buttons on its items. Each is an ordinary Tool call with its Tier, through the same paths as Custom actions and Recommended actions; approvals live inside the tools (ADR 0002) and reversible ones show Undo.

```jsonc
{ "id": "refund", "label": "Run refund workflow", "icon": "arrow-u-up-left",
  "on": "row",                                      // row (each row or card), group (a Lane's or group's header: every Thread in it), or both
  "when": { "lane": "delivered" },                  // three-valued: hidden when false or unknown
  "do": { "kind": "run_workflow", "workflow": "wf_refund", "inputs": { "order": "x:order_number", "amount": "x:order_total" } } }
```

| `do.kind` | What it does | How |
|---|---|---|
| `run_workflow` | starts a Workflow by hand on the Thread; `inputs` map Fields into its Run, which its Steps read as `{{inputs.<name>}}` | the Workflow runner; every Step keeps its own approvals and Standing approvals |
| `archive`, `mark_read`, `mark_unread` | as the row actions | InboxActions, with Undo |
| `snooze` | until a date Field (`x:delivery_date`) or a preset (`tomorrow`, `next_week`, `weekend`) | InboxActions, with Undo |
| `move` | to a Group | InboxActions, with Undo |
| `tag` | adds a Tag | InboxActions, with Undo |
| `reply_template` | opens a reply started from a Template, its Placeholders filled from the Thread | compose; the user sends |
| `forward` | opens a forward to an address Field (`x:accounts_email`) or a fixed address | compose; the user sends |
| `open_link` | opens a link Field (a tracking page) after showing its domain | the Recommended action's link check |
| `add_to_calendar` | an Event on a date Field, titled by a Field | the calendar tool's approval card |
| `custom_action` | runs one of the user's Custom actions | the Custom action runner, with its Tier |
| `set_lane` | puts the Thread in a Lane ("Move to") | a user placement and an Example, as a drag |
| `mark_done` | checks the Thread's checklist item | the checklist |
| `ask_agent` | opens the Agent with the action's prompt and the Thread (or the group's Threads) as context | a Session; nothing runs unasked |

- Anything that leaves the mailbox asks first: a forward and a reply open compose and never send; a Workflow's sending Steps pause for approval unless the user gave that Step a Standing approval; opening a link shows its domain first.
- A `group` action runs for every Thread in the Lane or group, one Tool call per Thread through the same batch preview as the Inbox's multi-select (`inbox.batch_preview_above`).
- Blocks name the actions their items carry (`"actions": ["track"]`). A shipped action's label (Archive, Snooze) is a `strings.views.action.*` Setting; an action the Agent wrote carries its own label in the document.
- On the View card the actions are shown on the tried rows, disabled, with what they would do ("Run refund workflow: Refunds, 3 steps").
- **Deferred:** a Workflow trigger "a Thread enters Lane X of View Y", so an action can run by itself. Until then the user presses the button, or asks for a Workflow with a `judged` condition.

## Making a View: the Agent must test it

TypeSafe's guidance is that questions written without evidence read literally and miss. So a View is never saved on the Agent's word alone.

1. **Draft.** `create_view` (read-only, metered): the language model (the `board` Task, main Role; `ai.local.background.tasks` includes it, so a command-line agent drafts it when monday runs on one) writes the whole document: scope, Signals with their own Jev questions, Extractions, Lanes, Blocks and actions. The drafting prompt (`views.prompt`, a Setting) carries the Block catalog, the Field vocabulary, the Extraction kinds, many values and the grains, the scope facts (with `subject_any`), the action catalog, good and bad question examples, the rule "picking many values is allowed; adding or counting them stays in code", and two worked examples that validate as written: "my orders with a chart of how much I bought per month" (Thread rows, a many money Extraction for each order's total, summed per month, deduped by order number) and "the vulnerabilities my GitHub repos have gotten, by severity per month" (item rows over a many `item` Extraction, severity a per-row Choice, a stacked bar per month). The revise prompt (`views.revise_prompt`) tells the model what "no candidates found" means and when to use many or a grain. Code validates the draft; the errors go back to the model at most `views.draft.retries` (2) times. Reuse beats invention: when a shipped Signal already asks the question (`frustrated`, `money_involved`, `has_deadline`), the draft must use it.
2. **Questions the TypeSafe way.** Each Signal is one narrow judgment about the Thread, with the judgment in `instructions` and the exact condition and its boundary in `criteria`; a Choice has a no-match option (`none`); an Extraction names the one value it wants and what `none` means. Examples of good and bad questions are in the prompt:
   - Good: `{"type": "noul", "instructions": "The newest message from someone other than the owner asks for help with a problem using the owner's product.", "criteria": {"true": "A customer reports something broken or asks how to do something.", "false": "Sales, newsletters, invoices, internal mail, or a thank-you with no request."}}`
   - Bad: "Is this an important support email with more than 3 replies?" (two judgments in one, and a count: use `message_count`).
   - Bad: "What is the order total?" as a Noul or a Score (a value is an Extraction with `find: money`).
3. **Try.** Code takes the newest `views.test.pool` (30) Threads in scope across the whole mailbox: the scope's exact facts (folder, dates, who started the Thread, who it went to) are applied in SQL before the bound, on the Server for the test and on the Device for the View, never "the newest few hundred, then filtered" (widening only the dates of a quiet scope to `views.test.widen_days`, 14, and saying so). When a Block adds up, groups or charts by an Extraction (a total per month), the Threads worth trying are those whose text holds that kind of value: code looks, without asking anything, through the newest `views.test.scan` (120) Threads in scope, prefers the ones where it finds candidates of every such Extraction's kind, fills the pool with the rest only when too few do, and the card and the tool say how many it passed over (`views.test.prefer_readable`, on). Then it asks each its one Signal request with the draft's questions riding in it, concurrently, and computes every Block over the answers.
4. **Show.** The View card in the Agent shows a small preview of each Block (a mini kanban, the stat's number, a chart's bars, the table's first rows), and `views.test.shown` (10) tried Threads spread across the Lanes and least confident first, each with its Lane, its values and the answers behind them ("Delivered: status delivered 92%; Total $41.97 (88%)"), and the actions it would carry, disabled.
   Under the Block previews the card shows the same numbers the Agent reads: how the tried Threads were chosen ("Tried on 10 of 143 matching threads, newest first, preferring ones with amounts, passed over 4 without them"), who sent most of them, and one line per Extraction and Signal ("Total: 8 of 10 read", then each reason with its count: "1 none of these", "1 unsure", "2 had no amounts", "not read", "cut at the limit", and a few values). A Field a Block shows that read on less than `views.card.warn_below` (50%) of the tried Threads is marked with a warning. Clicking a reason lists the tried Threads it names in place of the shown ones (every tried Thread travels in the tool's preview, not only the shown ten), and "Show all" goes back. A draft tried before the coverage was kept shows its card as before, without these lines.
   The Agent reads the same test in words: the scope's size, how the tried Threads were chosen and who sent them, and for each Extraction and Signal over every tried Thread how many got a value (a clear answer), "none of the candidates", an answer below the floor (Unsure), or **no candidates found** (code found nothing of that kind in the text, so nothing was asked), with a few values picked and the shown Threads' ids. `inspect_view_thread` (read-only, not metered) explains one Thread: why the scope admits it, fact by fact; each Extraction's candidates in order with the words around them and the share of Jev's answer each got, and what was picked; each Signal's answer. For a Thread the test did not try it shows what code finds in it without asking anything. The Agent diagnoses with these before it revises, never guessing that a body was missing.
5. **Correct.** Each row has "Move to" (a Lane or Unsure), "Wrong" per own Noul, and "Wrong value" per Extraction (pick another candidate, or "not stated"). Corrections are stored as the draft's `examples` and ride in the questions as Examples. `revise_view` folds them in (and rewrites a question the corrections show is off), tries again on the Threads it tried that the scope still admits (a revision that changes the scope drops the others and fills the pool with the newest Threads of the new scope, so a narrowed scope is never judged on the old one's Threads) and shows "Agrees with your corrections on 9 of 10" and what changed.
6. **Pin.** "Pin view" saves version 1, pins it, writes what the try already answered for the tried Threads (below) and starts reading its scope (Reading a pinned View). "Not now" discards it. The card stays in the Session, so "only this year" continues from it.

### Reading a pinned View

The shipped backfill walks the Inbox of the last months; a View looks wherever its scope says (archived receipts from a year ago). So a pinned View reads its own scope:

- **When.** On Pin view, and on a new version whose questions, Extractions or scope changed (Apply, `update_view`, Undo to a version that asks otherwise). Only the questions that are new or reworded are asked again; a moved scope reads all of the View's questions, and every Thread that already has a current answer costs nothing.
- **The try is kept.** The answers the try got for its tried Threads are written at Pin view (and Apply) at the saved View's question versions, as if just answered, with no request, when the Thread has not changed since; the walk is held until they are written, so it never asks those Threads again.
- **The walk.** Newest first over the scope's exact facts in SQL (archived and older Threads included), at most the scope's `limit` and `views.scope.max_threads`, a page of `views.backfill.page_size` (40) at a time; each Thread in its one Signal request with only the View's questions it lacks (many values, per-Message and per-row questions included), several Threads at once through the judge's pool and the limiter at background priority (`signals.backfill.concurrency`). One walk per View (`view_backfills`, migration 0033) with its cursor saved after every page, so a restart resumes where it was.
- **Budget and level.** Metered as background (`judge.backfill`) under `signals.budget.background_monthly_usd`: a spent budget, no judge, or an AI level below automate stops it with the reason, and it looks again after `routing.wait_seconds`.
- **Progress.** The Changes feed carries `view_reading` rows (headers: status, reason, done, total, and for a search scope its phase and how many matched), which the Cache keeps in `view_reading`; the View's bar says "Reading 12 of 40" with a thin meter, "Searching 200 of 1,200 threads: 4 match so far" while a search scope finds its Members, "Reading waits for monday to unlock" when locked, "Reading paused at 24 of 40: this month's background budget is spent", or "Reading waits for a TypeSafe key", with Pause, Resume and Stop (`GET /views/:id/reading`, `POST /views/:id/reading/pause|resume|stop`). Values reach the Device the way arrival's do (`view_values`).
- `views.backfill.enabled` (on) turns it off; a deleted or unpinned View's walk ends.

The card shows at least `views.test.shown` Threads (or all there are) before Pin view is enabled. With no TypeSafe key, a View whose Blocks and Lanes read only Facts can be pinned; one with Signals or Extractions says "Views that read your mail need a TypeSafe key." and offers to keep only what needs no reading.

## Changing and removing

- **By talking.** "Add a chart of spend per vendor", "make yellow only paying customers", "show it as a table", "add a button that runs my refund workflow": `update_view` makes a new version. If a Lane, Signal, Extraction or scope changed, the card tries it and shows which Threads would move before Apply; a Block, action, name or icon change applies with Undo and no test.
- **By hand.** The View's header menu: Rename, Change icon, Move up or down in the nav, Show as (for a View with Lanes: lanes, list, counts, table, timeline), Show the source (read-only JSON), Ask monday to change this view, Unpin, Delete.
- **Correcting on the View.** Dragging a Thread to another Lane, or Move to, records an Example for the Lane's deciding Signal and keeps the Thread there until it changes. Repeated corrections bring the offer to tighten the question ("You moved 5 threads out of Red this week. Tighten the question?").
- **Delete** is reversible with Undo (`delete_view`); the View's Signals lose their consumer and their answers are kept `signals.keep_inactive_days`.
- The old tool names `list_boards`, `create_board`, `revise_board`, `update_board`, `delete_board` stay as aliases of the View tools for Sessions and Workflows that name them.

## Limits

| Setting | Default | Why |
|---|---|---|
| `views.max` | 12 | The nav stays short |
| `views.max_lanes` | 6 | Plus Unsure |
| `views.max_signals` | 6 | Each is paid on every Thread in scope |
| `views.max_extractions` | 6 | Each is a question on every Thread its candidates are found in |
| `views.max_blocks` | 8 | A View is read at a glance |
| `views.max_actions` | 8 | |
| `views.scope.max_threads` | 2,000 | Above this the Agent narrows the scope |
| `views.query.max_rows` | 500 | Rows or groups one Block draws |
| `views.test.pool` | 30 | Threads tried |
| `views.test.shown` | 10 | Threads the user must see |
| `views.test.widen_days` | 14 | How far back a quiet scope looks |
| `views.test.prefer_readable` | on | The test prefers Threads whose text holds the values its Blocks add up |
| `views.test.scan` | 120 | Threads in scope code looks through for them (no judge) |
| `views.extract.min_confidence` | 0.6 | Below it an Extraction is Unsure |
| `views.extract.candidates_max` | 20 | Candidates per Extraction per Thread |
| `views.extract.date_order` | `mdy` | How `10/03/2026` reads |
| `views.extract.item_chars` | 300 | The longest line offered as an item |
| `views.extract.many.threshold` | 0.7 | A candidate of many is kept at or above this probability |
| `views.extract.many.max` | 30 | Candidates asked per many-Extraction or per-item Signal per Thread |
| `views.grain.max_messages` | 20 | Messages a message-grain View reads per Thread |
| `views.grain.message_chars` | 1500 | Characters of a Message in its own question |
| `views.backfill.enabled` | on | A pinned View reads its own scope |
| `views.backfill.page_size` | 40 | Threads read before the walk's place is saved |
| `views.query.count_max` | 500 | Matches a search scope's try counts; above it the card says "at least" |
| `views.query.scan_max` | 20,000 | Threads, newest first, a search scope reads to find its Members |
| `views.query.page_size` | 200 | Threads a search scope's walk matches before its place is saved |
| `views.card.warn_below` | 0.5 | A Field its Blocks show that read on less of the tried Threads is marked on the card |
| `views.nav.show_counts` | on | Counts beside Views in the nav |

A View over the limits is refused before anything is saved, with the reason in the card. `signals.max_active` also applies (a View's Signals and Extractions both count).

## Data and sync

- Server: `views` (workspace, id, current version, pinned, nav position, the sealed extras: placements, checklist marks and corrections), `view_versions` (one immutable sealed document per version) and `view_drafts`. Migration 0031 renames the Board tables and keeps every row; the documents are sealed under their original content kind, and a Board document (with `layout`) is read as a View with one Block of that component.
- The Changes feed carries `view` changes (headers), `view_values` changes (a Thread whose picked values changed, headers only), `view_reading` changes (how far a pinned View has read its scope: counts only, and for a search scope its phase and how many matched) and `view_members` changes (a search scope's Members who joined or left: ids only). The Cache mirrors the Members in `view_members`. The Cache mirrors the current documents (`views`) and the picked values (`view_values`, fetched through `POST /views/values` for the Threads the feed names, or `GET /views/:id/values` for a whole View). A View's Blocks are computed on the Device from `thread_signals`, `thread_facts` and `view_values` in SQLite, so opening a View never waits (ADR 0011) and works offline with the answers already there.
- Signals: each View Signal is `board:<viewId>:<signalId>` and each Extraction `board:<viewId>:x_<id>`, owned by the View (`owner.kind` `view`), scoped by its scope's Facts.
- Settings: `boards.*` and `strings.boards.*` became `views.*` and `strings.views.*`; the migration moves saved values, and a config file that still says `boards.*` applies through the key aliases.

## Strings (examples)

"Views", "Pin view", "Not now", "Unsure", "Not read yet", "Everything else", "{count} unsure", "Tried on earlier days: {when} has {count} threads so far", "Move to", "Wrong", "Wrong value", "Not stated", "Agrees with your corrections on {n} of {m}", "{count} threads move: {moves}", "Views that read your mail need a TypeSafe key.", "up {pct} on last {period}", "+ {amount}", "Ask monday to change this view", "Show the source", "Open {domain}?".

## Edge cases

- The scope is empty even after widening: the card says so and offers to pin it anyway; the questions are then tested live and the View shows a "New view: check its first placements" bar until dismissed.
- An Extraction whose candidates are never found on a Thread (no amount in a shipping notice) is answered "not stated" by code without asking; the Field is empty, not Unsure.
- Two Threads of one order disagree on the total: dedupe keeps the newest known value; the table's cell shows it with the Thread it came from.
- A sum over two currencies shows the main one and lists the rest; nothing is converted.
- A chart whose group has more than `views.chart.max_groups` (12) groups shows the largest and "Other".
- A View action whose Workflow was deleted or disabled is hidden and the View card says which.
- A shipped Signal a View uses is reworded: the View keeps working on stale answers (lists may, `signals.md`).
- Moving a Thread to another Account's Workspace is impossible; Views are per Workspace.

## Code, Jev, language model

| Code | Jev | Language model |
|---|---|---|
| Scope Facts, candidate finding and normalizing, every comparison, count, sum and date bucket, dedupe, three-valued logic, hysteresis, Rows, many values kept by threshold, Blocks, limits, the test sample, action gating | The View's Signals (per Thread or per Row), the shipped ones it uses, and each Extraction's pick (one Choice, or one Noul per candidate of many), per Thread, in the one Signal request | Drafting and revising the View document, its questions and its Blocks from the sentence and the corrections |

## Acceptance criteria

1. "Show today's support requests as red, yellow and green" on the fixture mailbox yields a card with 10 tried Threads and their reasons; nothing is in the nav until Pin view. (Boards acceptance 1.)
2. A Thread whose `is_support_request` answer is 0.5 goes to Unsure, never to Green. (Boards 2.)
3. Marking two tried Threads "not a support request" and revising shows the agreement line; pinning saves version 1 with those Examples. (Boards 3.)
4. A new Thread arriving while a View is open lands in its Lane, its table row or its stat within one Signal request, and the nav count updates without a reload. (Boards 4.)
5. "Only paying customers" shows the moves before Apply and saves version 2; Undo restores version 1. (Boards 5.)
6. A View with only Fact Blocks works with no TypeSafe key. (Boards 6.)
7. A draft that asks Jev "has more than 3 replies" fails validation and the retry uses `message_count`. (Boards 7.)
8. Deleting a View and Undo within 30 days brings it back with its answers, with no new requests. (Boards 8.)
9. Every Board saved before the migration opens as a View with one Block of its old component, the same Lanes and the same counts, and no Signal is asked again.
10. **Amazon orders.** On the fixture orders (a confirmation, a shipping notice and a delivery notice for each of two orders, one in September and one in October), "all my Amazon orders with shipped and delivered lanes and total spend per month" yields lanes with one card per order in its latest status, a stat of this month's spend, and a bar chart with September and October; the totals come from the fake judge's picks among the amounts code found, and each order is counted once.
11. **Invoices I owe.** "Invoices I owe as a table with amount, due date and vendor, sorted by due date" yields a table whose rows are sorted by the extracted due date, amounts formatted as money, and a vendor column; an invoice whose amount pick is below the floor shows Unsure in its cell.
12. **Who emails me most.** "Who emails me most this quarter" yields a `people` Block and a bar chart counted by code, no Jev question at all, and works with no TypeSafe key.
13. **Travel bookings.** "My travel bookings on a calendar" yields a `calendar` Block with each booking on the day of its extracted travel date.
14. The try on 30 Threads asks each Thread once, with every question of the draft in that one request, and the requests run concurrently.
15. An Extraction pick below `views.extract.min_confidence` is Unsure: it shows as Unsure, is left out of the sum and is counted in the Block's Unsure line.
16. **Actions.** A `run_workflow` action starts the Workflow on the Thread through the Workflow runner with the mapped inputs, and its sending Step pauses for approval; a `forward` action opens compose and sends nothing; an `archive` action applies with Undo; an action whose `when` is unknown is hidden; the card shows the actions disabled on the tried rows.
17. A draft that names an unknown Block, Field, Extraction kind, action kind, Workflow or Lane fails validation with the reason, and the retry corrects it.
18. **The right Threads.** A View of five order senders over a year, whose orders are older than 210 newer newsletters, is tried on every one of its orders and counts its scope exactly; the Device's View of it lists them too. A bare domain in `from_any` fails validation and names `from_domain`. `subject_any: ["Order Confirmation"]` tries the two order confirmations of a shop (one written "Order   Confirmation"), older than every other Thread, and not its shipping notice. A first draft over everything tries 30 newsletters; revised to the order senders it tries the orders, not the newsletters again; revised once more it keeps the same Threads. Over everything, a View that adds up totals tries every order that holds an amount before any newsletter and says how many it passed over.
19. **Coverage.** On five order confirmations of one sender (one picked below its floor, one "none", one a shipping notice with no amount), `create_view`'s result says "a value on 2 of 5; none of the candidates on 1; below its confidence floor on 1; no candidates found on 1", the senders of the tried Threads and a few values; `inspect_view_thread` shows the candidates with Jev's share of each and why the scope admits the Thread, and for an untried newsletter shows why the scope refuses it, with no judge call.
20. **Many values.** An order confirmation bundling three orders adds its three order totals (not the item prices, not the grand total) to its month in one Signal request with a Noul per amount; pinned, a new confirmation's totals are read back whole through the values route. A Dependabot digest of three packages is three Rows of an item View, each with its own severity asked in the same request, charted by severity. A thread of three advisories is three Rows of a message View, charted on each Message's month.
21. **Reading a pinned View.** Pinned over eight archived receipts of the past year (five tried), the View asks no Thread at Pin view, then reads the other three, one per request, and ends "8 of 8" with every row's value readable and the receipt older than a year untouched; the feed carried the counts. A new version rewording the total asks only the total, of the Threads its own try did not reach. Pause holds its place, Resume finishes it, Stop ends it; a spent monthly budget stops it with the reason.
22. **The card's numbers.** On the orders try of criterion 19, the View card shows "Total: 2 of 5 read" with "1 none of these", "1 unsure" and "1 had no amounts", the pool line and the sender; the total, which the chart adds up, is marked as reading on fewer than half; clicking "1 had no amounts" lists the shipping notice (tried, not among the shown ones when more were tried) and "Show all" brings the shown rows back. A draft from before coverage renders without these lines.
23. **A search as a scope.** Three refunds months old and archived, whose subjects never say "refund", sit under twenty-five newer newsletters. A View scoped by the query `"refund approved" -cancelled` is tried on exactly those three (not on a newsletter, nor on the refund that was cancelled), counts 3 in scope ("at least 10" when a search matches more than `views.query.count_max`), and `inspect_view_thread` says "refund approved in a message's text"; a query with `is:unread` or `older_than:7d` fails validation with the reason and the retry fixes it. Pinned, the walk finds the three Members (the feed carries a reset and their ids, nothing from the mail; `GET /views/:id/members` lists them), asks each its questions and no newsletter. A new refund that arrives joins (one Job, one feed row), and a reply that cancels it takes it out; the Signal request asks the View's question of an arriving Member and not of a Thread the search refuses. A new query empties the Members and finds them again; locked, the walk waits with the reason "locked" and finishes after the unlock. On the Device the View lists its Members from the Cache, follows the feed's joins, leaves and reset, and opens offline with its nav count.
