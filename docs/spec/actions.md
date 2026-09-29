# Recommended actions

Behaviors a tester can check. Recommended action, Signal, Fact and Unsure are defined in `CONTEXT.md`; approvals are ADR 0002, Signals ADR 0014; every default is a Setting (ADR 0004) and every word a `strings.actions.*` Setting.

## What the user sees

- The reader shows up to `actions.recommended.max_in_reader` (3) chips under the Brief, or at the top of the Thread when there is no Brief, before any Brief is written: "Reply", "Snooze until Mon 09:00", "Forward to Priya". Custom actions that apply come first; Recommended actions fill the rest, likeliest first.
- In the list, a row's hover (and the selected row) shows the top Recommended action beside archive and snooze (`actions.recommended.in_list`: `hover`, default; `always`; `off`), at most `actions.recommended.max_in_list` (1). Nothing is added to a row at rest, so the calm row rule holds (`inbox.md`, Rows).
- Keys: `actions.recommended.keys` (default Alt+1, Alt+2, Alt+3) run the chips in reader order; in the list the key runs the hovered or selected row's chip. The palette lists them for the open Thread ("Snooze until Mon 09:00").
- Each chip is an ordinary Tool call with its Tier, unchanged (ADR 0002): a reply, forward or hand-off opens compose and sends nothing; an RSVP, an unsubscribe and anything else that reaches a third party shows its approval card with the exact payload; archive and snooze apply with Undo; opening a link or a carrier's page is read-only.
- "Not this" on a chip's menu hides it for this Thread; "Not for mail from stripe.com" stops that action for that sender (below).

## The catalog

Each action has a **fit** Signal (a Noul, owned by the Recommended action, shipped, its words a Setting under `actions.recommended.<action>.question`) and, where it takes arguments, argument Signals asked speculatively in the same Signal request (`signals.md`). Code gates which questions are asked at all and assembles the arguments; the chip shows only when the fit clears the action's threshold and every argument it needs is confident. Below, `state` is the Signal request's state.

### Reply
- Fit: the shipped `needs_reply` Signal (no second question for the same thing).
- Arguments: none from Jev. The chip reads "Reply" or, when a Template fits (`templates.md`, "On open"), "Reply with Confirm the time"; with a Brief, the Brief's proposed opening line is placed in the draft (the only thing the Brief still writes for chips).
- Tool: `compose.reply` (always-ask; opens compose, sends nothing).

### Archive
```json
{ "type": "noul",
  "instructions": "The mailbox owner can archive this thread now: nothing on it needs them and they will not need to find it in the inbox again.",
  "criteria": { "true": "A receipt, notification, confirmation, finished exchange or announcement that asks nothing and is complete.",
                "false": "Anything that asks the owner for something, is still in progress, has a date still ahead, or that the owner is likely to come back to." } }
```
- Gate: no Unsure or holding `needs_reply`, `waiting_on_me`, `has_deadline` with `deadline_at` ahead.
- Tool: `thread.archive` (reversible).

### Snooze
```json
{ "type": "noul",
  "instructions": "This thread needs the mailbox owner later, not now: it names a later day when something happens, or it waits on something that has not happened yet.",
  "criteria": { "true": "Examples: a delivery due Thursday, a meeting next week that needs preparing the day before, 'let's pick this up after the launch'.",
                "false": "It needs the owner now, or never." } }
```
- Arguments, speculative, read only when the fit holds:
```json
{ "snooze_anchor": { "type": "choice", "instructions": "If the owner puts this thread aside, when should it come back? Use the day the thread itself points to.",
    "criteria": { "tomorrow": null, "weekday": "A named day this week or next.", "next_week": "Next week, no day named.",
                  "deadline": "Shortly before the date the owner has to act by.", "date": "A calendar date named in the thread.",
                  "none": "The thread points to no day." } },
  "snooze_weekday": { "type": "choice", "instructions": "If it should come back on a named day of the week, which one?",
    "criteria": { "monday": null, "...": null, "sunday": null, "none": null } },
  "snooze_part": { "type": "choice", "instructions": "If the thread points to a part of that day, which one?",
    "criteria": { "morning": null, "afternoon": null, "evening": null, "none": null } } }
```
- Code: `deadline` reuses `deadline_at` minus `actions.snooze.before_deadline_hours` (24); `date` reuses the `deadline_*` parts; parts of day map to the snooze presets (`inbox.snooze.*`); `none` or low confidence falls back to the first preset and the chip reads "Snooze" and opens the picker.
- Tool: `thread.snooze` (reversible).

### Forward and Hand to someone
```json
{ "forward_fits": { "type": "noul",
    "instructions": "The mailbox owner will want to send this thread on to someone else so they have it, such as an accountant, an assistant or a colleague who keeps records." },
  "delegate_fits": { "type": "noul",
    "instructions": "The mailbox owner will want someone else to handle what this thread asks, rather than doing it themselves." },
  "forward_to": { "type": "choice",
    "instructions": "If the owner sends this thread on, to whom? Choose from the people listed; use what the owner did with earlier mail from this sender.",
    "criteria": { "accounts@monday.test": "Forwarded 9 threads from billing@hetzner.com",
                  "priya@monday.test": "Priya Raman, same company, often copied on invoices",
                  "none": "None of these people." } } }
```
- Candidates for `forward_to`, built by code: the addresses the owner forwarded this sender's mail to, the addresses the owner handed similar mail to, the addresses named in the Thread's text, and `actions.delegate.people` (the user's own list of people they hand work to), at most `signals.candidates.max`, each with one line of Facts as its description. The gate asks it only when there is a candidate.
- The chip shows "Forward to Priya" when `forward_fits` clears its threshold and `forward_to` picks a person with confidence at or above `actions.recommended.forward.to_confidence`; "Hand to Priya" when `delegate_fits` does. A hand-off opens compose with the "Handing this over" Template and, if `actions.delegate.follow_up_days` is set, offers to snooze the Thread until then after sending.
- Tool: `compose.forward` (always-ask; opens compose with the recipient filled, sends nothing).

### RSVP
- Gate: the Fact `has_invite` and not `invite_answered`. The Invite exists, so no fit question is asked.
- The chip is one grouped control, "Accept · Maybe · Decline", with the Fact `invite_clashes` shown when true ("Clashes with Design review"). monday does not guess the answer: which to pick is the user's.
- Tool: the calendar's RSVP tool with its existing Tier (`calendar.md`).

### Add to calendar
```json
{ "calendar_fits": { "type": "noul",
    "instructions": "The thread proposes or confirms a specific meeting, call, appointment or event for the mailbox owner, with a day, and no calendar invite for it is attached." },
  "event_minute": { "type": "choice", "instructions": "If the event names a time, at which minute past the hour does it start?",
    "criteria": { "00": null, "15": null, "30": null, "45": null, "other": null, "none": null } } }
```
- Gate: not `has_invite`. The day and hour reuse the `deadline_*` part Choices with their own instructions ("the day and time the event happens", asked as `event_*` part Choices, the same option sets); code assembles the start in the Workspace's zone; the length is `actions.calendar.default_minutes` (30); the title is the subject without "Re:" and "Fwd:".
- The chip reads "Add Thu 15:00 to calendar"; without a confident hour, "Add Thu to calendar" opens the event form on that day.
- Tool: `calendar.create_event` with its Tier (always-ask when it invites anyone; the chip never adds invitees).

### Meetings

Meeting requests and proposed times have their own actions, specced and built ahead of the Signal store: `meetings.md`. **Offer times** (a reply Draft with Free slots), **Schedule** and **Reply: works for me** (a proposed time the owner is free for), **Suggest another time** (busy then), and **Pick a time** (the event editor, when the reading is unsure). Their fit questions are the meeting Nouls (`asks_to_meet`, `owner_asked`, `proposes_time`), their arguments the meeting date parts; code does every date, zone, free and busy decision.
- Where a Thread asks to meet or proposes a meeting time, the meeting chips take the place of Add to calendar: Schedule is Add to calendar with the free or busy check, the guests and the reply. Add to calendar stays for events that are not meetings with the sender (an appointment, a talk, a delivery window).
- Tools: `schedule_event` (always-ask, its approval card) for Schedule; `compose.reply` (always-ask; opens compose with the reply text, sends nothing) for the three replies; the event editor (the user's own write) for Pick a time.
- They count in the chip limits below, like every Recommended action: at most `meetings.max_in_reader` (2) of them in the reader, one on a row.

### Pay or file
```json
{ "pay_fits": { "type": "noul",
    "instructions": "The thread asks the mailbox owner to pay an amount that is still due: an invoice, bill or payment request, not a receipt for something already paid." },
  "pay_link": { "type": "choice",
    "instructions": "Which of these links opens the page where the owner pays this amount?",
    "criteria": { "l1": "\"Pay invoice\" on pay.stripe.com", "l2": "\"View in browser\" on hetzner.com", "none": "None of these is a payment page." } } }
```
- Gate: `money_involved` holds, `money_direction` is `owner_pays`, and a `money_amount` was picked. `pay_link` is asked only when the Thread has links; its options are code-numbered link ids with their visible text and domain.
- Code refuses a picked link whose domain is not the sender's domain or on `actions.pay.trusted_domains` (shipped with the common payment processors), and any link on a Thread whose `hidden_instructions` holds; the chip then reads "Remind me to pay" only.
- The chip reads "Pay $1,315.50 by Oct 3" and opens the link in the browser after showing its domain; its menu has "Remind me" (snooze until `deadline_at` minus `actions.pay.remind_days_before`, 2) and "File" (the Custom action or Tag the user set for invoices, when there is one). monday never pays anything.
- Tools: `open.link` (read-only, the domain shown first), `thread.snooze` (reversible).

### Unsubscribe
- No Jev question. Code shows it when the Fact `list_unsubscribe` exists, `newsletter` holds, and the owner left the last `actions.unsubscribe.unread_streak` (5) issues from the same `list_id` unread.
- The action is RFC 8058 one-click (a `POST` with `List-Unsubscribe=One-Click`) when `List-Unsubscribe-Post` is present, else the `mailto:` address as a Message sent through the Account. An `https:` link without one-click is never fetched by monday; the chip opens it in the browser instead.
- Tool: `list.unsubscribe` (new, always-ask: it reaches a third party). The card names the list and the exact request or address. Afterwards, offer "Archive the 23 issues from this list" (reversible).

### Track a package
```json
{ "track_fits": { "type": "noul",
    "instructions": "The thread is a shipping or delivery notice for a package on its way to the mailbox owner." },
  "track_number": { "type": "choice",
    "instructions": "Which of these is the tracking number of that package?",
    "criteria": { "1Z999AA10123456784": "UPS pattern", "none": "None of these is the tracking number." } } }
```
- Gate: a tracking-number or carrier-link candidate found by the carrier patterns. Code builds the carrier's URL from the picked number (or uses the picked carrier link).
- The chip reads "Track package"; its menu offers "Snooze until the delivery day" when `deadline_*` gave one.
- Tool: `open.link` (read-only).

### Run a Workflow
```json
{ "workflow_pick": { "type": "choice",
    "instructions": "Which of the owner's workflows would the owner start on this thread by hand?",
    "criteria": { "wf_candidate_intake": "Candidate intake: when a candidate sends a take-home, save it to Drive and post in #hiring",
                  "none": "None of these workflows is meant for this thread." } } }
```
- Gate: the Workspace has enabled Workflows with a manual trigger or a Thread trigger; the options are those Workflows with the sentence each was written from, at most `signals.candidates.max`.
- The chip reads "Run Candidate intake" when the pick's probability clears the threshold and its confidence clears the floor. Running it is `workflow.run` on that Thread; every Step keeps its own approval.

## Thresholds by risk

| Action | Setting | Default | Why |
|---|---|---|---|
| Reply | `actions.recommended.reply.threshold` | 0.7 | Opens compose; a wrong one costs a click |
| Archive | `…archive.threshold` | 0.85 | Hides mail; Undo exists but the user may not notice |
| Snooze | `…snooze.threshold` | 0.75 | Hides mail until a time |
| Forward | `…forward.threshold`, `…forward.to_confidence` | 0.8, 0.8 | A wrong recipient is embarrassing even if it asks |
| Hand to someone | `…delegate.threshold`, same recipient floor | 0.85, 0.8 | Passes responsibility |
| Add to calendar | `…calendar.threshold`, `…calendar.time_confidence` | 0.75, 0.7 | A wrong time is worse than no time |
| Meetings | `meetings.offer.threshold`, `meetings.schedule.threshold`, `meetings.schedule.time_confidence`, `meetings.suggest.threshold`, `meetings.pick.threshold` | 0.7, 0.8, 0.7, 0.75, 0.5 | By risk, in `meetings.md` |
| Pay or file | `…pay.threshold`, `…pay.amount_confidence` | 0.8, 0.8 | Money; the amount must be right |
| Unsubscribe | code only | | No judgment |
| Track a package | `…track.threshold` | 0.7 | Read-only |
| Run a Workflow | `…workflow.threshold`, confidence floor 0.6 | 0.8 | Starts automation |
| RSVP | code only | | The Invite is a fact |

Thresholds are tuned against the pinned model; the Signals page shows each action's fit rate.

## Brief chips, judged chips and Custom actions

- **Replaced:** the judged chips of slice 25 (`CHIP_NAMES`: reply, call, review link, open attachment, pay or file, snooze) and the `chip_*` questions. Reply, snooze and pay carry over; call folds into the meeting chips (`meetings.md`), which already replace it in the reader wherever they show; review link and open attachment are dropped as chips, since the reader already shows the Thread's links and attachments (see the open question in the report).
- **Merged:** the Brief no longer chooses actions. It keeps its bullets and writes the reply's proposed opening line, which the Reply chip uses. Brief-less Threads get the same chips, because the chips come from Signals asked on arrival.
- **Kept:** Custom actions are the user's own and render first in the chip row and in the toolbar. A Custom action and a Recommended action with the same tool and arguments render once, as the Custom action.

## Learning from what the user does

- Every chip shown is a row in `recommendation_events` (workspace, thread, action, the fit probability, the arguments, shown at, outcome): `used` (clicked or its key), `dismissed` ("Not this"), `ignored` (the Thread was archived, snoozed or answered another way while the chip showed), `other_used` (the user did the same kind of action with other arguments, such as a different recipient).
- Per action, over its last `actions.learning.window` (50) outcomes: when fewer than `actions.learning.min_use_rate` (10%) were used, the action's threshold rises by 0.05, up to 0.95; when more than `actions.learning.high_use_rate` (60%) were, it falls by 0.05, never below its shipped default. Each change is a Setting write the Activity log shows ("Archive suggestions: shown 50 times, used 3; now shown only when 90% sure"), undoable.
- "Not for mail from stripe.com" adds the sender's domain to `actions.recommended.<action>.muted_senders`. `other_used` recipients become forward candidates ahead of the others.
- What the owner did with a sender's mail also reaches Jev as `sender_history` in the Signal request's state, so the next Thread from the same sender is judged with it. No weights are trained.

## Background cost

The action Signals ride in the Signal request: about 12 questions, about 1,200 tokens, about $0.00005 per Thread on top of the request. Argument Choices are asked only when their gate holds. A Thread outside the Signal scope gets its chips when it is opened: the reader asks the Signal request for it once, at open, and shows the chips when it answers.

## Settings

Beyond the thresholds above: `actions.recommended.enabled` (on), `actions.recommended.max_in_reader` (3), `actions.recommended.max_in_list` (1), `actions.recommended.in_list` (`hover`), `actions.recommended.keys` (Alt+1..3), `actions.recommended.<action>.enabled` (on for each), `actions.recommended.<action>.question` (the words above), `actions.recommended.<action>.muted_senders` ([]), `actions.snooze.before_deadline_hours` (24), `actions.calendar.default_minutes` (30), `actions.pay.remind_days_before` (2), `actions.pay.trusted_domains` (shipped list), `actions.unsubscribe.unread_streak` (5), `actions.delegate.people` ([]), `actions.delegate.follow_up_days` (3), `actions.learning.window` (50), `actions.learning.min_use_rate` (0.1), `actions.learning.high_use_rate` (0.6), `actions.learning.enabled` (on).

## Strings (examples)

"Reply", "Reply with {template}", "Archive", "Snooze until {when}", "Snooze", "Forward to {name}", "Hand to {name}", "Accept", "Maybe", "Decline", "Clashes with {event}", "Add {when} to calendar", "Pay {amount} by {date}", "Remind me to pay", "Unsubscribe", "Archive the {count} issues from this list", "Track package", "Run {workflow}", "Not this", "Not for mail from {domain}", "{action} suggestions: shown {shown} times, used {used}; now shown only when {percent} sure".

## Edge cases

- The Thread changes while a chip is shown: the chip stays until the new Signal request answers, then updates; a click on a chip whose Thread version changed re-checks the arguments first ("This thread changed. Snooze until Mon 09:00 still?").
- Two actions tie: the order is fit probability times the action's recent use rate; Custom actions still go first.
- A Thread in a Group whose Custom action already archives: the Recommended archive is not shown.
- Unsure `hidden_instructions`, `not_english` or `image_only`: no Recommended action except RSVP and Unsubscribe, which rest on headers alone.
- Offline: chips come from the Cache; running one goes through the Outbox like any action; an always-ask one waits for the Server.
- The AI level is `assist`: chips show on open (the Signal request runs at open, like Briefs); `off`: no chips.

## Code, Jev, language model

| Code | Jev | Language model |
|---|---|---|
| Candidates (people, links, amounts, tracking numbers, Workflows); gates; date assembly; link-domain checks; the unsubscribe request; thresholds, ordering and learning | Every fit Noul and every argument Choice | The Brief's proposed reply line; nothing else here |

## Acceptance criteria

1. The fixture Hetzner invoice shows "Pay $1,315.50 by Oct 3" and "Remind me to pay" before any Brief, and no link is offered when the link's domain is not Hetzner's or a trusted processor.
2. The fixture podcast invite from Sofia shows "Reply"; a fixture meeting proposal "Thursday at 3pm" shows "Add Thu 15:00 to calendar", and adding it creates the event only on the owner's calendar.
3. A newsletter left unread five issues running shows "Unsubscribe"; approving sends the RFC 8058 POST, which a fake list server records.
4. Forward to a person appears only when the fake judge's `forward_to` confidence is at or above 0.8; the compose opens with that person and nothing is sent.
5. Dismissing Archive on 45 of 50 fixture Threads raises its threshold to 0.9, the Activity log shows the change, and Undo restores 0.85.
6. A Thread whose `hidden_instructions` holds shows no Recommended action except RSVP or Unsubscribe.
7. The reader never shows more than three chips and a row never more than one, on hover only by default.
8. `CHIP_NAMES`, `chip_*` questions and the Brief's action choice are gone; the Brief's reply line reaches the Reply chip.
