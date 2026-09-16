# monday

A calm, agent-first email client: a desktop client plus a self-hosted sync server, with one assistant that can do anything the user can. This glossary is the canonical vocabulary for the product, the code and the tickets.

## Language

### Accounts and mail

**Account**:
A connection to one mail provider with its credentials. Gmail, Microsoft 365, JMAP or IMAP/SMTP.
_Avoid_: mailbox, login, profile

**Workspace**:
Everything that hangs off one Account: its mail, calendar, Groups, Tags, Workflows and agent context. One Account is exactly one Workspace, and the client shows one Workspace at a time.
_Avoid_: unified inbox, account view

**Provider**:
The external mail or calendar service an Account connects to.
_Avoid_: backend, service

**Thread**:
A conversation of one or more Messages. The unit that is routed, tagged, briefed, archived and snoozed.
_Avoid_: conversation, email (when the whole exchange is meant)

**Message**:
One email inside a Thread. The unit that is composed, sent, replied to and forwarded.
_Avoid_: mail, email (when one item is meant)

**Draft**:
A Message not yet sent. Owned by the server and synced to every device.

**Label**:
A marker that belongs to the Provider (a Gmail label, an IMAP folder), synced in both directions.
_Avoid_: folder (except when speaking to IMAP directly), category

**Tag**:
A marker that belongs to monday, applied to a Thread by the Agent or the user, stored on the server and never pushed to the Provider.
_Avoid_: label, smart label, AI label

### Attention and routing

**Section**:
The kind of attention a Thread needs right now: Needs your reply, Waiting on you, For your information, Newsletters. Decided by the Agent, shown as the stream's headings, independent of Group.
_Avoid_: inbox type, category, bucket

**Group**:
A smart inbox that a Routing rule fills, such as Hiring or Finance. A Thread belongs to at most one Group. A Group is a lens on the Inbox, not a move out of it.
_Avoid_: smart inbox, smart folder, category

**Sub-group**:
A Group nested one level under a Group, such as Hiring › Candidates. Nesting stops at one level.
_Avoid_: child inbox, subfolder

**Routing rule**:
The plain-language sentence the Agent wrote for a Group, plus whatever structure monday derives from it, that decides which Threads the Group holds. Each rule yields a confidence per Thread.
_Avoid_: filter, classifier (that is an implementation)

**Needs a decision**:
The queue of Threads whose best Routing rule was not confident enough, or where two rules tied, waiting for the user to choose.
_Avoid_: low confidence, unsorted

**Brief**:
The Agent's short summary of a Thread with suggested actions, shown at the top of the reader.
_Avoid_: summary, TL;DR, AI summary

### The agent

**Agent**:
monday's single assistant persona, present in every Workspace. It can search, draft, send, delete, forward, reroute, change settings, and author Workflows and Groups.
_Avoid_: AI, assistant, copilot, bot

**Runtime**:
Where the Agent's model calls execute. There are two kinds.

**Local runtime**:
A command-line agent on the user's machine (Claude Code, Codex, OpenCode) that the client drives. Only available while the client is running.
_Avoid_: CLI backend, local mode

**Hosted runtime**:
A Provider API key (Anthropic, Gemini, OpenAI, Kimi, OpenRouter) that either the client or the server can call, so work continues while devices are off.
_Avoid_: API mode, cloud AI

**Session**:
One conversation with the Agent, with its history.
_Avoid_: chat, thread (reserved for mail)

**Tool call**:
One action the Agent takes through a monday tool, such as search or send.

**Approval**:
The gate before a Tool call that leaves the mailbox or destroys data. Rendered as a card with the outcome, and undoable where the action is reversible.
_Avoid_: confirmation, permission prompt

### Automation

**Workflow**:
An automation the Agent authored from what the user asked for. Lives in one Workspace and acts only there.
_Avoid_: rule, automation, recipe

**Kind**:
Whether a Workflow is hybrid (a declarative skeleton whose Steps may call the model) or agentic (the Agent drives the whole Run). Chosen by the user or the authoring Agent.

**Trigger**:
What starts a Workflow: a Thread arriving, an attachment, a schedule, silence after N days, a Tag applied, a calendar event.

**Step**:
One action or model call inside a Workflow.

**Run**:
One execution of a Workflow with its log and outcome.
_Avoid_: execution, job

### Server and deployment

**Server**:
monday's sync service: receives Provider events, stores mail, computes Sections, Tags and Briefs, runs Workflows. One person per Server, many Accounts.
_Avoid_: backend, API

**Cloud server**:
A Server deployed remotely: Vercel, Netlify or a container.

**Sidecar**:
The copy of the Server bundled with and started by the client. When both run they share one database.
_Avoid_: local server, embedded server

### Layout and appearance

**Layout**:
The current values of the three knobs: nav (full, rail, hidden), agent (bottom, left, right), list (stream, split).

**Preset**:
A built-in named Layout: Stream, Columns, Agent left.
_Avoid_: mode, template

**View**:
A user-saved Layout with a shortcut, shared across Workspaces.
_Avoid_: profile, saved layout

**Panel**:
A small built-in widget the Agent can place in the Layout from a fixed catalog.
_Avoid_: widget, plugin

**Palette**:
A named set of color tokens with a light and a dark half. Shipped or loaded from a file.
_Avoid_: theme (theme means light or dark), color scheme

**Density**:
The scale of text, icons and rows: compact, comfortable or spacious.
