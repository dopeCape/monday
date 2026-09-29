---
status: proposed
---

# Judgments become standing Signals: one Thread per request, versioned questions, answers kept locally

ADR 0012 made decisions typed questions to Jev. Three features the user approved (Recommended actions, Boards, a composer that knows which Template fits) need the same kind of answer on thousands of Threads, and read it far more often than the mail changes. Today the answers are asked three ways: the arrival request per Thread (`thread_judgments`, fixed columns), a Noul per judged Section and custom action (`section_judgments`, keyed by the statement), and the Backlog sort, which packs up to 50 Threads into one state with one Choice each. We decided that every judgment monday keeps about a Thread is a **Signal**: a question with an id and a Question version, owned by whatever declared it (monday itself, a Section, a Custom action, a Board, the Interruption policy), whose answer is stored per Thread version in one table on the Server and mirrored into the Cache, so every list, Lane and chip is a SQL query over numbers and never waits on a model. Every Signal that applies to a Thread is asked in **one request whose state is that one Thread** (speculative fan-out), on arrival and in the background, and the Backlog sort moves to the same shape.

TypeSafe's own guidance drove the shape: accuracy falls as the state fills with material unrelated to the question (Jev 1.13 jaggedness, "large state full of irrelevant detail"), while many questions over one state cost almost nothing extra because the state dominates the tokens and questions are answered independently (the parallel-questions cookbook: 13 questions in one call, 12.2x cheaper, no change in answers). Fifty Threads in one state is the opposite trade: every question sees 49 Threads it is not about, to save a few cents per ten thousand Threads. The measurement in `docs/spec/signals.md` ("Measure first") runs before the switch and records the numbers; batching survives only for the Backlog sort's Group Choice, and only if it agrees with one-Thread requests at the threshold set there.

## Considered options

- Keep the three paths and add columns for new questions. Rejected: every new question is a migration, and a Board or an action cannot add one at run time.
- Ask each consumer's questions in its own request. Rejected: the state (the Thread) is most of every request, so three consumers pay for it three times, and the rate limit is counted in requests.
- Keep packing many Threads per request. Rejected unless the measurement says otherwise, for the accuracy reason above; the saving is cents.
- Compute answers on demand and cache them briefly. Rejected: a Board over 500 Threads would wait on 500 requests when opened, which breaks ADR 0011's rule that lists never wait.
- Embeddings for similarity instead of judged questions. Rejected: a second model and index, and no calibrated yes or no to threshold.

## Consequences

- A Signal's wording is a Setting when monday ships it (ADR 0004) and part of its owner's document otherwise (a Board, a Section rule, a Custom action). Changing the words raises the Question version; answers under an older version are stale. Lists may show stale answers until the backfill reaches them; nothing that acts (a Recommended action, a Workflow) reads a stale answer.
- A new or reworded Signal is backfilled newest first by a background Job within its scope and a monthly background budget, never all at once; new mail always gets every active Signal on arrival.
- Code owns everything exact: dates, counts, senders, amounts found by pattern, whether the owner wrote last. Jev picks among what code found (a date's parts, an amount among the candidate spans) and never invents a value.
- The Group Choice rides in the same request but stays routing's (`thread_routes`): placement moves mail and has its own rules (Predicates first, Examples, the ask band, user placements win).
- `thread_judgments` and `section_judgments` migrate into the Signal answers table and are dropped.
- Answers are probabilities, not mail content, so they sit in the clear like routes; the state that produced them still leaves the mailbox for TypeSafe exactly as ADR 0012 describes, behind the same share switch.
- The number of active Signals is bounded by a Setting, because every one is paid on every arriving Thread.
