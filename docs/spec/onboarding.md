# Onboarding

Optional. The first screen and the keymap question run on first launch, before any Account exists, and end by connecting the first Account; the conversation runs after that Account syncs. Its only job is to gather context and seed good defaults so the app is useful from the first minute. Skipping it loses nothing that cannot be asked of the Agent later.

## First screen: what do you want

Before any conversation, one plain screen with three choices. It is the only step that is not a chat, because it decides whether there is a chat at all. AI is never pushed; the choice is the user's and it can change at any time.

- **Just mail.** No AI at all: no agent bar, no Briefs, no routing, no Workflows, no model calls, no provider key asked for. monday is a fast mail client with Groups the user makes by hand, search, keymaps and the calendar. The conversation is skipped; the keymap question still asks, then the first Account is connected.
- **Mail with an assistant.** The agent bar and what it reaches (draft, find, summarize, change settings, undo), Briefs on open, and the Task map. No routing, no automation, nothing runs without the user asking. Onboarding continues with the conversation below, minus the Groups and Workflows proposals.
- **Mail that sorts and acts for me.** Everything: routing into Groups, background Briefs under the policy, Workflows with their approvals. The full conversation below.

After the cards and the keymap comes "Connect an account" (Fastmail or JMAP, IMAP, Gmail, Microsoft) with "Connect later" as the way out; the welcome is recorded once so it never re-asks. Each Account added afterwards gets its own offer, opening on the conversation (or on nothing at all under Just mail).

The choice is the Setting `ai.level` (`off`, `assist`, `automate`). It shows at the top of Settings › AI and agent as the same three cards, and the Agent can change it when asked. Moving down never deletes anything: Groups, Workflows and Briefs stay stored and disabled, and come back on moving up. Moving up from `off` asks for a runtime (a local CLI or a key) only then, not before.

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

- "Set me up" in the composer at any time runs the same conversation on an existing Workspace, starting again from the three choices. Existing Groups and Workflows are never changed without approval; new proposals are added beside them.
- Each new Account gets its own onboarding offer.
