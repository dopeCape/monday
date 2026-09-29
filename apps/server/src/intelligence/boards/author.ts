// Writing and revising a Board (docs/spec/boards.md, "Making a Board"): the
// language model (the `board` Task, main Role) writes the Board document from
// the owner's sentence, with Facts for everything exact and Signals only for
// what needs reading; code validates it and the errors go back to the model
// at most boards.draft.retries times. A revision reads the owner's
// corrections: code has already put the corrected Threads in the questions as
// Examples; the model rewrites a question only when a correction shows it
// reads the owner wrong. TypeSafe's guidance is why: questions written
// without evidence read literally and miss, so nothing is saved on the
// model's word alone (the test follows).

import type { BoardDoc, BoardLimits } from "@monday/shared";
import { canonicalJson, validateBoard } from "@monday/shared";
import { BoardInvalidError } from "../../boards/index.ts";
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
}

export interface AuthorSettings {
  prompt: string;
  revisePrompt: string;
  retries: number;
  limits: BoardLimits;
}

function contextLines(ctx: AuthorContext): string {
  return [
    `The owner: ${ctx.owner}. Today: ${ctx.today}.`,
    ctx.groups.length
      ? `Groups (folder "group:<id>", fact in_group): ${ctx.groups.map((g) => `${g.id} (${g.name})`).join(", ")}.`
      : "",
    ctx.sections.length
      ? `Sections (folder "section:<id>", fact in_section): ${ctx.sections.map((s) => `${s.id} (${s.name})`).join(", ")}.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Asks the model, validates, and asks again with the errors, at most `retries` more times. */
async function writeValidated(
  runtime: HostedRuntime,
  workspaceId: string,
  system: string,
  prompt: string,
  settings: AuthorSettings,
  finish: (raw: Record<string, unknown>) => Record<string, unknown>,
): Promise<{ doc: BoardDoc; attempts: number }> {
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
      const v = validateBoard(finish(raw), settings.limits);
      if (v.ok) return { doc: v.doc, attempts: attempt + 1 };
      errors = v.errors;
    }
    extra = `\n\nYour last answer did not validate: ${errors.join(" ")} Answer again with the corrected JSON document only.`;
  }
  throw new BoardInvalidError(errors);
}

/** A Board document from the owner's sentence. Throws BoardInvalidError when no answer validates. */
export async function writeBoard(options: {
  runtime: HostedRuntime;
  workspaceId: string;
  sentence: string;
  context: AuthorContext;
  settings: AuthorSettings;
  /** The id the draft carries. */
  id: string;
}): Promise<{ doc: BoardDoc; attempts: number }> {
  const { settings } = options;
  const system = settings.prompt
    .replaceAll("{lanes}", String(settings.limits.maxLanes))
    .replaceAll("{signals}", String(settings.limits.maxSignals));
  const prompt = `${contextLines(options.context)}\n\nThe owner asks: ${options.sentence}`;
  return writeValidated(options.runtime, options.workspaceId, system, prompt, settings, (raw) => ({
    unsure: { label: "Unsure" },
    others: "hide",
    ...raw,
    id: options.id,
    sentence: typeof raw.sentence === "string" && raw.sentence ? raw.sentence : options.sentence,
    version: 0,
    examples: {},
  }));
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
export async function reviseBoard(options: {
  runtime: HostedRuntime;
  workspaceId: string;
  doc: BoardDoc;
  corrections: readonly CorrectionLine[];
  instruction?: string | undefined;
  context: AuthorContext;
  settings: AuthorSettings;
}): Promise<{ doc: BoardDoc; attempts: number }> {
  const { doc } = options;
  const { examples: _examples, ...shown } = doc;
  const prompt = [
    contextLines(options.context),
    `The Board:\n${JSON.stringify(shown, null, 2)}`,
    options.corrections.length
      ? `The owner corrected these threads:\n${options.corrections
          .map(
            (c, i) =>
              `${i + 1}. From ${c.from}, "${c.subject}": ${c.said}. The Board read: ${c.answers.join(", ") || "nothing yet"}.`,
          )
          .join("\n")}`
      : "",
    options.instruction ? `The owner asks: ${options.instruction}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return writeValidated(
    options.runtime,
    options.workspaceId,
    options.settings.revisePrompt,
    prompt,
    options.settings,
    (raw) => ({
      ...raw,
      id: doc.id,
      sentence: doc.sentence,
      version: doc.version,
      examples: doc.examples,
    }),
  );
}

/** Whether a Signal's own words changed between two documents (Examples aside). */
export function rewordedSignals(before: BoardDoc, after: BoardDoc): string[] {
  return after.signals
    .filter((s) => {
      const old = before.signals.find((o) => o.id === s.id);
      return !old || canonicalJson(old.question) !== canonicalJson(s.question);
    })
    .map((s) => s.id);
}
