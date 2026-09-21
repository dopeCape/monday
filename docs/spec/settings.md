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

## Sections

### Accounts
- List of Accounts with provider, sync state, last sync, native versus emulated actions (inbox spec), and a Remove that asks and explains what is deleted.
- Add account: Fastmail or JMAP (token paste), IMAP (autoconfig, then SRV, then guess, then manual), Gmail and Microsoft (the credential wizard from ADR 0008).
- Per Account: signature, default meeting link type, linked CalDAV calendar, Voice profile (view, edit, rebuild from sent mail, off by default).

### Appearance
- Mode: system, light, dark. Palette swatches for the seven shipped palettes plus Custom from file (token TOML or base16).
- Layout preset, then the three knobs, then density (compact, comfortable, spacious), font, font size, monospace font. Density and font size are per device.
- Views: list with name, shortcut, and knob summary; rename, reassign shortcut, delete; "Ask monday for a view" input.
- Config file: live view of the file with the watcher state and the warnings above.

### Routing
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
- Default Placement, ask-before-enable, notify on failure, Run log retention, Budget defaults for agentic steps.
- MCP servers: add by command or URL, auth, which tools become Workflow steps and Agent tools, remove.

### Sync server
- Current mode (Sidecar only, Cloud, both) with health and latency. The three upgrade cards (Vercel, Netlify, container) when Sidecar only. Devices list with pairing and revoke. Insecure server switch for private networks with its persistent warning.
- Storage: message count and size, Cache size cap and pre-warm window, encryption recovery file status with export.

### Shortcuts
- Keymap picker (Vim, Gmail, Natural), then the full binding table grouped by area, each remappable; conflicts highlighted.

### About
- Version, license, source link, check for updates, telemetry line stating there is none.

## Strings

Every user-visible string is a Setting keyed by name.
