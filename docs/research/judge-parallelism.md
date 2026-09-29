# Judge parallelism: many one-Thread requests at once

2026-09-29. Batching several Threads into one TypeSafe request was measured and rejected (`judge-batching.md`): each Jev request stays **one Thread**, and `routing.backfill.batch_size` stays 1. What was slow was how those one-Thread requests were issued: one after another, or in lock-step chunks that waited for the slowest request before starting the next chunk. This note records the change to a continuous worker pool.

## What TypeSafe says

- Jev 1.13 limits (https://docs.typesafe.ai/models.md): **1,200 requests per minute and 250,000 tokens per second**. A request over either gets `429 Too Many Requests`. The page adds that the limits "are adjusting dynamically" and "can change without notice".
- The API (https://docs.typesafe.ai/api.md): on `429` or `529 Overloaded`, retry with exponential backoff, honouring `retry-after`.
- The cookbooks run one request per item concurrently (`ThreadPoolExecutor(max_workers=12)` in the re-ranking cookbook), and the Python SDK suggests HTTP/2 when sending many concurrent requests.
- Independent questions over the **same** state belong in one request: Jev evaluates them in parallel (the typesafe-ai skill; the parallel questions cookbook). monday already does this. The Signal request asks all of a Thread's questions at once, and the Backlog sort's Group Choice rides in it.

What the numbers mean: `judge-batching.md` measured one-Thread requests at 9.96 s per 100 Threads with 4 in flight, so about 0.4 s a request. At 1,200 a minute (20 a second) that takes about 8 requests in flight. Tokens are not the limit: at about 1,400 tokens a Thread, 20 requests a second is 28,000 tokens a second, about a ninth of 250,000. **The request rate is the ceiling**, and the old defaults (600 a minute, 4 in flight) held monday to half of it.

## Before and after

| | Before | After |
|---|---|---|
| Signal backfill (`signals/backfill.ts`) | Page of 4 x concurrency Threads, pool inside the page, then wait for the whole page before fetching the next | `streamPool`: pages read ahead, `concurrency` requests in flight all the time, pages written back in order (the cursor never passes a Thread in flight), the step goes on while half its budget is left |
| Backlog sort, one Thread per request (`routing/backlog.ts`) | A round of `concurrency` Threads through `routeMany`, which waited for all of them; then the next round | `streamPool` over the walk (and the catch-up pass), one `routeMany` per Thread, pages written back in order. Batched sizes above 1 and the language model path keep their rounds |
| `routing/index.ts` `judgeEach`, batched stage, re-run | Private `inPool` copies | The shared `eachPool` |
| Board test (`boards/test.ts`) | `inBatches`: chunks of `concurrency` in lock-step | `eachPool` |
| Batching measurement (`measure/batching.ts`) | Private `inPool` copy | `eachPool` |
| Judged Sections (`organize.ts`) | One Thread at a time | `eachPool`, `signals.backfill.concurrency` at once |
| Tuning tests (`tune.ts`): routing, arrival and Section questions | One Thread at a time; the current and the proposed wording asked one after the other | Threads through `mapPool`; the two wordings in flight at once (still one request per wording, as the tune tests specify) |
| Workflow Dry run (`workflows/index.ts`) | The judged trigger sample and the Dry run of each Thread one at a time | `mapPool` with a stop once the sample has enough; results read back in order, so the sample is the same Threads as before |
| Signal request split in parts (`signals/index.ts`) | A Thread whose questions outgrow one request asked its parts one after the other | All parts in flight at once (same state, same Thread) |

Everything else that reaches the judge asks once per user action (the guard, Brief verification, intents, meetings, templates, workflow conditions on one Thread) or depends on an earlier answer (template suggestion and duplicate checks ask a second request built from the first), so it stays as it was.

### The pool (`apps/server/src/intelligence/signals/pool.ts`)

- `mapPool(items, concurrency, work, { stop })`: up to `concurrency` in flight; as one finishes the next starts. Results in input order, each `done`, `failed` (its own error) or `skipped` (after `stop`). `eachPool` is the same, throwing the first error once all have settled.
- `streamPool({ concurrency, next, work, onPage, stop })`: the same over a paged source. The next page is fetched while the current one runs, so the pool never drains between pages; `onPage` is called strictly in page order once all of a page has settled, which is where the backfills write their cursor and counts. `stop` fetches no more pages but lets the fetched ones finish, so a page is never half written.
- Every request still passes the limiter. The pool only makes sure there is work waiting at it.

### The limiter and the client

- The limiter keeps its rate, its background cap, arrival first, and the 429 back-off (retry-after, halve the background cap for the cooldown, grow back one at a time). New: background leaves `signals.rate.arrival_reserve_per_minute` of each minute to arrival, and background starts are spread across the minute (its share over 60 in any one second), so 16 in flight do not spend the minute in the first 25 seconds and then stall, and do not burst into a per-second 429.
- The TypeSafe client (`runtime/typesafe.ts`) is built once per process (`entry/services.ts`); Bun's `fetch` keeps connections alive, and nothing serializes requests. It used to retry a 429 itself, inside the limiter's slot, so the limiter never saw the 429 and never slowed background work down. The Server's client now hands a 429 straight to the limiter (`retryRateLimited: false`), which waits the `retry-after` without holding a slot and halves the background cap. 503, 529, timeouts and network failures are still retried in the client.
- Signal definitions sync one at a time per Workspace (`signals/index.ts`): with many Threads asked at once, two first-time syncs raced to insert the same definition, and the loser stored its answers under none.

## Defaults

| Setting | Before | Now | Why |
|---|---|---|---|
| `signals.backfill.concurrency` | 4 (max 16) | 16 (max 64) | About 8 in flight reach 20 a second at 0.4 s a request; 16 keeps the rate up when requests take longer (larger states, a slow network). The rate caps it anyway |
| `routing.backfill.concurrency` | 4 (max 16) | 16 (max 64) | The same requests (the Backlog sort asks through the Signal request, as background) |
| `routing.rerun.concurrency` | 4 (max 16) | 16 (max 64) | A re-run is the same one-Thread requests, started by the user |
| `signals.rate.requests_per_minute` | 600 | 1,100 | Just under the published 1,200, since TypeSafe says its limits move; a 429 still halves background work on its own |
| `signals.rate.arrival_reserve_per_minute` | (none) | 100 | The headroom the old half-rate default gave arrival, now reserved explicitly |

Background throughput goes from at most 600 requests a minute to about 1,000 (1,100 less the reserve for arrival). The tasks a user starts (a Board draft, a tuning test, a Dry run, organizing) run at arrival priority with `signals.backfill.concurrency` Threads at once.

## Tests

`apps/server/test/judge-pool.test.ts`, with a fake judge that takes a fixed time per request: 16 requests at concurrency 4 finish in about 4 request times, not 16; a slow request does not stop the ones behind it from starting; order and per-item errors hold; the paged pool reads ahead, hands pages back in order behind a slow item, and stops cleanly; through the limiter, background stays under its cap and a 429 still halves it. `typesafe.test.ts` covers the 429 handed back to the limiter. No test calls TypeSafe.
