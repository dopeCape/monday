# Routing page behavior

Behaviors a tester can check. Routing, Groups, Sections, Judgments and Examples are defined in `CONTEXT.md`; the placement rule is ADR 0004 and ADR 0012; every default is a Setting and every word a `strings.routing.*` Setting.

## Locked by the AI level

- New mail is sorted only at the AI level "Mail that sorts and acts for me". Below it the page opens with the same locked panel as Workflows: "Sorting is paused", "Increase the AI level to unlock Routing.", one line naming the current level and how many Groups are kept, what Routing brings (`strings.routing.locked.benefits`), and the one action to raise the level after a short confirm (or, when `ai.level` is in the Config file, where to change it).
- Nothing is lost: every Group, rule, Sub-group, Section and custom action stays, and Groups still work by hand (new Group, Change rule, delete, moving mail). Each rule carries a Paused tag. Re-run on inbox and "Ask for a group" are hidden; the overview says "Sorting paused".

## Overview

- Under the head, one line: how many Groups, how many visible Sections, how many Threads wait for a decision, and the sorting state: "Sorting new mail as it arrives" (`routing.on_arrival`), "Sorting only when you re-run", or "Sorting paused".
- Three tabs: Groups, Sections and judgments, Custom actions, each with its count.

## Groups

- Each top-level Group is a card: its icon, name, unread and routed Thread counts, the mean Confidence as a small meter with "94% confident" once something was scored, Change rule and Open (the Group in the inbox).
- "Rule": the plain-language sentence, with the Predicate's facts it mentions set in code.
- "Always": the Predicate as chips ("Anyone at careers.example.com", "From billing@stripe.com", "Subject has invoice", "List …", "With an attachment"), and the Group's own threshold ("Asks you below 70% sure") when it has one.
- Sub-groups hang from the card on a tree line, each with its sentence and unread count, and open in the inbox.
- "Learned from n of your corrections": the Group's Examples (threads the user moved in or out), behind Show.
- Change rule opens the editor inside the card: name, sentence, domains, senders, subjects, lists, threshold, Brief policy, the Examples, Save, Cancel, and Delete group, which asks once naming the Group.

## Sections and judgments, Custom actions

- The Sections block and the Actions block, the same rows the Agent writes (`sections.rules`, `sections.order`, `actions.custom`): each Section's sentence, conditions, Judgment, placement, reorder, rename, hide and delete; each custom action's label, condition, tool, arguments and Tier. "Ask monday" rows hand a sentence to the composer, hidden while locked.

## Beside the Groups

- Re-run on inbox opens a small popover that asks which mail: the Sort scope (CONTEXT.md), picked with monday's own segmented controls, starting at `routing.rerun.scope` (default the newest 50): the newest N threads, the last N days, weeks, months or years, everything since a date, or everything. "Show what would move" runs the dry run with its progress above the tabs; Apply moves them, Cancel drops the preview.
- A scope that holds more than `routing.rerun.preview_max` Threads (default 500) is not listed thread by thread: the dry run scores the newest `routing.rerun.sample` (default 100) and says so ("12 of the newest 100 would move. All your mail holds 56,000 threads: Apply moves these now and sorts the rest in the background."), with the counts per Group. "Apply and sort the rest" moves the sample and starts the Backlog sort below it.

## Background sorting

- The Backlog sort (CONTEXT.md) routes the mail already there, inside a Sort scope, newest first: one per Workspace, a `route-backlog` Job (ADR 0005) that keeps its place in `routing_backlogs`, so a restart resumes where it was. It starts from a large re-run's Apply, from an approved Group proposal (onboarding, `propose_groups`) or from `organize_existing` with a scope; starting another replaces the one running.
- `routing.backfill.concurrency` requests (default 16) are in flight at once; on one Thread per request they run through one worker pool page after page, the next starting as soon as one answers, each page written back in order so the cursor never passes a Thread still being asked. On TypeSafe a request carries up to `routing.backfill.batch_size` Threads (default 50: TypeSafe warns that unrelated material in the state costs accuracy), one Choice each over one state that holds the batch's Threads and the Groups once, cut short to fit `routing.backfill.request_tokens` (64,000, Jev 1.13's per-request budget) and `routing.backfill.state_tokens` (32,000, state plus the longest question). Without TypeSafe a language model is asked about `routing.backfill.llm_batch_size` Threads per prompt (default 5), one prompt at a time; on a coding agent the card says it is slow. Every request is metered as today. Slices 28 and 29 measure this packing against one Thread per request and move the Backlog sort onto the Signal request, one Thread per request with its missing Signals (`signals.md`, "Measure first"; ADR 0014).
- Placement is arrival routing's: the Predicates first, the same thresholds (route, Needs a decision, leave), Sub-groups in a second stage. A Thread the user placed is never moved; a count scope stops at its count.
- Mail that lands in scope while it runs is sorted too: when the walk has caught up with the mail synced so far and the first sync is still bringing older mail inside the scope, it waits `routing.backfill.sync_wait_seconds` and goes on; then one pass takes Threads that arrived above where it started and that arrival routing did not place.
- With nothing that can sort it waits `routing.wait_seconds` and says "Sorting needs TypeSafe, an AI provider key, or a coding agent."; below "sorts and acts for me" it waits for the level. It never fails for either.
- The Routing page shows it above the tabs while it runs, is paused, or ended while the page was open: "Sorting the last 3 months", "1,200 of 5,400 threads", "310 moved, 12 to decide, 2 you placed", the batch, why it waits, and Pause, Resume and Stop (then Dismiss). It reads `GET /routing/backlog` every `routing.backfill.poll_seconds`. The agent's card that started it and onboarding's conversation show the same progress in one line.
- "Ask for a group" hands "Make a group: …" to the composer.
- Needs a decision: each Thread with its candidate Groups as buttons carrying routing's Confidence ("Hiring 61%") and Leave; an answered row fades out and becomes an Example.
- Recently routed (`routing.page.recent_shown`, 0 hides it): each Thread's subject, the Group it went to, and why: "Matched <fact>" (a Predicate fact its headers met), "Read the rule, n% sure" (the model on the rule sentence), "You put it here" (a correction), or "Sorted by the rule".
- At automate with nothing on the Server that can sort (no TypeSafe key, no key for the chosen provider, no connected coding agent; the judge state `none`), a note says "Sorting needs TypeSafe, an AI provider key, or a coding agent." New Threads wait meanwhile (`routing.wait_seconds`) and are sorted once one is there; their route Jobs never fail for it.
- Who sorts, with `ai.judge.provider` auto: TypeSafe when its key is on the Server; else the language model the user actually has (a connected Local runtime, else the chosen provider when its key is shared); never a provider with no key.
- A TypeSafe key added anywhere (onboarding, Settings, AI and agent) is shared with the Server on save while `ai.judge.share_by_default` is on, and a key already in the keychain whose share Setting is on is shared again when the app starts and the Server lacks it. A language model's key is shared on save only while the Sidecar is the only Server (`ai.keys.share_with_sidecar`); beside a Cloud, sharing stays the user's switch.

## Strings

Every user-visible string is a Setting keyed by name: `strings.routing.*`, the Sections and actions strings under `strings.settings.*`, and the shared `strings.ai.lock.*`.
