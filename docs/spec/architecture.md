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

Servers never talk to each other. All coordination is the jobs table with leases and need tags; heartbeats decide failover; the Sidecar does everything when no Cloud is alive (ADR 0005). Three need tags exist: `needs-public-url` (push webhooks, a Cloud), `needs-process` (IMAP IDLE, JMAP EventSource, Local runtime steps), and `needs-always-on` (time-critical work such as a scheduled send, claimed by a live Cloud so it happens while every laptop is closed). In "both" mode the Sidecar opens the Cloud's Postgres from a connection string recorded in its data directory by the upgrade; the deployment guide is `apps/server/deploy/README.md`.

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
- `workflows` (workspace, document json, version, enabled, placement) and `workflow_versions`, `runs`, `run_steps`, `standing_approvals`
- `sessions` (workspace, runtime, title, developer mode) and `session_events` (the transcript, in order), plus the LangGraph checkpoint tables (`checkpoints`, `checkpoint_blobs`, `checkpoint_writes`, `checkpoint_migrations`) under the `langgraph` schema, created and versioned by the checkpointer's own setup right after our migrations at boot
- `activity` (workspace, actor, tool, input summary, approval, result, undo ref, ts)
- `settings` (scope global or device, key, value json) and `devices` (token hash, name, last seen, cache key)
- `jobs` (class, needs, payload, lease, attempts, run_at) and `heartbeats` (server id, mode, ts)
- `drafts` (thread nullable, workspace, body_enc, blobs, provider draft id) and `scheduled_sends`
- `calendars`, `events` (with attendees, link, status), `invites` (message, event, method)
- `credentials` (external MCP keys and OAuth clients, scope, expiry, last use)
- `meter` (workspace, task, provider, model, tokens in, tokens out, cost estimate, ts)

Client SQLite mirrors threads, messages (bodies within the Cache window), attachments text, labels, tags, briefs, groups, section rules, settings, drafts and events, plus an FTS5 virtual table over subject, participants, snippet and body, and the `outbox` table of intents.

## API shape

One HTTP JSON API on the Server, typed routes, a generated client in `packages/shared`. Every request carries the Workspace id and a Device token (ADR 0006).

- `GET /changes?since=<cursor>`: ordered change events; woken by WebSocket, SSE or polling per mode.
- `/threads`, `/messages`, `/attachments`, `/labels`, `/tags`: read plus the write intents (archive, snooze, star, read, move, tag).
- `/drafts`, `/send` (schedules a send Job), `/scheduled`.
- `/groups`, `/sections`, `/routing/rerun`, `/routing/decisions`.
- `/workflows`, `/workflows/:id/versions`, `/runs`, `/runs/:id/retry`, `/runs/:id/approve`.
- `/sessions`, `/sessions/:id/turns` (the turn streams its events over SSE on the POST itself), `/sessions/:id/approvals/:activityId`, `/activity`, `/activity/:id/undo`, `/agent/tools`.
- `/calendar/events`, `/calendar/invites/:id/rsvp`.
- `/settings`, `/devices`, `/pair`, `/credentials`.
- `/mcp`: the external MCP transport (streamable HTTP).
- `/health`, `/capabilities` (protocol version, mode, features).

The Sidecar serves the same API on loopback with the per-launch token, plus the pairing UI when a Cloud is configured.

## Runtimes

- Local: Claude Code (`claude -p` stream-json via the user's binary), Codex (`codex app-server`), OpenCode (`opencode serve`), each behind one AgentSession interface, built-in tools stripped, monday's tools via the loopback MCP server (research 2, ADR 0002).
- Hosted: LangChain providers for Anthropic, Gemini, OpenAI, Kimi, OpenRouter; LangGraph agent loop with Postgres checkpoints; Roles main and fast per provider (ADR 0007).
- The tool server is one implementation with approvals inside; both runtime kinds call it.

## Security summary

- Root key held by the user as a recovery file; resident only in Server processes that must decrypt (Sidecar always; Cloud only if the user shares it for offline Briefs and Workflows). Threat model excludes root on the running host and the AI provider.
- Device tokens in the OS keychain; pairing, not passwords. HTTPS off loopback.
- Hosted keys per device unless explicitly shared with the Server, then stored under the envelope.
- Mail content is untrusted: runtimes never get shell or file tools unless Developer mode is on for a Session.
- No telemetry.
