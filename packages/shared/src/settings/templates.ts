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

const SECTION: SettingSection = "accounts";
const GROUP = "Templates";

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

export const TEMPLATE_SETTINGS = {
  "templates.enabled": entry({
    type: z.boolean(),
    default: true,
    scope: "global",
    section: SECTION,
    group: GROUP,
    label: "Templates",
    help: "Offer your Templates in compose: the picker, the insert shortcut and suggestions while you type.",
  }),
  "templates.trigger": entry({
    type: z.string().min(1).max(4),
    default: ";;",
    scope: "global",
    section: SECTION,
    group: GROUP,
    visibleWhen: { key: "templates.enabled", equals: true },
    label: "Picker trigger",
    help: "Typed at the start of a line in compose, opens the Template picker at the caret.",
  }),
  "compose.templates.open": entry({
    type: z.string().min(1).max(40),
    default: "mod+;",
    scope: "global",
    section: SECTION,
    group: GROUP,
    visibleWhen: { key: "templates.enabled", equals: true },
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
};
