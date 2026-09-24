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

- Enter sends. Shift-Enter inserts a newline. The input clears and the message appears as the user turn. The input grows to `ai.composer.max_rows` lines.
- Up in an empty input recalls what was sent earlier in the Session, newest first; Down steps back to the draft (`ai.composer.input_history`).
- While a turn runs, Send becomes Stop. Stop drops the stream and ends a Local runtime's CLI; the thread keeps what arrived with a Stopped line, and a tool that already ran stays in the Activity log with its Undo.
- A new Session starts with the plus button, with `/new`, or automatically after 24 hours of inactivity. History lists past Sessions by first message and date; opening one resumes it.
- A Session is bound to one Workspace. Switching Workspace in the nav starts or resumes that Workspace's latest Session. An explicit "switch to my personal account" inside a Session shows a switch card and rebinds the Session.
- Retention: Sessions are kept 90 days on the Server, then summarized to one line in the Activity log.
- Switching Runtime mid-Session is allowed from the header; the transcript is replayed to the new Runtime as context. Tool calls already made are not repeated.

## Streaming and cards

- Assistant text streams token by token and renders as Markdown (`ai.composer.markdown`): lists, tables, code blocks with Copy, inline code, and links that open in the system browser. Raw HTML in an answer is never rendered.
- Tool calls render as cards in the order they happen, each with a title, a one-line detail and a status: running, done, failed, waiting. A turn's read-only steps (searches, reads, a Developer mode tool) group into one line that stays open while the Agent works and folds to a summary once the answer starts (`ai.composer.fold_activity`); a card that asks, or that can be undone, is never folded.
- Search results, calendar events and drafts render inside the card in the same visual language as the rest of the app (thread rows, event rows), never as raw JSON.
- A reversible action card shows Undo. An always-ask card shows the exact payload (recipients and text for send, the list of Threads for a batch, the event for an invite) and Approve, Edit, Cancel. Edit opens the payload in the right editor (compose, event form) and returns to the card.
- A batch above 10 Threads shows the list first with a count and one Apply.
- A card whose Runtime built-in tools were used in Developer mode is marked with a warning glyph and the tool name.
- Errors render as a card with the failure and a Retry. Offline: hosted work shows one line, "Offline, hosted work paused", and Local runtime work continues.

## Turn actions and menus

Built on Assistant UI's headless primitives (action bar, composer trigger popover), styled with monday's tokens.

- Each user turn shows, on hover or focus, its time, Copy, and Edit and resend, which puts the turn back in the bar, focused; sending it is a new turn (the transcript is linear, nothing is thrown away).
- A finished answer shows Copy on hover; the last answer shows Copy and Ask again, which sends the turn it answered again as a new turn. Its time shows on hover (`ai.composer.timestamps`). Times come from the Server for a loaded Session and from the Device for a live one.
- A stopped turn's line offers Continue while it is the last turn; it sends `strings.agent.continue_prompt`.
- While a turn works, the Working line and the running steps line count the time once it passes `ai.composer.elapsed_after_seconds`.
- `/` in the bar lists `ai.composer.commands` (name and words) and `/new`, filtered as the user types; picking one starts the message with its words, `/new` starts a new Session. Arrow keys, Enter and Esc work in the menu. Not offered in the onboarding conversation.
- `@` in the bar lists Threads, Groups, Sections and people by kind (`ai.composer.mentions`; the newest `ai.composer.mention_threads` Threads and their people), and typing searches every kind. A pick inserts `:kind[Label]{name=id}`; the system prompt tells the Agent to act on the id. The sent turn shows it as a chip; a Thread chip opens the Thread.
- A card that asks carries one line saying what approving means (`strings.agent.asks.always`, `strings.agent.asks.reversible`) and its tool's glyph; its status glyph is a raised hand while it waits, a cross once declined, a turn-back once undone.

## Suggestions

- Up to four chips, shown when the Session is empty and when the panel first opens. Sources, in order: pending approvals and failed Runs, threads in Needs your reply, the current Thread's Brief actions, and two evergreen prompts. Chips are plain sentences, no icons.
- Clicking a chip sends it as a user turn.

## Handoffs

- `/` from anywhere focuses the composer. Tab from the search box or palette sends the typed text with the parsed operators attached. "Ask" in the reader header sends "About this thread" with the Thread attached.
- Attaching context: dragging a Thread (or, from a row in the multi-select, the whole selection) from the list onto the Agent, the panel or the bar, puts each Thread in the input as a mention, the same directive an @ pick inserts, so the user adds what to do and sends. The Agent reads a mention as a pointer to that Thread's id and uses its tools on it. While a row is dragged the Agent is outlined as the place to drop. Dropping an Event is not built yet.

## Runtime differences

- Local runtime: the Session runs through the CLI adapter; approvals still come from monday's tools. If the CLI is not running or not logged in, the header shows "Claude Code not available" with a link to Settings › AI, and the composer offers the Hosted runtime if one is configured.
- Hosted runtime: the Session runs through LangGraph on the Server; a paused Run resumes exactly where its interrupt fired.

## Strings

Every user-visible string is a Setting keyed by name.
