# TypeSafe System One in monday: judgments without a language model

Research note, 21 September 2026. Sources: the TypeSafe docs (`docs.typesafe.ai`, read
live: System One, primitives, confidence, state, models, API, patterns, the Jev 1.13
jaggedness page and the cookbooks) and two experiments against `jev-latest`
(`jev-1.13.0`) on the design fixture's threads, run with the key in the repo's `.env`.

## What it is, in monday's terms

A System One model (Jev) takes a `state` (text or JSON) and a map of typed questions,
and answers every question in parallel with a calibrated probability distribution,
never with text. Three primitives:

| Primitive | Answer | monday reads it as |
| --- | --- | --- |
| Choice | one option plus a probability per option plus a confidence | a Group, an intent, a Section |
| Noul | the probability that a yes/no statement holds | needs a reply, is a newsletter, is a complaint |
| Score | a position on ordered levels you describe | urgency, how much a Brief would help |

It cannot write: no bullets, no replies, no rewritten Predicates. It is text only,
English strongest, 32k tokens of state per request, 1,200 requests a minute,
$0.042 per million input tokens, output free. Calibration is measured across groups
of answers, not per answer. The model is not fine-tuned per account; the state and
the criteria carry the domain, and its `confidence` is the signal for "not sure".

## What the experiments showed

Nine fixture threads, one request each, six questions per request (Group, needs a
reply, newsletter, Brief worth, first action, urgency). Nine requests in parallel:
1,007 ms wall clock, about 1,030 tokens each, so roughly $0.00004 per thread for all
six judgments. Results, `jev-1.13.0`:

| Thread | Group (confidence) | needs reply | newsletter | Brief worth (0 to 3) | urgency (0 to 3) |
| --- | --- | --- | --- | --- | --- |
| Aoife, take-home submitted | hiring (1.00) | 0.64 | 0.07 | 1.0 | 1.2 |
| Kenji, term sheet redline v3 | finance (1.00) | 0.58 | 0.07 | 1.9 | 1.8 |
| Ngozi, Design Engineer application | hiring (1.00) | 0.23 | 0.10 | 0.7 | 1.0 |
| Mateus, icon set round 2 | product (1.00) | 0.17 | 0.07 | 1.0 | 0.8 |
| Sofia, podcast invite | press (1.00) | 0.91 | 0.11 | 0.5 | 0.5 |
| Hetzner invoice | finance (1.00) | 0.03 | 0.78 | 0.0 | 0.5 |
| GitHub PR review request | product (0.75) | 0.38 | 0.84 | 0.3 | 1.4 |
| Bytes newsletter | none (0.84) | 0.07 | 0.92 | 0.4 | 0.2 |
| Linear weekly digest | product (0.39) | 0.07 | 0.93 | 0.0 | 1.0 |

Reading it: eight of nine Groups right with full confidence; the Linear digest lands
on `product` at 0.39, which is the answer monday wants (Needs a decision), because the
confidence is the second axis. Newsletter detection separates cleanly (0.78 to 0.93
against 0.07 to 0.11). Brief worth puts the term sheet at 1.9 and the invoice and the
digest at 0.0, which is the user's brief policy ("non important mail does not deserve
a Brief") as a judgment instead of a header rule.

Two misses were question design, not model failure, and the jaggedness page predicts
both: a Choice option "open a link and review something" was read literally and
swallowed the reply cases; "a person is waiting on owner to write back" undercounted
a job application. Re-asked as one Noul per action the same four threads came back
right (Aoife: reply 0.84, call 0.86; Ngozi: reply 0.88, attachment worth opening 0.74;
GitHub: review 0.84; Sofia: call 0.93).

Second experiment, typed sentences as typed intents (the function-calling pattern,
closed sets only, no generation):

| Typed | intent | person | day | hour | scope | age |
| --- | --- | --- | --- | --- | --- | --- |
| set up a call with Aoife Thursday 15:00 | schedule_event (1.00) | aoife (1.00) | thu | 15 | one | none |
| archive every newsletter older than a week | archive (1.00) | none | none | none | 0.32 | week |
| snooze this until tomorrow morning | snooze (1.00) | none | tomorrow | morning | one | none |
| move the term sheet thread to finance | move (1.00) | none | none | none | one | none |
| what did kenji say about the board seat | search (0.99) | kenji (0.99) | none | none | one | none |

The only weak answer is "many threads" at 0.32 for "every newsletter", the literal
reading again ("acts on many threads at once" versus "names a set of threads"); the
age limit came back `week` on the same sentence.

Third experiment, corrections as Examples in the state: a NixOS module thread routed
to `community` at 0.99 with no examples and 1.00 with two of the owner's past
decisions in the state, so Examples work as the spec means them to, without a
Predicate rewrite.

## The principle

**Judgments go to System One; generation and multi-step reasoning stay with the
language models.** Today monday has nine Tasks (ADR 0007). Four of them are
judgments dressed as prompts: `classify`, `route` (the scoring half), `section`,
`tag`. Two are policy decisions that today either use a header rule or a Haiku call
with JSON parsing: the brief policy and the Workflow condition. All of those become
typed questions. `composer`, `agentic-step`, `brief` (the bullets), `draft-in-voice`,
`summarize` and the Predicate revision stay with Sonnet or Haiku, but a judgment can
decide whether they run at all.

What monday gains beyond cost: every answer is a probability, so "Needs a decision"
stops being a threshold over a number the LLM made up in JSON and becomes the
model's own uncertainty; the same request can carry a dozen speculative questions
for the price of one; and answers are independent, so adding a question never
changes another's result (a Setting can add a question without a prompt rewrite).

## Changes, module by module

### 1. A `judge` seam beside `run` and `converse`

`HostedRuntime.judge(task, state, questions, options)` in
`apps/server/src/intelligence/runtime/`, with a `Judge` provider interface, a
TypeSafe adapter over `POST /v1/systemone` (fetch, retries on 429 and 503 with
backoff, the SDK is optional), a fake for tests that answers from a script, and a
Meter row per request (tokens in, cost from a pricing entry, output free). Key
storage follows `provider_keys`: a `typesafe` provider with its own share switch,
so the Server can judge on arrival while the laptop is closed. Settings:
`ai.judge.provider` (`typesafe` | `llm`, the latter keeps today's prompts as the
fallback), `ai.judge.model` (pinned to `jev-1.13.0`, since thresholds are tuned per
version), `ai.pricing.typesafe`. The AI level gates it like every other model call:
nothing runs at `off`.

### 2. Routing on Choice with confidence

`intelligence/routing/index.ts`: `stage()` asks one Choice per stage with the Groups
as options (name, sentence, criteria text) plus `none`, the Thread facts as state
and the Group's Examples inside the instructions as `examples`. The placement reads
`probabilities` and `confidence` directly: route above the Group's threshold on
probability, Needs a decision when confidence is below `routing.threshold.ask`,
two-stage sub-groups exactly as now. `parseClassifyOutput` and the JSON extraction
go away on this path. Corrections keep writing Examples; the `route` Task that
rewrites the Predicate text stays an LLM call, but it can be rarer, because
Examples alone already moved the answer.

### 3. One request per arrival: policy, Section, chips, urgency

`brief.ts` and `policy.ts`: the brief policy's `model` mode becomes a Score ("how
much would a three-bullet summary help") with levels the user can reword in
Settings; `always` when the score clears `briefs.judge.always_above`, `on_open`
in the middle, `never` below. The same request carries `needs_reply`,
`waiting_on_me`, `newsletter`, `automated`, one Noul per action chip (reply, call,
review link, open attachment, pay or file), and an urgency Score, so the Section
rules gain semantic conditions (`sections.rules[].when.judged`) and the reader's
chips exist before any Brief is written. Sender, subject, snippet, counts and list
headers are enough state; bodies are not sent for these questions.

### 4. The palette speaks the user's language without a Session

`apps/desktop/src/screens/Palette.tsx` and `search/`: a typed sentence goes to one
`judge` request with the intent Choice, a contact Choice over the address book
(255 options per Choice, so chunked by recency), weekday and hour Choices, age and
scope Nouls, then code builds the Intent. Confidence gates the action by tier
(ADR 0002): a read or reversible intent above 0.9 runs at once, a `leaves_mailbox`
intent always opens the composer's card, anything under 0.6 falls through to the
Agent. The composer stays for everything that needs a conversation.

### 5. Workflows: a semantic condition and a semantic trigger

`packages/shared/src/workflow/index.ts`: `condition.op` gains `judged` with a Noul
statement and a threshold ("the message is a complaint", "the sender is asking for
a refund"), and the arrival trigger gains `judge` beside `group` and `predicate`.
`workflows/index.ts` evaluates them through `judge` under the Run's Budget. Dry
runs report the probability per Thread so the user sees why a Run would start.

### 6. Guardrails on what reaches the Agent and the external MCP

`intelligence/agent/tools/`: before a Thread body enters a composer turn or an
agentic Step, one Noul asks whether the text carries an instruction aimed at an
assistant (the "classifying RAG passages" pattern); a hit marks the body and the
tool result says so, and the Agent's system prompt is told to treat it as quoted
text. External MCP calls (`external/`) get the same screen on arguments. Jev is
not adversarially robust by itself (its docs say so), so this is one layer under
the tiers and approvals, not a replacement for them.

### 7. Brief verification

After the LLM writes bullets, one Choice per bullet asks whether the Thread's text
supports it (`supported`, `partly`, `unsupported`, the citation-check cookbook).
Unsupported bullets are dropped before the Brief is stored; `partly` is shown
dimmed. This is the cheapest hallucination check available and costs one request.

### 8. Search re-ranking and the Today panel

`search`: the local FTS5 shortlist (say 30 hits) goes to one request with a Choice
over hit ids for "the hit that best answers `query`" plus a Noul per hit for
relevance, the re-ranking cookbook; the Cache still answers first (ADR 0011: search
never waits), the re-rank refines when it arrives. The Today panel orders by the
urgency Score already computed on arrival.

### 9. Onboarding proposals with fewer LLM calls

`propose_groups` scores candidate Groups over the last 30 days with one Choice per
Thread (the same routing question), so the move counts in the proposal list are
judged counts, not a second LLM pass.

### 10. Personalization, later

Jev's probabilities are features. With the user's corrections and opens as labels,
a small classical model per Workspace (the autoresearch cookbook) can learn what
this user calls important; monday keeps the raw judgments so weights can change
without re-asking.

## What stays with the language models

The composer and the agentic Step (tool use, multi-step), the Brief's bullets and
the action labels, replies in the user's voice, summaries, the Predicate rewrite
after a correction, and any question over long bodies where the 32k state limit or
the "large state full of irrelevant detail" edge bites. Jev decides whether those
calls happen and checks their output; it does not make them.

## Limits and how monday handles them

- **Literal reading.** Criteria must say the exact condition; one judgment per
  question; a Noul phrased so yes is high. Every question ships with a fixture test.
- **No arithmetic, no date comparison.** Weekday and hour are Choices over closed
  sets; code turns them into a time (`calendar.ts` already has the zone logic).
- **Adversarial text.** Bodies are untrusted; the guardrail is a layer, the tiers
  still ask.
- **Availability.** A 503 was observed once during the experiments; the adapter
  retries with backoff and falls back to the LLM path or the header rule, never to
  nothing. Routing waits for the Job's retry rather than guessing.
- **Privacy.** State leaves the mailbox, so TypeSafe is a provider like Anthropic:
  its key sits under the envelope, the share switch carries the same threat-model
  line, and the AI level cards say what is sent. Enterprise zero data retention
  exists; the default account is not trained on requests.
- **Language.** English is strongest; a Noul "the thread is not in English" can
  send those Threads to the LLM path.
- **Version drift.** `jev-latest` moves; monday pins `ai.judge.model` and the
  response's `model` field is stored on the Meter row.

## Suggested order

1. The `judge` seam, the TypeSafe provider, key and share switch, Meter, Settings,
   the fake, and an ADR ("judgments are typed questions; language models generate").
2. Routing on Choice with confidence, Examples in the state, Needs a decision from
   confidence; the fixture mailbox test rewritten for probabilities.
3. The arrival request: brief policy Score, Section judgments, chips, urgency, the
   Today panel ordering.
4. The palette's typed intents with confidence-gated tiers.
5. Workflow `judged` conditions and triggers, Dry run probabilities.
6. Guardrails and Brief verification.
7. Search re-ranking; personalization when there are labels to learn from.
