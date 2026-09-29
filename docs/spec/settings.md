# Settings, views and appearance behavior

Behaviors a tester can check. The settings schema lives in `packages/shared` and is the single source for the screens, the Agent's settings tool and the Config file validator (ADR 0001, ADR 0004).

## Rendering rules

- Every control is rendered from the schema: key, type, range or options, default, scope (global or per device), and help text. There are no hand-built settings screens.
- A control whose key is set in the Config file is Pinned: locked, showing "set in monday.toml" with the file value. Hovering shows the line. The Agent explains and offers to edit the file only after an explicit yes.
- Changing a control writes the Setting through the Store and applies at once. Undo is available from the toast.
- Invalid Config file lines show at the top of Appearance as warnings with line numbers and a "Fix with monday" button.
- Every control is a card with its label, help, the control, and a footer with the scope (per device or every device), the Pinned line, the default with Reset when the value differs, and any validation error. Danger actions (remove, revoke, delete) ask inline before they run.
- A search field at the top of the page finds Settings and panels by label, help, key, option labels and section or group names; results are the same cards grouped by section, with "Show in section" to jump to the card. `settings.search_key` focuses it; Escape clears it.
- The right-hand "On this page" index lists the current section's groups and follows the scroll position; it hides under `settings.index_min_width`.

## Disclosure

Show what the user's current choices make relevant; everything else is one deliberate click away, never gone.

- Every key has a tier in the schema: `primary` shows when its group shows; `more` (the default) sits behind the group's "More settings (n)" in place; `advanced` sits in one Advanced row at the bottom of the section, with a one-line warning. A group whose keys are all `more` folds to its heading with a one-line summary.
- A key may depend on other Settings (`visibleWhen`: equals, in, truthy, matches; the chain is followed). A key whose choice excludes it is not on the page. Groups may depend too (the Hosted providers need the Hosted runtime), fold (the providers other than the chosen one sit in one "Other providers" row that says which have a key, each expandable) or keep their own Advanced (each provider, TypeSafe).
- Each section opens with an overview card: its state in plain words and the two or three common actions. AI and agent at `off` is the level cards and nothing else.
- Search still finds every key. A result a choice keeps off the page says which choice brings it back, with one click to make that choice. "Show in section" and the index open whatever a target sits in; the index lists only what is on the page and marks what is folded.
- Disclosures open and close with the motion tokens and remember their state per section for the session.

## Sections

### Accounts
- List of Accounts with provider, sync state, last sync, native versus emulated actions (inbox spec), and a Remove that asks and explains what is deleted.
- Add account: Fastmail or JMAP (token paste), IMAP (autoconfig, then SRV, then guess, then manual), Gmail and Microsoft (the credential wizard from ADR 0008).
- Per Account, inside that Account's card: its own signature, meeting link, linked CalDAV calendar, Voice profile (view, edit, rebuild from sent mail, off by default).
- Sign-in apps, for the whole app: the Google and Microsoft OAuth app every Account of that provider signs in through, saved as soon as it validates.

### Appearance
- Mode: system, light, dark. Palette swatches for the seven shipped palettes plus Custom from file (token TOML or base16).
- Layout preset, then the three knobs, then density (compact, comfortable, spacious), font, font size, monospace font. Density and font size are per device.
- Views: list with name, shortcut, and knob summary; rename, reassign shortcut, delete; "Ask monday for a view" input.
- Config file: live view of the file with the watcher state and the warnings above.

### Routing
The Routing page itself is `routing.md`; this section of Settings holds the same pieces:
- Groups tree with each Group's sentence, confidence threshold, Sub-groups, and Example count; the Needs a decision queue with its cap.
- Sections, user-defined: each with its sentence, its deterministic conditions, its Judgment, where it shows (stream heading, nav entry, both), rename, hide, reorder, and "Ask monday to change". The shipped four are rows like any other.
- Custom actions per Group or Section: label, condition, the tool and its arguments, the Tier it renders with; add, edit, remove, and "Ask monday for an action".
- Brief policy editor: the current rule sentence, per-Group and per-Section overrides, and an optional custom prompt.
- Global thresholds, re-evaluation policy and lookback.

### AI and agent
- The three level cards first (`ai.level`: just mail, mail with an assistant, mail that sorts and acts for me), exactly as onboarding shows them; the rest of this section is hidden under `off` and the automation parts under `assist`.
- Runtime mode: Local CLI or Hosted, with the detected CLIs and their status, and the Hosted providers with key state.
- TypeSafe: the key (add, replace, remove; never displayed; validated live), its share switch with the threat-model line, "Judgments" (auto, TypeSafe, language model) and the pinned model. The Meter shows `judge.*` lines beside the Tasks.
- Per provider: main and fast Roles, the "Let the server use this key" switch with its one-line threat model, and the key itself (add, replace, remove; never displayed).
- Task-to-Role map with an exact-model override per Task, and effort per Task.
- Meter: this month by Task and provider, with cost estimates; no budgets.
- Permissions: the Tier list with the promote-to-always-ask toggle per reversible tool; Developer mode default; web fetch on or off.
- Activity log: searchable list of tool calls with tool, input summary, who approved, result, undo where still possible.

### Workflows
The Workflows page is `workflows.md`; this section of Settings holds the defaults:
- Default Placement, ask-before-enable, notify on failure, Run log retention, Budget defaults for agentic steps.
- MCP servers: the connected servers and "Connect a tool" (below).

#### MCP servers and Connect a tool

The research behind this is `docs/research/mcp-connect.md`.

**Where it opens.** Connect a tool opens from:
- Settings › Workflows › MCP servers.
- The Workflows page head, beside New workflow. It is hidden while Workflows are locked or no Server is reachable.
- The Agent. `search_mcp_catalog` (read-only) searches the catalog and lists what is connected. `connect_mcp` (always asks, ADR 0002) connects a registry entry or a URL after the user approves the card. The card shows the exact URL or command. When the server needs a key or other input, the Agent sends the user to Settings and never takes a secret itself.

**Search.**
- The client asks the Server, and the Server asks the MCP Registry. The desktop app needs no network rules of its own, and every Device shares one short cache.
- Search is live as you type, after `workflows.mcp_connect.debounce_ms`.
- Each result is a card: icon, title, publisher, one line, Hosted and/or Runs locally, and "Needs a key" or "Sign in if asked".
- "Add by URL" and "Add by command" cover anything not listed.
- When search is off (`workflows.mcp_registry.enabled`) or the registry does not answer, the page says so and the two Add paths still work.
- Keyboard:
  - Typing or `/` focuses the search.
  - The arrows move between cards.
  - Enter connects the focused card.
  - Escape closes, and cancels a sign-in that is still open.

**Connect.** Choosing a card connects at once when there is nothing to ask. Otherwise it shows only what the entry declares:
- **A hosted server with OAuth.** Connecting finds out: a server that answers 401 and publishes Protected Resource Metadata is marked OAuth, and the browser opens at once.
  - The Server runs the protocol with the MCP SDK's `auth()`: resource metadata, authorization server metadata, Dynamic Client Registration as a native app, PKCE S256, the `resource` parameter, then the code exchange.
  - The redirect comes back to the Sidecar's loopback listener, the same one the mail sign-in uses. On a Cloud server it comes back to its public `/mcp-servers/oauth/callback`.
  - The Server checks `state` and, when present, `iss`.
  - While the browser is open the page shows "Open the page again" and Cancel. Cancel forgets the pending sign-in, so a late redirect adds nothing.
  - The wait is `workflows.mcp_connect.sign_in_minutes`. The name the server's consent page shows is `workflows.mcp_connect.client_name`.
- **A hosted server with a key.** Only the declared headers or `{variables}` are asked for; Add by URL offers one optional key field. A server that refuses without OAuth metadata reads "Needs a key".
- **A local package.** Before Connect the page shows the exact command it will run (`npx`, `uvx`, `docker run` or `dnx`, from the entry's registry type). Only the declared arguments and environment variables are asked for; secret ones are masked, and optional ones start at their default. Add by command takes a command line and `NAME=value` lines, all sealed.
- After connecting, the server's tools are listed with every one on, and the user unchecks what Workflows and the Agent may not use. Everything on is saved as `[]`, "every tool", so a tool the server adds later is allowed too.

**The connected list.**
- One row per server:
  - Its title, where it runs, and how many tools it may use.
  - A status: Connected, Needs sign-in, Needs a key, Not answering, Needs the Sidecar, or Not checked yet.
  - Tools, which connects, lists and lets the user choose.
  - Sign in or Reconnect, with the same Cancel.
  - Remove, which asks first.
- The status comes from the last connection. An OAuth server with no tokens reads Needs sign-in without a network call.
- Every call a Workflow Step or the Agent makes sends the stored access token. On a 401 the SDK refreshes it with the refresh token. If the refresh fails the row reads Needs sign-in; nothing opens a browser in the background.

**Settings and secrets (ADR 0001, ADR 0004).**
- `workflows.mcp_servers` holds names, templates and the tools allowlist, written by the Server: the URL or command with its arguments, and the headers and environment variables with `{name}` holes where a secret goes.
- The values that open a server are sealed on the Server under the envelope, one row per server (`integration_secrets`, id `mcp:<name>`): a token, secret inputs, the registered OAuth client, the tokens, what discovery found, and a pending sign-in.
- The Setting lists the names of the sealed values in `secrets`, never a value. Non-secret inputs are written into the templates.
- An older entry that still carries `token` keeps working. The Server moves the token into the sealed store the next time it is unlocked.
- A Config file may pin `workflows.mcp_servers`. The list then shows as pinned and Connect a tool is not offered (ADR 0001).
- The behaviors are Settings:
  - `workflows.mcp_registry.enabled`, `.url` (any registry speaking the official API, default `https://registry.modelcontextprotocol.io/v0.1`), `.results` and `.cache_minutes`.
  - `workflows.mcp_connect.debounce_ms`, `.sign_in_minutes`, `.timeout_seconds` and `.client_name`.
  - Every word is a `strings.mcp.*` Setting.

**Sidecar and Cloud (ADR 0005, ADR 0008).**
- A hosted (URL) server works from any Server. Its OAuth tokens are shared through the database, so a Workflow on the Cloud server uses a sign-in made from the Sidecar.
- A local (stdio) server runs on the machine running the Server that makes the call: the Sidecar, or a container that has the runtime (`npx`, `uvx`, `docker`) installed. Vercel and Netlify cannot start processes. There, adding one is refused, and an existing one reads "Needs the Sidecar".
- A Workflow Step that calls a local server and runs on a Vercel or Netlify Server fails with "Needs the Sidecar". Open item: routing such Steps' Jobs only to a Server that can start processes.

### Sync server
- Current mode (Sidecar only, Cloud, both) with health and latency. Background service (ADR 0013): running since, PID and memory, who runs it, locked or not, Restart and Stop (asked first), Start when stopped; Start at login (`server.sidecar.start_at_login`). The three upgrade cards (Vercel, Netlify, container) when Sidecar only. Devices list with pairing and revoke. Insecure server switch for private networks with its persistent warning.
- Storage: message count and size, Cache size cap and pre-warm window, encryption recovery file status with export.

### Shortcuts
- Keymap picker (Vim, Gmail, Natural), then the full binding table grouped by area, each remappable; conflicts highlighted.

### About
- Version, license, source link, check for updates, telemetry line stating there is none.

## Strings

Every user-visible string is a Setting keyed by name.
