// Templates and Placeholders (CONTEXT.md "Template", "Placeholder";
// docs/spec/templates.md). A Template is the user's content, like a Draft:
// Server rows sealed under the Workspace key, never Settings and never the
// Config file (ADR 0001). The 21 built-ins ship as data (builtin.ts) and are
// read-only; editing one saves a copy in the Workspace. Runtime-neutral:
// types only.

import type { Id, IsoDate, Person } from "../domain.ts";

export const PLACEHOLDER_TYPES = [
  "person",
  "first_name",
  "email",
  "date",
  "time",
  "amount",
  "number",
  "reference",
  "link",
  "text",
] as const;
export type PlaceholderType = (typeof PLACEHOLDER_TYPES)[number];

export interface Placeholder {
  /** "invoice_number", written {invoice_number} in the body. */
  name: string;
  type: PlaceholderType;
  /** Written {name?}; an unfilled optional Placeholder and the space before it are removed. */
  optional: boolean;
  /** "the invoice number the sender quotes": what the fill question carries. */
  hint: string;
}

export type TemplateKind = "reply" | "starter";

/** What the user or the Agent writes: the Template without its row state. */
export interface TemplateInput {
  name: string;
  /** One line: when it fits, used by suggestions. */
  fitsWhen: string;
  /** Answers a Thread, or starts a new Message. */
  kind: TemplateKind;
  /** Starters only; may hold Placeholders. */
  subject: string | null;
  /** Plain text with light markup, may hold Placeholders. */
  body: string;
  /** Declared, in order of first use. */
  placeholders: Placeholder[];
}

export interface Template extends TemplateInput {
  id: Id;
  /** Null only for the built-ins. */
  workspaceId: Id | null;
  /** Copies of one Template in several Workspaces share this id. */
  shareGroupId: Id | null;
  /** The built-in it was copied from, if any. */
  builtIn: string | null;
  createdBy: "user" | "agent";
  updatedAt: IsoDate;
}

/** Where a new Template goes: this Workspace, or one copy in every Workspace (templates.default_scope). */
export type TemplateScope = "workspace" | "everywhere";

/**
 * A Template as the Changes feed carries it: headers only. Name, fits-when,
 * subject and body are content and stay behind GET /templates.
 */
export interface TemplateChange {
  id: Id;
  kind: TemplateKind;
  builtIn: string | null;
  shareGroupId: Id | null;
  createdBy: "user" | "agent";
  updatedAt: IsoDate;
  deleted: boolean;
}

/* ------------------------------ Filling ------------------------------ */

/** One span of the Thread that could fill a Placeholder, verbatim, with its normalized value. */
export interface PlaceholderCandidate {
  /** The span exactly as the Thread writes it. */
  span: string;
  /** What goes into the Message: the span normalized by type. */
  value: string;
}

/** How one Placeholder came out of filling (docs/spec/templates.md, "Filling Placeholders from the Thread"). */
export interface PlaceholderFill {
  name: string;
  /** The normalized pick, or null when it stays for the user. */
  value: string | null;
  /** The span the value came from, verbatim. */
  span: string | null;
  /** "code" when no question was needed; "judge" when a pick answered; null when unfilled. */
  by: "code" | "judge" | null;
  /** The pick's confidence (1 for code). */
  confidence: number;
  /** Every candidate, likeliest first, for the chip's menu. */
  candidates: PlaceholderCandidate[];
}

export interface TemplateFillResult {
  templateId: Id;
  fills: PlaceholderFill[];
  /** Who answered the questions: TypeSafe, the language model's fallback, or nobody. */
  judge: "typesafe" | "llm" | "none";
}

/* ------------------------------ Suggestions ------------------------------ */

/** What the compose window sends while the user types (docs/spec/templates.md, "Suggestions while typing"). */
export interface TemplateSuggestRequest {
  workspace: Id;
  /** The Thread a reply answers; null for a new Message. */
  threadId: Id | null;
  draft: { to: Person[]; subject: string; typed: string };
}

export type TemplateSuggestResult =
  | { status: "suggested"; templateId: Id; name: string; fits: number; gate: number }
  | { status: "none"; reason: "gate" | "floor" | "empty" | "disabled"; gate?: number }
  /** No judge answers on this Server: nothing is suggested and the window says so quietly. */
  | { status: "unavailable"; reason: string };

/* ------------------------------ Writing a Template from examples ------------------------------ */

export type DuplicateLevel = "different" | "related" | "same";

export interface DuplicateVerdict {
  templateId: Id;
  name: string;
  /** The Score, 0 different to 2 same. */
  score: number;
  level: DuplicateLevel;
}

export interface TemplateDraftResult {
  template: TemplateInput;
  /** The closest existing Template when it is related or the same; null when none is. */
  duplicate: DuplicateVerdict | null;
}

/* ------------------------------ Verifying a drafted Message ------------------------------ */

/** One badge's state: clean, flagged, or Unsure ("Could not check"). */
export type CheckState = "clean" | "flagged" | "unsure";

/**
 * The three checks on a `draft_from_template` Step (docs/spec/templates.md,
 * "Verify"), what the approval card and the Run's Step card show.
 */
export interface TemplateChecks {
  answers: { state: CheckState; answered: number; total: number; unanswered: string[] };
  promises: { state: CheckState; unsupported: string[] };
  leaks: { state: CheckState; details: string[]; confidential: boolean };
}

/** Whether every badge is clean: the only case a Standing approval sends unattended. */
export function checksClean(checks: TemplateChecks): boolean {
  return (
    checks.answers.state === "clean" &&
    checks.promises.state === "clean" &&
    checks.leaks.state === "clean"
  );
}
