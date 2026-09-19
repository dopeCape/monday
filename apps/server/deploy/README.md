# Running the sync server in the Cloud

monday starts as a Sidecar beside the desktop app with an embedded Postgres (ADR 0008). A Cloud server is an upgrade from Settings › Server: it keeps working while the laptop is closed, and the two share one Postgres (ADR 0005). Three shapes exist; the capability matrix is in `docs/research/serverless-hosting.md`.

| Shape | What it adds | What it cannot do |
|---|---|---|
| Your own container | everything: push webhooks, scheduled sends while closed, IMAP connections held open | nothing |
| Vercel | push webhooks, scheduled sends while closed (cron every minute on Pro, daily on Hobby) | IMAP IDLE and JMAP EventSource; those stay with the Sidecar |
| Netlify | push webhooks, scheduled sends while closed (scheduled tick every minute) | IMAP IDLE and JMAP EventSource; those stay with the Sidecar |

## The steps, whichever shape

1. Deploy with the button on the Server page (or by hand, below) and set the environment variables the card lists.
2. Move your mail: paste the Cloud database's direct connection string on the Server page and click Copy database. The Sidecar copies every table over the wire. Or export a `pg_dump` file and restore it with `pg_restore --no-owner --no-acl -d "$DATABASE_URL_UNPOOLED" monday.dump`.
3. Connect this device: enter the Cloud URL and the `MONDAY_SETUP_CODE` you set. The Cloud mints a Device token and keeps it in your keychain.
4. Share the database with the Sidecar so both servers work on one copy (the "both" mode), then restart monday.

## Environment

Every Cloud mode reads these (see the header of `entry/cloud.ts`):

- `DATABASE_URL`: the pooled connection string (Neon's `-pooler` host, Supabase port 6543, PgBouncer). Prepared statements are turned off when the URL looks pooled; `DATABASE_POOLED=1|0` forces it.
- `DATABASE_URL_UNPOOLED`: the direct string, for migrations and the database copy. Falls back to `DATABASE_URL`.
- `MONDAY_SETUP_CODE`: a one-time code of your choosing; the first Device pairs with it, then it stops working.
- `MONDAY_PUBLIC_URL`: the `https://` origin the internet reaches the deployment at; Gmail and Microsoft push notifications are registered against it. Gmail push also needs the `sync.gmail_push_service_account` Setting (Settings, Accounts, Sync): the email of a service account in the Google project that Pub/Sub signs push deliveries as (grant the Pub/Sub service agent `roles/iam.serviceAccountTokenCreator` on it). The webhook verifies every delivery's OIDC token against it before the URL secret; without one no push subscription is registered and Gmail is polled on the reconcile interval.
- `MONDAY_ROOT_KEY`: the base64 root key, only if the Cloud should decrypt mail for Briefs and Workflows while every device is off (the `server.share_root_key` Setting).
- `MONDAY_SERVER_ID`: the heartbeat id. Optional; the platform's deployment id is used when it exposes one.

### Vercel

`vercel.json` at `apps/server` routes every path to `api/index.ts` and schedules `GET /cron/tick` every minute. Set the project's root directory to `apps/server`, and add:

- `MONDAY_MODE=vercel`
- `CRON_SECRET`: a random string; Vercel Cron sends it as `Authorization: Bearer` and nothing else may trigger a tick.

Hobby accounts allow one cron run per day: change the schedule in `vercel.json` to `0 0 * * *`, and expect scheduled sends to leave on the next request or the next daily tick.

### Netlify

`netlify.toml` at `apps/server` names `entry/netlify/` as the functions directory: `api.ts` serves every path, `tick.ts` is the Scheduled Function that runs the Job tick every minute inside its 30 s budget. Set the site's base directory to `apps/server` and add `MONDAY_MODE=netlify`. Bun installs at build time; the runtime is Node.

### Your own container

`docker-compose.yml` in this directory runs Postgres and the server from a clone of the repository:

```sh
cd apps/server/deploy
MONDAY_SETUP_CODE=pick-something MONDAY_PUBLIC_URL=https://mail.example docker compose up -d
```

Put the server behind HTTPS at `MONDAY_PUBLIC_URL` (ADR 0006 requires it off loopback), then connect the desktop app. The container image built by the release pipeline replaces the bind mount and the install step.

## How the two servers share the work

Every background action is a Job in one table with a lease (ADR 0005). Need tags decide who may claim a Job: `needs-public-url` for provider push webhooks (a Cloud), `needs-process` for IMAP IDLE, JMAP EventSource and Local runtime steps (the Sidecar or a container), and `needs-always-on` for time-critical work such as a scheduled send, which a live Cloud claims so it happens while every laptop is closed. Each server writes a heartbeat (`server.heartbeat_seconds`); when no Cloud heartbeat is fresh (`server.stale_after_seconds`), the Sidecar claims every class. A serverless Cloud has no loop: its cron tick and the requests that queue a Job each run one bounded pass and write the heartbeat.
