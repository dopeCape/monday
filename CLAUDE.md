# monday

Read `docs/spec/README.md` before any work. It indexes the glossary (`CONTEXT.md`), the ADRs (`docs/adr/`), the behavior specs and the slice plan (`docs/spec/slices.md`). Use the glossary's terms exactly.

## Layout

- `apps/desktop`: Tauri 2 app, React 19. `src-tauri/` is Rust. Rust builds need `nix-shell` (see `shell.nix`).
- `apps/server`: Bun + Hono. `src/app.ts` is a runtime-neutral fetch handler; Bun-only APIs live under `entry/`.
- `packages/shared`: domain types, settings schema, workflow schema, config file parser, API client types. No runtime dependencies on Bun or the DOM.
- `packages/ui`: tokens, CSS, components. The mock in `design/` is the visual reference.

## Rules

- Every product behavior is a Setting with a default in the schema, never a constant (ADR 0004).
- Anything that leaves the mailbox asks first; approvals live inside tools (ADR 0002).
- The config file is the user's; the app never writes it unasked (ADR 0001).
- No Tailwind, no component library, no CSS-in-JS. Phosphor icons only. No em-dashes in user-facing strings.
- Tests: each module through its interface with fakes at the seam (`bun test`). Typecheck with `bun run typecheck`.
- Commits end with the Co-Authored-By trailer given by the harness.
