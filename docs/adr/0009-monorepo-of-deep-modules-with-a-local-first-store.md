---
status: accepted
---

# A Bun monorepo of deep modules, with a local-first Store as the client's only data path

We decided on one repository with Bun workspaces: `apps/desktop` (Tauri), `apps/server` (Hono with four entrypoints), `packages/shared` (domain types, settings schema, workflow schema, config file parsing, generated API client) and `packages/ui` (the token system and components from `design/`). The codebase is organised as deep modules, each with one interface at one seam:

| Module | Lives in | Interface hides |
|---|---|---|
| Providers | server | Gmail, Graph, JMAP and IMAP adapters behind one sync, send and calendar interface |
| Mailstore | server | envelope encryption, threads, messages, labels, tags, attachments |
| Jobs | server | the leased step runner and the four kickers (process, Vercel, Netlify, Inngest) |
| Intelligence | server | routing, sections, briefs, LangGraph, Roles, the Meter |
| Automation | server | workflows, runs, versions, standing approvals |
| Agent host | server (Sidecar) | the MCP tool server, the CLI adapters, sessions, the Activity log |
| Calendar | server | events, invites, RSVP across providers |
| Store | desktop | SQLite Cache via Rust commands, the Outbox, the Changes feed subscription, live queries |
| Shell | desktop | layout knobs, views, panels, theming from Settings and the Config file |

The client reads only from the Store, never from the network; writes go to the Store, which applies them locally and enqueues an intent. UI-only state is plain React state. The UI is React 19 over CSS custom properties from `packages/ui`, Phosphor icons, no Tailwind and no component library, so a palette file is the entire theming story.

## Considered options

- Two repositories. Rejected: shared schemas drift once they are a published package.
- A server-state library with SQLite as fallback. Rejected: two read paths, and offline becomes a special case.
- A separate agent-host process. Rejected: a second sidecar, token and lifecycle for no isolation the Sidecar cannot provide as a module.
- Tailwind or shadcn/ui. Rejected: a second styling system the Config file could not drive.

## Consequences

- Each module is tested through its interface with fakes at the seam; one headless end-to-end smoke boots the real Sidecar and screenshots every layout, density and theme; provider contract tests run nightly against live test accounts. Typecheck, module tests and the smoke gate every merge.
- The existing scaffold in `src/` and `src-tauri/` moves into `apps/desktop`; the mock in `design/` becomes the seed of `packages/ui`.
- LangChain and LangGraph bundle size on the compiled Bun Sidecar is verified in the first server slice.
