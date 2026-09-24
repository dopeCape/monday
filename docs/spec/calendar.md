# Calendar

The Calendar screen and the calendar module behind it. Issue 15 and 16 set the scope, research 6 (`docs/research/calendar-apis.md` on `research/calendar-apis`) the Provider facts, slice 18 the first build. This page is what the screen does now. Terms are the glossary's: Account, Workspace, Event, Invite, Local calendar, Setting, Activity.

## What is on screen

- **Views.** Day, Week (the default, `calendar.default_view`), Month and Agenda. The header names the span on screen, steps back and forward a view at a time, and returns to today. Week shows all seven days unless `calendar.show_weekends` is off; the week starts on Monday unless `calendar.week_starts_monday` is off. Agenda lists `calendar.agenda_days` days at a time.
- **The time grid** (Day and Week). All 24 hours, `calendar.hour_height` pixels each; the hours outside the working day (`calendar.day_start_hour` to `calendar.day_end_hour`) and the days outside `calendar.work_days` are shaded. The grid opens scrolled to the start of the working day, or to now when today is shown and now is outside it. A red line marks the current time in today's column. Timed Events that overlap share the column side by side, and an Event widens into columns that stay free for its whole span. All-day Events, and timed ones a day or longer, sit in the all-day row above the grid as bars across the days they cover, stacked in lanes. `calendar.secondary_time_zone` adds a second column of hours in another zone. `calendar.week_numbers` shows the ISO week in the header, the Month view and the mini month.
- **Month.** Whole weeks from the one holding the 1st. Each day lists all-day and multi-day Events first, then timed ones by start, up to `calendar.month_events_max`, then "N more", which opens the day.
- **Sidebar** (`calendar.sidebar`, flipped by the header's sidebar button). The mini month (`calendar.mini_month`) with the days on screen marked and busy days dotted; the Today panel (`calendar.today_panel`); the invites still waiting for an answer; and the calendars of every Account shown, grouped by Account, each a coloured switch for whether it shows (kept on the Server, so every Device agrees) and a swatch menu to pick another colour (`calendar.colors`).
- **Every Account together.** With `calendar.other_accounts` on, the other Accounts' calendars and Events are read through the API for the window on screen and shown beside the open Workspace's, which come from the Cache. Writes to them go through the API by Event id, and the window is read again after each.
- **Colours.** A calendar's colour is the user's choice, else the Provider's, else a palette token by its place in the list. An Event is tinted in its calendar's colour. Tentative and unanswered invites are striped, declined ones dimmed and struck through (shown only with `calendar.show_declined`), past ones faded, and the Agent's outlined.

## Making and changing Events

- **Make.** A click on empty time opens the quick create on a slot of `calendar.default_duration_minutes`; a drag makes the slot the drag covered; a click on the all-day row or on a Month day's empty space makes an all-day slot. The New Event button (and its key) opens it on the next free slot. Everything snaps to `calendar.snap_minutes`. A press only becomes a drag after `calendar.drag_threshold_px`.
- **The quick create** holds the title, the start and end (the end date only once the Event runs past its first day), all day, the calendar, and guests. "More options" carries the Draft into the editor.
- **The editor** adds the time zone the times are read in (the Device's by default), repeat (does not repeat, every day, every weekday, every week, every two weeks, every month, every year, or a custom RRULE), the meeting link (the Setting's, none, Google Meet on Google, Teams on Microsoft 365, Jitsi, or a URL), the place, reminders (the default, none, or any of `calendar.reminder_choices`), and notes. Changing the start carries the end along so the length stays. An end before the start, or a malformed date or time, is refused in plain words before anything is sent.
- **Move and resize.** The user's own Events (on a writable calendar, organized by the user) move by dragging, across days too, and resize by dragging the bottom edge. In Month an Event drags to another day. A move shows at once; if the write fails the Event goes back and the line under the header says why. A move with no guests offers Undo on the toast (`inbox.undo_toast_ms`, the `undo` key).
- **The detail** opens on a click: the title in its colour, when (with the Event's own zone when it differs from the Device's), how it repeats, the meeting link with Join (primary within `notifications.calendar_lead_minutes` of the start), the place, the organizer and each guest with their answer and the counts, the reminders, the notes, and the calendar and Account. An invite gets Yes, Maybe and No. Edit, duplicate and delete sit at the top; edit and delete only where the user may.
- **Repeating Events.** Changing or deleting one asks which instances the change reaches: this Event, this and following Events, or all Events. Masters that CalDAV and the Local calendar keep are expanded on the client (the shared expander, EXDATE honoured); Google and Graph hand over instances.
- **Guests are asked about first** (ADR 0002). Any write the user makes that emails an Event's guests (an invitation, an update, a cancellation) first names who will get the email and waits for Send. Who mails is unchanged: the Provider on Google and Microsoft 365, monday by iMIP on the Local calendar. The Agent's scheduling tools keep their own approval card.

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

A desktop notification before each Event the user has not declined, from the Cache, so the Server need not be awake. An Event's own reminders (minutes before its start) replace `notifications.calendar_lead_minutes`; each fires once.

## The Server

The calendar module (`apps/server/src/calendar`) keeps every Provider behind the `CalendarSession` interface (Google Calendar v3, Microsoft Graph, CalDAV) and the Local calendar in its own rows. What the screen needed and the module now does:

- **Writes aimed at instances.** `updateEvent(id, patch, {scope, occurrence})` and `deleteEvent(id, {scope, occurrence})`. On an instance the Provider expanded, "this" writes the instance, "all" the series master (read through `CalendarSession.readEvent`, shifted by how far the instance moved), and "this and following" cuts the master before the instance and starts a new series there; the calendar is then synced inline so the instances follow. On a master kept here (CalDAV, Local), `occurrence` names the instance: "this" adds an EXDATE and makes a single Event, "following" cuts the rule with UNTIL and starts a new master, "all" shifts the master. A Provider that cannot is refused with a reason (409).
- **Reminders** on every Event: Google popup overrides, Graph's reminder minutes, CalDAV VALARMs, the Local calendar's rows; carried on the Changes feed.
- **Status.** `GET /calendar/status?workspace=` answers from the last sync or one probe, classifying the Provider's error into the kinds above with the fix URL; `POST /calendar/sync` reads again now.

Routes are listed at the top of `apps/server/src/routes/calendar.ts`.

## Settings

Behavior: `calendar.default_view`, `calendar.week_starts_monday`, `calendar.show_weekends`, `calendar.work_days`, `calendar.day_start_hour`, `calendar.day_end_hour`, `calendar.hour_height`, `calendar.snap_minutes`, `calendar.drag_threshold_px`, `calendar.week_numbers`, `calendar.secondary_time_zone`, `calendar.month_events_max`, `calendar.agenda_days`, `calendar.other_accounts`, `calendar.mini_month`, `calendar.sidebar`, `calendar.colors`, `calendar.reminder_choices`, `calendar.dates_month_first`, `calendar.show_declined`, `calendar.today_panel`, `calendar.default_duration_minutes`, plus the sync and meeting-link ones. Words: `strings.calendar.*`, `strings.action.calendar.*`, `strings.palette.calendar_jump`.

## Not yet

- Graph series edits ("this and following" on Microsoft 365) where the master's rule is not in the model.
- A CalDAV "this Event" change is written as an EXDATE plus a separate Event, not a RECURRENCE-ID override in the same object, so guests on such a series get a separate invitation for the moved instance.
- Displaying the whole Calendar in a zone other than the Device's (the second column covers the common case).
- Room booking, propose a new time and shared-calendar writes stay out of v1 (`README.md`).
