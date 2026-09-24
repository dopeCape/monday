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

- Re-run on inbox shows "What would move" first (a dry run); Apply moves them, Cancel drops the preview.
- "Ask for a group" hands "Make a group: …" to the composer.
- Needs a decision: each Thread with its candidate Groups as buttons carrying routing's Confidence ("Hiring 61%") and Leave; an answered row fades out and becomes an Example.
- Recently routed (`routing.page.recent_shown`, 0 hides it): each Thread's subject, the Group it went to, and why: "Matched <fact>" (a Predicate fact its headers met), "Read the rule, n% sure" (the model on the rule sentence), "You put it here" (a correction), or "Sorted by the rule".
- At automate with no shared key, a note says routing needs one.

## Strings

Every user-visible string is a Setting keyed by name: `strings.routing.*`, the Sections and actions strings under `strings.settings.*`, and the shared `strings.ai.lock.*`.
