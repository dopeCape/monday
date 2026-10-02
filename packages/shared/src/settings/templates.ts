// The Templates Settings (docs/spec/templates.md, "Settings" and "Strings"):
// every behavior is a Setting with a default (ADR 0004) and every word a
// strings.templates.* Setting. Kept in their own file and spread into the
// schema, so the Templates slices (36 to 38) touch the schema in one place.
// Type-only imports from schema.ts: no runtime cycle.

import { z } from "zod";
import type { SettingEntry, SettingSection } from "./schema.ts";

function entry<T extends z.ZodType>(e: SettingEntry<T>): SettingEntry<T> {
  return e;
}

const SECTION: SettingSection = "templates";
const GROUP = "Templates";

/**
 * The group a key sits under on Settings › Templates, by its prefix. Keys
 * written with the plain GROUP move here; the section's own group keeps the
 * switch, the scope, the hidden built-ins and the panel.
 */
const GROUP_BY_PREFIX: ReadonlyArray<readonly [string, string]> = [
  ["templates.trigger", "In compose"],
  ["compose.templates.", "In compose"],
  ["templates.hint.", "In compose"],
  ["templates.picker.", "In compose"],
  ["templates.suggest.", "Suggestions"],
  ["templates.fill.", "Filling"],
  ["templates.author.", "Writing templates"],
  ["templates.duplicate.", "Writing templates"],
  ["templates.verify.", "Checks"],
  ["templates.step.", "Checks"],
];

function regroup<T extends Record<string, { group?: string }>>(entries: T): T {
  for (const [key, e] of Object.entries(entries)) {
    if (e.group !== GROUP) continue;
    const found = GROUP_BY_PREFIX.find(([prefix]) => key.startsWith(prefix));
    if (found) e.group = found[1];
  }
  return entries;
}

function str(label: string, value: string) {
  return entry({
    type: z.string(),
    default: value,
    scope: "global",
    section: SECTION,
    label,
    help: "A user-visible string. The Agent can change the wording on request.",
  });
}

function question(label: string, value: string, help: string) {
  return entry({
    type: z.string().min(1).max(2000),
    default: value,
    scope: "global",
    section: SECTION,
    group: GROUP,
    control: "sentence",
    tier: "advanced",
    label,
    help,
  });
}

const unit = z.number().min(0).max(1);

/* ------------------------------ Slice 36: storage, picker, Placeholders ------------------------------ */

export const TEMPLATE_SETTINGS = regroup({
  "templates.enabled": entry({
    type: z.boolean(),
    default: true,
    scope: "global",
    section: SECTION,
    group: GROUP,
    tier: "primary",
    label: "Templates",
    help: "Offer your Templates in compose: the picker, the insert shortcut and suggestions while you type.",
  }),
  "templates.trigger": entry({
    type: z.string().min(1).max(4),
    default: ";;",
    scope: "global",
    section: SECTION,
    group: GROUP,
    tier: "primary",
    label: "Picker trigger",
    help: "Typed at the start of a line in compose, opens the Template picker at the caret.",
  }),
  "compose.templates.open": entry({
    type: z.string().min(1).max(40),
    default: "mod+;",
    scope: "global",
    section: SECTION,
    group: GROUP,
    tier: "primary",
    label: "Picker key",
    help: "The key chord that opens the Template picker in compose. Mod is Command on macOS and Control elsewhere.",
  }),
  "templates.default_scope": entry({
    type: z.enum(["workspace", "everywhere"]),
    default: "workspace",
    scope: "global",
    section: SECTION,
    group: GROUP,
    label: "New templates belong to",
    help: "The current account only, or a copy in every account. Work and personal accounts rarely share wording.",
  }),
  "templates.builtin.hidden": entry({
    type: z.array(z.string().min(1)),
    default: [],
    scope: "global",
    section: SECTION,
    group: GROUP,
    hidden: "Changed in the Templates panel, by Hide and Show on each built-in.",
    label: "Hidden built-in templates",
    help: "Built-in Templates you do not want listed, by id.",
  }),
  "templates.fill.confidence": entry({
    type: unit,
    default: 0.7,
    scope: "global",
    section: SECTION,
    group: GROUP,
    tier: "advanced",
    label: "Fill confidence",
    help: "A Placeholder is filled from the thread only when the pick is at least this sure; below it the Placeholder waits for you with its candidates.",
  }),
  "templates.fill.candidates_max": entry({
    type: z.int().min(1).max(50),
    default: 8,
    scope: "global",
    section: SECTION,
    group: GROUP,
    tier: "advanced",
    label: "Candidates per Placeholder",
    help: "The most spans from the thread one Placeholder is chosen among.",
  }),
  "templates.fill.state_chars": entry({
    type: z.int().min(500).max(50_000),
    default: 6000,
    scope: "global",
    section: SECTION,
    group: GROUP,
    tier: "advanced",
    label: "Thread text the judge reads",
    help: "The most characters of the thread's newest messages the fill, suggestion and check questions read.",
  }),
  "templates.fill.date_format": entry({
    type: z.enum(["d MMMM", "MMMM d", "yyyy-MM-dd", "d/M/yyyy", "M/d/yyyy"]),
    default: "d MMMM",
    scope: "global",
    section: SECTION,
    group: GROUP,
    tier: "advanced",
    label: "Dates in templates",
    help: "How a date picked from the thread is written: 3 October, October 3, or with the year. A date the thread writes without one keeps its wording.",
  }),
  "templates.fill.time_format": entry({
    type: z.enum(["24h", "12h"]),
    default: "24h",
    scope: "global",
    section: SECTION,
    group: GROUP,
    tier: "advanced",
    label: "Times in templates",
    help: "How a time picked from the thread is written: 15:00 or 3:00 pm.",
  }),
  "templates.fill.question": question(
    "Question: which span fills a Placeholder",
    "The owner is replying with a template that needs: {hint}. Which of these spans from the thread is it?",
    "Asked once per Placeholder with its candidates from the thread as the options; {hint} is the Placeholder's hint.",
  ),
  "templates.fill.none": question(
    "Answer: none of the spans",
    "None of these is it, or the thread does not say.",
    "The option that leaves a Placeholder for you to fill.",
  ),

  /* Slice 37: suggestions while typing, the on-open suggestion, drafting from examples, duplicates */

  "templates.suggest.enabled": entry({
    type: z.boolean(),
    default: true,
    scope: "global",
    section: SECTION,
    group: GROUP,
    tier: "primary",
    label: "Suggest a template while I type",
    help: "After a pause at the start of a message, one quiet line offers the template that fits, when one clearly does. Tab uses it, Esc dismisses it.",
  }),
  "templates.suggest.debounce_ms": entry({
    type: z.int().min(100).max(10_000),
    default: 600,
    scope: "global",
    section: SECTION,
    group: GROUP,
    tier: "advanced",
    label: "Suggestion pause",
    help: "How long you pause, in milliseconds, before monday looks for a template.",
  }),
  "templates.suggest.min_interval_ms": entry({
    type: z.int().min(0).max(60_000),
    default: 2000,
    scope: "global",
    section: SECTION,
    group: GROUP,
    tier: "advanced",
    label: "Time between suggestions",
    help: "At most one pair of requests this often, in milliseconds.",
  }),
  "templates.suggest.max_typed_chars": entry({
    type: z.int().min(0).max(5000),
    default: 200,
    scope: "global",
    section: SECTION,
    group: GROUP,
    tier: "advanced",
    label: "Suggest only before this many characters",
    help: "Suggestions help a message start, not a finished draft.",
  }),
  "templates.suggest.gate": entry({
    type: unit,
    default: 0.4,
    scope: "global",
    section: SECTION,
    group: GROUP,
    tier: "advanced",
    label: "Suggestion gate",
    help: "How sure the three questions must be, on average, that a routine message is being written before a template is suggested.",
  }),
  "templates.suggest.fits_floor": entry({
    type: unit,
    default: 0.5,
    scope: "global",
    section: SECTION,
    group: GROUP,
    tier: "advanced",
    label: "Suggestion floor",
    help: "The best of the closer look must say a template fits at least this surely, or nothing is suggested.",
  }),
  "templates.suggest.shortlist": entry({
    type: z.int().min(1).max(10),
    default: 3,
    scope: "global",
    section: SECTION,
    group: GROUP,
    tier: "advanced",
    label: "Templates looked at closely",
    help: "How many of the best-ranked templates the second request reads in full.",
  }),
  "templates.suggest.choice_max": entry({
    type: z.int().min(3).max(255),
    default: 255,
    scope: "global",
    section: SECTION,
    group: GROUP,
    tier: "advanced",
    label: "Templates per ranking question",
    help: "The most options one ranking question carries; a larger library is split.",
  }),
  "templates.suggest.on_open": entry({
    type: z.boolean(),
    default: true,
    scope: "global",
    section: SECTION,
    group: GROUP,
    label: "Name the Reply chip with a template",
    help: "When a thread that needs a reply opens, the Reply chip names the template that fits: Reply with Confirm the time.",
  }),
  "templates.suggest.needs_reply_at": entry({
    type: unit,
    default: 0.6,
    scope: "global",
    section: SECTION,
    group: GROUP,
    tier: "advanced",
    label: "Needs a reply, for the Reply chip",
    help: "How likely a thread must need a reply before opening it looks for a template.",
  }),
  "templates.suggest.question.which": question(
    "Question: which template fits",
    "Which of the owner's templates, if any, fits the message the owner has started to write?",
    "The ranking over the whole library; each option is a template's name and when it fits.",
  ),
  "templates.suggest.question.none": question(
    "Answer: no template fits",
    "The owner is writing something no template covers.",
    "The ranking's option for a message no template covers.",
  ),
  "templates.suggest.question.gate_standard": question(
    "Question: a routine message",
    "What the owner has started to write, together with the thread, is a routine message many people send in nearly the same words.",
    "One of the three questions whose mean decides whether a template is wanted at all.",
  ),
  "templates.suggest.question.gate_purpose": question(
    "Question: the purpose is clear",
    "The owner's purpose in this message is already clear from what they typed and the thread.",
    "One of the three questions whose mean decides whether a template is wanted at all.",
  ),
  "templates.suggest.question.gate_personal": question(
    "Question: something personal",
    "The owner is writing something personal or specific to this situation that no standard message would cover.",
    "Counted the other way round: yes here means no template.",
  ),
  "templates.suggest.question.rerank": question(
    "Question: the closer look",
    "Exactly one of these templates is the one the owner should use for the message they started. Which one? Read each template's text.",
    "The second request's choice among the best-ranked templates, with their full text.",
  ),
  "templates.suggest.question.fits": question(
    "Question: this template fits",
    "The template '{name}' says what the owner means to say in this message. Its text: {text}",
    "Asked once per template in the closer look; {name} and {text} are the template's.",
  ),
  "templates.duplicate.same_at": entry({
    type: z.number().min(0).max(2),
    default: 1.5,
    scope: "global",
    section: SECTION,
    group: GROUP,
    tier: "advanced",
    label: "Duplicate: same from",
    help: "A new template scoring this or more against an existing one is called the same: You already have it.",
  }),
  "templates.duplicate.related_at": entry({
    type: z.number().min(0).max(2),
    default: 0.5,
    scope: "global",
    section: SECTION,
    group: GROUP,
    tier: "advanced",
    label: "Duplicate: similar from",
    help: "From this score up to the same line, a new template is shown beside the similar one.",
  }),
  "templates.duplicate.question": question(
    "Question: how close two templates are",
    "Compare the new template with the existing template '{name}'. How close are they in purpose and wording?",
    "The Score per nearby template; {name} is the existing template's.",
  ),
  "templates.duplicate.levels": entry({
    type: z.array(z.string().min(1)).length(3),
    default: [
      "Different: they are used for different situations.",
      "Related: similar situations, but each says something the other does not.",
      "Same: they would be used for the same situation and say the same thing.",
    ],
    scope: "global",
    section: SECTION,
    group: GROUP,
    tier: "advanced",
    label: "Duplicate levels",
    help: "The three levels of the duplicate Score, low to high.",
  }),
  "templates.duplicate.shortlist_question": question(
    "Question: the nearest templates",
    "Which of the owner's existing templates is closest in purpose to the new template?",
    "Picks the few existing templates the duplicate Score then compares.",
  ),
  "templates.author.prompt": entry({
    type: z.string().min(1).max(8000),
    default:
      'You write one reusable email template from example messages the owner sent. Keep the examples\' wording where they agree and put a Placeholder where they differ. A Placeholder is written {name} in lowercase with underscores, or {name?} when it may stay empty, and has a type: person, first_name, email, date, time, amount, number, reference, link or text. Answer with one JSON object and nothing else: {"name": short title, "fits_when": one line saying when it fits, "kind": "reply" or "starter", "subject": the subject with Placeholders for a starter, else null, "body": the text, "placeholders": [{"name", "type", "optional", "hint": what it is, in a few words}]}. Declare every Placeholder the text uses, and no other. No signature, no em-dashes.',
    scope: "global",
    section: SECTION,
    group: GROUP,
    control: "sentence",
    tier: "advanced",
    label: "Template drafting prompt",
    help: "What the language model is told when it writes a template from your example messages.",
  }),
  "templates.author.example_chars": entry({
    type: z.int().min(200).max(20_000),
    default: 3000,
    scope: "global",
    section: SECTION,
    group: GROUP,
    tier: "advanced",
    label: "Example text per message",
    help: "The most characters of each example message the model reads.",
  }),
  "templates.author.examples_max": entry({
    type: z.int().min(1).max(10),
    default: 5,
    scope: "global",
    section: SECTION,
    group: GROUP,
    tier: "advanced",
    label: "Examples per template",
    help: "The most example messages one template is written from.",
  }),

  /* Slice 38: the draft_from_template Step, its checks and Standing approvals */

  "templates.verify.enabled": entry({
    type: z.boolean(),
    default: true,
    scope: "global",
    section: SECTION,
    group: GROUP,
    label: "Check drafts from templates",
    help: "A Workflow that drafts from a template checks the draft: it answers every question, promises nothing the thread does not support and shares nothing from outside it. The checks show as badges on the approval card.",
  }),
  "templates.verify.standing_requires_clean": entry({
    type: z.boolean(),
    default: true,
    scope: "global",
    section: SECTION,
    group: GROUP,
    label: "Send unattended only when every check passes",
    help: "A standing approval on a step that sends from a template applies only when every badge is clean; otherwise that run waits for you and the notification says which badge.",
  }),
  "templates.verify.unsure_band": entry({
    type: z.number().min(0).max(0.5),
    default: 0.15,
    scope: "global",
    section: SECTION,
    group: GROUP,
    tier: "advanced",
    label: "Could not check, within",
    help: "A check whose answer is this close to even reads Could not check, and counts as not clean.",
  }),
  "templates.verify.question.asks": question(
    "Check: a sentence asks something",
    "`newest_message.sentences[{i}]` asks the owner to do or answer something.",
    "Asked of each sentence of the newest message that does not end in a question mark.",
  ),
  "templates.verify.question.answers": question(
    "Check: the draft answers it",
    "The draft reply answers or addresses `newest_message.sentences[{i}]`.",
    "Asked of each question or request in the newest message.",
  ),
  "templates.verify.question.commits": question(
    "Check: a sentence promises",
    "`draft[{j}]` commits the owner to do something (send, pay, deliver, meet, decide) or names a date for it.",
    "Asked of each sentence of the draft.",
  ),
  "templates.verify.question.supports": question(
    "Check: the promise is supported",
    "Does the thread or the template support the commitment in `draft[{j}]`?",
    "Asked of each sentence that commits the owner; supported, partly or unsupported. Only supported counts as clean.",
  ),
  "templates.verify.supports.supported": question(
    "Answer: supported",
    "The thread or the template says the owner will do this, or asks for exactly this.",
    "The supported answer to the promise check.",
  ),
  "templates.verify.supports.partly": question(
    "Answer: partly supported",
    "The thread or the template supports part of it, but the draft adds a detail such as a date or an amount.",
    "The partly answer to the promise check.",
  ),
  "templates.verify.supports.unsupported": question(
    "Answer: not supported",
    "Nothing in the thread or the template supports this commitment.",
    "The unsupported answer to the promise check.",
  ),
  "templates.verify.question.leak": question(
    "Check: something confidential",
    "The draft shares internal or confidential information the recipient did not ask for: prices, salaries, other customers, credentials, internal plans.",
    "Asked once over the whole draft.",
  ),
  "templates.step.write_prompt": entry({
    type: z.string().min(1).max(8000),
    default:
      "Write the reply email from this template. Keep the template's sentences as they are and change only what connects them to this thread, following the extra instructions if there are any. Plain text, no subject line, no signature, no em-dashes.",
    scope: "global",
    section: SECTION,
    group: GROUP,
    control: "sentence",
    tier: "advanced",
    label: "Writing from a template",
    help: "What the language model is told when a Workflow step writes a message from a template.",
  }),

  "strings.templates.badge.answers_all": str(
    "Badge: answers every question",
    "Answers {n} of {m} questions",
  ),
  "strings.templates.badge.answers_some": str(
    "Badge: leaves questions",
    "Leaves {n} unanswered: {question}",
  ),
  "strings.templates.badge.no_promises": str("Badge: no new promises", "No new promises"),
  "strings.templates.badge.promises": str(
    "Badge: an unsupported promise",
    "Promises something the thread does not support: {sentence}",
  ),
  "strings.templates.badge.no_details": str("Badge: no outside details", "No outside details"),
  "strings.templates.badge.details": str(
    "Badge: outside details",
    "{n} details not in the thread: {list}",
  ),
  "strings.templates.badge.confidential": str(
    "Badge: confidential information",
    "Shares internal information nobody asked for",
  ),
  "strings.templates.badge.could_not_check": str("Badge: unsure", "Could not check"),
  "strings.templates.could_not_fill": str(
    "Step waiting on a Placeholder",
    "Could not fill {placeholder} from the thread",
  ),
  "strings.templates.gone": str("Step's Template deleted", "The template {name} no longer exists"),
  "strings.templates.standing_clean": str(
    "Workflow card: unattended when clean",
    "Runs on your standing approval when every check passes",
  ),
  "strings.templates.waiting_check": str(
    "Waiting because of a badge",
    "Waiting for your approval: {badge}",
  ),

  "strings.workflows.flow.summary.draft_from_template": str(
    "Flow: drafts from a template",
    "Drafts a reply from {template}",
  ),
  "strings.workflows.flow.summary.draft_from_template_send": str(
    "Flow: writes and sends from a template",
    "Writes a reply from {template} and sends it",
  ),
  "strings.workflows.flow.kind.draft_from_template": str(
    "Step kind: draft from a template",
    "Draft from a template",
  ),
  "strings.workflows.flow.template_choose": str(
    "Flow: the template the judge picks",
    "the template that fits",
  ),
  "strings.workflows.flow.arg.checks": str("Flow: the checks field", "Checks"),
  "strings.workflows.flow.checks_standing": str(
    "Flow: unattended when clean",
    "Runs on your standing approval when every check passes",
  ),
  "strings.workflows.flow.checks_ask": str(
    "Flow: asks with the checks",
    "Asks first; the approval shows whether it answers every question, promises nothing new and shares nothing from outside the thread",
  ),

  "strings.templates.suggest.use": str("Suggestion line", "Use {name} (Tab)"),
  "strings.templates.suggest.replace": str(
    "Replace typed text question",
    "Replace what you typed?",
  ),
  "strings.templates.suggest.replace_yes": str("Replace typed text, yes", "Replace"),
  "strings.templates.suggest.replace_no": str("Replace typed text, no", "Keep it"),
  "strings.templates.suggest.dismiss": str("Suggestion dismiss", "Dismiss"),
  "strings.templates.suggest.unavailable": str(
    "No judge for suggestions",
    "Template suggestions need TypeSafe or a language model",
  ),
  "strings.templates.reply_with": str("Reply chip with a template", "Reply with {name}"),
  "strings.templates.from_message": str("Message menu item", "Make a template from this"),
  "strings.templates.save_as": str("Compose menu item", "Save as template"),
  "strings.templates.drafting": str("Drafting line", "Writing a template from your message"),
  "strings.templates.draft_failed": str(
    "Drafting failed",
    "The template could not be written: {message}",
  ),
  "strings.templates.duplicate.same": str("Duplicate: same", "You already have {name}"),
  "strings.templates.duplicate.related": str("Duplicate: similar", "Similar to {name}"),
  "strings.templates.duplicate.replace": str("Duplicate: replace", "Replace it"),
  "strings.templates.duplicate.keep": str("Duplicate: keep both", "Keep both"),
  "strings.templates.saved": str("Saved line", "Saved {name}"),
  "strings.templates.started_from": str("Agent drafted from a Template", "Started from {name}"),
  "strings.agent.preview_template.create": str("Template card, new", "New template: {name}"),
  "strings.agent.preview_template.update": str(
    "Template card, change",
    "Changes the template {name}",
  ),
  "strings.agent.preview_template.delete": str(
    "Template card, delete",
    "Deletes the template {name}",
  ),
  "strings.agent.preview_template.use": str("Template card, use", "Starts a draft from {name}"),
  "strings.agent.preview_template.everywhere": str(
    "Template card, every account",
    "Saved in every account",
  ),

  "strings.templates.title": str("Templates heading", "Templates"),
  "strings.templates.hint": str(
    "Templates hint",
    "Messages you send often, with Placeholders monday fills from the thread. Type ;; at the start of a line in compose to insert one.",
  ),
  "strings.templates.picker.empty": str("Picker, nothing matches", "No template matches"),
  "strings.templates.picker.search": str("Picker search", "Find a template"),
  "strings.templates.picker.yours": str("Picker, your templates", "Yours"),
  "strings.templates.picker.builtin": str("Picker, built-in templates", "Built in"),
  "strings.templates.fill_first": str("Send blocked by a Placeholder", "Fill {placeholder} first"),
  "strings.templates.type_it": str("Placeholder menu, type it", "Type it"),
  "strings.templates.candidates": str("Placeholder menu heading", "From the thread"),
  "strings.templates.no_candidates": str(
    "Placeholder menu, nothing found",
    "Nothing in the thread fits",
  ),
  "strings.templates.use_everywhere": str("Save for every account", "Use in every account"),
  "strings.templates.change_everywhere": str("Edit every copy", "Change it everywhere"),
  "strings.templates.only_here": str("Edit this copy", "Only here"),
  "strings.templates.change_where": str(
    "Question before editing a shared Template",
    "This template is in every account. Change it everywhere or only here?",
  ),
  "strings.templates.restore": str("Delete an edited built-in", "Restore the original"),
  "strings.templates.new": str("New template button", "New template"),
  "strings.templates.edit": str("Edit button", "Edit"),
  "strings.templates.delete": str("Delete button", "Delete"),
  "strings.templates.deleted": str("Deleted toast", "Deleted {name}"),
  "strings.templates.undo": str("Undo button", "Undo"),
  "strings.templates.save": str("Save button", "Save"),
  "strings.templates.cancel": str("Cancel button", "Cancel"),
  "strings.templates.hide": str("Hide a built-in", "Hide"),
  "strings.templates.show": str("Show a hidden built-in", "Show"),
  "strings.templates.hidden_count": str("Hidden built-ins line", "{n} hidden"),
  "strings.templates.export": str("Export button", "Export"),
  "strings.templates.import": str("Import button", "Import"),
  "strings.templates.exported": str("Export done", "Saved {n} templates to {folder}"),
  "strings.templates.imported": str("Import done", "Imported {n} templates"),
  "strings.templates.import_failed": str("A file that did not import", "{file}: {message}"),
  "strings.templates.failed": str("Something failed", "That did not work: {message}"),
  "strings.templates.invalid": str(
    "Template will not save",
    "This template does not save yet: {errors}",
  ),
  "strings.templates.badge.builtin": str("Built-in badge", "Built in"),
  "strings.templates.badge.edited": str("Edited built-in badge", "Edited"),
  "strings.templates.badge.everywhere": str("Shared badge", "Every account"),
  "strings.templates.badge.agent": str("Written by the agent badge", "By monday"),
  "strings.templates.field.name": str("Name field", "Name"),
  "strings.templates.field.fits_when": str("Fits when field", "Fits when"),
  "strings.templates.field.kind": str("Kind field", "Kind"),
  "strings.templates.field.subject": str("Subject field", "Subject"),
  "strings.templates.field.body": str("Text field", "Text"),
  "strings.templates.field.body_hint": str(
    "Text field hint",
    "Write {name} for a Placeholder, or {name?} for one that may stay empty.",
  ),
  "strings.templates.field.placeholders": str("Placeholders heading", "Placeholders"),
  "strings.templates.field.hint": str("Placeholder hint field", "What it is"),
  "strings.templates.field.optional": str("Placeholder optional switch", "Optional"),
  "strings.templates.kind.reply": str("Kind, reply", "Reply"),
  "strings.templates.kind.starter": str("Kind, new message", "New message"),
  "strings.templates.type.person": str("Placeholder type, person", "Person"),
  "strings.templates.type.first_name": str("Placeholder type, first name", "First name"),
  "strings.templates.type.email": str("Placeholder type, address", "Email address"),
  "strings.templates.type.date": str("Placeholder type, date", "Date"),
  "strings.templates.type.time": str("Placeholder type, time", "Time"),
  "strings.templates.type.amount": str("Placeholder type, amount", "Amount"),
  "strings.templates.type.number": str("Placeholder type, number", "Number"),
  "strings.templates.type.reference": str("Placeholder type, reference", "Reference"),
  "strings.templates.type.link": str("Placeholder type, link", "Link"),
  "strings.templates.type.text": str("Placeholder type, text", "Text"),
  "strings.templates.palette": str("Palette row", "Template: {name}"),
  "strings.templates.load_failed": str(
    "Templates did not load",
    "Templates did not load: {message}",
  ),
  "strings.templates.empty": str("No templates yet", "No templates of your own yet."),
  "strings.meter.judge.template": str("Meter line: templates", "Templates"),

  /* Finding templates: the compose button, the one-time hint, Jev in the picker, the softer line */

  "templates.hint.trigger_seen": entry({
    type: z.boolean(),
    default: false,
    scope: "device",
    section: SECTION,
    group: GROUP,
    hidden: "Kept by compose; the hint shows until it is dismissed or a template is used.",
    label: "Template hint seen",
    help: "Whether compose has shown, once, how to open the template picker on this device.",
  }),
  "templates.picker.rank": entry({
    type: z.boolean(),
    default: true,
    scope: "global",
    section: SECTION,
    group: GROUP,
    tier: "primary",
    label: "Put the templates that fit first",
    help: "In a reply, or with something typed, the picker opens at once in its usual order and then moves the templates that fit this thread to the top, marked Suggested.",
  }),
  "templates.picker.suggested_max": entry({
    type: z.int().min(0).max(10),
    default: 3,
    scope: "global",
    section: SECTION,
    group: GROUP,
    tier: "advanced",
    label: "Suggested in the picker",
    help: "The most templates the picker marks Suggested.",
  }),
  "templates.picker.suggested_floor": entry({
    type: unit,
    default: 0.15,
    scope: "global",
    section: SECTION,
    group: GROUP,
    tier: "advanced",
    label: "Suggested from",
    help: "A template is marked Suggested in the picker only when the ranking gives it at least this much.",
  }),
  "templates.picker.rank_cache_ms": entry({
    type: z.int().min(0).max(3_600_000),
    default: 60_000,
    scope: "global",
    section: SECTION,
    group: GROUP,
    tier: "advanced",
    label: "Remember a ranking for",
    help: "How long, in milliseconds, the picker reuses a ranking for the same thread and the same typed text.",
  }),
  "templates.suggest.hint_floor": entry({
    type: unit,
    default: 0.35,
    scope: "global",
    section: SECTION,
    group: GROUP,
    tier: "advanced",
    label: "Softer suggestion from",
    help: "When the closer look rejects every template but the ranking's first choice is at least this likely, a softer line offers it: Maybe: Offer other times (Tab).",
  }),

  "strings.templates.button": str("Compose toolbar button", "Templates"),
  "strings.templates.button_tip": str(
    "Compose toolbar button tooltip",
    "Insert a template. Type {trigger} at the start of a line, or press {key}",
  ),
  "strings.templates.hint.trigger": str("One-time compose hint", "Type {trigger} for templates"),
  "strings.templates.hint.dismiss": str("One-time compose hint, dismiss", "Got it"),
  "strings.templates.suggest.maybe": str("Softer suggestion line", "Maybe: {name} (Tab)"),
  "strings.templates.picker.suggested": str("Picker, suggested templates", "Suggested"),
  "strings.templates.picker.fit": str("Picker, how well it fits", "{percent}%"),
  "strings.templates.picker.fit_title": str(
    "Picker, how well it fits, tooltip",
    "How likely this template fits, from the ranking",
  ),
  "strings.templates.picker.manage": str("Picker, open Settings", "Manage templates"),
});
