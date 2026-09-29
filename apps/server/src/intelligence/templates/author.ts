// Writing a Template from examples (docs/spec/templates.md, "Writing a
// Template from examples"). The language model drafts (the `template` Task):
// name, fits-when, kind, subject, the body with Placeholders chosen from the
// typed set and a hint each, keeping the examples' wording where they agree
// and putting a Placeholder where they differ. Code validates the
// declarations and asks the model once more with the errors when they fail.
// Then the judge checks for duplicates (the entity-alignment pattern): one
// Choice shortlists the three nearest Templates, and one Score per
// shortlisted Template says different, related or same.

import type {
  ChoiceAnswer,
  DuplicateVerdict,
  JsonValue,
  JudgeQuestions,
  ScoreAnswer,
  Template,
  TemplateInput,
} from "@monday/shared";
import { ownWords, PLACEHOLDER_TYPES, templateErrors, tidyTemplate } from "@monday/shared";
import { TemplateInvalidError } from "../../templates/index.ts";
import type { HostedRuntime } from "../runtime/index.ts";
import type { Ask } from "./ask.ts";

export interface AuthorSettings {
  prompt: string;
  exampleChars: number;
}

export interface DuplicateSettings {
  sameAt: number;
  relatedAt: number;
  shortlist: number;
  choiceMax: number;
  shortlistQuestion: string;
  none: string;
  question: string;
  levels: string[];
}

export interface Example {
  subject: string;
  text: string;
}

/** The last JSON object in a model's answer, or null. */
function lastObject(text: string): Record<string, unknown> | null {
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

/** The model's JSON as a Template, tidied; missing fields come back empty so validation names them. */
export function parseTemplateDraft(text: string): TemplateInput {
  const o = lastObject(text) ?? {};
  const kind = o.kind === "starter" ? "starter" : "reply";
  const raw = Array.isArray(o.placeholders) ? o.placeholders : [];
  const placeholders = raw.flatMap((p) => {
    if (!p || typeof p !== "object") return [];
    const x = p as Record<string, unknown>;
    const type = (PLACEHOLDER_TYPES as readonly string[]).includes(String(x.type))
      ? (String(x.type) as TemplateInput["placeholders"][number]["type"])
      : "text";
    return [
      {
        name: String(x.name ?? ""),
        type,
        optional: x.optional === true,
        hint: String(x.hint ?? ""),
      },
    ];
  });
  return tidyTemplate({
    name: String(o.name ?? ""),
    fitsWhen: String(o.fits_when ?? o.fitsWhen ?? ""),
    kind,
    subject: kind === "starter" && typeof o.subject === "string" ? o.subject : null,
    body: String(o.body ?? ""),
    placeholders,
  });
}

export function authorPrompt(
  examples: readonly Example[],
  voice: string | null,
  maxChars: number,
): string {
  const lines = examples.map(
    (e, i) => `Example ${i + 1}\nSubject: ${e.subject}\n${ownWords(e.text).slice(0, maxChars)}`,
  );
  return [voice ? `How the owner writes:\n${voice}\n` : "", lines.join("\n\n---\n\n")]
    .filter(Boolean)
    .join("\n");
}

/** Drafts a Template from one to five example Messages; asks once more with the errors if it does not validate. */
export async function draftTemplate(options: {
  runtime: HostedRuntime;
  workspaceId: string;
  examples: readonly Example[];
  voice: string | null;
  settings: AuthorSettings;
}): Promise<TemplateInput> {
  const prompt = authorPrompt(options.examples, options.voice, options.settings.exampleChars);
  const run = (extra: string) =>
    options.runtime.run(
      "template",
      { system: options.settings.prompt, prompt: `${prompt}${extra}` },
      { workspaceId: options.workspaceId, jobId: null },
    );
  let draft = parseTemplateDraft((await run("")).output);
  let errors = templateErrors(draft);
  if (errors.length === 0) return draft;
  draft = parseTemplateDraft(
    (
      await run(
        `\n\nYour last answer did not validate: ${errors.join(" ")} Answer again with the corrected JSON object.`,
      )
    ).output,
  );
  errors = templateErrors(draft);
  if (errors.length > 0) throw new TemplateInvalidError(errors);
  return draft;
}

const view = (t: Pick<TemplateInput, "name" | "fitsWhen" | "body">): JsonValue => ({
  name: t.name,
  fits_when: t.fitsWhen,
  text: t.body,
});

/**
 * The nearest existing Template when it is related or the same; null when
 * none is, when the library is empty, or when no judge answers.
 */
export async function findDuplicate(options: {
  ask: Ask;
  workspaceId: string;
  candidate: TemplateInput;
  library: readonly Template[];
  settings: DuplicateSettings;
}): Promise<DuplicateVerdict | null> {
  const { settings, library, candidate } = options;
  if (library.length === 0) return null;
  const opts = { workspaceId: options.workspaceId, jobId: null };
  const per = Math.max(1, settings.choiceMax - 1);
  const chunks: Template[][] = [];
  for (let i = 0; i < library.length; i += per) chunks.push(library.slice(i, i + per));
  const first: JudgeQuestions = {};
  chunks.forEach((chunk, i) => {
    const criteria: Record<string, string> = {};
    for (const t of chunk) criteria[t.id] = `${t.name}: ${t.fitsWhen}`;
    criteria.none = settings.none;
    first[chunks.length === 1 ? "nearest" : `nearest_${i}`] = {
      type: "choice",
      instructions: settings.shortlistQuestion,
      criteria,
    };
  });
  const a = await options.ask({ new_template: view(candidate) }, first, opts);
  if (!a) return null;
  const ranked: Array<{ t: Template; p: number }> = [];
  chunks.forEach((chunk, i) => {
    const ans = (a.answers as Record<string, ChoiceAnswer | undefined>)[
      chunks.length === 1 ? "nearest" : `nearest_${i}`
    ];
    for (const t of chunk) ranked.push({ t, p: ans?.probabilities?.[t.id] ?? 0 });
  });
  const shortlist = ranked
    .filter((r) => r.p > 0)
    .sort((x, y) => y.p - x.p)
    .slice(0, settings.shortlist)
    .map((r) => r.t);
  if (shortlist.length === 0) return null;

  const second: JudgeQuestions = {};
  for (const t of shortlist) {
    second[`dup_${t.id}`] = {
      type: "score",
      instructions: settings.question.replaceAll("{name}", t.name),
      criteria: settings.levels,
    };
  }
  const state: JsonValue = {
    new_template: view(candidate),
    existing: Object.fromEntries(shortlist.map((t) => [t.name, view(t)])),
  };
  const b = await options.ask(state, second, opts);
  if (!b) return null;
  let best: DuplicateVerdict | null = null;
  for (const t of shortlist) {
    const s = (b.answers as Record<string, ScoreAnswer | undefined>)[`dup_${t.id}`];
    if (!s) continue;
    if (!best || s.score > best.score) {
      best = { templateId: t.id, name: t.name, score: s.score, level: "different" };
    }
  }
  if (!best) return null;
  best.level =
    best.score >= settings.sameAt
      ? "same"
      : best.score >= settings.relatedAt
        ? "related"
        : "different";
  return best.level === "different" ? null : best;
}
