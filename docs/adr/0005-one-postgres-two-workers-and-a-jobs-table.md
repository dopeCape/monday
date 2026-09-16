---
status: accepted
---

# One Postgres, any number of servers, and a jobs table as the only coordination

A Cloud server and a Sidecar can run at the same time against one Postgres, or either can run alone. We decided that they never talk to each other: all coordination goes through the database. Every background action is an idempotent, time-budgeted row in a jobs table with a lease, and each server is a worker that claims rows it is able to serve. Job classes carry needs: `needs-public-url` rows (provider push webhooks) are claimed by the Cloud, `needs-process` rows (IMAP IDLE, JMAP EventSource, Local runtime steps) by the Sidecar, and everything else by whoever is awake. Servers write heartbeats; when no Cloud heartbeat is fresh, the Sidecar claims every class and runs the polling path for push-only providers. A Sidecar-only install runs an embedded Postgres so there is one schema and one query layer everywhere.

## Considered options

- Two databases that replicate. Rejected: needs a conflict model between servers on top of the one between client and server.
- Cloud does everything and the Sidecar is a replica. Rejected: Local runtime workflows and IMAP IDLE would have no home.
- SQLite on the Sidecar. Rejected: two SQL dialects and no shared database in "both" mode.

## Consequences

- The same jobs table is what Vercel and Netlify kickers wake, so serverless modes need no special code path.
- Provider subscriptions record which server registered them; on Cloud return, push is re-registered and the Sidecar stops polling those accounts.
- The client talks to localhost whenever a Sidecar runs, and to the Cloud URL otherwise. Offline actions are an outbox of intents replayed in order; per-field last-writer-wins, user actions beat automation.
