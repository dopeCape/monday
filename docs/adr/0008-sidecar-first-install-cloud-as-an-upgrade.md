---
status: accepted
---

# The first run is Sidecar-only with an embedded Postgres; a Cloud server is an upgrade from Settings

Easy install was a hard requirement. We decided that a new user only downloads the desktop app. It starts the Sidecar and an embedded Postgres, the user adds an account, and mail syncs. No server is deployed, no account is created, nothing is configured. A Cloud server is offered afterwards from Settings as "keep working while this laptop is closed" with Deploy buttons for Vercel and Netlify and a docker compose for containers; the app migrates the embedded database into the new one and pairs itself. The target is 5 minutes from download to a synced inbox for providers that need only a token or a password.

## Considered options

- Cloud first, then the app. Rejected: every user would run a deploy before seeing an inbox.
- A choice screen at first run. Rejected: a decision before any value.
- Cloud as a fresh start without migration. Rejected: loses Tags, Groups, Workflows and Activity.

## Consequences

- The Sidecar must be a complete server, which ADR 0005 already requires.
- One CI matrix builds the Bun server and embedded Postgres per target; the same server binary is the container entrypoint and a standalone download for headless hosts.
- Gmail and Microsoft cannot hit the 5 minute target because of credential registration; an in-app wizard with deep links and live-validated paste boxes is the mitigation, and IMAP with an app password is the escape hatch.
