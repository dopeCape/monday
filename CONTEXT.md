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
A Message not yet sent. Owned by the Server, synced to every Device, and mirrored into the Provider's Drafts folder.

**Voice profile**:
A per-Workspace, user-editable description of how the user writes, with excerpts, built from sent mail when the user opts in. Passed to every drafting Task.
_Avoid_: style, persona, tone model

**Label**:
A marker that belongs to the Provider (a Gmail label, an IMAP folder), synced in both directions.
_Avoid_: folder (except when speaking to IMAP directly), category

**Tag**:
A marker that belongs to monday, applied to a Thread by the Agent or the user, stored on the server and never pushed to the Provider.
_Avoid_: label, smart label, AI label

### Attention and routing

**Section**:
A list in the nav that a Section rule fills, opened as its own view; the Inbox itself is never divided into Sections. Shipped defaults are the kinds of attention a Thread needs: Needs your reply, Waiting on you, For your information, Newsletters. User-defined, independent of Group.
_Avoid_: inbox type, category, bucket

**Judgment**:
A typed question (Choice, Noul or Score) a System One model answers with probabilities and a confidence, never text: which Group, which Section, whether a Brief is worth writing, what a typed sentence asks for. Decisions are Judgments; sentences are generation (ADR 0012).
_Avoid_: classification call, scoring prompt

**Judge**:
The seam on the Runtime that answers Judgments: TypeSafe's Jev when its key is configured, the language model's prompt path otherwise, a header rule as the floor. Metered under `judge.*`.

**Custom action**:
A button the user defined for the Threads of a Group or Section ("forward invoices to accounting"): a label, a condition, and an ordinary tool call with its Tier. Rendered in the reader toolbar and as a chip; authored by the Agent from a sentence.
_Avoid_: macro, shortcut

**Section rule**:
The rule, in the same shape as a Routing rule, that decides which Threads a Section holds. Predicates and Facts first, a Signal for the rest. A user-defined Section carries its own sentence and where it shows: as a heading in the stream, as an entry in the nav, or both.

**Predicate**:
The structured, model-free part of a rule (senders, domains, subject patterns, list ids, headers) that runs on every Thread at no cost.
_Avoid_: filter, matcher

**Example**:
A Thread the user confirmed or corrected into a Group or Section, kept as evidence for the rule's model prompt.
_Avoid_: training data, sample

**Confidence**:
The score a rule gives a Thread. At or above the route threshold the Thread is placed; in the ask band it goes to Needs a decision; below, it is left alone.

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

**Sort scope**:
How much of the mail already there a re-run or a Backlog sort covers: the newest N Threads, the last N days, weeks, months or years, everything since a date, or everything. Written as a short sentence ("last 3 months").
_Avoid_: range, window, lookback

**Backlog sort**:
The background Job that routes the mail already there inside a Sort scope, newest first, one per Workspace, after its newest sample was moved on approval. New mail is routing on arrival, not the Backlog sort.
_Avoid_: backfill (in user-facing words), bulk sort, migration

**Brief**:
The Agent's short summary of a Thread, shown at the top of the reader above its Recommended actions.
_Avoid_: summary, TL;DR, AI summary

### Signals and what they power

**Signal**:
A standing Judgment monday keeps answered on every Thread in its scope, such as "needs a reply", "money is involved" or "the sender is frustrated". Its answer (probability, confidence, the question version and when it was asked) is stored per Thread so lists, Views and actions read numbers instead of asking again. Shipped with monday, or added by a Section, a Custom action, a View or the Interruption policy.
_Avoid_: tag (a Tag is a marker), label, feature, attribute, flag

**Fact**:
A value code computes about a Thread without any model: when it arrived, who sent it, how many Messages it has, whether the owner wrote last, the amounts, dates and addresses found in its text. Facts filter; Signals judge.
_Avoid_: signal (a Signal is judged), metadata, attribute

**Question version**:
The number a Signal's wording carries; it goes up whenever its instructions, options or levels change. An answer asked under an older version is stale.
_Avoid_: revision, prompt version

**Unsure**:
The state of a Signal answer that neither clearly holds nor clearly fails: a Noul between its two thresholds, or a Choice or Score below its confidence floor. Never treated as yes or as no.
_Avoid_: low confidence, maybe, unknown (unknown means not asked yet)

**Recommended action**:
An action monday proposes for a Thread from a fixed catalog (reply, archive, snooze, forward, RSVP, add to calendar, pay or file, unsubscribe, track a package, run a Workflow, hand to someone) because a Signal says it fits, with its arguments already chosen. Rendered as a chip; always an ordinary Tool call with its Tier.
_Avoid_: suggestion, smart action, quick action, chip (a chip is how it is drawn)

**Template**:
A reusable Message body with Placeholders, built in or written by the user, used to start a Message or answer one.
_Avoid_: canned response, snippet, macro, saved reply

**Placeholder**:
A named, typed gap in a Template (`{name}`, `{amount}`) that the user fills or that monday fills by picking a span from the Thread, never by inventing a value.
_Avoid_: variable, merge field, token

**View**:
A pinned, generated page the user asked for in a sentence ("all my Amazon orders with total spend per month", "today's support requests as red, yellow and green"): a scope of Threads, the Fields read about each (Facts, Signals, Extractions), and a stack of Blocks from a fixed catalog, each drawing a query over those Fields, with action buttons on its items. The Agent writes it as a JSON document; code validates, queries and draws it. Lives in the nav beside Groups. What was called a Board is a View with one lanes Block.
_Avoid_: board, dashboard, report, smart folder, saved search

**Block**:
One piece of a View from the fixed catalog (lanes, list, counts, table, stat, chart, timeline, calendar, cards, people, checklist, heatmap, text), with typed props and a query. The Agent picks Blocks and fills their props; it never writes markup.
_Avoid_: widget (a Panel is the Layout's widget), component, card (a card is the Agent's preview)

**Field**:
One value a View reads per Thread: a Fact, a Signal or an Extraction, named by a reference such as `received_at`, `signal:status` or `x:order_total`.
_Avoid_: column, attribute, property

**Extraction**:
A value a View takes from a Thread's text by selection: code finds the candidates of one kind (amounts, dates, reference numbers, names, links), Jev picks the one the View's question asks for or none, and code copies and normalizes it. Below its confidence floor it is Unsure. Never written by a model.
_Avoid_: parsing, scraping, generated value, entity

**Lane**:
One group of Threads in a View with its condition, such as Red or Waiting on legal, drawn by the lanes, list and counts Blocks. Every View with Lanes ends with an Unsure Lane for Threads its Signals could not decide.
_Avoid_: column, bucket, placement (Placement is where a Workflow runs)

**Interruption policy**:
The user's own sentence saying when monday may interrupt them with a notification, split into the part about the mail (judged) and the part about time and calendar (computed).
_Avoid_: notification rules, focus mode, do not disturb

**Interest**:
A short phrase for something the user likes to read about, learned from what they open in newsletters and editable by them. Digests rank paragraphs against Interests.
_Avoid_: topic, preference, profile

**Digest**:
A short reading monday writes from the newsletter paragraphs that best match the user's Interests over a period, each item linked to its source.
_Avoid_: newsletter summary, roundup, brief (a Brief is one Thread's summary)

### Calendar

**Event**:
One entry on a calendar, read from the Provider or from the Local calendar.

**Invite**:
A `text/calendar` request inside a Message. Rendered as an invite bar in the reader; answered through the calendar API where one exists, by reply mail otherwise.
_Avoid_: invitation email, ICS attachment

**Free slot**:
A span on the owner's own calendars inside the working hours and days, clear of every Event that blocks time (not declined, cancelled or all-day), found by code. What Offer times and Suggest another time write into a reply, and what `find_free_time` returns.
_Avoid_: availability, opening, free time (as a noun for one span)

**Local calendar**:
The calendar monday keeps in its own database for a Workspace whose Account has no calendar API and no linked CalDAV calendar.
_Avoid_: fallback calendar, offline calendar

### The agent

**Agent**:
monday's single assistant persona, present in every Workspace. It can search, draft, send, delete, forward, reroute, change settings, and author Workflows and Groups.
_Avoid_: AI, assistant, copilot, bot

**AI level**:
The user's choice of how much AI monday does, made on onboarding's first screen and changeable at any time: `off` (just mail: no agent bar, Briefs, routing, Workflows or model calls), `assist` (the agent bar and Briefs on open, nothing runs unasked), `automate` (routing, background Briefs and Workflows too). Setting `ai.level`. Lowering it disables, never deletes.

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

**Role**:
A named slot a task's model is chosen through: main or fast. Each Hosted provider maps both roles to a model, and any task may instead name an exact model.
_Avoid_: tier (reserved for approvals), size

**Task**:
One kind of model work with its own Role, effort and meter line: composer, agentic step, brief, classify, route, section, tag, draft in my voice, summarize.
_Avoid_: job (reserved for background work)

**Meter**:
The per-Workspace record of tokens and estimated cost for every Hosted call, by Task and provider.
_Avoid_: usage, billing

**Tool call**:
One action the Agent takes through a monday tool, such as search or send.

**Approval**:
The gate before a Tool call that leaves the mailbox or destroys data. Rendered as a card with the outcome, and undoable where the action is reversible.
_Avoid_: confirmation, permission prompt

**Tier**:
The fixed approval class of a tool: always-ask, reversible (applies with Undo) or read-only (silent).
_Avoid_: permission level, risk level

**Standing approval**:
A stored yes on one Workflow Step that lets an always-ask tool run unattended in that Step. Shown on the Workflows page and revocable.
_Avoid_: auto-approve, whitelist

**Activity log**:
The per-Workspace record of every Tool call: tool, input summary, who approved, result, undo pointer.
_Avoid_: audit log, history (reserved for Session history)

**Developer mode**:
A per-Session switch that re-enables the Local runtime's own built-in tools (shell, files, web) after an explicit warning. Off by default.
_Avoid_: unsafe mode, power mode

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
One execution of a Workflow with its log and outcome, tied to the Workflow version it ran under.
_Avoid_: execution, job

**Placement**:
Where a Workflow runs: on the Server with a Hosted runtime, or on a Local runtime while the client is open.
_Avoid_: target, host

**Dry run**:
A Run over recent mail that reports what would have happened without acting. Shown before a Workflow is enabled.
_Avoid_: simulation, test run

**Budget**:
The caps on an agent Step: tool calls, tokens and wall time. Exceeding any cap fails the Run.
_Avoid_: limit, quota (reserved for provider quotas)

### Server and deployment

**Server**:
monday's sync service: receives Provider events, stores mail, computes Sections, Tags and Briefs, runs Workflows. One person per Server, many Accounts.
_Avoid_: backend, API

**Cloud server**:
A Server deployed remotely: Vercel, Netlify or a container.

**Sidecar**:
The copy of the Server bundled with the client and started by it as a background service that keeps running when the window closes (ADR 0013). When both run they share one database; alone, it runs an embedded Postgres and does everything.
_Avoid_: local server, embedded server

**Job**:
One idempotent, time-budgeted unit of background work in the shared jobs table, claimed with a lease by a Server that can serve its needs.
_Avoid_: task, worker item

**Heartbeat**:
The row each running Server refreshes so the others can tell it is alive.

**Cache**:
The client's per-Workspace SQLite copy: headers for every Thread, bodies for recent and opened Threads, and a full-text index over them.
_Avoid_: local database, mirror

**Outbox**:
The client's queue of intents made while offline, replayed in order on reconnect.
_Avoid_: pending queue, sync queue

**Changes feed**:
The ordered stream of change events the client reads from a cursor; the push transport that wakes it varies by deployment mode.
_Avoid_: realtime, event stream, socket

**Device**:
One installed client that holds a per-Device token for a Server. Listed and revocable in Settings.
_Avoid_: session (reserved for the Agent), login

**Pairing**:
Approving a new Device from an existing one with a short code.
_Avoid_: login, sign in

**Setup code**:
The one-time code an install produces so the first Device can pair.
_Avoid_: admin password, secret

### Layout and appearance

**Layout**:
The current values of the three knobs: nav (full, rail, hidden), agent (bottom, left, right), list (stream, split).

**Preset**:
A built-in named Layout: Stream, Columns, Agent left.
_Avoid_: mode, template

**Layout shortcut**:
A user-saved Layout with a shortcut, shared across Workspaces (the `views` Setting in the config file, a name kept from before Views).
_Avoid_: profile, saved layout, view (a View is the generated page)

**Panel**:
A small built-in widget the Agent can place in the Layout from a fixed catalog.
_Avoid_: widget, plugin

**Palette**:
A named set of color tokens with a light and a dark half. Shipped or loaded from a file.
_Avoid_: theme (theme means light or dark), color scheme

**Density**:
The scale of text, icons and rows: compact, comfortable or spacious.

**Config file**:
`monday.toml`, the per-machine file the user owns. Holds preferences only, wins over saved Settings, and is never written by the app unless the user asks.
_Avoid_: settings file, rc file

**Setting**:
A preference saved by the UI or the Agent in the server database and synced to every device. Some Settings are per device.
_Avoid_: option, preference (as a noun in code)

**Pinned**:
The state of a Setting whose key the Config file also sets, so the file value is in effect and the UI control is locked.
_Avoid_: overridden, locked (in prose the control is locked, the Setting is pinned)
