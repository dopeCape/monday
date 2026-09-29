# Inbox behavior

Behaviors a tester can check. Every default below is a Setting (ADR 0004) unless marked fixed. Vocabulary is from `CONTEXT.md`.

## Stream

- **The Inbox is one plain list of every Thread in the Inbox, newest activity first.** No Section headings and no routing in it: it is the whole mailbox at a glance. Groups and Sections never split or reorder it.
- **Sections live in the nav only**, under Groups, in the user's order, with unread counts. Clicking one shows that Section's Threads as their own list (a lens). Default Sections: Needs your reply, Waiting on you, For your information, Newsletters; a Section the user defined ("Invoices I still owe") sits beside them. A Section is a view onto the Inbox, never a move out of it.
- **Sections need an AI that can sort** (`sections.require_ai`, default on): a TypeSafe key, a language model key (here or shared with the Server), or a coding agent CLI, at an AI level above Just mail. Without one the nav lists no Sections, only one quiet line (`strings.nav.sections_off`) with a link to the AI settings; the Inbox stays one list. Turning the Setting off keeps rule-only Sections.
- **Needs your reply decides on Judgments alone**: judged to need a reply, and neither automated nor a newsletter. Shipment notices, one-time codes and payment receipts never land there, and a Thread not judged yet sits in For your information until the Judge answers.
- The nav lists every Group and Sub-group the user has, in the user's order, with unread counts; a Group or Section created a moment ago by the Agent appears without a reload.
- Inside any list, Threads are ordered by newest activity first.
- A Section with no Threads stays in the nav with no count. An empty Inbox shows one line, "Nothing needs you", and nothing else.
- A Thread is in exactly one Section and at most one Group plus one Sub-group.
- **The Filter menu** in the list header narrows whichever list is shown (the Inbox, a Section, a Group, a Mail folder, the search results): Unread, Starred, Has attachments, Needs a reply, a Year, a Person (a sender), a Domain (a sender's domain) and a Date (this week, this month, or two days picked). Year, Person and Domain list their choices from the whole Cache with counts, years newest first, people and domains most mail first (`inbox.filter_facet_limit`), typed ahead over the whole Cache. Picks stack as chips under the header and combine with AND; a chip's click removes it, Escape removes the last one, Clear all removes every one. The list and its count come from the Cache, not from the Threads held in memory, and grow on scroll like the Inbox. Chips last for the session, per Workspace. The menu opens from its key (`list.filter`: Shift-F in Vim and Gmail) and from the palette.

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
- Hover shows a checkbox where the dot sits; while any row is selected every row shows one. At rest there is no checkbox column.
- The time reads "09:41" today, "Yesterday", a weekday within the week, "Mar 12" earlier this year, and "Mar 12, 2025" for anything from an earlier calendar year (fixed). The reader, Drafts and the other lists follow the same rule.

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
- Every action shows an undo toast; Z undoes the last one, whole batches included.
- Custom actions: a Thread whose Group or Section carries custom actions shows them in the reader toolbar after the built-in ones and as chips under the Brief; each is a tool call with its Tier, so a "forward to accounting" asks and an "archive and tag" just runs with Undo.
- Batch actions above 10 Threads preview first (ADR 0002), whichever way they start: a key, the selection bar, a typed sentence.

## Composing several messages at once

- A compose window can be **minimized**: it collapses into a chip docked along the bottom edge (subject or "New message", recipient, a dot when unsent changes exist). Several can be minimized at once; clicking one restores it, the others stay docked. Each is an ordinary Draft, so it survives a restart and is also in Drafts.
- Opening a new message while one is open minimizes the open one instead of replacing it. Closing a window with content keeps the Draft (Discard is explicit, with Undo).
- Keyboard: a shortcut cycles through open and minimized drafts; Esc minimizes rather than closes when the draft has content.
- All of it is Settings (and so config file keys): whether windows minimize or close by default, where the dock sits (bottom right, bottom left, bottom full width), the most minimized windows shown before they collapse into "+N", whether a new message minimizes the current one or stacks beside it, and the window style (floating sheet, docked, full screen).

## Briefs

- A Brief is at most three bullets: what happened; what is asked of you or waiting; context (Group, a Workflow that already ran, a related Thread). Then up to three action chips from a fixed catalog: reply with a proposed line, forward to a person, add to calendar, snooze until, archive, open a link. Each chip is an ordinary tool call with its Tier. Recommended actions (`actions.md`, slices 34 and 35) replace this choice: the chips come from Signals before any Brief exists, and the Brief keeps only the reply's proposed line.
- Shown only in the reader, never in a row.
- A Thread with one message under 120 words gets no Brief.
- Recomputed when a new message arrives on the Thread, or when the user asks.
- **Brief policy.** Which Threads get a Brief in the background is a rule the user owns, in the same shape as a Section rule. Default: Needs your reply and Waiting on you always; For your information only with two or more messages, an attachment, or more than 800 words; Newsletters and automated senders (List-Unsubscribe, noreply, precedence bulk) never. Anything else is computed on open. The user may replace the rule with their own sentence, a per-Group or per-Section override, or a custom prompt that lets the model judge importance. With no Hosted runtime, all Briefs are computed on open by the Local runtime.

## Keyboard

- Three built-in keymaps chosen in Settings: Vim (default), Gmail, Natural. Every binding is remappable in the Config file.
- Vim defaults: J/K move, Enter opens, Esc closes the sheet, E archive, H snooze, S star, # delete, L label, M move to Group, R reply, A reply all, F forward, X toggle multi-select, Shift-J and Shift-K extend selection, Z undo, / agent, ⌘K palette, ⌘1..9 views.
- After archive, snooze or delete the selection advances to the next Thread and the row collapses; in the sheet the next Thread opens. Direction and open-next are Settings.
- Multi-select applies the same keys to every selected Thread.

## Multi-select

- A row's checkbox toggles it without opening it; Shift-click selects every row from the last one toggled (by click or X). X and Shift-J/K select the same way and show in the checkboxes. The rows selected carry the selected style.
- While a selection exists the **selection bar** replaces the list header: a checkbox, the count ("3 selected"), and the actions, each with its key in the tooltip: Archive, Delete, Mark read or Mark unread (whichever fits most of the selection), Star or Unstar (Unstar only when every one is starred), Snooze (the snooze picker), Move to (the Group picker), and More. More holds the other read and star action, Label, and the custom actions every selected Thread carries (one that asks first confirms on a second pick; forward and draft stay in the reader, one Thread at a time). Clear or Esc ends the selection and the header comes back.
- The bar's checkbox selects every row shown, or none once all are. When the list holds more Threads than the rows shown (the Store keeps only a window in memory), a link then offers "Select all N in <list>", counted over the whole Cache; picked, the bar says "All N in <list> selected" and every action, from the bar or a key, applies to the list's Threads by its query, not only the rows held. It works in the Inbox, a Group lens, a Mail folder and a list the Filter menu narrowed; a search, a Section lens and Needs a reply select only the rows shown. Unchecking a row falls back to the rows shown, less that one.
- In Archive the bar offers Unarchive in place of Archive.
- Every bar action runs the batch path: the preview above `inbox.batch_preview_above` (it names the Threads the list holds and counts them all), the same undo toast ("Archived, 12 threads"), the same approvals.
- The list header carries the search and the Filter menu only; there is no More menu and no mark-all-read. Selecting all, then Mark read, does the same.

## First sync and offline

- First sync fills the stream progressively as headers arrive, with a thin progress line at the top ("Syncing, 1,204 of 12,418"). Sections form as routing runs. Nothing blocks.
- Offline: the workspace header dot turns grey. Rows stay interactive through the Outbox. The agent bar says hosted work is unavailable; Local runtime work continues.
- Unread counts in the nav come from the Server and update through the Changes feed.

## Strings

Every user-visible string on this screen is a Setting keyed by name, so the Agent can change wording on request.
