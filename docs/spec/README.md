# monday v1 build spec

monday is a calm, agent-first email client: a Tauri desktop app for Linux, macOS and Windows, plus a self-hosted TypeScript sync server that runs as a Sidecar beside the client, in a container, or on Vercel or Netlify, any combination sharing one Postgres. Single user, many mail accounts, free, MIT.

This directory is the spec. It is an index, not a restatement: every decision lives in exactly one place and is linked from here.

## Read in this order

1. [`CONTEXT.md`](../../CONTEXT.md), the glossary. Every term in every document below is defined there.
2. The eleven ADRs in [`docs/adr/`](../adr/), the architecture. Each is one page.
3. [`architecture.md`](./architecture.md), how the modules, deployments and data fit together, with the data model and API shape.
4. The behavior specs: [`inbox.md`](./inbox.md), [`agent-composer.md`](./agent-composer.md), [`settings.md`](./settings.md), [`external-mcp.md`](./external-mcp.md), [`onboarding.md`](./onboarding.md).
5. [`slices.md`](./slices.md), the ordered implementation plan.
6. The research under [`docs/research/`](../research/) on the `research/*` branches, for the provider and platform facts behind the decisions.

## Decisions by area

| Area | Where |
|---|---|
| Config file, settings, pinning | ADR 0001, ADR 0004, `settings.md` |
| Agent tools, tiers, approvals, activity log | ADR 0002, `agent-composer.md` |
| Workflows, triggers, steps, runs | ADR 0003 |
| Routing, sections, briefs | ADR 0004, `inbox.md`, issue 11 |
| Sync topology, jobs, cache, outbox | ADR 0005, `architecture.md` |
| Client protocol, device pairing, TLS, versioning | ADR 0006 |
| Hosted runtimes, model roles, meter, keys | ADR 0007 |
| Install, cloud upgrade, channels, CI | ADR 0008 |
| Repo, modules, store, tests, UI stack | ADR 0009 |
| Drafts, send, voice, attachments | ADR 0010 |
| Search and command palette | ADR 0011 |
| Calendar | issue 15, issue 16, research 6 |
| External MCP | `external-mcp.md` |
| Onboarding | `onboarding.md` |
| Design system and layouts | `design/README.md`, `design/` mock |

## Standing rules

- Speed, functionality and UI/UX, in that order.
- Every product behavior is a Setting with a default, never a constant (ADR 0004).
- Anything that leaves the mailbox or reaches a third party asks first (ADR 0002).
- The config file is the user's; the app never writes it unasked (ADR 0001).
- Search and the list never wait on the network or a model (ADR 0011).
- No telemetry.

## Out of scope for v1

Mobile clients, multi-user servers, PGP, a unified inbox across accounts, shared-calendar writes, room booking, propose-new-time, voice input, Snap and the Microsoft Store, a hosted instance run by the project.

## Open items carried into implementation

- Flathub policy on prebuilt Bun and Postgres binaries; whether the Nix package builds from source.
- Plain-language schedule to cron: supported phrases and how ambiguity is confirmed.
- Attachment preview in the reader and Server storage limits.
- Desktop notification policy beyond calendar and workflow failures.
- Agent memory across Sessions beyond the Voice profile.
- Backup, export and account deletion.
- Spam handling.
- The release name (issue 20) and provider test credentials (issue 19).
