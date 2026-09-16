# Onboarding

Optional. Runs after the first Account syncs. Its only job is to gather context and seed good defaults so the app is useful from the first minute. Skipping it loses nothing that cannot be asked of the Agent later.

## Form

- A short conversation with the Agent in the composer, not a form. Five questions at most, each answerable in one sentence or a chip: who you are and what you do; what mail matters most (chips built from the top senders already synced); which tools you use (Slack, Notion, Drive, Discord, chips); whether monday may learn your voice from sent mail (off unless yes); whether monday may read the last 30 days to propose Groups (off unless yes).
- Every step has Skip. Closing the panel skips the rest.

## What it reads

- Only with the explicit yes above: the last 30 days of mail headers and, for the top senders, bodies, on the Runtime in use. Without the yes it uses only the sender list.
- Runtime: the Local runtime if configured, else the Hosted runtime, else it seeds from deterministic signals only.

## What it seeds

- Groups and Routing rules: proposed from the answers and the mail read, shown as a list with the sentence and the count of existing Threads that would move. Nothing is applied until the user approves the list; approval is reversible with one Undo.
- Section rules: the four defaults, renamed if the user's words suggest it.
- Workflows: at most two proposals drawn from a catalog matched to the tools chosen (for example, invoices to Drive; candidates to Notion), each shown with its Dry run result and enabled only on approval.
- Views: none by default; a Focus view is offered if the user said they get a lot of mail.
- Settings: keymap (asks Vim, Gmail or Natural once), density from screen size, notification defaults.

## Later and again

- "Set me up" in the composer at any time runs the same conversation on an existing Workspace. Existing Groups and Workflows are never changed without approval; new proposals are added beside them.
- Each new Account gets its own onboarding offer.
