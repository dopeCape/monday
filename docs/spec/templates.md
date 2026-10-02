# Templates

Behaviors a tester can check. Template and Placeholder are defined in `CONTEXT.md`; approvals are ADR 0002, Workflows ADR 0003, the Config file ADR 0001; every default is a Setting (ADR 0004) and every word a `strings.templates.*` Setting.

## What a Template is

```ts
interface Template {
  id: string;
  workspaceId: string | null;     // null only for the built-ins
  shareGroupId: string | null;    // copies of one Template in several Workspaces share this id
  name: string;                   // "Confirm the time"
  fitsWhen: string;               // one line: when it fits, used by suggestions
  kind: "reply" | "starter";      // answers a Thread, or starts a new Message
  subject: string | null;         // starters only; may hold Placeholders
  body: string;                   // plain text with light markup, may hold Placeholders
  placeholders: Placeholder[];    // declared, in order of first use
  builtIn: string | null;         // the built-in it was copied from, if any
  createdBy: "user" | "agent";
  updatedAt: string;
}

interface Placeholder {
  name: string;                   // "invoice_number", written {invoice_number} in the body
  type: "person" | "first_name" | "email" | "date" | "time" | "amount" | "number" | "reference" | "link" | "text";
  optional: boolean;              // written {name?}; an unfilled optional Placeholder and the space before it are removed
  hint: string;                   // "the invoice number the sender quotes"
}
```

- A Placeholder is written `{name}` or `{name?}`. Every name in the body must be declared and every declared name used; a Template that breaks this does not save.
- Types decide where candidates come from (below) and how a picked span is normalized: a `date` or `time` in the user's format, an `amount` with its currency, a `first_name` as the first word of a display name.

## Where Templates live

- **Server data, not Settings and not the Config file.** A Template is the user's content, like a Draft: rows in `templates` on the Server with name, fits-when, subject and body sealed under the Workspace key (ADR 0009), synced to every Device and mirrored into the Cache for the picker and for search. They are never written to `monday.toml` (ADR 0001: the file holds preferences, never data).
- **Built-ins** ship as data in `packages/shared/src/templates/builtin.ts`, read-only. Editing one saves a copy in the Workspace that replaces it in the picker; "Restore the original" deletes the copy. Hiding a built-in is the Setting `templates.builtin.hidden` (a list of ids), since that is a preference.
- **Across Workspaces.** A new Template belongs to the current Workspace (`templates.default_scope`, `workspace`). "Use in every account" saves one copy per Workspace, each sealed under its own key, linked by `shareGroupId`; editing one offers "Change it everywhere" or "Only here".
- **Files, on request only.** Settings › Templates has Export (a folder of Markdown files, one per Template, with the name, fits-when, kind and Placeholders as front matter) and Import (the same format). Neither runs by itself, and nothing watches the folder.

## The built-ins

| Name | Kind | Fits when | Placeholders |
|---|---|---|---|
| Thanks, received | reply | Someone sent a file, document, payment or information the owner only needs to acknowledge | `{first_name}`, `{thing}` |
| Confirm the time | reply | Someone proposed a time for a call or meeting and the owner accepts it | `{first_name}`, `{time}`, `{date}` |
| Offer other times | reply | Someone proposed a time the owner cannot make | `{first_name}`, `{times}` |
| Decline politely | reply | The owner says no to a request, invitation or offer | `{first_name}`, `{reason?}` |
| Need more time | reply | The owner cannot meet a deadline and proposes a later one | `{first_name}`, `{new_date}` |
| Follow up | reply | The owner wrote before and has had no answer | `{first_name}`, `{topic}` |
| Here is the file | reply | Someone asked for a document the owner is attaching | `{first_name}`, `{document}` |
| Ask for details | reply | The owner needs one thing clarified before acting | `{first_name}`, `{question}` |
| Handing this over | reply | The owner passes the request to a colleague who will handle it | `{first_name}`, `{colleague}`, `{colleague_email}` |
| Payment sent | reply | The owner has paid an invoice and says so | `{first_name}`, `{amount}`, `{reference}`, `{date}` |
| Question about an invoice | reply | Something on an invoice looks wrong | `{first_name}`, `{reference}`, `{amount}`, `{issue}` |
| Not interested, thanks | reply | Sales or recruiting outreach the owner declines | `{first_name}` |
| Thanks for applying | reply | A candidate applied; the owner confirms and names the next step | `{first_name}`, `{role}`, `{next_step}` |
| Reschedule | reply | The owner moves an agreed meeting | `{first_name}`, `{old_time}`, `{new_time}` |
| Slow to reply this week | reply | The owner is away or busy and sets expectations | `{first_name}`, `{return_date}` |
| Thank you | reply | The owner thanks someone for help, a favour or an introduction | `{first_name}`, `{what_for}` |
| Introduce two people | starter | The owner connects two people who should talk | `{person_a}`, `{person_b}`, `{person_b_email}`, `{reason}` |
| Schedule a call | starter | The owner asks someone for a short call | `{first_name}`, `{topic}`, `{times}` |
| Checking in | starter | The owner restarts a quiet conversation | `{first_name}`, `{topic}` |
| Ask for a refund | starter | The owner asks a company to refund an order | `{company}`, `{reference}`, `{amount}`, `{reason}` |
| Please remove me | starter | A list without an unsubscribe header keeps writing | `{company?}` |

Example body, "Confirm the time":

```
Hi {first_name},

{time} on {date} works for me. I'll send an invite shortly.

Thanks,
```

The signature is the Account's own, added by compose as today; built-ins never contain one. Every built-in's text avoids em-dashes and is plain enough to read in any Voice profile.

## Using a Template

- **The picker.** In compose, typing `templates.trigger` (default `;;`) at the start of a line, the key `compose.templates.open` (Ctrl or Cmd+;), or the Templates button opens the picker at the caret: the Workspace's Templates, then the built-ins, filtered as the user types by name and fits-when. Arrows move, Enter inserts, Esc closes. The palette lists them too ("Template: Confirm the time"). The picker ends with "Manage templates", which opens Settings › Templates (the open compose window goes to the dock).
- **The Templates button.** Both compose surfaces (the compose window and the inline reply) have a Templates button in the writing toolbar, after the formatting: a Phosphor notepad and the label `strings.templates.button`. Its tooltip names the trigger and the picker key from their Settings ("Insert a template. Type ;; at the start of a line, or press Ctrl+;"). It opens the picker at the caret, or at the end of the owner's text when the editor is not focused; a second click closes it. With `compose.toolbar` off the row and the button are hidden; the trigger and the key still work.
- **The one-time hint.** Until the device flag `templates.hint.trigger_seen` is set, compose with Templates on shows one quiet line where suggestions go: "Type ;; for templates" (the trigger from its Setting) and "Got it". Got it, or inserting any Template, sets the flag; the line never shows on that device again. A suggestion line takes its place while one shows.
- **Jev's order in the picker.** When the picker opens in a reply, or with something typed, it opens at once in the order above and asks request 1 below alone (`rankOnly`: the ranking Choice, no gate, no closer look) for that Thread and the typed text, the trigger left out. When the ranking is back the picker reorders: at most `templates.picker.suggested_max` (3) Templates the ranking gives at least `templates.picker.suggested_floor` (0.15) move to the top under "Suggested", likeliest first, each with its share shown quietly ("62%"); every other Template keeps its place. The row under the arrow stays under it. A ranking is remembered for `templates.picker.rank_cache_ms` (60 s) per Thread and typed text, and a suggestion while typing that already carried one answers the picker without a request. No ranking (off, no judge, an error) leaves the usual order. Off with `templates.picker.rank` or with suggestions off.
- **Inserting.** The body replaces the trigger; for a starter with a subject, the subject fills an empty subject field. Each Placeholder shows as an inline chip in the editor ("invoice number") until filled. Tab and Shift-Tab move between Placeholders.
- **Filling (below)** runs at once when the compose window replies to a Thread; a new Message has no Thread, so only the To field's name fills.
- **Send is blocked** while any required Placeholder is unfilled: the Send button is disabled and says why ("Fill invoice number first"); Send later and the send key refuse the same way. An unfilled optional Placeholder is removed with the space before it when sending.

## Filling Placeholders from the Thread

Values are selected, never invented (the pre-parsed value extraction cookbook).
1. **Code finds candidates** per type from the Thread's text and headers: names from the From, To and Cc display names; addresses; dates and times written in the text (every pattern, plus the Signal request's `deadline_*` parts when present); amounts (the same patterns as `money_amount`); references (invoice, order and ticket patterns); links; for `text`, the sentences of the newest message. At most `signals.candidates.max` per Placeholder.
2. **One request** over the same state as the Signal request asks one Choice per Placeholder:
```json
{ "fill_reference": { "type": "choice",
    "instructions": "The owner is replying with a template that needs: the invoice number the sender quotes. Which of these spans from the thread is it?",
    "criteria": { "INV-2291": null, "INV-2290": null, "none": "None of these is it, or the thread does not say." } } }
```
   The instructions carry the Placeholder's hint. `first_name` with exactly one other person on the Thread is filled by code with no question.
3. **Code copies the pick** verbatim and normalizes it by type. A pick below `templates.fill.confidence` (0.7), or `none`, leaves the Placeholder unfilled with the candidates in its chip's menu, likeliest first, and "Type it".

A filled Placeholder stays marked (a faint underline) until the user edits it or sends, so a wrong pick is easy to see.

## Suggestions while typing

The skill-suggestion cookbook's two requests: a cheap ranking over the whole library, then a close look at the top three that may reject all of them.
- **When.** Only in a compose window whose body has fewer than `templates.suggest.max_typed_chars` (200) characters typed, after the user pauses for `templates.suggest.debounce_ms` (600), at most once per `templates.suggest.min_interval_ms` (2,000), never again in this Draft after a suggestion was dismissed, and only with a TypeSafe key at `assist` or above.
- **Request 1**, state: the Thread's Signal-request state for a reply (or none for a new Message) plus `draft: { to, subject, typed }`. Questions:
```json
{ "which": { "type": "choice",
    "instructions": "Which of the owner's templates, if any, fits the message the owner has started to write?",
    "criteria": { "t_confirm_time": "Confirm the time: someone proposed a time for a call or meeting and the owner accepts it",
                  "t_decline": "Decline politely: the owner says no to a request, invitation or offer",
                  "none": "The owner is writing something no template covers." } },
  "gate_standard": { "type": "noul", "instructions": "What the owner has started to write, together with the thread, is a routine message many people send in nearly the same words." },
  "gate_purpose": { "type": "noul", "instructions": "The owner's purpose in this message is already clear from what they typed and the thread." },
  "gate_personal": { "type": "noul", "instructions": "The owner is writing something personal or specific to this situation that no standard message would cover." } }
```
  The library goes in as options with `name: fits-when` as each description, up to 255 per Choice; a larger library is split into Choices of 255 and the winners of each go to request 2. The gate is the mean of the three Nouls with `gate_personal` inverted; below `templates.suggest.gate` (0.4) nothing is suggested.
- **Request 2**, the same state, the top three by `which` probability, each with its full body as the description:
```json
{ "which": { "type": "choice", "instructions": "Exactly one of these templates is the one the owner should use for the message they started. Which one? Read each template's text.",
    "criteria": { "t_confirm_time": "Hi {first_name}, {time} on {date} works for me. ...", "...": "..." } },
  "fits_t_confirm_time": { "type": "noul", "instructions": "The template 'Confirm the time' says what the owner means to say in this message. Its text: Hi {first_name}, {time} on {date} works for me. ..." } }
```
  When the best `fits_*` is below `templates.suggest.fits_floor` (0.5), nothing is suggested; otherwise request 2's `which` winner is.
- **The ranking travels.** Every answer after request 1 carries `ranking: [{templateId, p}]`, request 1's `which` probabilities likeliest first (Templates given nothing left out); the picker orders by it.
- **The softer line.** When request 2 rejects all of them, or the gate says the message looks personal, but request 1's first choice has at least `templates.suggest.hint_floor` (0.35), the answer carries `maybe: {templateId, name, p}` and the line reads "Maybe: Offer other times (Tab)", quieter than the confident one; Tab and Esc work the same. Below the gate there is no confident line and no second request, but a likely template still shows softly: the owner may want it all the same.
- **Shown** as one quiet line above the editor, "Use Confirm the time (Tab)". Tab inserts it at the caret, replacing what was typed only when the user confirms ("Replace what you typed?") if more than one line was typed; Esc dismisses it for this Draft.
- **On open.** A Thread whose `needs_reply` holds gets the same two requests with `typed` empty when it is opened (not on arrival: the library changes too often to be a standing Signal); the winner names the Reply chip ("Reply with Confirm the time", `actions.md`).

## Writing a Template from examples

- "Make a template from this" on a sent Message's menu, "Save as template" in compose, or asking the Agent ("make a template from my last three replies to recruiters"). One to five example Messages.
- **The language model drafts** (the `template` Task, fast Role): the name, fits-when, kind, subject, the body with Placeholders chosen from the typed set, and a hint per Placeholder, from the examples and the Voice profile. It must keep the examples' wording where they agree and put a Placeholder where they differ. Code validates the declarations and the typed set, and asks the model once more with the errors if they fail.
- **Jev checks for duplicates** (the entity-alignment pattern). Request 1 shortlists the three nearest Templates with a Choice over the library (as in suggestions); request 2 asks, per shortlisted Template, one Score:
```json
{ "dup_t_confirm_time": { "type": "score",
    "instructions": "Compare the new template with the existing template 'Confirm the time'. How close are they in purpose and wording?",
    "criteria": [
      "Different: they are used for different situations.",
      "Related: similar situations, but each says something the other does not.",
      "Same: they would be used for the same situation and say the same thing." ] } }
```
  with both texts in the state. A Score at 1.5 or above is shown as "You already have Confirm the time" with Replace it, Keep both, Cancel; from 0.5 to 1.5, "Similar to Confirm the time" with a side-by-side view; below, nothing.
- **Saving** is a card (the Agent's or the compose sheet's) with the rendered Template, its Placeholders as chips, and Save, Edit, Cancel. Saving is reversible: Undo deletes it.

## Draft from a Template in a Workflow

A new built-in Step, `draft_from_template` (ADR 0003: a typed model Step):
```jsonc
{ "kind": "draft_from_template",
  "template": "t_thanks_received",          // an id, or "choose" to let Jev pick from the library as in "On open"
  "instructions": "Mention that we will reply in full by Friday.",   // optional, for the language model
  "send": "draft" }                         // "draft" saves a Draft; "send" schedules a send through the send Job and always asks unless a Standing approval covers it
```
- **Fill:** Placeholders are filled from the Thread by selection, exactly as above. Unfilled required Placeholders stop the Step with "Could not fill invoice number from the thread" and the Run waits for the user, with the Draft saved.
- **Write:** the language model (the `draft-in-voice` Task) writes the Message from the filled Template and the optional instructions, keeping the Template's sentences and changing only what connects them.
- **Verify:** one request over a state holding the Thread's newest message from someone else, the filled Template and the draft, with the draft split into sentences by code:
  - *Answers every question.* Code finds the questions and requests in the newest message from someone else (sentences ending in "?", and sentences that Jev marks with the Noul "`sentences[i]` asks the owner to do or answer something"). Per question, the Noul "The draft reply answers or addresses `questions[i]`."
  - *No promise the thread does not support.* Per draft sentence, the Noul "`draft[i]` commits the owner to do something (send, pay, deliver, meet, decide) or names a date for it." For each that holds, the citation-check Choice "Does the thread or the template support this commitment?" with `supported`, `partly`, `unsupported`.
  - *No leak.* Code lists every address, phone number, amount, reference and capitalised name in the draft that appears in neither the Thread, the Template nor the Account's signature ("details not in the thread"). One Noul over the whole draft asks "The draft shares internal or confidential information the recipient did not ask for: prices, salaries, other customers, credentials, internal plans."
- **Badges on the approval card** (and on the Run's Step card): "Answers 2 of 2 questions" or "Leaves 1 unanswered: Can you send the W-9?"; "No new promises" or "Promises something the thread does not support: I'll send it by Friday"; "No outside details" or "2 details not in the thread: priya@acme.com, $4,200". Each badge is Unsure-aware: an Unsure answer shows as "Could not check".
- **Standing approvals and badges.** A Standing approval on a `send: "send"` Step applies only when every badge is clean; any flagged or Unsure badge makes that Run wait for the user, and the notification says which badge. The Workflow card says so under the Step ("Runs on your standing approval when every check passes").
- Verification never rewrites the draft and never blocks a draft-only Step; it only marks.

## The Agent

- Tools: `list_templates` (read-only), `use_template` (opens compose with a Template filled for a Thread, reversible: it creates a Draft), `create_template`, `update_template`, `delete_template` (reversible, with the Template card and Undo). The Agent drafting a reply may start from a Template and says which ("Started from Thanks, received").
- The Agent can author Templates from examples exactly as above, with the duplicate check on its card.

## Settings

Settings › Templates is its own section of Settings (`settings:templates`), between Routing and AI and agent: the Templates panel with the switch, the scope and the hidden built-ins, then In compose (trigger, key, the picker's ranking), Suggestions, Filling, Writing templates and Checks.

| Key | Default | Why |
|---|---|---|
| `templates.enabled` | on | Picker and suggestions |
| `templates.trigger` | `;;` | Typed at a line start to open the picker |
| `compose.templates.open` | Ctrl or Cmd+; | Opens the picker |
| `templates.default_scope` | `workspace` | Work and personal accounts rarely share wording |
| `templates.builtin.hidden` | [] | Built-ins the user does not want listed |
| `templates.fill.confidence` | 0.7 | Below it a Placeholder stays for the user |
| `templates.suggest.enabled` | on | Suggestions while typing |
| `templates.suggest.debounce_ms` | 600 | Wait for a pause |
| `templates.suggest.min_interval_ms` | 2,000 | At most one pair of requests this often |
| `templates.suggest.max_typed_chars` | 200 | Suggestions help starts, not finished drafts |
| `templates.suggest.gate` | 0.4 | Below it nothing is suggested |
| `templates.suggest.fits_floor` | 0.5 | The reject-all floor of request 2 |
| `templates.suggest.hint_floor` | 0.35 | Below the floor, request 1's first choice this likely shows as "Maybe" |
| `templates.picker.rank` | on | The picker puts the Templates that fit first |
| `templates.picker.suggested_max` / `suggested_floor` | 3 / 0.15 | How many are marked Suggested, and from what share |
| `templates.picker.rank_cache_ms` | 60,000 | A ranking is reused this long per Thread and typed text |
| `templates.hint.trigger_seen` | off, per device | The one-time "Type ;; for templates" was dismissed or a Template was used |
| `templates.suggest.on_open` | on | Names the Reply chip with a Template |
| `templates.duplicate.same_at` / `related_at` | 1.5 / 0.5 | Score boundaries for the duplicate check |
| `templates.verify.enabled` | on | Badges on `draft_from_template` |
| `templates.verify.standing_requires_clean` | on | A Standing approval sends only when every check passes |

## Strings (examples)

"Templates", "Use {name} (Tab)", "Maybe: {name} (Tab)", "Type {trigger} for templates", "Got it", "Insert a template. Type {trigger} at the start of a line, or press {key}", "Suggested", "Manage templates", "Replace what you typed?", "Fill {placeholder} first", "Type it", "Make a template from this", "You already have {name}", "Similar to {name}", "Replace it", "Keep both", "Use in every account", "Change it everywhere", "Only here", "Restore the original", "Answers {n} of {m} questions", "Leaves {n} unanswered: {question}", "No new promises", "Promises something the thread does not support: {sentence}", "No outside details", "{n} details not in the thread: {list}", "Could not check", "Could not fill {placeholder} from the thread", "Runs on your standing approval when every check passes".

## Edge cases

- The Thread has two people with the same first name: `first_name` asks the Choice instead of filling by code.
- A Placeholder's type has no candidates in the Thread: it stays unfilled, no request is spent on it.
- A reply to a non-English Thread: Placeholders still fill (spans are copied, not translated); suggestions are off (`signals.non_english`).
- The user edits a filled Placeholder: it becomes ordinary text; nothing refills it.
- A Template is deleted while a Draft uses it: the Draft keeps its text; unfilled Placeholder chips turn into plain `{name}` text and still block Send.
- A Workflow Step names a Template that was deleted: the Run fails at that Step with "The template {name} no longer exists" and the Workflow shows Failing.
- More than 255 Templates: the ranking Choice is split as above.

## Code, Jev, language model

| Code | Jev | Language model |
|---|---|---|
| Storage and sealing; the picker; Placeholder syntax and validation; candidates and normalization; Send blocking; sentence splitting; the details-not-in-the-thread list; the Standing approval rule | Which Template fits (two requests); which span fills a Placeholder; duplicate Scores; whether a draft answers, promises or leaks | Drafting a Template from examples; writing the Message in a `draft_from_template` Step |

## Acceptance criteria

1. Typing `;;conf` in a reply to the fixture podcast Thread and Enter inserts Confirm the time with `{first_name}` filled as Sofia and `{time}` and `{date}` filled from her message; Send is disabled while any stays empty.
2. The fake judge answering `none` for a Placeholder leaves it unfilled with its candidates listed; nothing is invented.
3. Typing "Thanks for sending the" in a reply to a Thread with an attachment suggests Thanks, received after the pause; typing a personal paragraph suggests nothing.
4. "Make a template from this" on two fixture replies produces a Template with Placeholders where they differ, and flags "You already have Thanks, received" when the fake Score says same.
5. A `draft_from_template` Step on a fixture Thread asking two questions shows "Leaves 1 unanswered" when the draft skips one, and a Standing approval does not send that Run.
6. Templates are unreadable in `psql` and readable through the API; `monday.toml` is never written.
7. A Template marked Use in every account appears in both fixture Workspaces; editing it offers Change it everywhere.
8. Both compose surfaces show the Templates button, whose tooltip names `;;` and the picker key; clicking it opens the picker. When the fake judge's ranking gives Offer other times 0.62, opening the picker in a reply lists it first under Suggested with "62%", after the picker has already shown its usual order.
9. With the fake closer look rejecting all and request 1 giving Offer other times 0.48, the line reads "Maybe: Offer other times (Tab)" and Tab inserts it.
