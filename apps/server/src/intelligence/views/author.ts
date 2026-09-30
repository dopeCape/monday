// Writing and revising a View (docs/spec/views.md, "Making a View"): the
// language model (the `view` Task, main Role) writes the View document from
// the owner's sentence, with Facts for everything exact and Signals only for
// what needs reading; code validates it and the errors go back to the model
// at most views.draft.retries times. A revision reads the owner's
// corrections: code has already put the corrected Threads in the questions as
// Examples; the model rewrites a question only when a correction shows it
// reads the owner wrong. TypeSafe's guidance is why: questions written
// without evidence read literally and miss, so nothing is saved on the
// model's word alone (the test follows).

import type { ViewDoc, ViewLimits, ViewRefs } from "@monday/shared";
import { canonicalJson, validateView } from "@monday/shared";
import { ViewInvalidError } from "../../views/index.ts";
import type { HostedRuntime } from "../runtime/index.ts";

/** The last JSON object in a model's answer, or null. */
export function lastObject(text: string): Record<string, unknown> | null {
  const end = text.lastIndexOf("}");
  for (
    let start = text.indexOf("{");
    start >= 0 && start < end;
    start = text.indexOf("{", start + 1)
  ) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {}
  }
  return null;
}

export interface AuthorContext {
  /** The owner's address and today's date in words, so "my" and "today" read right. */
  owner: string;
  today: string;
  groups: Array<{ id: string; name: string }>;
  sections: Array<{ id: string; name: string }>;
  /** What an action may name: the Workspace's Workflows and Custom actions, and every id validation accepts. */
  workflows?: Array<{ id: string; name: string }> | undefined;
  customActions?: Array<{ id: string; name: string }> | undefined;
  refs?: ViewRefs | undefined;
}

export interface AuthorSettings {
  prompt: string;
  revisePrompt: string;
  retries: number;
  limits: ViewLimits;
}

function contextLines(ctx: AuthorContext): string {
  const named = (list: Array<{ id: string; name: string }> | undefined) =>
    (list ?? []).map((x) => `${x.id} (${x.name})`).join(", ");
  return [
    `The owner: ${ctx.owner}. Today: ${ctx.today}.`,
    ctx.groups.length
      ? `Groups (folder "group:<id>", fact in_group, action move): ${named(ctx.groups)}.`
      : "",
    ctx.sections.length
      ? `Sections (folder "section:<id>", fact in_section): ${named(ctx.sections)}.`
      : "",
    ctx.workflows?.length ? `Workflows (action run_workflow): ${named(ctx.workflows)}.` : "",
    ctx.customActions?.length
      ? `Custom actions (action custom_action): ${named(ctx.customActions)}.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The drafting prompt with its limits filled. */
export function draftingPrompt(prompt: string, limits: ViewLimits): string {
  return prompt
    .replaceAll("{lanes}", String(limits.maxLanes))
    .replaceAll("{signals}", String(limits.maxSignals))
    .replaceAll("{extractions}", String(limits.maxExtractions ?? 6))
    .replaceAll("{blocks}", String(limits.maxBlocks ?? 8))
    .replaceAll("{actions}", String(limits.maxActions ?? 8));
}

/** Asks the model, validates, and asks again with the errors, at most `retries` more times. */
async function writeValidated(
  runtime: HostedRuntime,
  workspaceId: string,
  system: string,
  prompt: string,
  settings: AuthorSettings,
  finish: (raw: Record<string, unknown>) => Record<string, unknown>,
  refs: ViewRefs = {},
): Promise<{ doc: ViewDoc; attempts: number }> {
  let extra = "";
  let errors: string[] = ["The answer held no JSON object."];
  for (let attempt = 0; attempt <= settings.retries; attempt++) {
    const r = await runtime.run(
      "board",
      { system, prompt: `${prompt}${extra}` },
      { workspaceId, jobId: null },
    );
    const raw = lastObject(r.output);
    if (raw) {
      const v = validateView(finish(raw), settings.limits, undefined, refs);
      if (v.ok) return { doc: v.doc, attempts: attempt + 1 };
      errors = v.errors;
    }
    extra = `\n\nYour last answer did not validate: ${errors.join(" ")} Answer again with the corrected JSON document only.`;
  }
  throw new ViewInvalidError(errors);
}

/** A View document from the owner's sentence. Throws ViewInvalidError when no answer validates. */
export async function writeView(options: {
  runtime: HostedRuntime;
  workspaceId: string;
  sentence: string;
  context: AuthorContext;
  settings: AuthorSettings;
  /** The id the draft carries. */
  id: string;
}): Promise<{ doc: ViewDoc; attempts: number }> {
  const { settings } = options;
  const system = draftingPrompt(settings.prompt, settings.limits);
  const prompt = `${contextLines(options.context)}\n\nThe owner asks: ${options.sentence}`;
  return writeValidated(
    options.runtime,
    options.workspaceId,
    system,
    prompt,
    settings,
    (raw) => ({
      unsure: { label: "Unsure" },
      others: "hide",
      ...raw,
      id: options.id,
      sentence: typeof raw.sentence === "string" && raw.sentence ? raw.sentence : options.sentence,
      version: 0,
      examples: {},
    }),
    options.context.refs,
  );
}

/** One correction as the revision reads it. */
export interface CorrectionLine {
  from: string;
  subject: string;
  said: string;
  answers: string[];
}

/**
 * The document revised after the owner's corrections, or after the owner's
 * words for an edit ("make yellow only paying customers"). Ids, Examples and
 * the sentence are kept by code.
 */
export async function reviseView(options: {
  runtime: HostedRuntime;
  workspaceId: string;
  doc: ViewDoc;
  corrections: readonly CorrectionLine[];
  instruction?: string | undefined;
  context: AuthorContext;
  settings: AuthorSettings;
}): Promise<{ doc: ViewDoc; attempts: number }> {
  const { doc } = options;
  const { examples: _examples, ...shown } = doc;
  const prompt = [
    contextLines(options.context),
    `The View:\n${JSON.stringify(shown, null, 2)}`,
    options.corrections.length
      ? `The owner corrected these threads:\n${options.corrections
          .map(
            (c, i) =>
              `${i + 1}. From ${c.from}, "${c.subject}": ${c.said}. The View read: ${c.answers.join(", ") || "nothing yet"}.`,
          )
          .join("\n")}`
      : "",
    options.instruction ? `The owner asks: ${options.instruction}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  // The catalog and the rules ride along, so an edit that asks for a chart or a button can add one.
  const system = `${options.settings.revisePrompt}\n\nThe rules and the catalog, as when drafting:\n\n${draftingPrompt(
    options.settings.prompt,
    options.settings.limits,
  )}`;
  return writeValidated(
    options.runtime,
    options.workspaceId,
    system,
    prompt,
    options.settings,
    (raw) => ({
      ...raw,
      id: doc.id,
      sentence: doc.sentence,
      version: doc.version,
      examples: doc.examples,
    }),
    options.context.refs,
  );
}

/** The Extractions whose own words changed between two documents (Examples aside). */
export function rewordedExtractions(before: ViewDoc, after: ViewDoc): string[] {
  return after.extractions
    .filter((x) => {
      const old = before.extractions.find((o) => o.id === x.id);
      return !old || canonicalJson(old) !== canonicalJson(x);
    })
    .map((x) => x.id);
}

/** Whether a Signal's own words changed between two documents (Examples aside). */
export function rewordedSignals(before: ViewDoc, after: ViewDoc): string[] {
  return after.signals
    .filter((s) => {
      const old = before.signals.find((o) => o.id === s.id);
      return !old || canonicalJson(old.question) !== canonicalJson(s.question);
    })
    .map((s) => s.id);
}
