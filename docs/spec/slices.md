# Ordered slices

Each slice is sized to one agent session, ends shippable on its own, and is gated by typecheck, module tests and the smoke (ADR 0009). Order follows the modules so every slice has what it needs. "Done when" is the test a reviewer runs.

## Phase 0: foundation

1. **Monorepo and packages.** Bun workspaces, `apps/desktop` from the existing scaffold, `apps/server` with the four entrypoints as stubs, `packages/shared` with the domain types from `CONTEXT.md`, `packages/ui` from `design/`. Done when: `bun run typecheck` passes and the desktop app renders the Stream preset from `packages/ui` with fixture data.
2. **Settings schema and config file.** Schema in `packages/shared`, TOML parser with comment-preserving edit, precedence and pinning per ADR 0001, Rust watcher, Shell reads knobs from it. Done when: editing `monday.toml` changes the palette live and the Appearance page shows the key as pinned.
3. **Server core.** Hono app, Postgres via drizzle, migrations, `jobs` table with leases and the in-process kicker, heartbeats, `/health` and `/capabilities`, embedded Postgres started by the Sidecar, per-launch token. Done when: the Sidecar boots from Tauri, creates the database, and the client pairs on loopback.
4. **Encryption.** Envelope keys, root key generation and recovery file, `store_content` seam that every body-derived write goes through. Done when: a message written through Mailstore is unreadable in `psql` and readable through the API.

## Phase 1: mail

5. **Providers: JMAP and IMAP.** Sync (state strings, QRESYNC or CONDSTORE tiers), send (EmailSubmission, SMTP), labels both ways, IDLE and EventSource in the Sidecar, polling fallbacks. Fake Provider with recorded mailboxes for tests. Done when: a Fastmail account and a Dovecot account sync end to end and the nightly contract test passes.
6. **Store and Changes feed.** SQLite schema via rusqlite commands, live queries, `/changes` with WebSocket wake, Outbox with intent replay and last-writer-wins. Done when: archive while offline replays on reconnect and the row never flickers.
7. **Inbox screen.** The stream and split layouts from `inbox.md` over the Store: rows, sections (deterministic rules only at this point), actions with native or emulated semantics, snooze Jobs, undo toasts, three keymaps, first-sync progress. Done when: the smoke screenshots every preset, density and theme against baselines.
8. **Reader and compose.** Thread view, collapsed history, attachments as encrypted blobs, drafts server-owned and mirrored, send as a scheduled Job with the Undo bar, send later, reply-all rule, rich text editor with plain-text alternative. Done when: a reply drafted offline sends 30 seconds after reconnect and appears in Fastmail's Sent.
9. **Providers: Gmail and Graph.** OAuth wizards from ADR 0008 with live-validated paste, Pub/Sub pull, history.list, Graph delta and webhooks (Cloud only), XOAUTH2 for their IMAP path. Done when: both nightly contract tests pass and the wizard completes in the target time on a fresh Google project.
10. **Search and palette.** FTS5 over the Cache, operator parser, pre-warm Job, headers index on the Server, results view, the single palette input. Done when: results render under 50 ms on a 50,000 thread fixture.

## Phase 2: intelligence and agent

11. **Hosted runtime and Meter.** LangChain providers, Roles, task-to-Role map as Settings, Meter rows, key storage per device and the share switch. Done when: a Brief for a fixture thread is produced by Haiku 4.5 and appears in the Meter with a cost estimate.
12. **Routing and sections.** Predicates, the classify call, thresholds, Needs a decision, corrections to Examples and Predicates, two-stage sub-groups, re-run with preview, Section rules, brief policy. Routing page from the mock. Done when: the fixture mailbox routes into the expected groups with the expected confidences and a correction changes the Predicate.
13. **Briefs.** Background computation under the brief policy, staleness, action chips as tool calls. Done when: opening a needs-reply thread shows a Brief that was computed before open, and a newsletter shows none until opened.
14. **Agent host and tool server.** The MCP tool server with tiers and approvals inside, Activity log, Sessions, LangGraph loop with Postgres checkpoints and interrupts, composer UI from `agent-composer.md` in bottom-bar mode. Done when: "archive every newsletter older than a week" previews above 10, applies, and Undo restores them, all through the Hosted runtime.
15. **Local runtimes.** Claude Code, Codex and OpenCode adapters behind AgentSession, detection, built-in tools stripped, Developer mode with its warning, runtime switch mid-Session. Done when: the same instruction as slice 14 works through the user's installed Claude Code and the Activity log shows identical entries.
16. **Workflows.** JSON schema, step runner on Jobs, triggers, built-in steps and the five integrations, agentic step via LangGraph with Budget, Placement, Dry run, Standing approvals, failure policy, versions, the Workflows page. Done when: the "Candidate intake" workflow from the mock runs on a fixture arrival, pauses at Slack without a Standing approval, and completes after one.
17. **Settings screens.** Every section of `settings.md` rendered from the schema, Devices and pairing UI, Activity log view, Meter view. Done when: no settings control exists outside the schema and the Agent can change any of them.

## Phase 3: calendar, external, onboarding

18. **Calendar.** Provider calendar operations from research 6, Local calendar and iMIP for IMAP, Week, Day, Agenda and Month, Today panel, invite bar, the scheduling tool with the approval card, 5 minute polling and Cloud webhooks, notifications. Done when: "set up a call with Aoife Thursday 15:00" creates one event on Google with a Meet link and Google sends the invite, not monday.
19. **External MCP.** `/mcp` on the Cloud and loopback on the Sidecar, `monday mcp` launcher, keys from Settings, OAuth 2.1 with the consent page, scope filtering, approvals routed to the owner's client, rate limits. Done when: a Claude Code session outside monday reads the inbox with a read key and is refused a send.
20. **Onboarding.** The conversation from `onboarding.md`, proposal lists with move counts, catalog Workflows with Dry runs, "set me up" rerun. Done when: a fresh Fastmail account ends onboarding with approved Groups and one enabled Workflow inside 5 minutes.
21. **Cloud modes and upgrade.** Vercel and Netlify entrypoints, kickers, pooled Postgres, capability flags, the three upgrade cards with Deploy buttons, pg_dump migration and re-pairing, the "both" failover with heartbeats. Done when: a Sidecar-only install upgrades to Vercel, the laptop closes, and a scheduled send still goes out.

## Phase 4: ship

22. **Distribution.** CI matrix for the Bun server and embedded Postgres per target, Windows exe signing, Tauri bundles for DMG, NSIS, AppImage, deb, rpm, updater with minisign, Homebrew cask, winget, Flatpak, AUR, Nix flake, COPR, apt repo, standalone server download and container image. Done when: a release tag produces every artifact and the updater moves a previous build forward on all three platforms.
23. **Release readiness.** Rename per issue 20, provider credentials per issue 19 wired into nightly contract tests, docs site with the self-host guides, the 5 minute install measured on a clean machine per platform. Done when: the measured install times are recorded in the README and under target.

## Dependencies at a glance

Slices 1 to 4 are sequential. 5 and 6 can run in parallel after 4. 7 needs 6; 8 needs 7; 9 needs 5; 10 needs 6. 11 needs 4; 12 and 13 need 11 and 7; 14 needs 11 and 8; 15 needs 14; 16 needs 14 and 12; 17 needs 14. 18 needs 9 and 14; 19 needs 14; 20 needs 12 and 16; 21 needs 3 and 6. 22 needs everything in phases 0 to 3; 23 is last.
