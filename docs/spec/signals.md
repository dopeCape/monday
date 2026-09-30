# Signals

Behaviors a tester can check. Signal, Fact, Question version and Unsure are defined in `CONTEXT.md`; the decision is ADR 0014 on top of ADR 0012; every default below is a Setting (ADR 0004) and every word a `strings.signals.*` Setting. Recommended actions (`actions.md`), Templates (`templates.md`), Views (`boards.md`) and the smaller features (`signal-features.md`) all read what this page defines.

## Why

Today one Thread can be sent to Jev three times: the arrival request (`judgments.ts`, fixed columns in `thread_judgments`), a Noul per judged Section or custom action (`organize.ts`, `section_judgments`), and the Backlog sort, which packs up to 50 Threads into one state (`routing/batch.ts`). Each new question is a migration. Signals make every kept judgment one row shape, asked in one request per Thread, and read locally.

## Measure first (slice 28)

Before anything switches, the lead measures batched against one-Thread requests on the user's own mail. Nothing here changes product behavior.

**The harness.**
- `POST /intelligence/eval/batching` on the Sidecar only (loopback, Device token), refused unless the Setting `ai.judge.eval_enabled` is on (default off, advanced). It samples, asks, compares and returns numbers and Thread ids only, never subjects or text. Every request is metered as `judge.eval`.
- `bun apps/server/scripts/judge-batching-eval.ts --server <url> --token <device token> --workspace <id> [--sample 300] [--seed 7] [--out batching-report.md]` calls it and writes the report. `--fake` runs against the fake judge so the script and the report format are tested in CI.
- The lead runs it against the live Sidecar with the user's TypeSafe key. An agent building slice 28 never runs it live.

**The sample.** 300 Threads with at least one Message body in the Cache, seeded: the newest 100, 100 drawn at random from the last 3 months, 100 at random from older mail inside `routing.backfill.scope`. The user's labelled Threads are added on top: every Thread the user placed or corrected (`thread_routes.by = user`, the Groups' Examples, answered Needs a decision rows), up to 200.

**The questions.** Exactly what batching would carry: the stage-one Group Choice (the Groups and Examples as the Backlog sort sends them today), and the four arrival Nouls (`needs_reply`, `waiting_on_others`, `newsletter`, `automated`) plus the urgency Score, worded as the Settings hold them now.

**The arms.**

| Arm | One request holds | Repeats |
|---|---|---|
| Single | one Thread, all its questions | 2 |
| Batch 10 | 10 Threads, one question set per Thread, packed as `packBatches` packs today | 2 |
| Batch 50 | 50 Threads, the same packing (today's default) | 2 |

**What the report says**, per arm against Single's first repeat:
- Placement agreement: same outcome after the thresholds (routed to the same Group, sent to Needs a decision, or left), in percent, with the Threads that differ listed by id.
- The noise floor: Single's repeat 1 against its repeat 2. Batching is judged against this, not against 100%.
- Accuracy on the labelled Threads, per arm, with the count.
- Mean Group confidence and the share sent to Needs a decision.
- Noul decisions at 0.7: agreement in percent; mean absolute difference of the probabilities.
- Urgency: mean absolute difference of the Score.
- Tokens and cost per Thread, and wall time per 100 Threads, per arm.

**The bar.** Batching is kept for the Backlog sort's Group Choice only if every one of these holds for the batch size proposed:
1. Placement agreement with Single is at least the noise floor minus 1 point, and at least 97% absolute.
2. On the labelled Threads (at least 30 of them, else the result is inconclusive and batching is not kept), accuracy is at least Single's minus 1 point.
3. Mean Group confidence is at most 0.03 lower, and the Needs a decision share at most 2 points higher.
4. Noul decisions at 0.7 agree at least 97%.

Why these numbers: one point on a 10,000 Thread backlog is 100 Threads in the wrong Group, about the number a user notices and has to fix by hand. Jev is highly consistent (the parallel-questions cookbook measured repeat answers with no spread at all), so the noise floor should sit near 100% and anything worse than 97% is batching's doing. And the saving is small: at about 5,000 tokens a Thread a one-Thread request costs about $0.0002, so batching can save at most a few dollars over a very large mailbox. Ties go to one Thread per request.

**The switch** (slice 29), whatever the report says for Signals: the Backlog sort asks one Thread per request through the Signal request below, carrying the Group Choice and any Signal the Thread lacks. If the bar was met, `routing.backfill.batch_size` stays for the Group Choice alone and its help says what was measured; if not, the Setting, `packBatches` and the batch state shape are removed, and a Config file that still sets the key gets the ordinary unknown-key warning (ADR 0001). `routing.backfill.llm_batch_size` (the language model path) is not affected. The report is committed under `docs/research/judge-batching.md` with the date and the model version.

## What a Signal is

```ts
type SignalKind = "noul" | "choice" | "score";

interface SignalDef {
  id: string;                  // "needs_reply", "section:invoices-owed", "action:forward.fits", "board:<viewId>:severity"
  owner: { kind: "shipped" | "section" | "custom_action" | "recommended_action" | "view" | "interruption"; id: string | null };
  kind: SignalKind;
  question: NoulQuestion | ChoiceQuestion | ScoreQuestion;   // exactly as sent (packages/shared/src/judge.ts)
  version: number;             // the Question version
  hash: string;                // sha-256 of the canonical question JSON; a new hash is a new version
  scope: SignalScope;          // which Threads carry it
  gate?: FactGate;             // ask only when code says it can apply (candidates found, an Invite present)
  options?: { from: "amounts" | "addresses" | "links" | "tracking" | "workflows" }; // per-Thread options built by code
  consumers: string[];         // who reads it; the Signal is active while this is not empty
}

interface SignalScope {
  window: SortScope;           // "last 3 months" by default; "arrival only" for the Interruption policy
  facts?: FactFilter;          // a View's exact filters: senders, domains, received today, in the Inbox
}

interface SignalAnswer {
  threadId: string;
  signalId: string;
  version: number;
  model: string;               // "jev-1.13.0"
  judgedAt: string;
  threadVersion: { messageCount: number; latestMessageId: string };
  noul?: number;               // probability of yes
  choice?: string;             // the picked option; for per-Thread options, the verbatim span
  score?: number;              // expectation over the levels, 0 to levels - 1
  probabilities?: Record<string, number>;  // Choice options or Score levels
  confidence?: number;         // Choice and Score only; Nouls carry none
  lowTrust?: "not_english" | "image_only" | "hidden_instructions";
}
```

- Two owners asking the same question (the same hash) share one Signal and its answers.
- A Signal is **active** while it has a consumer and its owner is enabled. Deleting a View or a Section removes its consumer; the answers stay `signals.keep_inactive_days` so an Undo brings them back without asking again, then a sweep deletes them.
- Per-Thread options (an amount, an address, a link) are built by code for each Thread; the question's wording is versioned, the options are not, and the answer keeps the picked span verbatim.

## The shipped Signals

Shipped Signals' words are Settings (`signals.questions.*`; the existing `judgments.questions.*` keys keep their names). Each is written below exactly as sent. The state is the Thread (below); `owner` in the state is the mailbox owner.

**needs_reply** (Noul; existing, criteria added)
```json
{ "type": "noul",
  "instructions": "A person wrote the newest message to the mailbox owner and expects the owner to write back.",
  "criteria": {
    "true": "The newest message is from someone other than the owner and asks a question, makes a request, or proposes something the owner is expected to answer in writing.",
    "false": "The owner wrote the newest message, or it is a notification, receipt, newsletter or note that expects no answer." } }
```

**waiting_on_me** (Noul; new)
```json
{ "type": "noul",
  "instructions": "Someone on the thread is waiting for the mailbox owner to do something: answer, decide, approve, sign, pay, send a file or take an action they asked for.",
  "criteria": {
    "true": "A message from someone other than the owner asks the owner for an action or a decision, and no later message shows it done.",
    "false": "Nobody asks the owner for anything, or a later message shows the owner already did it." } }
```

**waiting_on_others** (Noul; existing wording): "The mailbox owner wrote the newest message and is waiting for someone else on the thread to answer."

**newsletter**, **automated** (Nouls; existing wording, unchanged).

**personal** (Noul; new: "written by a human")
```json
{ "type": "noul",
  "instructions": "A person typed the newest message and wrote it to the mailbox owner, alone or in a small group.",
  "criteria": {
    "true": "A named person wrote it for these recipients: a colleague, client, friend, candidate or supplier writing in their own words.",
    "false": "A system, a template or a mass mailing sent it: notifications, receipts, newsletters, marketing, alerts, automatic replies." } }
```

**has_deadline** (Noul; new)
```json
{ "type": "noul",
  "instructions": "The thread gives a date or time by which the mailbox owner has to do something: reply, pay, sign, attend, deliver or decide.",
  "criteria": {
    "true": "A date, weekday or time is attached to something the owner must do, such as 'by Friday', 'due 3 October', 'before the 5pm call'.",
    "false": "No date is attached to anything the owner must do. Dates that only describe the past, someone else's plans, or a newsletter's contents do not count." } }
```

Its date is read in parts, speculatively in the same request (the date-extraction cookbook), and code assembles it. Each part is a Choice with an explicit "not stated" option; code reads only the parts `deadline_form` calls for:

```json
{ "deadline_form":    { "type": "choice", "instructions": "How is the date the owner has to act by written?",
                        "criteria": { "absolute": "A calendar date naming a month, such as '3 October' or '10/03'.",
                                      "relative": "Relative to when it was written, such as 'tomorrow', 'Friday', 'next week', 'end of the month'.",
                                      "none": "The thread states no such date." } },
  "deadline_month":   { "type": "choice", "instructions": "If that date names a month, which one?",
                        "criteria": { "january": null, "...": null, "december": null, "none": "No month is stated." } },
  "deadline_day":     { "type": "choice", "instructions": "If that date names a day of the month, which day (1 to 31)?",
                        "criteria": { "1": null, "...": null, "31": null, "none": "No day of the month is stated." } },
  "deadline_year":    { "type": "choice", "instructions": "If that date names a year, which one?",
                        "criteria": { "2026": null, "2027": null, "none": "No year is stated.", "other": "A year other than these is stated." } },
  "deadline_anchor":  { "type": "choice", "instructions": "If that date is relative, what is it relative to?",
                        "criteria": { "today": null, "tomorrow": null, "weekday": "A named day of the week.",
                                      "end_of_week": null, "next_week": "Some time next week, no day named.",
                                      "end_of_month": null, "none": "It is not relative." } },
  "deadline_weekday": { "type": "choice", "instructions": "If that date names a day of the week, which one?",
                        "criteria": { "monday": null, "...": null, "sunday": null, "none": "No weekday is named." } },
  "deadline_week":    { "type": "choice", "instructions": "If that date names a weekday, which week is meant?",
                        "criteria": { "this": "This week, or the next such day.", "next": "The week after this one, as in 'next Thursday' said to mean the following week.", "none": "No weekday is named." } },
  "deadline_hour":    { "type": "choice", "instructions": "If that date names a time of day, in which hour of the day does it fall, on a 24-hour clock?",
                        "criteria": { "0": null, "...": null, "23": null, "none": "No time of day is stated." } } }
```

The year options are the current and next year, built by code. Code turns the parts into the Fact `deadline_at` in the Workspace's zone, counting relative dates from the date of the Message that states them (not from today); the lowest confidence among the parts it used is the date's confidence. Below `signals.deadline.min_confidence`, or when the parts do not make a date (31 February, `other` year), `deadline_at` stays empty and the Fact `deadline_unclear` is true. The model never compares dates.

**money_involved** (Noul; new) with its amount and direction:
```json
{ "money_involved": { "type": "noul",
    "instructions": "The thread is about money the mailbox owner pays, is owed, or is asked to approve: an invoice, bill, quote, refund, payment request, charge or salary.",
    "criteria": { "true": "An amount or a payment is the subject of at least one message.",
                  "false": "Money is only mentioned in passing, in a signature, an advertisement or a newsletter." } },
  "money_amount": { "type": "choice",
    "instructions": "Which of these amounts is the one the mailbox owner is asked to pay, is owed, or was charged on this thread?",
    "criteria": { "$1,315.50": null, "$89.00": null, "none": "None of these amounts is what the owner pays, is owed or was charged." } },
  "money_direction": { "type": "choice",
    "instructions": "Which way does the money on this thread move?",
    "criteria": { "owner_pays": "The owner is asked to pay, or will be charged.",
                  "owner_is_paid": "Someone owes the owner, or will pay them.",
                  "already_settled": "It is a receipt or confirmation of a payment already made.",
                  "unclear": "The thread does not say." } } }
```
`money_amount`'s options are the spans a pattern found (currency symbols and codes, amounts with separators), deduplicated, verbatim, at most `signals.candidates.max` (default 12), plus `none`; the gate asks it only when at least one was found. Code parses the picked span into a number and a currency; Jev never reads a number back.

**frustrated** (Score; new)
```json
{ "type": "score",
  "instructions": "How frustrated is the newest message written by someone other than the mailbox owner?",
  "criteria": [
    "Calm or friendly: no complaint.",
    "Mildly impatient: a reminder, a second ask, or a small complaint stated politely.",
    "Clearly frustrated: repeats a complaint, calls something unacceptable, or sets a demand.",
    "Angry: threatens to cancel, leave, escalate or take legal action, or uses hostile words." ] }
```

**owner_promised** and **they_promised** (Nouls; new: "a promise was made", split by who promised because one Noul cannot say which)
```json
{ "owner_promised": { "type": "noul",
    "instructions": "In one of their messages on this thread, the mailbox owner committed to do something for someone (send, reply, pay, deliver, call, decide), and no later message shows it done." },
  "they_promised": { "type": "noul",
    "instructions": "Someone other than the mailbox owner committed on this thread to do something for the owner (send, reply, pay, deliver, call, decide), and no later message shows it done." } }
```

**urgency** and **brief_worth** (Scores; existing wording and levels, unchanged).

**hidden_instructions** (Noul; the guard's statement, `guard.question`, asked on arrival: `signal-features.md`, "Screening on arrival").

The Recommended actions add their own shipped Signals (`actions.md`).

## Facts

Computed by code on the Server when a Thread version is stored, mirrored to the Cache with the Thread row, and never sent to a model as a question:

| Fact | From |
|---|---|
| `received_at`, `last_activity_at`, age buckets (today, this week) | Message dates in the Workspace's zone |
| `message_count`, `participant_count`, `attachment_count` | the Thread |
| `from_address`, `from_domain`, `to_me_directly` (owner in To, not only Cc or a list) | headers |
| `owner_wrote_last`, `owner_ever_wrote` | the owner's address |
| `known_sender` (the owner has written to them before), `sender_threads`, `owner_replied_share`, `owner_archived_unread_share`, `owner_forwarded_to` (addresses) | Sent mail and the owner's past actions |
| `list_id`, `list_unsubscribe` (mailto, https, one-click), `precedence_bulk` | headers |
| `has_invite`, `invite_answered`, `invite_clashes` (the owner is busy then) | Invites and the calendar |
| `amounts`, `addresses`, `links` (text, domain), `tracking_numbers` (carrier patterns) | patterns over the text, the candidates above |
| `deadline_at`, `deadline_unclear` | code over `deadline_*` answers |
| `language` (`en` or other), `image_only` (no text beyond a few words, images attached or inline) | a script and stop-word check |

## The Signal request

**One Thread, every Signal that applies, one request.** On arrival (the existing `judge` Job, one per Thread version) and in the background (the backfill below), the Server builds one state for the Thread and asks every active Signal whose scope and gate hold for it, plus, when routing applies, the Group Choice. Questions are answered independently, so a Signal added later never changes another's answer.

The state (code builds it; nothing else goes in):
```json
{ "owner": { "name": "Sam Okafor", "address": "sam@monday.test" },
  "thread": {
    "subject": "Invoice INV-2291 for September",
    "message_count": 3,
    "owner_wrote_last": false,
    "attachment_names": ["INV-2291.pdf"],
    "list_headers": {},
    "newest_message": {
      "from": { "name": "Hetzner Billing", "email": "billing@hetzner.com" },
      "to": [{ "name": "Sam Okafor", "email": "sam@monday.test" }], "cc": [],
      "written": "Tuesday 29 September 2026",
      "text": "Dear customer, your invoice INV-2291 over $1,315.50 is due on 3 October ..." },
    "earlier_messages": [
      { "from": { "name": "Sam Okafor", "email": "sam@monday.test" }, "written": "Monday 28 September 2026",
        "text": "Thanks, I'll pay it this week." } ] },
  "sender_history": { "threads_from_sender": 14, "owner_replied": 1, "owner_archived_unread": 11, "owner_forwarded_to": ["accounts@monday.test"] } }
```
- `newest_message.text` is the newest Message's plain text with quoted history and signatures removed by code, up to `signals.state.newest_chars`; `earlier_messages` fill the rest of `signals.state.thread_chars`, newest first, each cut to `signals.state.earlier_chars`. Attachment text is not sent (names only).
- `written` is a date in words so the model can read "tomorrow" in context; it never computes with it.
- `sender_history` is Facts, in words and counts code computed, so action Signals see what the owner usually does with this sender.
- The Group Choice rides as today (Groups as options, Examples in its instructions). Sub-group Choices ride speculatively, one per Group that has Sub-groups; code reads only the one under the Group chosen (the fan-out pattern), so a two-stage placement is one request.
- The request is cut to fit Jev's budgets (64,000 tokens for everything, 32,000 for the state plus the longest question). If the questions would not fit, they go in a second request over the same state, still one Thread; the Signal request never mixes Threads.
- Typical size: 2,000 to 3,000 tokens of state and 30 to 40 questions, about 5,000 tokens, about $0.0002 per Thread at $0.042 per million.

**Which Signals a Thread gets.** Every shipped Signal on every Thread in scope; a Section's, Custom action's or View's Signal only on Threads its scope's Facts admit (a View about today's support mail asks only about today's mail to support); gated Signals only when their gate holds (`money_amount` needs an amount, `rsvp` needs an Invite). Code decides; the model is never asked whether a question applies.

**Without TypeSafe.** `signals.llm_fallback` decides: `shipped_sections` (default) asks the language model only the Signals the shipped Sections read, as the arrival path does today; `all` asks every Signal through the prompt path, one Thread per prompt, with a line on the Signals page saying it is slow and costs more; `none` asks nothing. View and action Signals without an answer show as not read yet.

## Where answers live

- Server: `signal_defs` (workspace, signal id, owner kind and id, kind, question JSON, hash, version, scope, gate, active, created and retired times) and `signal_versions` (signal id, version, hash, question, created) so an old answer can be explained; `signal_answers` (workspace, thread, signal, version, model, judged at, the Thread version, noul, choice, score, probabilities, confidence, low trust), primary key (thread, signal). In the clear, like `thread_routes`: numbers and verbatim spans the user already has, never a body. A picked span (an amount, an address) is short and comes from the Thread; it is sealed under the Workspace key like other body-derived columns (ADR 0009 `store_content`).
- The Changes feed carries a `signals` change per Thread with the answers that changed; one change per Signal request, not per answer.
- The Cache mirrors `thread_signals` (thread, signal, version, noul, choice, score, confidence, stale, low trust) and `signal_defs`, indexed by (signal, noul) and (signal, score), so a Section, a Lane or a chip row is one SQL query (ADR 0011: nothing waits).
- Migration: `thread_judgments` rows become answers for the shipped Signals at version 1; `section_judgments` rows become answers for `section:<id>` and `action:<id>` Signals at the version their statement had; both tables are dropped after the copy.

## Versions and staleness

- Rewording a Signal (a Setting, a Section's statement, a View edit) makes a new hash and a new Question version. A new `ai.judge.model` counts the same way for every Signal: answers from the old model are stale.
- **Lists may show a stale answer; nothing that acts reads one.** Sections, Views and the nav read the newest answer whatever its version (marked stale in the Signals page and in Explain) while `signals.stale_answers` is `show` (default), so a reworded shipped question does not empty the Inbox's Sections for an afternoon. Recommended actions, Workflow conditions, the Interruption policy and anything the Agent acts on read only answers of the current version and the current Thread version.
- The same Thread version is never asked the same Question version twice. A new Message makes a new Thread version and the whole request is asked again on arrival.

## Backfill

- When a Signal is created or gets a new version, or the model changes, a `signals-backfill` Job (ADR 0005) walks the Signal's scope newest first and asks each Thread only the Signals it lacks at their current version, one Thread per request. One walk per Workspace, kept in `signal_backfills` (the same cursor shape as `routing_backlogs`: top, cursor, done, total, calls, status, reason), so a restart resumes; a second change while one runs widens the running walk instead of starting another.
- A running Backlog sort carries missing Signals in the same requests, so the two never ask one Thread twice.
- Above `signals.backfill.confirm_above` Threads, the Agent's card or the Signals page asks first with the count and an estimate from the recent average tokens per Thread ("About 5,400 threads, about $1.10 at TypeSafe's price. Read them now?"). Smaller backfills just run.
- Progress shows where the change was made (the View's test card, the Section's card, the Signals page): "Reading your mail for Support today: 120 of 480".

## Budget and rate

- **Rate.** Every judge request from one Server passes one limiter: at most `signals.rate.requests_per_minute` (default 1,100, a little under Jev 1.13's published 1,200 because TypeSafe says its limits move while it scales) and `signals.backfill.concurrency` requests in flight for background work (default 16: a request takes about half a second, so 16 in flight reach the rate). Arrival requests go first, background leaves `signals.rate.arrival_reserve_per_minute` (default 100) of every minute to arrival and is spread across the minute instead of spent in a burst. Many Threads are asked through one worker pool, each Thread its own request, the next one starting as soon as any answers (never in lock-step rounds; `docs/research/judge-parallelism.md`). A 429 honours `retry-after`, halves background concurrency for `signals.rate.cooldown_seconds`, then grows it back one at a time. With a Cloud and a Sidecar both running, each limits itself; background walks are one per Workspace, so they do not double.
- **Money.** `signals.budget.background_monthly_usd` (default 3.00) caps what background walks (Signal backfills, the Backlog sort, View tests beyond their sample) may spend on `judge.*` in a calendar month, from the Meter's estimates. Reaching it pauses the walks with the reason shown ("Paused: this month's background reading budget of $3.00 is spent."), with Raise and Resume next month. Arrival requests are never capped: they are the product working, about $0.0002 a Thread.

## Unsure, flicker and Jev's limits

- **The Unsure band.** A Noul holds at or above its high threshold and fails below its low one; between them it is Unsure. Defaults `signals.unsure.noul_low` 0.3 and `signals.unsure.noul_high` 0.7; a consumer may set its own (a Section's `judge_threshold`, a Lane's condition). A Choice or Score answer under `signals.unsure.confidence_below` (0.5) is Unsure whatever it picked. Unsure is shown as Unsure: a View's Unsure Lane, no chip, a Section that does not claim the Thread.
- **Flicker.** Answers are consistent for the same state, but a new Message changes the state and a probability near a threshold can cross it back and forth. Sections and Lanes use hysteresis: a Thread that is in leaves only when its new answer is past the threshold by `signals.hysteresis` (0.05), and the other way round.
- **Literal reading.** Every shipped question states the exact condition and its boundary in `criteria`; one judgment per question; a reworded question is tested with the Agent's tune tools on the newest 50 matching Threads before it is saved (`tune.ts`).
- **Yes-bias and base rates.** The Signals page shows, for each Signal, how often it held over the last `signals.stats.window` (500) Threads. A Signal that holds on most of the mailbox, or on none, is flagged ("Holds on 91% of your mail. Its question may be too broad."). Questions are phrased so yes is the rare, interesting case.
- **Dates, counts, maths.** Never asked: code owns them (Facts). Jev picks date parts and spans.
- **Adversarial content.** Mail can argue for its own answer ("URGENT, reply now"). A Signal never authorises anything: every action it proposes is a Tool call with its Tier (ADR 0002). A Thread whose `hidden_instructions` holds is marked `lowTrust`, and its action Signals are treated as Unsure.
- **Text only, English first.** A Thread whose `language` Fact is not English is marked `lowTrust: not_english` and its answers count as Unsure for acting while `signals.non_english` is `unsure` (default); `trust` uses them as they are. An image-only Thread is `lowTrust: image_only` the same way.
- **Early access.** Rate limits change without notice; the limiter above and the arrival-first order are the answer, and a 503 keeps the Job's retry, never a guess.

## Sections, Groups and Custom actions

- **Sections are Signal consumers.** A shipped Section rule's judged bounds (`needs_reply_at_least` and the rest) read the shipped Signals by name; a general form `when.signals: [{ signal, at_least?, at_most?, is? }]` replaces the fixed keys, which stay as aliases. A user Section's `judge` statement is a Signal owned by the Section (`section:<id>`), a Noul with that statement and the Section's Examples in its instructions, as `organize.ts` asks it today.
- **Waiting on you reads `waiting_on_me`.** Today the shipped rule pairs "someone else wrote last" with the `waiting_on_others` Judgment, whose question says the owner wrote last; once a Thread is judged, the two can hardly both hold. The rule becomes `lastFrom: others` and `waiting_on_me` at least 0.7, with `automated` at most 0.4.
- **Groups stay routing's.** The Group Choice rides in the Signal request but is not a Signal: its options change with every Group, and its answer moves mail under routing's own rules (Predicates first, Examples, the ask band, the user's placements win). Its result stays in `thread_routes`.
- **Custom actions** with an `on.judge` statement are Signals owned by the action (`action:<id>`), exactly like a Section's.

## The Signals page

Settings › AI and agent › Signals (and the Agent's `list_judgments`, `explain_thread`, `test_judgment` tools, which already exist in `tune.ts` and gain Signals):
- One row per active Signal: its question in words, who uses it ("Needs your reply, Recommended action: reply"), its kind, version, how many Threads carry a current answer ("4,210 of 5,400 read"), how often it holds, and the stale count while a backfill runs.
- A shipped Signal's row edits its Setting; any other row says where it is edited ("Edit on the View").
- Explain on a Thread (reader overflow menu, "Why these?") lists its Signals with probability, confidence, version and when asked.

## Settings

| Key | Default | Why |
|---|---|---|
| `signals.enabled` | on | The whole feature; off keeps today's arrival Judgments only |
| `judgments.on_arrival` | on | Existing key; now governs the Signal request on arrival |
| `signals.questions.*` | as written above | Every shipped question is the user's to reword (ADR 0012) |
| `signals.backfill.scope` | `last 3 months` | Same as the Backlog sort; older mail stays not read until asked |
| `signals.backfill.concurrency` | 16 | Requests in flight for background reading and any task that reads many Threads; enough to reach the rate at about half a second a request |
| `signals.backfill.confirm_above` | 2,000 | Above this a backfill asks first with its estimate |
| `signals.rate.requests_per_minute` | 1,100 | Just under the published 1,200, which TypeSafe says can move |
| `signals.rate.arrival_reserve_per_minute` | 100 | Background never takes these, so arrival is never queued behind a backfill |
| `signals.rate.cooldown_seconds` | 60 | How long background work stays slowed after a 429 |
| `signals.budget.background_monthly_usd` | 3.00 | About 15,000 Threads of background reading a month |
| `signals.state.newest_chars` | 4,000 | The newest Message, where most answers live |
| `signals.state.thread_chars` | 8,000 | The whole state's text, to stay well under 32k tokens |
| `signals.state.earlier_chars` | 600 | Each earlier Message |
| `signals.candidates.max` | 12 | Options per span Choice; more candidates dilute the pick |
| `signals.deadline.min_confidence` | 0.6 | Below it the date is shown as unclear, not guessed |
| `signals.unsure.noul_low` / `noul_high` | 0.3 / 0.7 | The Unsure band for Nouls |
| `signals.unsure.confidence_below` | 0.5 | The Unsure floor for Choices and Scores |
| `signals.hysteresis` | 0.05 | Keeps Sections and Lanes from flickering |
| `signals.stale_answers` | `show` | Lists keep old answers until re-read; `hide` treats them as not read |
| `signals.non_english` | `unsure` | Jev is English-first |
| `signals.max_active` | 64 | Every active Signal is paid on every arrival |
| `signals.keep_inactive_days` | 30 | Undo of a deleted View or Section costs nothing |
| `signals.llm_fallback` | `shipped_sections` | Without TypeSafe, keep the Sections working and nothing else |
| `signals.stats.window` | 500 | Threads the page's base rates are measured over |
| `ai.judge.eval_enabled` | off | The batching harness endpoint (advanced) |

## Strings (examples)

- `strings.signals.reading`: "Reading your mail: 1,200 of 5,400 threads"
- `strings.signals.not_read`: "Not read yet"
- `strings.signals.unsure`: "Unsure"
- `strings.signals.stale`: "Read with an earlier wording"
- `strings.signals.confirm_backfill`: "About {count} threads, about {cost} at TypeSafe's price. Read them now?"
- `strings.signals.budget_paused`: "Paused: this month's background reading budget of {budget} is spent."
- `strings.signals.non_english`: "monday reads English best, so this thread's answers count as unsure."
- `strings.signals.too_broad`: "Holds on {share} of your mail. Its question may be too broad."
- `strings.signals.needs_typesafe`: "Reading your mail this way needs a TypeSafe key."

## Edge cases

- A Thread folds into another (a Provider merge): its answers are dropped and the merged Thread is asked as a new version.
- A Thread leaves the scope (it ages past the window): its answers stay; nothing asks it again unless it changes.
- The user places a Thread by hand: its answers are unchanged; the placement wins where it applies (routing), and a Section or Lane correction becomes an Example for that Signal.
- The root key is locked (a Cloud without it): the Signal request cannot read bodies and waits, like Briefs.
- A Signal's owner is paused by the AI level: its Signal stays active but nothing asks it below `automate`; answers already stored still read.
- `signals.max_active` reached: creating a View or Section with a new Signal is refused with the count and the Signals page link, before anything is saved.
- A candidate list is empty: the gated Choice is not asked, and its consumer (an amount on a chip) is simply absent.
- The same Signal wording from two owners: one Signal; deleting one owner keeps it for the other.

## Code, Jev, language model

| Code | Jev | Language model |
|---|---|---|
| Facts; candidate spans; date assembly and every comparison; scopes, gates, thresholds, hysteresis; the limiter and budget; which questions go in a request | Every Signal: Nouls, Choices over closed sets and over candidates, Scores; the Group Choice | Nothing in the Signal request. It writes View questions, Templates and Briefs elsewhere, and answers Signals only as the fallback path |

## Acceptance criteria

1. The harness runs with `--fake` in CI and writes a report with every table above; the live report is committed with its date and model.
2. After slice 29, a Backlog sort over the fixture mailbox makes one request per Thread, each carrying the Group Choice and every shipped Signal, and places the same Threads as before.
3. A new Message on a judged Thread triggers exactly one Signal request; the same Thread version is never asked twice.
4. Rewording `signals.questions.frustrated` raises its version, starts one backfill of the scope, lists keep showing the old answers marked stale, and no Recommended action reads them.
5. The Store answers "Threads with money_involved at least 0.7 and deadline_at before Friday" from SQLite with the network off.
6. With a 429 injected by the fake judge, arrival requests still go out first and background concurrency halves then recovers.
7. With the background budget spent, the backfill pauses with the reason and arrival requests continue.
8. A French Thread's answers are stored and count as Unsure for acting while `signals.non_english` is `unsure`.
9. The Waiting on you Section holds a fixture Thread where a client asked the owner to sign a contract and the owner has not answered.
10. `thread_judgments` and `section_judgments` are gone after migration and every Section shows the same Threads as before on the fixture mailbox.
