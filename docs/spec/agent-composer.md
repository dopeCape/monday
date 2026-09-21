# Agent composer behavior

Behaviors a tester can check. Every default is a Setting (ADR 0004) unless marked fixed. Tool tiers and approvals are from ADR 0002; runtimes from ADR 0007.

## Surface

- The composer is one text input with the monday mark, present in every Workspace, positioned by the `agent` knob: bottom bar, left column or right column.
- Bottom bar: a single input floating over the content. Focus or `/` raises a panel above it holding the current Session. Esc collapses the panel; the input stays.
- Left or right column: the Session is always visible; the input sits at the bottom of the column. Suggestions appear above the input only when the Session is empty.
- The header of the panel or column shows the Runtime in use (Claude Code, Codex, OpenCode, or the Hosted provider and model) and the Workspace address. Clicking it opens Settings › AI.
- Voice input is not in v1 (fixed for v1).

## Organizing mail by talking

- "Put newsletters in a folder called Reading", "show me invoices I still owe at the top", "give invoice threads a forward-to-accounting button", "candidates go under Hiring" are one turn each. The Agent has tools that create, change and delete Groups, Sub-groups, Sections and custom actions from a sentence: `create_section` (sentence, conditions, Judgment, placement), `update_section`, `create_group` and `update_group` (already present), `create_action`, `update_action`, `delete_action`, and `move_threads` for the existing mail.
- Every one is reversible and shows a card naming what will exist and how many existing Threads move; the Judgment's question text is shown on the card and saved as a Setting the user can reword.
- A Section or Group the Agent creates shows in the nav and the stream at once, through the Changes feed, and the routing of existing Threads runs as a Job with a preview above the threshold.

## Sessions

- Enter sends. Shift-Enter inserts a newline. The input clears and the message appears as the user turn.
- A new Session starts with the plus button, with `/new`, or automatically after 24 hours of inactivity. History lists past Sessions by first message and date; opening one resumes it.
- A Session is bound to one Workspace. Switching Workspace in the nav starts or resumes that Workspace's latest Session. An explicit "switch to my personal account" inside a Session shows a switch card and rebinds the Session.
- Retention: Sessions are kept 90 days on the Server, then summarized to one line in the Activity log.
- Switching Runtime mid-Session is allowed from the header; the transcript is replayed to the new Runtime as context. Tool calls already made are not repeated.

## Streaming and cards

- Assistant text streams token by token. Tool calls render as cards in the order they happen, each with a title, a one-line detail and a status: running, done, failed, waiting.
- Search results, calendar events and drafts render inside the card in the same visual language as the rest of the app (thread rows, event rows), never as raw JSON.
- A reversible action card shows Undo. An always-ask card shows the exact payload (recipients and text for send, the list of Threads for a batch, the event for an invite) and Approve, Edit, Cancel. Edit opens the payload in the right editor (compose, event form) and returns to the card.
- A batch above 10 Threads shows the list first with a count and one Apply.
- A card whose Runtime built-in tools were used in Developer mode is marked with a warning glyph and the tool name.
- Errors render as a card with the failure and a Retry. Offline: hosted work shows one line, "Offline, hosted work paused", and Local runtime work continues.

## Suggestions

- Up to four chips, shown when the Session is empty and when the panel first opens. Sources, in order: pending approvals and failed Runs, threads in Needs your reply, the current Thread's Brief actions, and two evergreen prompts. Chips are plain sentences, no icons.
- Clicking a chip sends it as a user turn.

## Handoffs

- `/` from anywhere focuses the composer. Tab from the search box or palette sends the typed text with the parsed operators attached. "Ask" in the reader header sends "About this thread" with the Thread attached.
- Attaching context: dragging a Thread or an Event onto the input attaches it. The Agent sees attached items as tool results, not pasted text.

## Runtime differences

- Local runtime: the Session runs through the CLI adapter; approvals still come from monday's tools. If the CLI is not running or not logged in, the header shows "Claude Code not available" with a link to Settings › AI, and the composer offers the Hosted runtime if one is configured.
- Hosted runtime: the Session runs through LangGraph on the Server; a paused Run resumes exactly where its interrupt fired.

## Strings

Every user-visible string is a Setting keyed by name.
