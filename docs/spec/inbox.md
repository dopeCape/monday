# Inbox behavior

Behaviors a tester can check. Every default below is a Setting (ADR 0004) unless marked fixed. Vocabulary is from `CONTEXT.md`.

## Stream

- Sections appear in the user's order. Default: Needs your reply, Waiting on you, For your information, Newsletters.
- Inside a Section, Threads are ordered by newest activity first.
- An empty Section is not rendered. An empty Inbox shows one line, "Nothing needs you", and nothing else.
- A Thread is in exactly one Section and at most one Group plus one Sub-group.

## Rows

Row fields are a Setting; defaults per density:

| Density | Stream row | Split row |
|---|---|---|
| Compact | dot, sender, subject, snippet, group label, attachment mark, time on one line | dot, sender, time; subject |
| Comfortable | same as compact, larger | dot, sender, time; subject; one snippet line |
| Spacious | same, with a second snippet line | dot, sender, time; subject; two snippet lines |

- Unread: filled dot, sender in bold, subject in medium weight. Read: no dot, sender in muted color.
- Exactly one Group label per row, the deepest (Sub-group over Group). No Section label in the row.
- No avatars, no colored pills, no icons other than the attachment mark (fixed, calm rule).
- Hover reveals archive, snooze and ask actions on the right and hides the time.

## Action semantics

Each action maps to the provider's native concept where one exists and is emulated on the Server otherwise. Settings › Accounts lists native versus emulated per Account.

| Action | Gmail | Microsoft Graph | JMAP | IMAP |
|---|---|---|---|---|
| Archive | remove INBOX label | move to Archive | remove inbox mailbox | move to Archive folder |
| Delete | move to Trash | move to Deleted Items | move to Trash | move to Trash |
| Permanent delete | from Trash only, always-ask | same | same | same |
| Star | STARRED label | flag | $flagged | \Flagged |
| Read | native | native | $seen | \Seen |
| Snooze | emulated | emulated | emulated | emulated |
| Mute | native | emulated | emulated | emulated |

- Snooze removes the Thread from Inbox with archive semantics and stores a wake time on the Server. A Job returns it to Inbox as unread at the top of its Section. Snooze picker offers later today, tomorrow morning, next week, pick a time; the presets are Settings.
- Read state syncs both ways with the provider; reading elsewhere clears it here within one poll.
- Every action shows an undo toast; Z undoes the last one. Mark-all-read is undoable.
- Batch actions above 10 Threads preview first (ADR 0002).

## Briefs

- A Brief is at most three bullets: what happened; what is asked of you or waiting; context (Group, a Workflow that already ran, a related Thread). Then up to three action chips from a fixed catalog: reply with a proposed line, forward to a person, add to calendar, snooze until, archive, open a link. Each chip is an ordinary tool call with its Tier.
- Shown only in the reader, never in a row.
- A Thread with one message under 120 words gets no Brief.
- Recomputed when a new message arrives on the Thread, or when the user asks.
- **Brief policy.** Which Threads get a Brief in the background is a rule the user owns, in the same shape as a Section rule. Default: Needs your reply and Waiting on you always; For your information only with two or more messages, an attachment, or more than 800 words; Newsletters and automated senders (List-Unsubscribe, noreply, precedence bulk) never. Anything else is computed on open. The user may replace the rule with their own sentence, a per-Group or per-Section override, or a custom prompt that lets the model judge importance. With no Hosted runtime, all Briefs are computed on open by the Local runtime.

## Keyboard

- Three built-in keymaps chosen in Settings: Vim (default), Gmail, Natural. Every binding is remappable in the Config file.
- Vim defaults: J/K move, Enter opens, Esc closes the sheet, E archive, H snooze, S star, # delete, L label, M move to Group, R reply, A reply all, F forward, X toggle multi-select, Shift-J and Shift-K extend selection, Z undo, / agent, ⌘K palette, ⌘1..9 views.
- After archive, snooze or delete the selection advances to the next Thread and the row collapses; in the sheet the next Thread opens. Direction and open-next are Settings.
- Multi-select applies the same keys to every selected Thread.

## First sync and offline

- First sync fills the stream progressively as headers arrive, with a thin progress line at the top ("Syncing, 1,204 of 12,418"). Sections form as routing runs. Nothing blocks.
- Offline: the workspace header dot turns grey. Rows stay interactive through the Outbox. The agent bar says hosted work is unavailable; Local runtime work continues.
- Unread counts in the nav come from the Server and update through the Changes feed.

## Strings

Every user-visible string on this screen is a Setting keyed by name, so the Agent can change wording on request.
