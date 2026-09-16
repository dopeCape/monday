# Running the sync server on Vercel and Netlify

Research for issue #22. Date: 2026-09-16. Every limit below is taken from the platform's own documentation as of that date; the URL sits next to each fact. Limits on these platforms move quickly, so re-check before the spec is finalized.

## 1. Summary

The sync server can run on Vercel and Netlify from the same Bun + Hono codebase, but only as a **request-driven server**: HTTP in, bounded work, HTTP out. Three things a mail server normally does do not fit that shape and must be redesigned rather than ported:

1. **Long-lived connections.** IMAP IDLE (a TCP connection that stays open for up to 29 minutes) has no serverless equivalent. Vercel can hold a WebSocket or SSE stream only as long as one function invocation (300 s on Hobby, 800 s on Pro). Netlify has no inbound WebSocket support at all and caps streamed responses at 60 s.
2. **Work that runs for minutes.** Vercel Functions stop at 300 s (Hobby) or 800 s (Pro, 1800 s in beta). Netlify synchronous functions stop at 60 s, background functions at 15 minutes. A workflow that takes minutes must be cut into steps that each fit inside one invocation and are resumed by something durable.
3. **A process that is always awake.** Nothing polls, nothing keeps state in memory between requests. Scheduled work must come from platform cron (Vercel Cron: once a day on Hobby, every minute on Pro; Netlify Scheduled Functions: cron with a 30 s limit) or from a queue that calls back into the server.

Everything else ports cleanly. Gmail, Microsoft Graph and JMAP all push change notifications as HTTPS webhooks that carry only an identifier, so ingestion is "store the notification, ack in under 3 seconds, fetch the delta in a background step". Postgres works from short-lived functions through a transaction-mode pooler (Neon `-pooler`, Supabase port 6543). Hono runs unchanged: on Vercel as a zero-config framework preset (Node.js by default, Bun runtime in public beta), on Netlify as a Node.js Function using the Web-standard `Request` / `Response` signature.

**Recommendation in one line:** keep all durable state in Postgres, model every background action as an idempotent step in a `jobs` table with a lease, and give each deployment mode a small "kicker" that runs the next step: an in-process worker loop (container, sidecar), Vercel Queues plus Cron (Vercel), Netlify Async Workloads plus Scheduled Functions (Netlify). IMAP-only accounts and any workflow that must hold a connection open need the sidecar or a container; the Vercel and Netlify modes are documented as "cloud-lite" with those two capabilities absent.

## 2. Recommended architecture: one codebase, four deployment modes

### 2.1 Shape of the codebase

```
server/
  src/
    app.ts            Hono app. Pure Web-standard fetch handler. No Bun-only or Node-only APIs.
    core/             sync engines (gmail, graph, jmap, imap), workflows, briefs, tags
    jobs/             Postgres-backed step runner: jobs table, lease, idempotency, retry
    kicker/           one adapter per mode: process.ts, vercel.ts, netlify.ts, inngest.ts (optional)
    db/               postgres.js or pg + drizzle; pooled URL by default, unpooled for migrations
  entry/
    bun.ts            Bun.serve({ fetch: app.fetch, websocket }) + in-process worker. Container and sidecar.
    vercel/           index.ts: `export default app` (framework preset). Optional bunVersion in vercel.json.
    netlify/          functions/api.mts: `export default (req, ctx) => app.fetch(req, ctx)`, config.path "/*"
                      functions/tick.mts: config.schedule "* * * * *" (30 s budget)
                      functions/step.mts: config.background true (15 min budget) or an Async Workload
```

Rules that make this work:

- **The Hono app is runtime-neutral.** Use `fetch`, Web Crypto, `ReadableStream`. Bun-specific APIs (`Bun.serve` WebSocket, `Bun.sql`, `Bun.file`) live only in `entry/bun.ts` and in the process kicker. `Bun.sql` is Bun-only (https://bun.com/docs/api/sql), so the shared database layer uses `postgres` (postgres.js) or `pg` with drizzle, which run on Bun, Node and the Vercel Bun runtime alike.
- **Every background action is a step.** A step is a function of `(jobRow) => Promise<'done' | 'again' | { sleepMs }>` that must finish inside a **step budget** the kicker announces (container: unbounded; Vercel: `getDeadline()` from `@vercel/functions`, https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package; Netlify background: 15 min; Netlify sync: 60 s). Steps are idempotent because every platform queue is at-least-once (Vercel Queues, Netlify Async Workloads, Inngest and QStash all say so in their docs, cited in section 6).
- **The `jobs` table is the source of truth**, not the queue. The queue or cron only carries "job X may have work". A missed or duplicated kick is harmless; a sweeper (cron) re-kicks any job whose lease expired. This is exactly the pattern Vercel's own cron guidance asks for: "Design your operations to be idempotent and reconciliation-based so each run can safely reprocess outstanding work since the last successful run" (https://vercel.com/docs/cron-jobs/manage-cron-jobs).
- **Realtime to the client is a cursor, not a socket.** The client asks `/changes?since=<cursor>`; the transport (WebSocket, SSE, or polling) is chosen per mode. The client already has a SQLite cache, so a 5 to 15 s poll on cloud-lite modes is calm and cheap.

### 2.2 The four modes

| Mode | Process model | Kicker | Realtime transport | Who holds IMAP IDLE |
|---|---|---|---|---|
| Container | `bun run entry/bun.ts`, always on | in-process worker loop (`setInterval` + Postgres `LISTEN/NOTIFY` on a direct, unpooled connection) | WebSocket via `Bun.serve` websocket option, SSE as fallback | the container |
| Sidecar | same binary, spawned by the Tauri client, bound to localhost | in-process worker loop | WebSocket to localhost | the sidecar |
| Vercel | Hono framework preset, Node.js (or Bun runtime, beta), Fluid compute | Vercel Queues push consumer (beta) + Vercel Cron sweeper (daily on Hobby, every minute on Pro) | SSE stream re-opened before `maxDuration` (300 s Hobby, 800 s Pro), or WebSocket (beta, same limit); polling fallback | nobody, unless a sidecar is also running |
| Netlify | Node.js Function (Lambda) with `app.fetch`, credit-based plan | Netlify Async Workloads (durable steps, sleep, delayed events) + Scheduled Function every minute as sweeper + Background Functions for single 15 min jobs | polling (no inbound WebSocket; streaming capped at 60 s) | nobody, unless a sidecar is also running |

"Both" mode (cloud server plus sidecar sharing one Postgres, cloud owns the database) becomes the answer to every gap: the sidecar registers itself as a worker on the shared `jobs` table, takes IMAP accounts and any step tagged `needs-process`, and the cloud keeps webhooks, cron and the API reachable while the laptop is closed. Vercel Queues even support this directly: poll mode lets "consumers run outside of Vercel (on long-running services, on-premise workers, or other cloud environments)" (https://vercel.com/docs/queues/poll-mode).

### 2.3 Capability matrix per mode

Legend: full = works as designed; degraded = works with a stated limit; none = unsupported, needs sidecar or container.

| Capability | Container | Sidecar | Vercel | Netlify |
|---|---|---|---|---|
| HTTP API for the client | full | full (localhost) | full | full |
| Gmail Pub/Sub push webhook | full | none (not publicly reachable) | full | full |
| Graph change notification webhook | full | none | full | full |
| JMAP `PushSubscription` (server POSTs to our URL) | full | none | full | full (Fastmail support unverified, see 5.4) |
| JMAP `EventSource` (we hold an SSE connection open) | full | full | none | none |
| IMAP IDLE | full | full | none | none |
| IMAP polling with CONDSTORE/QRESYNC on a schedule | full | full | degraded: every minute on Pro, once a day on Hobby unless a queue delay re-kicks | degraded: every minute via Scheduled Function |
| SMTP send | full | full | full (ports 465 and 587 open, 25 blocked) | full (no official port policy, see 5.6) |
| Gmail / Graph / JMAP send over HTTPS API | full | full | full | full |
| Workflow step up to 60 s | full | full | full | full (sync or background) |
| Workflow step 60 s to 5 min | full | full | full | background function only (15 min) or Async Workload |
| Workflow step 5 to 15 min | full | full | Pro only (800 s); 1800 s in beta | background function or Async Workload |
| Workflow that sleeps hours or waits for an event | full | full | full via Vercel Queues delay (7 days max) or Vercel Workflows (no limit) | full via Async Workloads `step.sleep` / `delayUntil` (up to 1 year) |
| Realtime push to client (WebSocket) | full | full | degraded: beta, connection closes at `maxDuration` | none |
| Realtime push to client (SSE) | full | full | degraded: stream must be re-opened every 300 s (Hobby) / 800 s (Pro) | degraded: 60 s streaming limit, 20 MB |
| Scheduled work | full (in-process) | full | degraded on Hobby: once per day, plus or minus 59 min; per minute on Pro | full: cron to the minute, 30 s budget |
| Postgres | direct connection, LISTEN/NOTIFY | direct | pooled URL only; no LISTEN/NOTIFY through the pooler | pooled URL only |
| Message bodies encrypted at rest with a user key | full | full | full (Web Crypto) | full (Node crypto) |
| Memory / CPU per request | host-defined | host-defined | 2 GB / 1 vCPU (Hobby), up to 4 GB / 2 vCPU (Pro) | 1024 MB default, up to 4096 MB on Pro |
| Request/response body size | host-defined | host-defined | 4.5 MB | 6 MB buffered (4.5 MB binary), 20 MB streamed |
| Cost at single-user scale | your host | free | Hobby free (non-commercial), see 3.8 | Free plan 300 credits/month, hard limit, see 4.7 |

### 2.4 What the spec should say about cloud-lite modes

- **IMAP/SMTP-only accounts require the sidecar or a container.** The server refuses to add an IMAP account when it detects it is running on Vercel or Netlify without a registered sidecar worker, and explains why. A polling-only IMAP mode is possible (section 5.4) but is not first-class in v1; it can be a later slice.
- **Realtime is best-effort on cloud-lite.** The client polls `/changes` (default 10 s when focused, 60 s when hidden) and upgrades to SSE on Vercel. The UI never depends on push latency.
- **Long workflows are chunked.** The workflow runner records progress after every model call; a step that would exceed the budget yields and is re-kicked. Fully agentic workflows must checkpoint their tool-call loop the same way.
- **Webhook renewals are jobs.** Gmail `watch()` (7 days), Graph subscriptions (10,080 minutes for mail, 1,440 minutes with resource data), JMAP `PushSubscription` `expires` are all renewed by a scheduled job, so renewals survive the daily-only Hobby cron with margin.

## 3. Vercel in detail

### 3.1 Runtimes and Bun

- Official runtimes: Node.js, Bun, Python, Rust, Go, Ruby, Wasm, Edge (https://vercel.com/docs/functions/runtimes).
- **Bun is a first-party runtime in public beta.** Enable with `"bunVersion": "1.x"` or `"1.4.x"` in `vercel.json`; Vercel manages patch versions (https://vercel.com/docs/functions/runtimes/bun; beta announcement https://vercel.com/changelog/bun-runtime-now-in-public-beta-for-vercel-functions). `Bun.serve()` is accepted as the entrypoint since 2026-08-10, including its `websocket` option (https://vercel.com/changelog/bun-serve-entrypoint-for-vercel-functions). Differences from Node: no automatic source maps, no bytecode caching, no request metrics on `node:http`; Bun WebSocket differences: upgrade headers not applied, `drain` not invoked, `send()` does not return the `-1` backpressure code.
- **Hono is a zero-config framework preset.** Export the app as default from `index.ts`, `app.ts`, `server.ts` or the `src/` equivalents; routes become Vercel Functions on Fluid compute; `serveStatic()` is ignored, static files go in `public/` (https://vercel.com/docs/frameworks/backend/hono, https://hono.dev/docs/getting-started/vercel). The `hono/vercel` adapter is literally `(req) => app.fetch(req)` (https://github.com/honojs/hono/blob/main/src/adapter/vercel/handler.ts), so no adapter is needed.
- Bun as package manager is supported in builds independently of the runtime.

### 3.2 Duration, memory, size (Fluid compute, the default for projects created after 2025-04-23)

Source: https://vercel.com/docs/functions/limitations

| Limit | Hobby | Pro / Enterprise |
|---|---|---|
| Max duration (Node.js, Bun, Python) | 300 s default and max | 300 s default, 800 s max, 1800 s extended max (beta, needs function-level config, not with Secure Compute / Static IPs) |
| Memory / CPU | 2 GB / 1 vCPU | 2 GB / 1 vCPU default, 4 GB / 2 vCPU max |
| Request or response body | 4.5 MB | 4.5 MB |
| Bundle (uncompressed) | 250 MB; large functions up to 5 GB (beta; Node, Bun, Python) | same |
| `/tmp` | 500 MB, read-only elsewhere | same |
| File descriptors | 1,024 shared across concurrent executions | same |
| Concurrency | auto-scales to 30,000 | 30,000 (Pro), 100,000+ (Enterprise) |
| Region | single region, `iad1` by default; configurable | multiple regions on Pro/Enterprise |
| Functions per deployment (no framework) | 12 | unlimited |
| Environment variables | 64 KB total | 64 KB |

Functions are archived after 2 weeks without invocations on production, adding at least 1 s to the next cold start (https://vercel.com/docs/functions/runtimes). The timeout error is a 504 `FUNCTION_INVOCATION_TIMEOUT`. Projects created before 2025-04-23 without Fluid compute still have the old 10 s / 60 s (Hobby) and 15 s / 300 s (Pro) limits (https://vercel.com/docs/limits).

### 3.3 Streaming and SSE

- Node.js runtime streams by default; "Vercel Functions have a maximum duration, meaning that it isn't possible to stream indefinitely" (https://vercel.com/docs/functions/runtimes#streaming). Max duration "includes time spent processing the request and sending the response, including streamed responses" (https://vercel.com/docs/functions/limitations#max-duration).
- Edge runtime: must start responding within 25 s, can stream up to 300 s.
- So an SSE feed lives at most 300 s (Hobby) or 800 s (Pro) per connection; the client must reconnect with `Last-Event-ID`. Vercel's realtime guide recommends SSE for one-directional streams because "browsers reconnect on their own" (https://vercel.com/kb/guide/publish-and-subscribe-to-realtime-data-on-vercel).
- Hono's `stream()` helper is explicitly supported (https://vercel.com/docs/frameworks/backend/hono#streaming).

### 3.4 WebSockets (public beta)

- "Vercel Functions can serve WebSocket connections"; requires Fluid compute; the connection is pinned to one function instance and "WebSocket connections close when a Vercel Function reaches its maximum duration" (https://vercel.com/docs/functions/websockets). Billing follows normal function pricing (active CPU, so idle connections are cheap) plus data transfer.
- Hono works with `@hono/node-server`'s `upgradeWebSocket` plus `ws`, exported as an `http.Server` from `api/server.ts`, or natively via `Bun.serve({ websocket })` on the Bun runtime (same page, "Use with frameworks").
- State must live outside the instance (Redis or Postgres); new connections may land on a different instance or deployment.
- Verdict for monday: usable as an optimization, but the client must treat every socket as short-lived. The cursor-based `/changes` design makes reconnects lossless.

### 3.5 Cron

- Configured in `vercel.json` `crons`, always UTC, GET to the production URL with user agent `vercel-cron/1.0` and header `x-vercel-cron-schedule` (https://vercel.com/docs/cron-jobs).
- Limits: 100 cron jobs per project on every plan. **Hobby: once per day, and "Vercel cannot assure a timely cron job invocation" (invoked anywhere inside the scheduled hour); more frequent expressions fail deployment.** Pro and Enterprise: once per minute, per-minute precision (https://vercel.com/docs/cron-jobs/usage-and-pricing).
- Security: set `CRON_SECRET`; Vercel sends it as `Authorization: Bearer <secret>`. Duration equals function `maxDuration`. "Vercel will not retry an invocation if a cron job fails." Delivery is best effort, duplicates are possible, overlapping runs are possible (use a lock). Not supported in `vercel dev` (https://vercel.com/docs/cron-jobs/manage-cron-jobs).
- Consequence: on Hobby, cron is only good for daily sweeps (watch renewals, retention). Minute-level re-kicking on Hobby must come from Vercel Queues delayed messages, not cron.

### 3.6 Background work: `waitUntil`, Queues, Workflows

- `waitUntil(promise)` from `@vercel/functions` extends the invocation after the response is sent, but "Promises passed to waitUntil() will have the same timeout as the function itself" (https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package). `getDeadline()` returns the invocation deadline, which is exactly the step budget the kicker needs. There is no separate "background function" product on Vercel.
- **Vercel Queues (public beta).** Durable topics with consumer groups, at-least-once delivery, retries, visibility timeouts; push mode invokes a Vercel Function declared with `experimentalTriggers: [{ type: "queue/v2beta", topic }]` in `vercel.json` (the consumer has no public URL); poll mode lets any environment consume with `PollingQueueClient` (https://vercel.com/docs/queues, https://vercel.com/docs/queues/concepts, https://vercel.com/docs/queues/poll-mode). Limits: TTL 60 s to 7 days (default 24 h), delay 0 to 7 days, visibility timeout 0 to 60 min (default 60 s), message up to 100 MB, unlimited topics and consumer groups, no built-in DLQ, approximate ordering only, topics partitioned by deployment ID. Pricing: billed per API operation in 4 KiB chunks; **Hobby includes the first 1,000,000 operations** (https://vercel.com/docs/queues/pricing). A push delivery that times out is billed for the function's full `maxDuration`, so set `maxDeliveries`.
- **Vercel Workflows** (the `workflow` npm package, Workflow SDK, Apache-2.0: https://github.com/vercel/workflow). `'use workflow'` and `'use step'` directives; steps run as Vercel Functions, orchestration via Queues, state in Vercel-managed persistence. No limit on run or sleep duration; max runtime of an individual step is the function limit; 10,000 steps per run; 50 MB payloads; replay must finish within 240 s (https://vercel.com/docs/workflows/pricing). Hobby includes 50,000 events/month and 1 GB written; retention 1 day on Hobby, 7 days on Pro. Hono is supported through the Nitro module (`workflow/nitro`), which adds a build system to Hono (https://workflow-sdk.dev/docs/getting-started/hono). Outside Vercel it runs on a Local World (dev) or a community-maintained Postgres World (`@workflow/world-postgres`), and "workflow SDK apps currently work best when deployed to Vercel" (https://workflow-sdk.dev/docs/deploying).

### 3.7 Postgres from Vercel

- Neon Postgres is the Marketplace Postgres (https://vercel.com/marketplace/neon). Any Neon or Supabase database works with a pooled connection string.
- Call `attachDatabasePool(pool)` from `@vercel/functions` right after creating a `pg` pool so idle clients are released before Fluid instances suspend (https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#attachdatabasepool).
- Put the database in `iad1` / AWS us-east-1 (Neon us-east-1, Supabase us-east-1) to match the default function region.

### 3.8 Pricing at single-user scale

Hobby includes per month: 1,000,000 function invocations, 4 hours of active CPU, 360 GB-hours of provisioned memory, 100 GB fast data transfer, 10 GB fast origin transfer (https://vercel.com/docs/limits/fair-use-guidelines). Pro overage: $0.60 per 1M invocations, active CPU from $0.128 per hour, provisioned memory from $0.0106 per GB-hour. **Hobby is restricted to non-commercial personal use** (same page). A self-hosted personal mail server is within that, but a user who is paid to run it is not.

Rough sizing: a single user with 4 accounts, webhook-driven sync, a per-minute sweeper (Pro) and 30 workflow runs a day sits far below 1M invocations. Active CPU is the number to watch: model calls are I/O wait and do not count, MIME parsing and encryption do.

## 4. Netlify in detail

### 4.1 Runtime: Node.js Functions, no Bun at runtime

- Functions use the Web-standard signature `(req: Request, context: Context) => Response`, or a Fetchable module `{ fetch, config }` (https://docs.netlify.com/build/functions/api/). This is `app.fetch` directly; no Hono adapter is needed: `export default (req, ctx) => app.fetch(req, ctx); export const config = { path: "/*" }`.
- The runtime is an AWS Lambda Node.js runtime; the default follows the build's Node version, falling back to **Node.js 24**; override with `AWS_LAMBDA_JS_RUNTIME` (https://docs.netlify.com/build/functions/configuration/#node-js-version-for-runtime). Go and Rust are available through the Lambda-compatibility path.
- **Bun is build-time only.** Netlify runs `bun install` when it finds `bun.lockb` and honors `BUN_VERSION` (https://docs.netlify.com/build/configure-builds/manage-dependencies/#bun); the text `bun.lock` lockfile is detected since January 2025 per Netlify staff (https://answers.netlify.com/t/support-new-bun-lock-text-lockfile-for-bun/134716). There is no Bun function runtime.
- The official `hono/netlify` adapter targets **Edge Functions** (Deno, `jsr:@hono/hono/netlify`, file at `netlify/edge-functions/index.ts`) and is `(req, context) => app.fetch(req, { context })` (https://hono.dev/docs/getting-started/netlify, https://github.com/honojs/hono/blob/main/src/adapter/netlify/handler.ts). Edge Functions are the wrong home for this server: 50 ms CPU per request and a Deno runtime with beta npm support (section 4.5).

### 4.2 Limits

Source: https://docs.netlify.com/build/functions/configuration/#default-values

| Setting | Default | Configurable |
|---|---|---|
| Region | `cmh` (US East, Ohio) | yes, Pro/Enterprise |
| Memory | 1024 MB | 1024 to 4096 MB on credit-based Pro/Enterprise (`memory` or `vcpu` 0.5 to 2) |
| Synchronous execution limit | 60 s | no |
| Scheduled execution limit | 30 s | no |
| Background execution limit | 15 min | no |
| Buffered request/response payload | 6 MB (about 4.5 MB for binary because of base64) | no |
| Streamed response payload | 20 MB | no |
| Background request/response payload | 256 KB | no |

### 4.3 Streaming and realtime

- Return a `ReadableStream` body to stream; "Streaming functions have a 60-second execution limit and a 20 MB response size limit" (https://docs.netlify.com/build/functions/api/#streaming-responses). So SSE on Netlify is a 60 s long-poll; the client must reconnect every minute. Polling `/changes` every 10 s costs less than that and is the recommended transport.
- `context.waitUntil()` runs work after the response, still bounded by the function's execution limit (same page).
- **WebSockets: no inbound support.** The Functions and Edge Functions docs contain no server-side WebSocket API; Edge Functions list only the browser-style `WebSocket` client API among supported Web APIs (https://docs.netlify.com/build/edge-functions/api/#supported-web-apis). Netlify staff state on the support forum that Functions do not support WebSockets (https://answers.netlify.com/t/does-netlify-support-websocket-programming/4213). Treat this as "none".

### 4.4 Background and scheduled functions

- **Background Functions:** `export const config = { background: true }` (legacy `-background` filename suffix still works); the platform returns 202 immediately and the function runs up to 15 minutes; on error it retries after one minute and again two minutes later; no streaming; "available on Credit-based plans, including Free, Personal, and Pro and on Enterprise plans" (https://docs.netlify.com/build/functions/background-functions/). Payload is capped at 256 KB, so pass a job id, not the job.
- **Scheduled Functions:** `export const config = { schedule: "* * * * *" }` or `netlify.toml`; standard cron in UTC plus `@hourly` style extensions; 30 s execution limit; run only on published production deploys; body carries `next_run`; cannot be invoked by URL; available on all plans (https://docs.netlify.com/build/functions/scheduled-functions/). Per-minute schedules are allowed, which makes Netlify's sweeper more responsive than Vercel Hobby's.

### 4.5 Edge Functions (for completeness)

Deno runtime; 50 ms CPU per request, 40 s response-header timeout, 512 MB memory, 20 MB bundle; npm support in beta (https://docs.netlify.com/build/edge-functions/limits/, https://docs.netlify.com/build/edge-functions/api/). Fine for auth or routing middleware in front of the API, not for the sync server itself.

### 4.6 Netlify Async Workloads (durable steps on Netlify)

- A Netlify Extension, enabled per team, "can be enabled on any site and plan level"; it provisions serverless functions and blobs on the site and bills them as ordinary usage (https://docs.netlify.com/build/async-workloads/overview/).
- Programming model via `@netlify/async-workloads`: `asyncWorkloadFn((event) => ...)` subscribed to event names; `step.run(id, fn)` memoized steps; `step.sleep(id, duration)`; events sent with `client.send(name, { data, delayUntil, priority })`, `delayUntil` up to one year; retries default to 4 with a 5 s x4 backoff up to one week; explicit `ErrorDoNotRetry` / `ErrorRetryAfterDelay` (https://docs.netlify.com/build/async-workloads/writing-workloads/, https://docs.netlify.com/build/async-workloads/sending-events/).
- Execution: after each new step the whole workload is re-invoked, "to give each step a clean slate and as much time within the serverless runtime" (https://docs.netlify.com/build/async-workloads/multi-step-workloads/). Timeout detection defaults to 60 s for standard functions "as background functions use a 15 minute timeout" (`AWL_SERVERLESS_TIMEOUT`); the production scheduler polls every 60 s (min 10 s, max 900 s); pending-event upper limit 2000; chain limit 20 (https://docs.netlify.com/build/async-workloads/optional-configuration/).
- External systems can enqueue through the router API with `Authorization: Bearer AWL_API_KEY` at `/.netlify/functions/async-workloads-router`, which is how a webhook handler or the sidecar hands work to Netlify.
- Netlify-only. It is the natural `kicker/netlify.ts`.

### 4.7 Netlify Database and Postgres

- Netlify Database is "a fully managed Postgres database built into the Netlify platform", credit-based plans only, storage free until 2026-07-01, with a database branch per deploy preview and platform-run migrations (https://docs.netlify.com/build/data-and-storage/netlify-database/). The current docs no longer name the underlying provider (the 2025 launch was Neon-backed); treat it as a black-box Postgres. `@netlify/database` exposes `getConnectionString()` for use with `pg`, `postgres` or drizzle, plus a `pg.Pool` for transactions (https://docs.netlify.com/build/data-and-storage/netlify-database/api/).
- Any external Neon or Supabase database works the same way as on Vercel; put it near `cmh` (AWS us-east-2) or move the function region.

### 4.8 Pricing at single-user scale

Credit-based plans (all accounts created after 2025-09-04): Free 300 credits/month with a hard limit and sites paused when exhausted; Personal 1,000; Pro from 3,000. Rates: compute 10 credits per GB-hour, web requests 2 credits per 10,000, bandwidth 20 credits per GB, production deploys 15 credits each; Edge Functions count as web requests, not compute (https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/). Legacy plans have no Background Functions except Enterprise.

At 1024 MB, 300 credits is 30 GB-hours, i.e. 30 function-hours per month minus deploys and traffic. A per-minute 2 s sweeper alone is 24 hours a month of invocations at about 0.7 GB-hours; the real cost is workflow and sync steps. **Free fits a light single user; Personal ($5 for 500 more credits via auto-recharge) is the realistic floor.**

## 5. Provider change notifications on a serverless ingestion model

The ingestion contract every provider imposes is the same: a tiny notification arrives over HTTPS, it must be acknowledged within seconds, it may be duplicated or dropped, and the real work is "fetch the delta from stored state". That contract is a good fit for serverless as long as the webhook handler does nothing but verify, persist and return.

### 5.1 The shared pattern

1. **Webhook handler** (Hono route, runs anywhere): verify the caller, answer any handshake, `INSERT` one row into `sync_events` (provider, account, opaque cursor such as Gmail `historyId`, Graph `resource`, JMAP `changed` map), enqueue "sync account X" through the mode's kicker, return 202 in well under a second. Idempotency key: Pub/Sub `messageId`, Graph notification id, JMAP state string.
2. **Sync step** (a job): fetch the delta from the cursor stored in Postgres, never from the event payload; on "cursor too old" errors fall back to a full sync. Budget-aware: it pages and yields before the deadline.
3. **Sweeper** (cron): re-run sync for every account on a schedule regardless of webhook health, and renew watches and subscriptions. This also covers providers that have no push at all.
4. **Renewal jobs**: Gmail `watch` daily; Graph `PATCH /subscriptions/{id}` before expiry; JMAP `PushSubscription/set` to extend `expires`.

Deadlines that force this shape: Graph counts a delivery as failed unless it sees a 2xx "within 3 seconds", retries for up to 4 hours, and marks an endpoint "slow" (10 minute delivery delay) when more than 10 percent of responses exceed 3 s, or "drop" when more than 15 percent exceed the 10 s retry window (https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks#http-codes-and-retry-logic). Pub/Sub push acknowledges on any of 102, 200, 201, 202, 204 and otherwise redelivers with 100 ms to 60 s backoff; the ack deadline defaults to 10 s (https://docs.cloud.google.com/pubsub/docs/push, https://docs.cloud.google.com/pubsub/docs/subscription-properties).

### 5.2 Gmail: Cloud Pub/Sub push plus `history.list`

- `users.watch` registers a Pub/Sub topic (`projects/<project>/topics/<name>`) that must live in a Google Cloud project the user controls; grant Publisher on the topic to `gmail-api-push@system.gserviceaccount.com`; optional `labelIds` filter. Response carries `historyId` and `expiration` (https://developers.google.com/workspace/gmail/api/guides/push, https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/watch).
- "You must call the `watch` method at least once every 7 days or you'll stop receiving updates for the user"; "We recommend calling `watch` once per day" (same guide). A daily job fits even Vercel Hobby cron.
- Payload is `{"emailAddress": ..., "historyId": ...}` only, base64 inside the Pub/Sub envelope. "Each Gmail user being watched has a maximum notification rate of one event per second. The service drops any user notifications exceeding that rate." Dropping is harmless because the next `history.list` from the stored id returns everything.
- Push subscription endpoint: "A publicly accessible HTTPS address" with a CA-signed certificate; no domain ownership proof (https://docs.cloud.google.com/pubsub/docs/create-push-subscription). Enable push authentication so Pub/Sub sends a Google-signed OIDC JWT in `Authorization: Bearer`; verify signature, `aud` (set it explicitly to the endpoint URL), `email` equals the push service account, `email_verified` true (https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions).
- Catch-up: `users.history.list(startHistoryId)`; "History records are typically available for at least one week"; a 404 means the id is too old and "your client must perform a full sync" (https://developers.google.com/workspace/gmail/api/guides/sync). `maxResults` up to 500; history entries carry only `id` and `threadId`, so follow with `messages.get` (https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list).
- Quota (projects created on or after 2026-05-01): 6,000 quota units per minute per user per project, 1,200,000 per minute per project; `messages.get` costs 20, `history.list` 2, `watch` 100, `messages.send` 100 (https://developers.google.com/workspace/gmail/api/reference/quota).
- Setup cost for the user: a Google Cloud project, a topic, a push subscription and OAuth consent. This is the heaviest onboarding step among the providers and should be scripted (the `wizard` skill) in the install flow.

### 5.3 Microsoft Graph: change notifications plus per-folder delta

- `POST /subscriptions` with `changeType` (created, updated, deleted), `notificationUrl` (HTTPS), `resource` such as `/me/mailFolders('inbox')/messages` or `/me/messages`, `expirationDateTime`, `clientState` (up to 128 chars), optional `lifecycleNotificationUrl` (https://learn.microsoft.com/en-us/graph/api/resources/subscription, https://learn.microsoft.com/en-us/graph/outlook-change-notifications-overview). Up to 1,000 active subscriptions per mailbox across all apps.
- **Lifetime for Outlook messages is 10,080 minutes (under seven days); rich notifications with resource data are limited to 1,440 minutes (under one day)**; values under 45 minutes are raised to 45 (https://learn.microsoft.com/en-us/graph/api/resources/subscription#subscription-lifetime). Renew with `PATCH /subscriptions/{id}`. Average notification latency under 1 minute, max 3 minutes.
- Validation handshake on create: Graph POSTs `?validationToken=...` and the endpoint must reply 200 with `text/plain` and the decoded token "within 10 seconds"; the lifecycle URL is validated the same way (https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks#notificationurl-validation).
- Delivery: basic notifications carry `subscriptionId`, `clientState`, `changeType`, `resource` and `resourceData.id`, no content; several notifications may share one POST. Validate `clientState` on every delivery. Microsoft's own advice is to "validate and persist the notification in a queue on your endpoint and return 202 Accepted status code within the 3-second window".
- Rich notifications (`includeResourceData: true`) need an RSA 2048 to 4096 encryption certificate, `$select` without `Body`, and JWT validation of `validationTokens`; they save the follow-up GET but cost the shorter lifetime and certificate management. Recommendation: basic notifications plus delta (https://learn.microsoft.com/en-us/graph/change-notifications-with-resource-data).
- Lifecycle notifications (`reauthorizationRequired`, `subscriptionRemoved`, `missed`) can only be configured at creation; on `subscriptionRemoved` create a new subscription and run delta, on `missed` run a full resync (https://learn.microsoft.com/en-us/graph/change-notifications-lifecycle-events).
- Catch-up: "Delta query is a per-folder operation"; `GET /me/mailFolders/{id}/messages/delta`, follow `@odata.nextLink` to `@odata.deltaLink`, store the delta link per folder; track folder additions with `mailFolder` delta. A `410 Gone` or `syncStateNotFound` means full resync; "Your application must be prepared for replays" (https://learn.microsoft.com/en-us/graph/delta-query-messages, https://learn.microsoft.com/en-us/graph/delta-query-overview, https://learn.microsoft.com/en-us/graph/api/message-delta).
- Throttling per app and mailbox: 10,000 requests per 10 minutes, 4 concurrent requests, 150 MB uploads per 5 minutes (https://learn.microsoft.com/en-us/graph/throttling-limits#outlook-service-limits). The sync step must cap concurrency at 4 per account.

### 5.4 JMAP (Fastmail): PushSubscription is a webhook, EventSource is not

- RFC 8620 section 7 offers two mechanisms: an event source "for clients that can hold transport connections open", and `PushSubscription`, where "the JMAP server will then make an HTTP POST request to this URL for each push notification" (https://www.rfc-editor.org/rfc/rfc8620.html#section-7). The payload is a `StateChange` with new state strings per type, no data; the RFC states "It doesn't matter if some push events are dropped".
- `PushSubscription` details: `url` must be `https://`; optional `keys` for RFC 8291 encryption; the server immediately POSTs a `PushVerification` with a `verificationCode` that the client must write back before any further pushes (there is a documented race: the verification may arrive before the create call returns); servers may set or shorten `expires`, with a required minimum of 48 hours and a recommended 7 days for token-based credentials; the subscription dies with the credentials that created it; a 429 from the endpoint tells the server to slow down (https://www.rfc-editor.org/rfc/rfc8620.html#section-7.2). So on Vercel and Netlify: verify the code, persist, ack; renew `expires` daily.
- `EventSource` is a long-running `text/event-stream` request with `closeafter=state|no` and a `ping` of 30 to 300 s, resumable with `Last-Event-ID` (https://www.rfc-editor.org/rfc/rfc8620.html#section-7.3). It requires a process that stays connected: container or sidecar only. `closeafter=state` could be abused as a long-poll inside a bounded function, but that burns an invocation for the whole wait and is not recommended.
- **Fastmail support is only half documented.** Fastmail's own client "holds a persistent EventSource push connection while the app is open" (https://www.fastmail.com/blog/offline-architecture/), and the session endpoint and token auth are documented (https://www.fastmail.com/dev/). `PushSubscription` to arbitrary URLs is not documented on fastmail.com or jmap.io, and Cyrus IMAP, the server Fastmail develops, lists RFC 8620 as implemented "except for PushSubscription" (https://www.cyrusimap.org/imap/download/installation/http/jmap.html). Treat it as unverified: try `PushSubscription/set` at account setup, and fall back to polling when it fails.
- Polling fallback is cheap: every `/get` returns a `state` string, so one `Mailbox/get` per poll detects change with a single string compare; only then call `Email/changes(sinceState)`; `cannotCalculateChanges` means full re-query (https://www.rfc-editor.org/rfc/rfc8620.html#section-5.2). Fastmail publishes no general JMAP rate limit.

### 5.5 IMAP: no push, ever, in serverless

- IDLE (RFC 2177, also RFC 9051 section 6.3.13) keeps an authenticated TCP session open so the server can send untagged `EXISTS` / `EXPUNGE` responses; "Clients using IDLE are advised to terminate the IDLE and re-issue it at least every 29 minutes" (https://www.rfc-editor.org/rfc/rfc2177.html). NOTIFY (RFC 5465) has the same persistent-connection model and is rarely deployed (https://www.rfc-editor.org/rfc/rfc5465.html). No IMAP RFC defines a server-to-URL callback. A bounded function cannot hold IDLE; at best it would be a 300 to 800 s long-poll that pays for an invocation continuously.
- **Polling alternative** (the "degraded" IMAP mode, a later slice): on each poll, connect, `SELECT` with QRESYNC parameters (`UIDVALIDITY`, `HIGHESTMODSEQ`), `UID FETCH ... (CHANGEDSINCE n)` plus `VANISHED` for expunges, fetch UIDs at or above stored `UIDNEXT`, store `UIDVALIDITY`, `UIDNEXT`, `HIGHESTMODSEQ` per folder in Postgres, `LOGOUT`. If `UIDVALIDITY` changed, drop the cache (https://www.rfc-editor.org/rfc/rfc7162.html#section-3.1.2.1). Use `STATUS (UIDNEXT HIGHESTMODSEQ)` first to skip unchanged folders. Each poll must fit the budget: 30 s in a Netlify Scheduled Function, 300 s in a Vercel function; a Vercel Hobby cron runs only daily, so on Hobby a queue-delayed self-rescheduling job is the only way to poll every few minutes.
- OAuth2 over IMAP is available where the API path is unwanted: Gmail `imap.gmail.com:993` with SASL XOAUTH2 and the restricted `https://mail.google.com/` scope (https://developers.google.com/workspace/gmail/imap/xoauth2-protocol); Microsoft 365 IMAP with `IMAP.AccessAsUser.All` and SMTP with `SMTP.Send` (https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth). Not needed for v1 since both providers get native APIs.

### 5.6 SMTP and sending

- Vercel: outbound port 25 blocked, 465 and 587 open; "Await the send" because background work pauses after the response (https://vercel.com/kb/guide/serverless-functions-and-smtp). File descriptors (1,024 shared) include sockets.
- Netlify: no docs page lists outbound port policy; a Netlify staff answer says "We don't block any ports with Netlify Functions" (https://answers.netlify.com/t/can-i-send-mail-through-smtp-from-a-function/8076). Unofficial; verify in the Netlify smoke test.
- Gmail (`messages.send`, 100 quota units), Graph (`sendMail`, inside the 10,000 per 10 minutes mailbox limit) and JMAP (`EmailSubmission`, RFC 8621) send over HTTPS, so SMTP is only required for the generic IMAP/SMTP provider, which already needs the sidecar or container for receiving.

### 5.7 Provider summary for the capability matrix

| Provider | Webhook-style push | Serverless-safe ingestion | Catch-up primitive | Full resync trigger | Renewal |
|---|---|---|---|---|---|
| Gmail | yes: Pub/Sub push to HTTPS with OIDC | yes | `history.list(startHistoryId)` | HTTP 404 | `watch` every 7 days; daily recommended |
| Microsoft Graph | yes: subscription to HTTPS with `clientState` | yes | `mailFolders/{id}/messages/delta` per folder | 410 Gone or `syncStateNotFound` | `PATCH` before 10,080 min (1,440 min rich) |
| JMAP | spec: `PushSubscription` POST; Fastmail: EventSource confirmed, `PushSubscription` undocumented | only with `PushSubscription`; otherwise poll `Mailbox/get` state | `Email/changes(sinceState)` | `cannotCalculateChanges` | extend `expires` (servers may clamp to about 7 days) |
| IMAP | no | no; scheduled poll only | `SELECT (QRESYNC)`, `FETCH CHANGEDSINCE` | `UIDVALIDITY` change | n/a |


## 6. Queue, cron and durable-run options compared

| Option | Model | Step time bound | Sleep / delay | Self-host | Free tier | Hono / Bun | Lock-in |
|---|---|---|---|---|---|---|---|
| In-process worker (container, sidecar) | loop over the Postgres `jobs` table, `LISTEN/NOTIFY` wake-up | none | native | n/a | n/a | native Bun | none |
| Vercel Cron | GET to a function on a schedule | function `maxDuration` | n/a | no | 100 crons; Hobby daily only, Pro per minute | any | Vercel |
| Vercel Queues (beta) | topics, consumer groups, push into a private function or poll from anywhere | function `maxDuration`; visibility timeout up to 60 min | delay up to 7 days | no | 1,000,000 ops/month on Hobby | `@vercel/queue` SDK, runtime-neutral | Vercel (poll mode works off-platform) |
| Vercel Workflows / Workflow SDK | `'use workflow'` durable functions over Queues | function `maxDuration` per step; replay 240 s | unlimited | Local World; community Postgres World | 50,000 events/month on Hobby, 1 day retention | Hono via Nitro; Node | Vercel-first, Apache-2.0 SDK |
| Netlify Scheduled Functions | cron on published deploys | 30 s | n/a | no | all plans | any Node | Netlify |
| Netlify Background Functions | 202 then run | 15 min | n/a (use `delayUntil` in Async Workloads) | no | credit-based Free and up | any Node | Netlify |
| Netlify Async Workloads | events, memoized steps, re-invocation per step, built on the site's functions and blobs | 60 s (sync) or 15 min (background) per attempt | `delayUntil` and `step.sleep` up to 1 year | no | any plan, billed as compute | any Node | Netlify |
| Inngest | Inngest calls the app's `serve()` endpoint once per step and memoizes results (https://www.inngest.com/docs/learn/how-functions-are-executed) | platform function limit; on Vercel Fluid, `streaming: true` reaches the 800 s max (https://www.inngest.com/docs/learn/serving-inngest-functions) | `step.sleep` up to 7 days on Free, 1 year paid; runs up to 30 days Free / 366 days Pro (https://www.inngest.com/docs/usage-limits/inngest) | yes: single binary `inngest start`, SQLite by default, Postgres + Redis optional (https://www.inngest.com/docs/self-hosting); server SSPL with delayed Apache-2.0, SDKs Apache-2.0 (https://github.com/inngest/inngest) | 50k executions/month, 5 concurrent steps, 24 h history; Pro from $99/month (https://www.inngest.com/pricing) | `inngest/hono` and `inngest/bun` adapters | portable across all four modes; verified with `INNGEST_SIGNING_KEY` |
| Trigger.dev | tasks run on Trigger.dev's infrastructure (or self-hosted workers), triggered from the app with `tasks.trigger` (https://trigger.dev/docs/how-it-works) | none (configurable `maxDuration`); CRIU checkpoints for waits over 60 s | `wait.for` / `wait.until` | yes: Docker Compose or Kubernetes needing Postgres, Redis, ClickHouse 25.8+, MinIO, a registry; webapp 3+ vCPU / 6+ GB, worker 4+ vCPU / 8+ GB; no checkpoints self-hosted (https://trigger.dev/docs/self-hosting/docker, https://trigger.dev/docs/self-hosting/overview) | $5 credits/month, 20 concurrent runs, 1 day logs, 10 schedules; Hobby $10/month (https://trigger.dev/pricing) | Node official, Bun experimental (https://trigger.dev/docs/config/config-file) | task code leaves our server; heavy to self-host |
| Upstash QStash + Upstash Workflow | QStash delivers HTTP messages with retries, schedules and delays; Workflow calls the endpoint once per step and offloads external calls with `context.call` (https://upstash.com/docs/workflow/basics/how) | platform function limit; QStash waits up to 15 min (Free) or 2 h (paid) for a response | delay up to 7 days Free, 1 year paid; `context.sleep`, `waitForEvent` | no | 1,000 messages/day, 1 MB, 10 schedules, parallelism 10; then $1 per 100k (https://upstash.com/docs/qstash/overall/pricing) | `@upstash/workflow/hono` (https://upstash.com/docs/workflow/quickstarts/hono) | signed JWT in `Upstash-Signature` with current/next keys (https://upstash.com/docs/qstash/howto/signature); not self-hostable |

Reading of the table for monday:

1. **Default: in-house step runner + platform kickers.** The engine (Postgres `jobs`, leases, idempotent steps) is the same everywhere and has no third-party account. Platform kickers are thin: Queues + Cron on Vercel, Async Workloads + Scheduled Functions on Netlify, a loop in the process elsewhere. This matches the project's self-hosting and no-telemetry stance.
2. **Optional accelerator: Inngest.** If the kickers prove fiddly, Inngest is the one provider that (a) runs identically against Vercel, Netlify, a container and the sidecar, (b) has Hono and Bun adapters, (c) can be self-hosted as a single binary, and (d) has a free tier that covers one user. Make it a `kicker/inngest.ts` behind `WORKFLOW_DRIVER=inngest`, not a requirement.
3. **Not recommended as primary:** Trigger.dev (moves workflow code off our server and is heavy to self-host), QStash (cheapest and simplest but cannot be self-hosted, so it would be Vercel/Netlify-only anyway), Vercel Workflow SDK (excellent on Vercel, but Hono needs Nitro and the Postgres World is community-maintained; revisit when it is first-party).

## 7. Postgres from serverless

### 7.1 Neon

- Pooling is PgBouncer in **transaction mode** via the `-pooler` hostname; up to 10,000 client connections; `default_pool_size` is 0.9 x `max_connections` (about 377 concurrent transactions per user/database on a 1 CU compute). Unsupported through the pooler: `SET`/`RESET`, **`LISTEN`/`NOTIFY`**, SQL-level `PREPARE`, temporary tables; protocol-level prepared statements (what `pg` and postgres.js use) are fine. Neon: "Use the pooled connection string (hostname with -pooler suffix) for serverless functions" (https://neon.com/docs/connect/connection-pooling).
- `@neondatabase/serverless`: HTTP mode for one-shot queries, WebSocket mode for sessions and interactive transactions and `pg` compatibility; on edge runtimes a `Pool`/`Client` must be opened and closed within one request (https://neon.com/docs/serverless/serverless-driver). Drizzle: `neon-http` or `neon-serverless` for serverless, node-postgres or postgres.js "from a serverful environment" (https://orm.drizzle.team/docs/connect-neon). On Vercel's Node/Bun Fluid runtime a normal `pg` pool with `attachDatabasePool` is simplest and works on all four modes.
- Free plan: 100 projects, 0.5 GB storage per project, 100 CU-hours per project per month, autoscaling up to 2 CU, **scale to zero after 5 minutes (mandatory on Free)**, 5 GB egress; Launch plan is $0.106 per CU-hour and $0.35 per GB-month (https://neon.com/docs/introduction/plans). Scale-to-zero means the first request after idle pays a compute wake-up; a per-minute sweeper keeps it awake and burns the CU-hour budget (100 CU-hours is about 4 days at 1 CU), so on Free the sweeper must be lazy: skip the database when no webhook arrived.

### 7.2 Supabase

- Direct connection (port 5432, IPv6 on Free), Supavisor session mode (5432, IPv4), **transaction mode (6543) "for serverless and edge functions"**; transaction mode has no prepared statements and loses session state; use pool size 1 per function instance, `prepare: false`, SSL (https://supabase.com/docs/guides/database/connecting-to-postgres). The Nano compute on Free allows 60 direct connections and 200 pooler clients (https://supabase.com/docs/guides/platform/compute-and-disk).
- Free plan: 500 MB database, 2 active projects, **paused after 1 week of inactivity**, 5 GB egress, Realtime 200 concurrent connections and 2M messages; Pro from $25/month (https://supabase.com/pricing). The pause is a real hazard for a mail server that must accept webhooks around the clock; a paid plan or Neon is safer.
- Supabase Realtime `postgres_changes` streams WAL changes to subscribed clients but is single-threaded and authorizes each event per subscriber; recommended below about 3,000 subscribers (https://supabase.com/docs/guides/realtime/postgres-changes). It could be a client-side realtime fallback when Postgres is on Supabase, but the cursor poll is simpler and provider-neutral.

### 7.3 Rules for the shared database layer

- Two URLs in config: `DATABASE_URL` (pooled, used by request handlers and steps everywhere) and `DATABASE_URL_UNPOOLED` (direct; used by migrations, by the in-process worker for `LISTEN/NOTIFY`, and by nothing on Vercel/Netlify).
- Never rely on `LISTEN/NOTIFY` for correctness; it is a wake-up hint for the process kicker only.
- Client-scope pool at module level, small (`max: 2` on serverless), and `attachDatabasePool` on Vercel.
- Keep transactions short; transaction-mode poolers hand the connection back after each one.

## 8. Open risks

1. **Beta surface on Vercel.** Bun runtime, WebSockets, Queues, and durations above 800 s are all beta. The Node.js runtime with 300 s / 800 s and Cron are the only GA pieces the design depends on; keep the Bun runtime and Queues behind config so a beta regression does not take the Vercel mode down.
2. **Hobby cron is daily and imprecise.** Anything minute-level on Vercel Hobby rides on Queues (beta). If Queues is unavailable, Hobby degrades to daily sync sweeps plus webhook-driven sync only.
3. **Netlify free credits are a hard stop.** At 300 credits the site is paused, and a mail server that stops receiving webhooks silently loses push notifications until watches are renewed. Recommend Personal or Pro for Netlify, and alert in the client when the server has been unreachable.
4. **Netlify Async Workloads is an extension with limited documented limits.** Event payload size, blob retention and throughput are not published; the "pending upper limit" (2000) and the 60 s scheduler cadence are. It also cannot be run locally in the same way, so the process kicker is the reference implementation and Async Workloads is tested in CI against a Netlify site.
5. **IMAP-only users get a worse product on cloud-lite.** The spec must state this in install docs and in the account-add flow. A polling IMAP mode (CONDSTORE/QRESYNC every minute via Scheduled Function or Pro Cron, each poll bounded to 30 s / 300 s) is feasible and would lift this to "degraded"; it is a candidate later slice.
6. **Webhook endpoints must be publicly reachable with a stable HTTPS URL.** Preview deployments and the sidecar are not; only the production URL registers watches and subscriptions. Gmail Pub/Sub additionally requires a Google Cloud project owned by the user, which affects the minutes-to-first-inbox target.
7. **Database wake-ups and pauses.** Neon Free scales to zero after 5 minutes; Supabase Free pauses after a week idle. A paused database makes webhooks fail their 3 s ack window. Either pay for always-on compute or accept slower first responses and rely on the sweeper to catch up.
8. **Two runtimes to test.** The shared code runs on Bun (container, sidecar, Vercel Bun beta) and on Node 24 (Netlify, Vercel default). CI must run the test suite on both, and the shared layer must avoid Bun-only APIs.
9. **Fluid compute cost surprises.** Failed queue deliveries are billed at full `maxDuration`; long SSE streams are cheap in active CPU but count against concurrency and duration. Set `maxDeliveries`, and cap `maxDuration` per route rather than globally.
10. **Licensing of the optional accelerator.** Inngest's server is SSPL with a delayed Apache-2.0 release; that is fine for a self-hoster running it privately, but the project should not bundle or redistribute the Inngest server binary with an MIT product without checking.

## 9. Sources

Vercel

- https://vercel.com/docs/functions/runtimes
- https://vercel.com/docs/functions/runtimes/bun
- https://vercel.com/changelog/bun-runtime-now-in-public-beta-for-vercel-functions
- https://vercel.com/changelog/bun-serve-entrypoint-for-vercel-functions
- https://vercel.com/docs/functions/limitations
- https://vercel.com/docs/limits
- https://vercel.com/docs/limits/fair-use-guidelines
- https://vercel.com/docs/functions/streaming-functions
- https://vercel.com/docs/functions/websockets
- https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package
- https://vercel.com/docs/cron-jobs
- https://vercel.com/docs/cron-jobs/usage-and-pricing
- https://vercel.com/docs/cron-jobs/manage-cron-jobs
- https://vercel.com/docs/queues
- https://vercel.com/docs/queues/concepts
- https://vercel.com/docs/queues/poll-mode
- https://vercel.com/docs/queues/pricing
- https://vercel.com/docs/workflows
- https://vercel.com/docs/workflows/pricing
- https://workflow-sdk.dev/docs/getting-started/hono
- https://workflow-sdk.dev/docs/deploying
- https://github.com/vercel/workflow
- https://vercel.com/docs/frameworks/backend/hono
- https://vercel.com/kb/guide/publish-and-subscribe-to-realtime-data-on-vercel
- https://vercel.com/marketplace/neon
- https://hono.dev/docs/getting-started/vercel
- https://github.com/honojs/hono/blob/main/src/adapter/vercel/handler.ts

Netlify

- https://docs.netlify.com/build/functions/overview/
- https://docs.netlify.com/build/functions/api/
- https://docs.netlify.com/build/functions/configuration/
- https://docs.netlify.com/build/functions/background-functions/
- https://docs.netlify.com/build/functions/scheduled-functions/
- https://docs.netlify.com/build/functions/usage-and-billing/
- https://docs.netlify.com/build/edge-functions/api/
- https://docs.netlify.com/build/edge-functions/limits/
- https://docs.netlify.com/build/async-workloads/overview/
- https://docs.netlify.com/build/async-workloads/writing-workloads/
- https://docs.netlify.com/build/async-workloads/multi-step-workloads/
- https://docs.netlify.com/build/async-workloads/sending-events/
- https://docs.netlify.com/build/async-workloads/optional-configuration/
- https://docs.netlify.com/build/data-and-storage/netlify-database/
- https://docs.netlify.com/build/data-and-storage/netlify-database/api/
- https://docs.netlify.com/build/configure-builds/manage-dependencies/
- https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/
- https://answers.netlify.com/t/support-new-bun-lock-text-lockfile-for-bun/134716
- https://answers.netlify.com/t/does-netlify-support-websocket-programming/4213
- https://hono.dev/docs/getting-started/netlify
- https://github.com/honojs/hono/blob/main/src/adapter/netlify/handler.ts

Queues and durable runs

- https://www.inngest.com/docs/learn/how-functions-are-executed
- https://www.inngest.com/docs/learn/serving-inngest-functions
- https://www.inngest.com/docs/usage-limits/inngest
- https://www.inngest.com/docs/self-hosting
- https://www.inngest.com/pricing
- https://github.com/inngest/inngest
- https://trigger.dev/docs/how-it-works
- https://trigger.dev/docs/config/config-file
- https://trigger.dev/docs/self-hosting/overview
- https://trigger.dev/docs/self-hosting/docker
- https://trigger.dev/pricing
- https://github.com/triggerdotdev/trigger.dev
- https://upstash.com/docs/qstash/overall/pricing
- https://upstash.com/docs/qstash/howto/signature
- https://upstash.com/docs/workflow/basics/how
- https://upstash.com/docs/workflow/basics/caveats
- https://upstash.com/docs/workflow/quickstarts/hono

Postgres

- https://neon.com/docs/connect/connection-pooling
- https://neon.com/docs/serverless/serverless-driver
- https://neon.com/docs/introduction/plans
- https://orm.drizzle.team/docs/connect-neon
- https://supabase.com/docs/guides/database/connecting-to-postgres
- https://supabase.com/docs/guides/platform/compute-and-disk
- https://supabase.com/docs/guides/realtime/postgres-changes
- https://supabase.com/pricing
- https://bun.com/docs/api/sql

Mail providers

- https://developers.google.com/workspace/gmail/api/guides/push
- https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/watch
- https://developers.google.com/workspace/gmail/api/guides/sync
- https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list
- https://developers.google.com/workspace/gmail/api/reference/quota
- https://developers.google.com/workspace/gmail/imap/xoauth2-protocol
- https://docs.cloud.google.com/pubsub/docs/push
- https://docs.cloud.google.com/pubsub/docs/create-push-subscription
- https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions
- https://docs.cloud.google.com/pubsub/docs/subscription-properties
- https://learn.microsoft.com/en-us/graph/api/resources/subscription
- https://learn.microsoft.com/en-us/graph/outlook-change-notifications-overview
- https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks
- https://learn.microsoft.com/en-us/graph/change-notifications-with-resource-data
- https://learn.microsoft.com/en-us/graph/change-notifications-lifecycle-events
- https://learn.microsoft.com/en-us/graph/delta-query-messages
- https://learn.microsoft.com/en-us/graph/delta-query-overview
- https://learn.microsoft.com/en-us/graph/api/message-delta
- https://learn.microsoft.com/en-us/graph/throttling-limits
- https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth
- https://www.rfc-editor.org/rfc/rfc8620.html
- https://www.fastmail.com/dev/
- https://www.fastmail.com/blog/offline-architecture/
- https://www.cyrusimap.org/imap/download/installation/http/jmap.html
- https://www.rfc-editor.org/rfc/rfc2177.html
- https://www.rfc-editor.org/rfc/rfc5465.html
- https://www.rfc-editor.org/rfc/rfc7162.html
- https://www.rfc-editor.org/rfc/rfc9051.html
- https://vercel.com/kb/guide/serverless-functions-and-smtp
- https://answers.netlify.com/t/can-i-send-mail-through-smtp-from-a-function/8076
