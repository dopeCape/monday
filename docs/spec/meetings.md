# Meetings from mail

Behaviors a tester can check. Thread, Message, Draft, Event, Invite, Free slot, Judgment, Judge, Recommended action, Signal, Unsure, Tier and AI level are defined in `CONTEXT.md`; approvals are ADR 0002, Settings ADR 0004, Judgments ADR 0012, Signals ADR 0014 (proposed). Every default below is a Setting (`meetings.*`, the questions under `meetings.questions.*`) and every word a `strings.meetings.*` Setting.

## What it is for

Someone asks the owner to meet, or proposes a time, or the owner wrote "let's meet" and an answer arrives. monday reads the newest Message once, works out in code whether the owner is free, and offers the next step as a Recommended action chip. Every chip is an ordinary Tool call with its Tier: nothing is sent and no Event is made without the user.

## The cases

| Case | Read from the newest Message | Chip (likeliest first) | What the chip does |
|---|---|---|---|
| Asks, no usable time | `asks_to_meet` holds; no proposed time | **Offer times** | Code finds `meetings.slots` Free slots; the language model writes a short reply offering them in the user's voice; the reply opens as a Draft |
| "Next week" with no day | `asks_to_meet`, a relative "next week" part | **Offer times** | The same, with the slots inside next week |
| Proposes a time, owner free | `proposes_time` holds; a resolved, confident, future time; no busy Event overlaps | **Schedule Thu 15:00**, **Reply: works for me** | Schedule opens the scheduling card (`schedule_event`'s approval: title, time, guests, meeting link); approving makes the Event. Works for me opens a reply Draft accepting that time |
| Proposes a time, owner busy | as above, a busy Event overlaps | **Suggest another time** | Code finds the Free slots nearest the proposed time; the reply Draft declines the time and offers them |
| Several proposed times | up to `meetings.proposals_max` (3) proposals | as above for the first free one | Each is checked; the chip names the first free one, the rest stay in the options (and in the agent's tool) with their free or busy |
| Proposes a day, no time | "Thursday", "Thursday afternoon" | **Offer times Thu** | Free slots on that day, inside the part of the day when named (`meetings.parts_of_day`); none free that day: **Suggest another time** near it |
| Unsure | the time is below `meetings.schedule.time_confidence`, the zone is unclear, `proposes_time` is in the band between `meetings.pick.threshold` and `meetings.schedule.threshold`, a repeating meeting, a Message not in English, or no Free slot at all | **Pick a time** | Opens the event editor prefilled (the day and time read, the title, the guests); the user chooses and saves, and the editor asks before guests are emailed |
| The owner said "let's meet", no answer yet | the owner wrote the newest Message; `owner_asked` holds; no time | **Offer times** | A follow-up Draft with times |
| The owner proposed times | the owner wrote the newest Message and it proposes times | none | The other side answers next |
| The answer arrives | a new Message on the Thread | as above | The new Message is a new Thread version and is read again; the same logic applies |
| Already on the calendar | a proposed time overlaps an Event that has the sender as a guest | none | |
| An Invite is attached | a `text/calendar` part or an Invite for the Thread | none | The invite bar handles it (`calendar.md`); the Message is never sent to the Judge |
| No calendar can be read | no calendar seam, or none counts | **No calendar to check** | A toast says to connect one in Settings, Accounts |

The reader shows at most `meetings.max_in_reader` (2) meeting chips; a meeting chip replaces the judged "call" chip. A list row shows its one meeting chip on hover and on the selected row (`meetings.in_list`: `hover`, `always`, `off`), from the Cache, so the list never waits. A chip clicked on a row asks the Server again first: when the calendar moved it, the fresh chip is used and a toast says `strings.meetings.changed`.

After Schedule is approved the toast reads "Scheduled {title}. Reply that it works?" and the Works for me chip stays.

## The request

One Judgment request per Thread version (ADR 0014's shape, ahead of the Signal store): one state, every meeting question, answered in parallel (speculative fan-out). Code reads only the answers the Nouls call for.

**The gate** (code, no model): the request is not made when the newest Message has `List-Id` or `List-Unsubscribe`, an Invite is attached, or it holds none of `meetings.gate_words` (meet, call, chat, coffee, available, schedule, slot, talk and the rest) and no clock time next to a day. The Thread is stored as read by the gate.

**The state** (code builds it; nothing else goes in):
```json
{ "owner": { "name": "Sam Okafor", "email": "sam@monday.test" },
  "thread": {
    "subject": "The proposal",
    "owner_wrote_newest": false,
    "newest_message": { "from": { "name": "Aoife Byrne", "email": "aoife@example.com" },
                        "to": [{ "name": "Sam Okafor", "email": "sam@monday.test" }],
                        "written": "Tuesday 29 September 2026 at 10:15",
                        "text": "Could we meet Thursday at 3pm or Friday 10:30 CET?" },
    "message_before": { "from": { "...": "..." }, "written": "...", "text": "..." } },
  "clock_times": ["3pm", "10:30"],
  "zone_mentions": ["CET"] }
```
- `text` is the newest Message's own words (quoted history and `>` lines cut by code), up to `meetings.state.newest_chars`; the one before it up to `meetings.state.earlier_chars`.
- `written` is the date in words in the owner's zone, so the model reads "tomorrow" in context; it never computes with it.
- `clock_times` and `zone_mentions` are the spans code found (the pre-parsed value extraction pattern): "3pm", "15:00", "10.30", "noon", "at 4"; "CET", "PT", "UTC+2", "London time". The judge picks among them and never types a time back.

**The questions** (words are Settings; shown with their shipped text):
```json
{ "asks_to_meet": { "type": "noul",
    "instructions": "In `thread.newest_message`, written by someone other than the mailbox owner, the writer asks the owner to meet, have a call or talk live, or agrees to meet and asks when.",
    "criteria": { "true": "The newest message asks for a meeting, call, video call, coffee, demo or interview with the owner, or accepts one the owner suggested and asks which time suits.",
                  "false": "The newest message asks for no meeting: it only answers, informs, or mentions a meeting that is already arranged, past, or between other people." } },
  "owner_asked": { "type": "noul",
    "instructions": "In `thread.newest_message`, written by the mailbox owner, the owner suggests meeting, having a call or talking live with the other people on the thread.",
    "criteria": { "true": "The owner's newest message suggests meeting or talking, such as 'let's meet', 'shall we get on a call', 'happy to chat next week'.",
                  "false": "The owner's newest message suggests no meeting." } },
  "proposes_time": { "type": "noul",
    "instructions": "`thread.newest_message` proposes one or more specific days or times for that meeting.",
    "criteria": { "true": "The newest message names a day ('Thursday', '3 October', 'tomorrow') or a time ('3pm', '15:00') at which the writer offers or asks to meet.",
                  "false": "No day or time is offered for the meeting. Dates about other things (a deadline, a delivery, a past event) do not count; 'sometime next week' with no day does not count." } },
  "recurring": { "type": "noul",
    "instructions": "The meeting asked for in `thread.newest_message` repeats, such as a weekly call or a regular sync, rather than happening once." },
  "length": { "type": "choice",
    "instructions": "How long a meeting does `thread.newest_message` ask for, in minutes? Pick not_stated when it names no length and implies none.",
    "criteria": { "15": "15 minutes", "30": "30 minutes", "45": "45 minutes", "60": "60 minutes", "90": "90 minutes",
                  "not_stated": "The message names no length and implies none." } },
  "zone": { "type": "choice",
    "instructions": "In which of the time zones in `zone_mentions` is the proposed meeting time in `thread.newest_message` given? Pick not_stated when the message gives the time in no zone.",
    "criteria": { "CET": null, "not_stated": "The proposed time is given in no zone." } } }
```
Per proposed time n (first, second, third; `{nth}` in the Setting), date-part Choices with an explicit "not stated" option each (the date-extraction pattern):
```json
{ "p1_form":     { "type": "choice", "instructions": "How is the first day the newest message proposes for the meeting written? Pick none when the message proposes fewer days than that.",
                   "criteria": { "absolute": "A calendar date naming a month, such as '3 October' or '10/03'.",
                                 "relative": "Relative to when the message was written: 'today', 'tomorrow', 'the day after tomorrow', or 'next week' with no day named.",
                                 "weekday": "A named day of the week, such as 'Thursday' or 'next Tuesday'.",
                                 "time_only": "Only a time of day with no day, such as 'how about 3pm?'.",
                                 "none": "The message proposes fewer days or times than that, or none." } },
  "p1_relative": { "criteria": { "today": null, "tomorrow": null, "day_after": "...", "next_week": "...", "none": "..." } },
  "p1_weekday":  { "criteria": { "monday": null, "...": null, "sunday": null, "none": "No weekday is named." } },
  "p1_week":     { "criteria": { "this": "This week, as in 'this Thursday'.", "next": "The week after this one, as in 'next Thursday' meaning the following week, or 'Thursday next week'.", "none": "A bare weekday with no qualifier, or no weekday at all." } },
  "p1_month":    { "criteria": { "january": null, "...": null, "december": null, "none": "No month is named." } },
  "p1_day":      { "criteria": { "1": null, "...": null, "31": null, "none": "No day of the month is named." } },
  "p1_clock":    { "instructions": "Which of the times in `clock_times` is the time of day proposed for the first proposed day? Pick none when that day has no time of day.",
                   "criteria": { "3pm": null, "10:30": null, "none": "No time of day is given for that day." } },
  "p1_meridiem": { "criteria": { "am": "In the morning, before noon.", "pm": "At noon or later: the afternoon or evening.", "not_stated": "The message does not make it clear." } },
  "p1_part":     { "criteria": { "morning": null, "afternoon": null, "evening": null, "none": "No part of the day is named, or a clock time is." } } }
```
`p{n}_clock` and `p{n}_meridiem` are asked only when code found a clock time, `zone` only when it found a zone: the model is never asked for a value code did not find. About 33 questions over a 1,000 to 2,000 token state, one request, metered as `judge.meeting`.

**The judge path.** TypeSafe's Jev when its key is on the Server (the Runtime's `judge`); else, when `meetings.llm_fallback` is on, the language model gets the same state and the same questions in one prompt and answers them as JSON (`intelligence/prompt-judge.ts`: a Noul as a probability, a Choice as an option and a stated confidence; anything unreadable counts as unsure, never as yes); else nothing is asked and no chip shows. The header rules have nothing to say about meetings, so there is no third floor.

## Code, Jev, language model

| Code | Jev | Language model |
|---|---|---|
| The gate; quoted history cut; clock and zone candidates; the sender's UTC offset from the Date header; the English check; the date from its parts counted from the Message's date; the year; the clock time from the picked span; am or pm when the span says; working hours deciding a bare "at 4"; the zone and the instant (DST included); past and outside-hours flags; free or busy against the owner's calendars; the slot search and its spread; the case and the chip by the thresholds; the re-check before a draft; the grounding check of the reply; the template | Whether it asks to meet (per direction), whether it proposes a time, whether it repeats, the length, which zone, and each proposed time's parts: form, relative day, weekday, week, month, day, which clock span, am or pm, part of the day | The reply's prose only, in the Voice profile, around the slot lines code wrote. Nothing it writes is used unless code finds only the offered times in it |

Jev never compares dates, adds days or works out a weekday (Jev 1.13 jaggedness: dates and comparisons are code's).

## How a time is resolved

- **The day.** Relative words count from the day the Message was written in the zone the time is read in, not from today and not in UTC ("tomorrow" written at 00:30 on Wednesday in London is Thursday). A bare weekday is the next one on or after the written day; "this" is this week's; "next" the following week's, weeks starting on Monday unless `calendar.week_starts_monday` is off. A month and day with no year is this year's, or next year's when this year's is more than a week before the written day. A day that does not exist (31 February) or a part read below the floor makes the proposal unsure.
- **The time.** The picked span's own reading wins ("3pm", "15:00", "09:00", "noon"). A span with no am or pm ("10:30", "at 4") takes the judge's `meridiem` when it is confident; otherwise code keeps the one reading that fits the working hours (`calendar.day_start_hour` to `calendar.day_end_hour` with the meeting's length); when both or neither fit, the proposal is unsure.
- **The zone.** The zone the Message states, when the judge picked a zone code maps (PT, ET, CT, MT, UTC, GMT, BST, CET, EET, IST, JST, AEST, UTC±N, "London time" and the rest) with confidence; otherwise the owner's zone: `calendar.time_zone`, else the zone the Device reported when it last asked, else UTC. With no zone stated, a clock time, and a sender whose Date header offset differs from the owner's zone at that instant, the zone is unclear and the chip is Pick a time.
- **The length.** The `length` pick at or above `meetings.length_confidence`, else `calendar.default_duration_minutes` (the Meeting length Setting).
- **Flags.** A time before now is past (not scheduled; if the Thread still asks to meet, Offer times). A time outside working hours or days is shown and flagged ("outside your working hours" in the tooltip). A time with no day ("how about 3pm?") is unsure.

## Free and busy, and the slots

- **Busy** is what `find_free_time` treats as busy: the owner's own calendars (`meetings.busy_calendars`: `own`, default, or every `shown` calendar), Events not declined, not cancelled and not all-day, repeating ones expanded.
- **Slots** come from `find_free_time`'s own search (`freeSlots`): working hours on working days, starting on the `calendar.snap_minutes` step, not before now plus `meetings.lead_minutes` (120), within `meetings.lookahead_days` (7), `meetings.slots` (3) of them with at most `meetings.slots_per_day` (1) on one day.
- **Near a busy proposal**: the free slots from three days before to a look-ahead after it, nearest first, spread the same way, shown in time order.
- **Re-checked**: a draft checks each slot is still free and ahead before writing it; a slot that became busy is left out, and when none is left no text comes back and the chip is asked again.

## The reply

- The language model gets `meetings.draft_prompt`, the Voice profile when it is on, the Thread's subject and newest Message, and the slot lines code wrote ("- Thursday 1 October, 15:00 to 15:30 BST", `strings.meetings.draft.slot`), with the instruction to offer exactly those.
- Code checks the answer: every clock time in it is an offered start or end (or the proposed time a suggestion declines), every weekday and month named is an offered one, no relative day word appears, and every offered start appears. Otherwise, and whenever no language model answers, the template is used: `strings.meetings.draft.offer`, `.suggest` or `.accept` with the same slot lines. Em-dashes the model writes become commas.
- The text opens in the reply composer as the reply Draft's opening (paragraphs kept). Sending is the user's, with the Undo bar (ADR 0010).

## Storage and the feed

- Server: `thread_meetings` (migration `0022_thread_meetings`): the Thread, its Workspace, the Message id and count it read, the reading sealed under the Workspace key (content kind `meeting`: it holds spans from the text), who read it (`typesafe`, `llm`, `gate`), the model, when, and the chip the plan made then (times only, in the clear). A new Message makes a new reading; the same Message is never asked twice.
- The Changes feed carries a `meeting` change (`threadId`, `messageId`, `chip`) when a Thread is read and whenever a later look at the calendar changes its chip. The Cache keeps it in `thread_meetings` and joins it onto list rows.
- When: at `automate` with `meetings.on_arrival`, the sync engine's thread observer queues one `meeting` Job per Message; at `assist` (and for older mail), the reader asks on open. At `off` there are no chips and no requests.

## The agent

`meeting_options` (read-only): for a Thread, the case, each proposed time resolved with free or busy and its flags, Free slots (by default as the chips would offer them, or in the agent's own window with `from`, `to`, `duration_minutes`, `count`), and the Event's title and guests. "Reply to Aoife with some times next week" finds the Thread, asks `meeting_options` with next week's window, and writes the reply with `draft_message` from the slots returned; a free proposed time goes through `schedule_event`. Both ask first.

## Thresholds by risk

| Chip | Setting | Default | Why |
|---|---|---|---|
| Offer times | `meetings.offer.threshold` | 0.7 | Opens a Draft; a wrong one costs a click |
| Schedule, Works for me | `meetings.schedule.threshold`, `meetings.schedule.time_confidence` | 0.8, 0.7 | Makes an Event and invites people (asks first); a wrong time is worse than no chip |
| Suggest another time | `meetings.suggest.threshold` | 0.75 | Declines a time on the owner's behalf in a Draft |
| Pick a time | `meetings.pick.threshold` | 0.5 | Only opens the editor |
| Length | `meetings.length_confidence` | 0.6 | Otherwise the Meeting length Setting |
| Repeating | `meetings.recurring_threshold` | 0.7 | Series are the user's to set up |

## Settings

Beyond the thresholds: `meetings.enabled` (on), `meetings.on_arrival` (on), `meetings.lead_minutes` (120), `meetings.slots` (3), `meetings.slots_per_day` (1), `meetings.lookahead_days` (7), `meetings.busy_calendars` (`own`), `meetings.add_link` (on: the Event gets `calendar.meeting_link`'s kind), `meetings.parts_of_day` (morning 8 to 12, afternoon 12 to 17, evening 17 to 20), `meetings.in_list` (`hover`), `meetings.max_in_reader` (2), `meetings.non_english` (`unsure`), `meetings.llm_fallback` (on), `meetings.proposals_max` (3), `meetings.candidates_max` (8), `meetings.state.newest_chars` (3000), `meetings.state.earlier_chars` (600), `meetings.gate_words`, `meetings.draft_prompt`, and the questions `meetings.questions.asks_to_meet`, `.owner_asked`, `.proposes_time`, `.recurring`, `.length`, `.zone`, `.parts`. The calendar's own: `calendar.time_zone`, `calendar.day_start_hour`, `calendar.day_end_hour`, `calendar.work_days`, `calendar.snap_minutes`, `calendar.default_duration_minutes`, `calendar.week_starts_monday`, `calendar.meeting_link`.

## Strings

"Offer times", "Offer times {day}", "Schedule {when}", "Reply: works for me", "Suggest another time", "Pick a time", "No calendar to check", "outside your working hours", "the time zone is not clear", "a repeating meeting", "the time is not clear", "monday reads English best", "Opens a reply draft with {slots}. Nothing is sent.", "Asks before the Event is made and anyone is invited.", "Opens the event editor on {day} for you to choose.", "Opens the event editor for you to choose.", "monday needs a calendar to see when you are free. Connect one in Settings, Accounts.", "Your calendar changed. Here is what fits now.", "Scheduled {title}. Reply that it works?", "Meeting with {name}", the reply templates ("Happy to meet. Would one of these work for you?", "I'm not free at {proposed}, sorry. Would one of these work instead?", "{when} works for me. Talk then."), "- {day}, {start} to {end} {zone}", and the Meter line "Meeting requests".

## Edge cases

- **Past times**: never scheduled; the Thread falls back to Offer times when it still asks to meet, else nothing.
- **Outside working hours**: shown and flagged, never hidden.
- **All-day mentions** ("Thursday", "the 3rd"): Offer times on that day; all-day Events never block.
- **Repeating requests** ("a weekly sync"): Pick a time, flagged.
- **Other languages**: the English check marks the reading; under `meetings.non_english` `unsure` only Pick a time shows, and only when a meeting is likely.
- **Calendar not connected**, or no calendar counts: one chip that explains.
- **Several people on the Thread**: every other participant becomes a guest, no-reply addresses left out; the approval card shows them all before anyone is invited.
- **Adversarial mail** ("URGENT: accept now"): a reading never acts; Schedule always shows the approval card with the exact Event and guests.
- **A Thread changes while its chip shows**: the reader asks again for the new Message; a list chip is re-checked on click.
- **An Invite arrives later on the Thread**: the next read sees it and the chip goes.
- **Not propose-new-time**: Suggest another time is a reply Draft in the Thread, not the calendar Providers' propose-new-time on an Invite, which stays out of v1 (`README.md`).
- **Locked Server** (no root key): the reading cannot be sealed or the body read; the request waits, like Briefs.

## Acceptance criteria

1. A fixture Message "would you have time for a call?" from Aoife, with the owner free, shows Offer times; the reply Draft offers three Free slots on three days, none sooner than two hours, none over a busy Event, declined and all-day Events not counted; nothing is sent.
2. "Thursday at 3pm" (London, BST) with the owner free shows Schedule Thu 15:00 and Works for me; Schedule shows the approval card with Aoife as the guest and creates the Event only on approval.
3. The same with a 14:00 to 17:00 UTC Event shows Suggest another time with the nearest Free slots, none overlapping.
4. "Thursday at 3pm or Friday at 10:30" with Thursday busy schedules Friday 10:30 and keeps Thursday as a busy proposal.
5. The clock read at confidence 0.4, or a sender at UTC-7 with no zone stated, shows Pick a time, which opens the editor prefilled.
6. One Jev request per Message carries every meeting question; a second look at the same Message asks nothing; a new Message asks once more.
7. Without TypeSafe the language model is asked the same questions; without either, no chip.
8. A reply the model writes with a time it was not given is replaced by the template.
9. An attached Invite, a newsletter or a receipt never reaches the Judge.
10. At AI level off there are no chips and no requests.
11. `meeting_options` returns the case, free and busy proposals, and slots in the agent's window.

## Moving onto Signals

This ships before the Signal store (slices 30 to 35) with its own table and request, the shape ADR 0014 describes: one Thread, every question, one request. When the store lands (slice M2 in `slices.md`): `asks_to_meet`, `owner_asked`, `proposes_time`, `recurring` and `meeting_length` become shipped action Signals owned by the Recommended action (`action:meeting.*`, words kept as today's Settings), the date parts ride speculatively with `has_deadline`'s parts under the `meeting_*` prefix, the gate becomes their FactGate, the Signal request asks them with every other Signal, `thread_meetings` readings migrate into `signal_answers` at version 1 and the table is dropped, `sender_offset` joins the Facts, and the chips join the Recommended action row (`actions.md`) under its limits and learning. The plan, the slot search, the reply and the tool stay as they are.
