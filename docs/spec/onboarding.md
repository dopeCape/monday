# Onboarding

Optional. The first screen and the keymap question run on first launch, before any Account exists, and end by connecting the first Account; the conversation runs after that Account syncs. Its only job is to gather context and seed good defaults so the app is useful from the first minute. Skipping it loses nothing that cannot be asked of the Agent later.

## First screen: what do you want

Before any conversation, one plain screen with three choices. It is the only step that is not a chat, because it decides whether there is a chat at all. AI is never pushed; the choice is the user's and it can change at any time.

- **Just mail.** No AI at all: no agent bar, no Briefs, no routing, no Workflows, no model calls, no provider key asked for. monday is a fast mail client with Groups the user makes by hand, search, keymaps and the calendar. The conversation is skipped; the keymap question still asks, then the first Account is connected.
- **Mail with an assistant.** The agent bar and what it reaches (draft, find, summarize, change settings, undo), Briefs on open, and the Task map. No routing, no automation, nothing runs without the user asking. Onboarding continues with the conversation below, minus the Groups and Workflows proposals. With a TypeSafe key the palette also answers typed sentences without a Session.
- **Mail that sorts and acts for me.** Everything: routing into Groups and Sections the user describes in their own words, background Briefs under the policy, custom actions per Group, Workflows with their approvals. The full conversation below. The sorting runs on TypeSafe when its key exists and on the language model otherwise.

After the cards and the keymap comes "Connect an account" (Fastmail or JMAP, IMAP, Gmail, Microsoft) with "Connect later" as the way out; the welcome is recorded once so it never re-asks. Each Account added afterwards gets its own offer, opening on the conversation (or on nothing at all under Just mail).

The choice is the Setting `ai.level` (`off`, `assist`, `automate`). It shows at the top of Settings › AI and agent as the same three cards, and the Agent can change it when asked. Moving down never deletes anything: Groups, Workflows and Briefs stay stored and disabled, and come back on moving up. Moving up from `off` asks for a runtime only then, not before. The runtime step offers three ways in, each a card with what it needs and what it unlocks: **TypeSafe** (paste a TypeSafe key; sorting into Groups and Sections, chips, the brief policy and the palette's typed sentences run on it for a fraction of a cent, no conversation), **a language model** (an Anthropic, Gemini, OpenAI, Kimi or OpenRouter key, or Claude Code, Codex or OpenCode found on this computer; the composer, Briefs and Workflows), or **both**, which is the recommended card when the level is "sorts and acts for me". Any card can be added later under Settings › AI and agent; a TypeSafe key pasted anywhere is validated live against its models endpoint before it is saved.

## First sync

Connecting the first Account, from the welcome's connect step or Settings › Accounts, leads to one screen that stands in for the whole app until the Inbox is fetched; so does any launch where the current Workspace's first sync has not finished. Nothing else is mounted behind it: no nav, no palette, no agent bar, no keymap. Two ways out are always there: the account header opens the workspace switcher (every Account, the current one checked, then Add an account, which goes through Settings › Accounts), and Settings opens the app's Settings with a way back to the screen. Picking another Account opens that Workspace, behind its own first sync screen if it has not finished. Once the wait is over it steps aside with one slow beat of the motion tokens (none with transitions off) and the app opens; the per-Account conversation offer follows as above.

- **Fetched** means the newest part of the Inbox, not all of it: Gmail lets an app read about 300 Messages a minute (6,000 quota units per user per minute, 20 per Message, for Google Cloud projects made after May 2026), so a 60,000 message Inbox would block for hours. Per the Setting `sync.first_run_wait`: `headers`, a mirror row for each of the newest `sync.first_run_messages` Inbox Messages (default 1,000; 0 means the whole Inbox); or `inbox_bodies` (the default), that and the body of the newest `sync.first_run_bodies` Inbox Messages inside `sync.body_window_days` (default 200), so the first Threads opened render at once. Everything older keeps arriving after the app opens, and the screen says how many ("Your 66,463 older emails keep arriving in the background"). The definition lives in `packages/shared/src/first-sync.ts`; the Server counts from `sync_messages` and its `body_state` (`GET /accounts/:id/sync`), and the engine fetches the Inbox's newest bodies right after its headers, before the other folders. Completion latches per Workspace, so later mail never brings the screen back.
- **What it shows**: the address and the Provider's mark; one line per phase with its count ("Finding your messages 1,204 of 12,418", "Fetching messages 380 of 640") and a bar that never goes backwards, also across a restart; the time remaining from the recent rate, hidden until the estimates agree; why it waits; and, while the Provider paces for quota (Gmail after a rate-limit refusal), a calm line saying so.
- **On an error** (sign-in refused, Provider unreachable, anything else) it says why in plain words and adds Retry, which clears the failure and syncs now; Settings then opens on the Accounts section, where the Account can be reconnected or removed. A removed Account takes the app back to the Accounts screen.
- The screen reads the Server every `sync.first_run_poll_seconds`; closing and reopening the app, or restarting the Server, resumes where it was, since the progress is the mirror's.

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
