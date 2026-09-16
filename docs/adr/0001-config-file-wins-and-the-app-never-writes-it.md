---
status: accepted
---

# The config file is the user's: it wins over saved settings, and the app never writes it unasked

monday has two places a preference can live: `monday.toml` (per machine, hand-edited, driven by rices and dotfiles) and the server database (written by the settings UI and the Agent, synced to every device). We decided that a key set in the file always wins over the same key in the database, and that neither the UI nor the Agent writes the file on its own. A key the file sets shows as pinned in the UI, and the Agent may edit that one key only after the user explicitly says so, using a comment-preserving edit.

## Considered options

- The app rewrites the file on every change. Rejected: destroys comments and ordering, which is the whole point of a rice.
- Comment-preserving in-place edits by default. Rejected: still makes the file a shared write target and creates races with editors and dotfile managers.
- Two files, one for the user and one for the app. Rejected: two places to read, and the app-owned file would have to be synced anyway.

## Consequences

- The file holds preferences only, never data or secrets. Accounts, Groups, Routing rules, Workflows and Tags are server data with their own UI.
- The file is per machine and the database is shared, so density, font size and window state are marked per device in the database.
- A user who pins a key in the file and then asks the Agent to change it gets an explanation and an offer, not a silent no-op.
- Invalid or unknown keys are warnings; a syntax error keeps the last good config; the app never crashes on config.
