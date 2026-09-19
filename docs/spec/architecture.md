# Architecture

How the pieces fit. Vocabulary from `CONTEXT.md`; decisions cited by ADR.

## Shape

```
apps/desktop            Tauri 2 app. React 19 over packages/ui. Rust: sidecar spawn, keychain, config watcher, SQLite commands.
  Store                 SQLite Cache, Outbox, Changes feed subscription, live queries (ADR 0009)
  Shell                 layout knobs, views, panels, theming (ADR 0001, design/)
  screens               inbox, reader, compose, calendar, workflows, routing, settings, onboarding

apps/server             Bun + Hono. Runtime-neutral fetch handler. Four entrypoints: bun (container, Sidecar), vercel, netlify, plus an optional Inngest kicker.
  Providers             Gmail, Graph, JMAP, IMAP behind one sync, send and calendar interface (research 3, 6)
  Mailstore             envelope encryption, threads, messages, labels, tags, attachments (research 5)
  Jobs                  leased step runner, four kickers, heartbeats (ADR 0005, research 22)
  Intelligence          routing, sections, briefs, LangGraph, Roles, Meter (ADR 0004, ADR 0007)
  Automation            workflows, runs, versions, standing approvals (ADR 0003)
  Agent host            MCP tool server, CLI adapters, sessions, Activity log, external MCP (ADR 0002, research 2)
  Calendar              events, invites, RSVP (issue 15)

packages/shared         domain types, settings schema, workflow schema, config file parser, generated API client
packages/ui             tokens.css, app.css, components, palettes
```

## Deployment modes

| Mode | Process | Database | Kicker | Realtime | Holds IMAP IDLE |
|---|---|---|---|---|---|
| Sidecar only | spawned by Tauri, loopback, per-launch token | embedded Postgres | in-process loop | WebSocket | Sidecar |
| Container | `bun run entry/bun.ts` | user's Postgres | in-process loop | WebSocket | container |
| Vercel | framework preset, Node (Bun beta) | pooled Neon or similar | Queues plus Cron | SSE, polling fallback | nobody |
| Netlify | Node function | pooled Netlify DB or similar | Async Workloads plus Scheduled Functions | polling | nobody |
| Both | Sidecar plus any cloud mode | the cloud's Postgres | both | WebSocket to Sidecar | Sidecar |

Servers never talk to each other. All coordination is the jobs table with leases and need tags; heartbeats decide failover; the Sidecar does everything when no Cloud is alive (ADR 0005). A step that outlives its lease renews it (`StepContext.extend`; the agentic Step does so around every model and tool call), so the sweeper never hands a working Job to a second Server. Three need tags exist: `needs-public-url` (push webhooks, a Cloud), `needs-process` (IMAP IDLE, JMAP EventSource, Local runtime steps), and `needs-always-on` (time-critical work such as a scheduled send, claimed by a live Cloud so it happens while every laptop is closed). In "both" mode the Sidecar opens the Cloud's Postgres from a connection string recorded in its data directory by the upgrade; the deployment guide is `apps/server/deploy/README.md`.

## Data model (Postgres, source of truth)

All body-derived columns are ciphertext under envelope encryption: per-message data keys wrapped by a per-Workspace key wrapped by the user's root key (research 5). Headers used for indexing and routing are plaintext.

- `accounts` (id, provider, address, credentials ref, sync state, capabilities)
- `workspaces` (one per account; settings scope)
- `threads` (workspace, provider thread id, subject, participants, last activity, section, group, subgroup, unread, starred, snoozed_until, archived)
- `messages` (thread, provider message id, from, to, cc, date, headers, body_enc, snippet_enc, has_attachments)
- `attachments` (message, name, size, media type, blob ref, text_enc)
- `blobs` (chunked, encrypted, for attachments and compose uploads)
- `labels` (provider labels and folders, synced both ways) and `thread_labels`
- `tags` (monday's, never pushed) and `thread_tags`
- `briefs` (thread, bullets_enc, actions_enc, computed_at, stale)
- `groups` (workspace, parent, name, rule sentence, predicate json, prompt_enc, thresholds) and `examples`
- `section_rules` (workspace, name, order, rule as above)
- `brief_policy` (workspace, rule as above, overrides, custom prompt)
- `workflows` (workspace, name, enabled, current version, standing approvals as step ids) and `workflow_versions` (one immutable document per version), `workflow_runs` (workflow, version, status, trigger, thread, current step, the waiting Activity row, the user's decision, the Steps' outputs for later templates) and `workflow_run_steps` (one row per Step's outcome, with the Activity row it ran as); a Run is a chain of `workflow-step` Jobs, arrivals and Thread events enter as `workflow-trigger` Jobs, schedules and silence checks are `workflow-schedule` Jobs that re-arm at the next cron minute
- `sessions` (workspace, runtime, title, developer mode) and `session_events` (the transcript, in order; each event sealed under the Workspace envelope as the `transcript` kind, `event_enc` and `event_key`, so a locked Server answers 423 for a Session's history), plus the LangGraph checkpoint tables (`checkpoints`, `checkpoint_blobs`, `checkpoint_writes`, `checkpoint_migrations`) under the `langgraph` schema, created and versioned by the checkpointer's own setup right after our migrations at boot. The checkpointer is `SealedPostgresSaver` (`apps/server/src/intelligence/agent/checkpointer.ts`): every blob and pending write is sealed under the Workspace key of its graph thread as the `checkpoint` kind (the thread id reaches the serializer through AsyncLocalStorage; a Session's thread is its id or `<id>#<epoch>`, an agentic Step's is `run:<runId>:<index>`); checkpoint metadata (source, step, parents) holds no content and stays JSONB. Rows from before migration 0014 keep their plain type and read as they are.
- `activity` (workspace, actor, tool, input summary, approval, result, undo ref, ts; the session or run it belongs to, so a Workflow Step's Tool call is the Run's ledger entry)
- `settings` (scope global or device, key, value json) and `devices` (token hash, name, last seen, cache key)
- `jobs` (class, needs, payload, lease, attempts, run_at) and `heartbeats` (server id, mode, ts)
- `drafts` (thread nullable, workspace, body_enc, blobs, provider draft id) and `scheduled_sends`
- `calendars`, `events` (with attendees, link, status), `invites` (message, event, method)
- `external_credentials` (the external MCP server's Keys and OAuth tokens as one row shape: kind, name, scope read or act, Workspaces or all, hashed secret, a key's visible prefix, expiry that is never "never", last use, revoked, the OAuth client), `oauth_clients` (dynamic registration), `oauth_codes` (an authorization in flight: the consent page's pairing code, the PKCE challenge, the hashed code once approved) and `oauth_refresh_tokens` (rotate on use); `activity.actor_name` names the credential on every external call
- `calendars` (workspace, source: google, graph, caldav or local, provider id, primary, writable, visible, sync token, webhook subscription), `events` (calendar, provider id, iCalendar uid, times, zone, organizer, attendees with their answers, link, status, recurrence rule, own response, created by agent, sequence; title, description and location under one "event" envelope with an 80-character title prefix in the clear), `invites` (message, thread, the matched event, method, uid, sequence, times, organizer, attendees, the answer so far with its write stamp, by mail, sender mismatch; the title and the original text/calendar part under the envelope). The calendar module (`apps/server/src/calendar/`) reads and writes a Provider's calendar API (Google Calendar, Graph) through the mail Session's `calendar()`, a linked CalDAV calendar through the CalDAV adapter, and the Local calendar as rows of its own; `calendar.sync` polls every `calendar.poll_minutes` (woken early by `/webhooks/calendar/:accountId`, registered by `calendar.watch` where a public URL exists), and the sync engine's body observer turns `text/calendar` parts into Invites as bodies land. An RSVP goes through the calendar API where one exists and by an iMIP REPLY over the Account's own Session otherwise, never both; invitations for Events monday organizes go out the same way (research 6).
- `credentials` (external MCP keys and OAuth clients, scope, expiry, last use)
- `meter` (workspace, task, provider, model, tokens in, tokens out, cost estimate, ts)
- `provider_keys` (a Hosted key the user shared with the Server, sealed as a `credential` object under the K_ws of the Workspace the Device was showing) and `integration_secrets` (one sealed `integration` row per Workflow integration: the Slack token or webhook URL, the Discord webhook URL, the Notion and Drive tokens, the webhook bearer; set and cleared through `/integrations/:name`, never through `/settings`; the `workflows.integrations` Setting holds only which integrations are set up and is written by the Server)
- `voice_profiles` (the Voice profile's description and excerpts as one `voice` envelope; excerpts quote sent mail)
- Rows written in the clear before migration 0014 (transcripts, Voice profiles, integration secrets inside the Setting) are moved under the envelope by a sweep that runs at boot and after every unlock (`Intelligence.sealLegacy`).
- Rotating a Workspace key (`Mailstore.rotateWorkspaceKey`) re-wraps every wrapped data key in the schema (a test pins the list to the `*_key` columns) plus the transcript keys and the sealed checkpoint blobs of the Workspace's threads; no ciphertext is read.

Client SQLite mirrors threads, messages (bodies within the Cache window), attachments text, labels, tags, briefs, groups, section rules, settings, drafts, calendars, events and invites (titles fetched in batches after each pull, like Brief content), plus an FTS5 virtual table over subject, participants, snippet and body, and the `outbox` table of intents (Thread, Draft, send and `invite.rsvp` kinds). Recurring masters are expanded on the client with the shared expander (`packages/shared/src/calendar.ts`); Google and Graph hand instances over already.

## API shape

One HTTP JSON API on the Server, typed routes, a generated client in `packages/shared`. Every request carries the Workspace id and a Device token (ADR 0006).

- `GET /changes?since=<cursor>`: ordered change events; woken by WebSocket, SSE or polling per mode. Every Server mutation reaches the feed: a flag the Provider flipped (read on the phone) is a `thread` row from the sync engine's header write; a Message or Thread that left the Provider, or a Thread that folded into another, is announced with `removed: true` (and `deleted: true`, so a client that does not know the field hides it); a merge announces its moved Messages.
- `/threads`, `/messages`, `/attachments`, `/labels`, `/tags`: read plus the write intents (archive, snooze, star, read, move, tag). A winning intent goes to the Mailstore's intent observer: the sync engine applies its effect to its mirror at once (so the next pass never flips the row back) and enqueues a `provider.change` Job that carries it to the Provider with retries; a Group move or a Tag is monday's alone. A snooze arms a `thread.unsnooze` Job at its wake time; the wake unsnoozes, marks unread and bumps the Thread to the top through the same intent path, stands down when a later snooze superseded it, and every sleeping Thread is re-armed at boot.
- `/drafts`, `/send` (schedules a send Job), `/scheduled`.
- `/groups`, `/sections`, `/routing/rerun`, `/routing/decisions`.
- `/workflows`, `/workflows/:id` (PUT is a new version), `/workflows/:id/versions/:n`, `/workflows/:id/enable`, `/workflows/:id/dry-run`, `/workflows/:id/run`, `/workflows/:id/approvals` (a Standing approval on a Step), `/workflows/runs`, `/workflows/runs/:id`, `/workflows/runs/:id/activity`, `/workflows/runs/:id/approvals` (answers a paused Run and resumes its Job).
- `/sessions`, `/sessions/:id/turns` (the turn streams its events over SSE on the POST itself), `/sessions/:id/approvals/:activityId`, `/activity`, `/activity/:id/undo`, `/agent/tools`.
- `/workflows`, `/workflows/:id/versions`, `/runs`, `/runs/:id/retry`, `/runs/:id/approve`.
- `/sessions` (with an optional `runtime` for a Session a Local runtime drives), `/sessions/:id/turns` (the turn streams its events over SSE on the POST itself), `/sessions/:id/approvals/:activityId`, `/activity`, `/activity/:id/undo`, `/agent/tools`.
- For a Session on a Local runtime, whose turns the Device drives: `PATCH /sessions/:id/runtime` (the switch, answered with the line the thread shows), `POST /sessions/:id/events` (what the CLI said), `GET /sessions/:id/live` (SSE of the tool cards the Server produces as the CLI's MCP calls run), and `/mcp/local` on the Sidecar: monday's tools over MCP streamable HTTP on loopback, bearer the Device token, `X-Monday-Workspace` and `X-Monday-Session` naming whose cards they are. `monday-server mcp --port --token --workspace [--session]` is the stdio launcher that proxies to it.
- `/calendar/events`, `/calendar/invites/:id/rsvp`.
- `/settings`, `/devices` (with `/devices/me` and `/devices/pending`, the codes waiting for approval), `/pair`, `/storage`.
- The external MCP server (docs/spec/external-mcp.md), authenticated by a credential and never by a Device token: `/mcp` (streamable HTTP, on the Sidecar's loopback and the Cloud alike; the listing filtered by the credential's scope, the search cap applied, every row in the Activity log with the credential name as actor, `X-Monday-Workspace` when the credential reaches more than one) and `GET /mcp/pending/:activityId` (a call parked on an approval past `external.approval_timeout_minutes` returns a pending status the caller polls here). OAuth 2.1: `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, `POST /oauth/register` (dynamic client registration, public clients with PKCE S256 only), `GET /oauth/authorize` (the consent page, served by the Server, that names the client, the scope and the Workspaces and shows a pairing code), `GET /oauth/consent/:id` (polled by the page), `POST /oauth/token` (authorization code with the verifier, refresh with rotation), `POST /oauth/revoke`. For the owner's client: `/external/credentials` (list with last use, create returning the secret once, revoke), `/external/pending?workspace=` and `POST /external/pending/:id` (answer), `GET /external/live?workspace=` (SSE of external cards; subscribed while a client is open, which is how the Server knows one is and when to request a desktop notification instead), `/external/consents` and `/external/consents/approve` (by id or by the page's code). An external caller's cards live in a Session per credential and Workspace, titled after the credential, so the composer renders and answers them with the ordinary approval route and the history names the caller. `monday-server mcp --key <key> (--port | --url)` is the launcher's second mode, proxying stdio to `/mcp`.
- `/calendar/info`, `/calendars` (with `PUT /calendars/:id/visible`), `PUT /accounts/:id/caldav` (link or unlink a CalDAV calendar), `/calendar/events` (a window; masters included), `POST /calendar/events/content` (titles in a batch, for the Cache), `/calendar/events/:id` (with `/respond`), `/calendar/busy`, `/threads/:id/invites`, `/invites/:id`, `POST /invites/:id/rsvp` (the Outbox intent, last-writer-wins on the Invite), `POST /webhooks/calendar/:accountId` (Google channel and Graph subscription deliveries, verified by the registration's token).
- `/settings` (a key the schema does not know or a value its type refuses is 400), `/devices` (with `/devices/me` and `/devices/pending`, the codes waiting for approval), `/pair`, `/storage`, `/credentials`.
- `/integrations` (which Workflow integrations are set up; works locked), `PUT /integrations/:name` (seals a token or webhook URL; 423 locked), `DELETE /integrations/:name`.
- `/mcp`: the external MCP transport (streamable HTTP).
- `/health`, `/capabilities` (protocol version, mode, features).

The Sidecar serves the same API on loopback with the per-launch token, plus the pairing UI when a Cloud is configured.

## Settings screens

- Every page is rendered from the settings schema by `apps/desktop/src/screens/settings/render.tsx`: a section's keys arranged into groups (`SETTING_GROUPS`, `groupsInSection`), one control per key from its control shape (`describeSetting`) or from the named special control the entry declares (`control`), Advanced folded per group, keys another control renders (`renderedBy`) nested with their own `data-setting`. A key added with a `section` and no other metadata lands under a group derived from its prefix.
- Panels that are not Settings (Accounts, Voice profile, the Config file, the Groups tree, the Meter, the Activity log, the Server, Devices, Storage, About) register against a group name. "Ask monday" inputs hand text to the composer; nothing on these pages calls a model.
- The Local runtime detection seam is `RuntimeDetection` on the screen; the Permissions tier list renders from `TOOL_TIERS` in `packages/shared`, which a Server test pins to the tool catalog.
- The AI level (`ai.level`, CONTEXT.md) is the first group of AI and agent, rendered as the three cards from onboarding. `settingLevel` in the schema says the lowest level each key shows at (`groupsInSectionAt`): every AI key at `assist`, the Workflow, Brief and routing-on-arrival keys at `automate`; panels have their own level in the renderer. Moving up from `off` with no runtime configured shows the runtime step (the same `ai.mode`, `ai.local.cli` and provider key controls) before the level is saved.

## Onboarding and the AI level

- The level gates through Settings and seams, never constants. Server: the Hosted runtime refuses every call at `off` with `AiOffError` (409 `ai_off`; a turn ends with an `ai_off` error event); Briefs answer `ai_off` on request at `off`, and below `automate` `threadReady` queues nothing and a `sync` trigger computes nothing (the policy is forced to on open); routing's `onArrival`, the Workflow arrival hook, the trigger Job, the Thread-event watch and the schedule Job act only at `automate`, keeping every row and every enabled flag (a schedule ticks without acting so it is still armed when the level rises). Client: at `off` the App renders no agent column or bar and opens no Session (the layout falls back as if the agent knob were hidden; the Setting keeps its value), the Store asks for no Brief on open, the palette has no Ask section and no agent action, and the "Ask monday" inputs on Settings, Routing and Workflows hide.
- Onboarding (`apps/desktop/src/screens/Onboarding.tsx`) is offered once per Account (`onboarding.state`, written `offered` before the screen shows, then `completed` or `skipped`) and again from "Set me up" in the composer or the palette. `off` ends with the keymap question; `assist` and `automate` run the conversation on a Session of its own whose turns carry `context.onboarding`, which appends the filled `agent.onboarding_prompt` to the system prompt. Chips come from the top senders already synced and the tool names; every step has Skip; closing skips the rest. Density is seeded from the screen size on the first run only.
- The onboarding tools (`apps/server/src/intelligence/agent/tools/onboarding.ts`, through the `OnboardingSeam` in `ToolExtensions`): `onboarding_context` (read), `propose_groups` (routing's preview scores the candidate Groups beside the stored ones so the card lists each sentence with the count of existing Threads that would move; on approval the Groups are created and the moves applied; one `groups` undo record removes them and puts the Threads back), `propose_workflows` (read: the catalog entries matched to the tools chosen, each with a Dry run of the unsaved document), `adopt_workflow` (creates and enables one on approval; undo deletes it), `propose_views` (a Focus view into `views.list`), `set_keymap`. The catalog is `apps/server/src/workflows/catalog.ts`.

## Runtimes

- Local: Claude Code (`claude -p` stream-json via the user's binary), Codex (`codex app-server`), OpenCode (`opencode acp`, the Agent Client Protocol over stdio), each behind one AgentSession interface, built-in tools stripped, monday's tools via the loopback MCP server (research 2, ADR 0002). The Device spawns the CLI through the Tauri shell scope for that binary, persists what it said, and learns of the tool cards over the Session's live stream; approvals resume through the same route as a Hosted interrupt. A Runtime switch mid-Session starts a new epoch whose first turn carries the transcript so far as context.
- Hosted: LangChain providers for Anthropic, Gemini, OpenAI, Kimi, OpenRouter; LangGraph agent loop with Postgres checkpoints; Roles main and fast per provider (ADR 0007).
- The tool server is one implementation with approvals inside; both runtime kinds call it.

## Security summary

- Root key held by the user as a recovery file; resident only in Server processes that must decrypt (Sidecar always; Cloud only if the user shares it for offline Briefs and Workflows). Threat model excludes root on the running host and the AI provider.
- Device tokens in the OS keychain; pairing, not passwords. HTTPS off loopback.
- External MCP credentials (Keys, OAuth tokens) are a second credential type stored hashed, scoped read or act, bound to Workspaces, always expiring, revocable with last use shown; they never open the Device routes, and Device tokens never open `/mcp`. Anything an external caller asks that leaves the mailbox or destroys data still asks the owner, with the caller named on the card.
- Hosted keys per device unless explicitly shared with the Server, then stored under the envelope. Workflow integration secrets, Session transcripts, LangGraph checkpoints and the Voice profile are under the envelope too; the plaintext settings table holds nothing that opens a third party.
- A Gmail push delivery is verified twice: the Pub/Sub OIDC token in its Authorization header (Google's signature against the published keys, issuer accounts.google.com, the audience the registration named, the service account it signs as: `sync.gmail_push_service_account`) and then the per-Account secret in the URL, in constant time. With no signing account configured no push subscription is registered and Gmail is polled on the reconcile interval.
- The Agent's ToolHost is bound to one Workspace: an id from another Workspace reads as not found and is never written, whatever the model or an external caller passes.
- Mail content is untrusted: runtimes never get shell or file tools unless Developer mode is on for a Session.
- No telemetry.
