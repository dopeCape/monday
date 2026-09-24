# Calendar

The Calendar screen and the calendar module behind it. Issue 15 and 16 set the scope, research 6 (`docs/research/calendar-apis.md` on `research/calendar-apis`) the Provider facts, slice 18 the first build. This page is what the screen does now. Terms are the glossary's: Account, Workspace, Event, Invite, Local calendar, Setting, Activity.

## What is on screen

- **Views.** Day, Week (the default, `calendar.default_view`), Month and Agenda. The header names the span on screen, steps back and forward a view at a time, and returns to today. Week shows all seven days unless `calendar.show_weekends` is off; the week starts on Monday unless `calendar.week_starts_monday` is off. Agenda lists `calendar.agenda_days` days at a time.
- **The time grid** (Day and Week). All 24 hours, `calendar.hour_height` pixels each; the hours outside the working day (`calendar.day_start_hour` to `calendar.day_end_hour`) and the days outside `calendar.work_days` are shaded. The grid opens scrolled to the start of the working day, or to now when today is shown and now is outside it. A red line marks the current time in today's column. Timed Events that overlap share the column side by side, and an Event widens into columns that stay free for its whole span. All-day Events, and timed ones a day or longer, sit in the all-day row above the grid as bars across the days they cover, stacked in lanes. `calendar.secondary_time_zone` adds a second column of hours in another zone. `calendar.week_numbers` shows the ISO week in the header, the Month view and the mini month.
- **Month.** Whole weeks from the one holding the 1st. Each day lists all-day and multi-day Events first, then timed ones by start, up to `calendar.month_events_max`, then "N more", which opens the day.
- **Sidebar** (`calendar.sidebar`, flipped by the header's sidebar button). The mini month (`calendar.mini_month`) with the days on screen marked and busy days dotted; the Today panel (`calendar.today_panel`); the invites still waiting for an answer; and the calendar list in groups: **My calendars** (the open Account's own), each other Account's by its address, then **Shared with me** (calendars other people share with any Account, with who shares them). Each calendar is a coloured switch for whether this Workspace shows it; hovering shows **Show only this**, a colour menu (`calendar.colors`) and hide or show. A read-only calendar carries a lock, one that shows busy times only says so, and a calendar whose last read failed gets a warning with the Provider's words; an Account whose calendar cannot be read gets the warning on its group. **Show all** brings every hidden one back.
- **Every Account together, per Workspace.** Every Workspace shows every connected calendar by default: its own from the Cache, the other Accounts' read through the API for the window on screen (`calendar.other_accounts` turns those off everywhere). Which calendar each Workspace shows is the `calendar.shown` Setting, per Workspace and per calendar, with an "every workspace" column; Settings, Appearance, Calendar has the table of every calendar against every Workspace, and the sidebar's switches write the open Workspace's column. A calendar the Server marks hidden (an older choice) is shown again when switched on. Writes to another Account's Event go through the API by Event id, and the window is read again after each.
- **Shared calendars.** Google's calendar list and Graph's (its calendar groups too) include calendars others shared with the Account; each carries its access (owner, writer, reader, busy only) and who shares it. They sync and show like any other, and the ones the Account cannot write never offer move, edit or delete.
- **Colours.** A calendar's colour is the user's choice, else the Provider's, else a palette token by its place in the list. An Event is tinted in its calendar's colour. Tentative and unanswered invites are striped, declined ones dimmed and struck through (shown only with `calendar.show_declined`), past ones faded, and the Agent's outlined.

## Making and changing Events

- **Make.** A click on empty time opens the quick create on a slot of `calendar.default_duration_minutes`; a drag makes the slot the drag covered; a click on the all-day row or on a Month day's empty space makes an all-day slot. The New Event button (and its key) opens it on the next free slot. Everything snaps to `calendar.snap_minutes`. A press only becomes a drag after `calendar.drag_threshold_px`.
- **monday's own controls.** Every choice in the quick create and the editor is monday's own, never the browser's: a dropdown (arrows, Enter, a letter jumps), a date field that opens a month grid (arrows move a day or a week, Page Up and Down a month), a time field that takes typing ("9", "930", "9:30pm") and lists the day's times on the snap step (an end time lists them from the start with each length, "45 min"), and a time zone field that searches the zones (`calendar.zone_suggestions_max`).
- **The quick create** holds the title, the day and times (the end day only once the Event runs past its first day), All day and Repeat as chips, the calendar (writable ones only, grouped by Account), and Add guests. "More options" carries the Draft into the editor.
- **Guest suggestions.** Typing in a guest field suggests people from the mail (the composer's recipients) and from earlier Events, most recent first, up to `calendar.guest_suggestions_max`; arrows walk them, Enter or Tab picks, comma or a typed address adds one, Backspace removes the last chip.
- **The editor** is two columns: when (the day and times, All day, Repeat, the time zone), the guests and the notes on the left; the calendar, where (the meeting link and the place) and the reminders on the right. It adds the time zone the times are read in (the Device's by default), repeat (does not repeat, every day, every weekday, every week, every two weeks, every month, every year, or a custom RRULE), the meeting link (the Setting's, none, Google Meet on Google, Teams on Microsoft 365, Jitsi, or a URL), the place, reminders (the default, none, or any of `calendar.reminder_choices`), and notes. Changing the start carries the end along so the length stays. An end before the start, or a malformed date or time, is refused in plain words before anything is sent.
- **Move and resize.** The user's own Events (on a writable calendar, organized by the user) move by dragging, across days too, and resize by dragging the bottom edge. In Month an Event drags to another day. A move shows at once; if the write fails the Event goes back and the line under the header says why. A move with no guests offers Undo on the toast (`inbox.undo_toast_ms`, the `undo` key).
- **The detail** opens on a click: the title in its colour, when (with the Event's own zone when it differs from the Device's), how it repeats, the meeting link with Join (primary within `notifications.calendar_lead_minutes` of the start), the place, the organizer and each guest with their answer and the counts, the reminders, the notes, and the calendar and Account. An invite gets Yes, Maybe and No. Edit, duplicate and delete sit at the top; edit and delete only where the user may.
- **Repeating Events.** Changing or deleting one asks which instances the change reaches: this Event, this and following Events, or all Events. Masters that CalDAV and the Local calendar keep are expanded on the client (the shared expander, EXDATE honoured); Google and Graph hand over instances.
- **Guests are asked about first** (ADR 0002). Any write the user makes that emails an Event's guests (an invitation, an update, a cancellation) first names who will get the email and waits for Send. Who mails is unchanged: the Provider on Google and Microsoft 365, monday by iMIP on the Local calendar. The Agent's scheduling tools keep their own approval card.

## The Agent's calendar drafts

A calendar draft is a set of changes the Agent proposes as one, like a diff over the calendar: Events to add, Events to change (the old time and the new), Events to remove. The Agent makes one with `propose_calendar_draft` for work of more than one change (planning a week, clearing a day, blocking focus time); a single change the user asked for still goes through the single tools and their approval card. A draft writes nothing and emails no one until the user applies it.

- **Where it shows.** The conversation shows the draft as a card: the title, the summary, the counts to add, change and remove, the first `calendar.draft_card_rows` changes as diff lines (+, ~, −), and Show on the calendar, Discard and Apply all. When a draft arrives the App opens the Calendar on the days it touches with the draft over the views, unless `calendar.agent_draft_focus` is off; either way the draft waits in the conversation, and the Calendar says how many drafts are waiting with Open.
- **Over the views.** An Event the draft adds is a ghost in green with a +, a moved Event keeps a faded, dashed ghost where it was and gets a green ghost where it goes, and an Event it removes is struck through in red. The Agenda marks the same. A click on a ghost opens that change: what it does, when, why (the Agent's reason) and who would be emailed, with Keep in or Leave out.
- **The bar and the list.** A bar under the header names the draft with its counts and has Review, Discard and Apply. Review opens the list beside the views, one row per change with a box to keep it in or leave it out; Apply then says how many it applies ("Apply 3").
- **Applying.** Each change runs through the same writes as the editor and a drag. Before any guest would be emailed the user is asked once, for every guest of the changes being applied (ADR 0002); no applies nothing. A change that fails is named and the rest go on. Applying some leaves the draft open with the rest; the toast offers Undo, which removes what was made, puts moved Events back and makes removed ones again.
- **Remembered.** Which drafts were seen, applied (all or some) or discarded is kept in the Cache, so a draft reloaded with a conversation from history is not opened again.

Planning a week: the header's **Plan week** (and `/plan-week` in the composer, from `ai.composer.commands`) asks the Agent to read the week and the mail for tasks, deadlines and meetings people asked for, and to propose focus blocks, those meetings and prep time as one draft.

## The Agent's calendar tools

Reads (never ask): `list_calendars` (every calendar with its access and who shares it), `list_events` (a window, optionally some calendars and a query; series instances expanded with their `occurrence`), `search_events` (words over title, place, notes and people across the synced window), `find_free_time` (free slots of a length inside the working hours and days from Settings, `calendar.time_zone` for the zone; declined Events and shared calendars do not block), `get_calendar_draft`. Writes that email guests ask first with the event card: `schedule_event`, `update_event`, `move_event` (keeps the length), `rsvp`; `delete_event` is destructive. The writes take a recurring `scope` and `occurrence`, and reminders. `propose_calendar_draft` is a read on the Server: it validates every change (the Event exists, the calendar is writable and not busy only, the end comes after the start), fills in each change's before and after and its guests, and hands the draft to the app as the card's preview.

## Keys, search and the palette

The Calendar's keys are keymap actions (`keyboard.bindings`), in their own scope: they share chords with the mail screens' actions without clashing, and the Shortcuts page flags a clash only where both work. Vim and Gmail: `t` today, `k` and `j` previous and next, `d` `w` `m` `a` the views, `c` a new Event, `mod+f` search. Natural: the arrow keys step instead, `mod+n` makes an Event. Escape closes the popover, the search and the palette; `mod+k` opens the palette on the Calendar with the Calendar's actions; `/` asks the Agent; `z` undoes a move.

Search looks through every Event the Cache holds (`calendar.window_past_days` back, `calendar.window_future_days` ahead) by title, place, notes and people, every word matching, and lists the matches by day.

The palette reads a typed date ("tomorrow", "fri", "next monday", "3 oct", "oct 3 2027", "2026-10-03", "3/10") and offers "Calendar: go to" that day, from any screen. Numeric dates are day first unless `calendar.dates_month_first`.

## When the calendar cannot be read

The screen asks the Server for each Account's calendar status on open. An Account whose calendar is refusing gets a banner under the header in plain words, with the fix:

| Problem | What the banner says and offers |
|---|---|
| The Calendar API is turned off (Google `accessNotConfigured`, `SERVICE_DISABLED`) | The Google Calendar API is not enabled in the Google Cloud project monday signs in with; **Enable Calendar API** opens the API's page for that project |
| The sign-in did not grant the calendar | Sign in again and allow the calendar; **Sign in again** opens Settings, Accounts |
| The sign-in expired or was withdrawn | **Sign in again** |
| Offline or rate limited | monday tries again on its own |
| Anything else | The Provider's words under Details |

Every banner has **Try again**, which reads the Account's calendar now and replaces the banner with the answer. Mail keeps working meanwhile.

Loading shows "Reading your calendars" in the calendar list until the first rows arrive; an Account with no calendar yet says they appear after the first sync; an empty Agenda or search says so and offers a new Event.

## Reminders

`notifications.calendar` (on by default, under `notifications.enabled`) turns the calendar's notifications on or off on their own. A desktop notification before each Event the user has not declined, from the Cache, so the Server need not be awake. An Event's own reminders (minutes before its start) replace `notifications.calendar_lead_minutes`; each fires once.

## The Server

The calendar module (`apps/server/src/calendar`) keeps every Provider behind the `CalendarSession` interface (Google Calendar v3, Microsoft Graph, CalDAV) and the Local calendar in its own rows. What the screen needed and the module now does:

- **Writes aimed at instances.** `updateEvent(id, patch, {scope, occurrence})` and `deleteEvent(id, {scope, occurrence})`. On an instance the Provider expanded, "this" writes the instance, "all" the series master (read through `CalendarSession.readEvent`, shifted by how far the instance moved), and "this and following" cuts the master before the instance and starts a new series there; the calendar is then synced inline so the instances follow. On a master kept here (CalDAV, Local), `occurrence` names the instance: "this" adds an EXDATE and makes a single Event, "following" cuts the rule with UNTIL and starts a new master, "all" shifts the master. A Provider that cannot is refused with a reason (409).
- **Reminders** on every Event: Google popup overrides, Graph's reminder minutes, CalDAV VALARMs, the Local calendar's rows; carried on the Changes feed.
- **Status.** `GET /calendar/status?workspace=` answers from the last sync or one probe, classifying the Provider's error into the kinds above with the fix URL; `POST /calendar/sync` reads again now.

Routes are listed at the top of `apps/server/src/routes/calendar.ts`.

## Settings

Behavior: `calendar.shown`, `calendar.agent_draft_focus`, `calendar.draft_card_rows`, `calendar.guest_suggestions_max`, `calendar.zone_suggestions_max`, `calendar.time_zone`, `notifications.calendar`, `notifications.calendar_lead_minutes` (10 by default), `calendar.default_view`, `calendar.week_starts_monday`, `calendar.show_weekends`, `calendar.work_days`, `calendar.day_start_hour`, `calendar.day_end_hour`, `calendar.hour_height`, `calendar.snap_minutes`, `calendar.drag_threshold_px`, `calendar.week_numbers`, `calendar.secondary_time_zone`, `calendar.month_events_max`, `calendar.agenda_days`, `calendar.other_accounts`, `calendar.mini_month`, `calendar.sidebar`, `calendar.colors`, `calendar.reminder_choices`, `calendar.dates_month_first`, `calendar.show_declined`, `calendar.today_panel`, `calendar.default_duration_minutes`, plus the sync and meeting-link ones. Words: `strings.calendar.*`, `strings.action.calendar.*`, `strings.palette.calendar_jump`.

## Not yet

- Graph series edits ("this and following" on Microsoft 365) where the master's rule is not in the model.
- A CalDAV "this Event" change is written as an EXDATE plus a separate Event, not a RECURRENCE-ID override in the same object, so guests on such a series get a separate invitation for the moved instance.
- Displaying the whole Calendar in a zone other than the Device's (the second column covers the common case).
- Room booking, propose a new time and shared-calendar writes stay out of v1 (`README.md`).
- The Agent is not told which of a draft's changes the user applied; it can read the draft back with `get_calendar_draft` and the calendar with `list_events`.
- Drafts live on the Activity row that proposed them; there is no table of drafts across Sessions.
- A shared Microsoft 365 calendar whose change feed Graph refuses shows its error in the calendar list rather than its Events.
