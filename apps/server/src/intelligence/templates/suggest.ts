// Suggestions while typing (docs/spec/templates.md, "Suggestions while
// typing"; the skill-suggestion cookbook): two requests.
//   1. A cheap ranking over the whole library, one Choice per 255 Templates
//      with `name: fits-when` as each option, plus three Nouls whose mean
//      (gate_personal inverted) decides whether a Template is wanted at all.
//   2. A close look at the top three with their full text: a Choice among
//      them and one "does it fit" Noul each, which may reject all of them.
// Nothing is suggested below the gate or below the reject-all floor; below
// the floor (not the gate), request 1's first choice, when it is at least the
// hint floor, comes back as `maybe` for the softer line. Every answer after request 1 carries its
// ranking, which the picker orders by; `rankOnly` stops after request 1.

import type {
  ChoiceAnswer,
  ChoiceQuestion,
  JsonValue,
  JudgeQuestions,
  NoulQuestion,
  Person,
  Template,
  TemplateRank,
  TemplateSuggestResult,
} from "@monday/shared";
import type { Ask } from "./ask.ts";

export const NONE = "none";

export interface SuggestSettings {
  gate: number;
  fitsFloor: number;
  /** Request 1's first choice at least this likely is offered softly when nothing is suggested. */
  hintFloor: number;
  /** How many of request 1's best go to request 2. */
  shortlist: number;
  /** The most options one Choice carries; a larger library is split. */
  choiceMax: number;
  questions: {
    which: string;
    none: string;
    gateStandard: string;
    gatePurpose: string;
    gatePersonal: string;
    rerank: string;
    fits: string;
  };
}

export interface SuggestInput {
  ask: Ask;
  workspaceId: string;
  library: readonly Template[];
  /** The Thread's state for a reply; null for a new Message. */
  thread: Record<string, JsonValue> | null;
  draft: { to: readonly Person[]; subject: string; typed: string };
  settings: SuggestSettings;
  jobId?: string | null;
  /** Request 1 only, for the picker: no gate, no closer look. */
  rankOnly?: boolean;
  /**
   * Request 1's answer from an earlier rankOnly call over the same text: the closer
   * look runs on it at once instead of asking request 1 again.
   */
  prior?: { ranking: readonly TemplateRank[]; gate: number } | undefined;
}

/** What request 1 and request 2 read: the Thread (for a reply) and what the owner has started. */
export function suggestState(
  thread: Record<string, JsonValue> | null,
  draft: SuggestInput["draft"],
): JsonValue {
  return {
    ...(thread ? { thread } : {}),
    draft: {
      to: draft.to.map((p) => (p.name ? `${p.name} <${p.email}>` : p.email)),
      subject: draft.subject,
      typed: draft.typed,
    },
  };
}

/** The library as request 1's Choices, at most `max` options each (the `none` option included). */
export function rankQuestions(
  library: readonly Template[],
  settings: SuggestSettings,
): { questions: JudgeQuestions; chunks: Template[][] } {
  const per = Math.max(1, settings.choiceMax - 1);
  const chunks: Template[][] = [];
  for (let i = 0; i < library.length; i += per) chunks.push(library.slice(i, i + per));
  const questions: JudgeQuestions = {};
  chunks.forEach((chunk, i) => {
    const criteria: Record<string, string> = {};
    for (const t of chunk) criteria[t.id] = `${t.name}: ${t.fitsWhen}`;
    criteria[NONE] = settings.questions.none;
    questions[chunks.length === 1 ? "which" : `which_${i}`] = {
      type: "choice",
      instructions: settings.questions.which,
      criteria,
    } satisfies ChoiceQuestion;
  });
  const noul = (instructions: string): NoulQuestion => ({ type: "noul", instructions });
  questions.gate_standard = noul(settings.questions.gateStandard);
  questions.gate_purpose = noul(settings.questions.gatePurpose);
  questions.gate_personal = noul(settings.questions.gatePersonal);
  return { questions, chunks };
}

/** Request 2 over the shortlist: the full text as each option, and one "does it fit" Noul each. */
export function rerankQuestions(
  shortlist: readonly Template[],
  settings: SuggestSettings,
): JudgeQuestions {
  const criteria: Record<string, string> = {};
  for (const t of shortlist) criteria[t.id] = t.body;
  const questions: JudgeQuestions = {
    which: { type: "choice", instructions: settings.questions.rerank, criteria },
  };
  shortlist.forEach((t) => {
    questions[`fits_${t.id}`] = {
      type: "noul",
      instructions: settings.questions.fits
        .replaceAll("{name}", t.name)
        .replaceAll("{text}", t.body),
    };
  });
  return questions;
}

export async function suggestTemplate(input: SuggestInput): Promise<TemplateSuggestResult> {
  const { settings, library } = input;
  if (library.length === 0) return { status: "none", reason: "empty" };
  const state = suggestState(input.thread, input.draft);
  const opts = { workspaceId: input.workspaceId, jobId: input.jobId ?? null };

  let gate: number;
  let best: Array<{ template: Template; p: number }>;
  if (input.prior) {
    const byId = new Map(library.map((t) => [t.id, t]));
    gate = input.prior.gate;
    best = input.prior.ranking.flatMap((r) => {
      const template = byId.get(r.templateId);
      return template && r.p > 0 ? [{ template, p: r.p }] : [];
    });
  } else {
    const { questions, chunks } = rankQuestions(library, settings);
    const first = await input.ask(state, questions, opts);
    if (!first) return { status: "unavailable", reason: "no judge" };
    const answers = first.answers as Record<
      string,
      { type: string; noul?: number } & Partial<ChoiceAnswer>
    >;
    const noul = (id: string) => answers[id]?.noul ?? 0.5;
    gate = (noul("gate_standard") + noul("gate_purpose") + (1 - noul("gate_personal"))) / 3;
    const ranked: Array<{ template: Template; p: number }> = [];
    chunks.forEach((chunk, i) => {
      const a = answers[chunks.length === 1 ? "which" : `which_${i}`];
      for (const t of chunk) ranked.push({ template: t, p: a?.probabilities?.[t.id] ?? 0 });
    });
    best = ranked.filter((r) => r.p > 0).sort((a, b) => b.p - a.p);
  }
  const ranking: TemplateRank[] = best.map((r) => ({ templateId: r.template.id, p: r.p }));
  const top = best[0];
  const maybe =
    top && top.p >= settings.hintFloor
      ? { maybe: { templateId: top.template.id, name: top.template.name, p: top.p } }
      : {};
  if (input.rankOnly) return { status: "ranked", ranking, gate, ...maybe };
  // Below the gate the message looks personal: no confident line, but a likely template is
  // still offered softly ("Maybe: X"), since the owner may want it all the same.
  if (gate < settings.gate) return { status: "none", reason: "gate", gate, ranking, ...maybe };

  const shortlist = best.slice(0, settings.shortlist).map((r) => r.template);
  if (shortlist.length === 0) return { status: "none", reason: "floor", gate, ranking };

  const second = await input.ask(state, rerankQuestions(shortlist, settings), opts);
  if (!second) return { status: "unavailable", reason: "no judge" };
  const b = second.answers as Record<string, { noul?: number; choice?: string }>;
  const fits = shortlist.map((t) => b[`fits_${t.id}`]?.noul ?? 0);
  const fit = Math.max(...fits);
  if (fit < settings.fitsFloor) return { status: "none", reason: "floor", gate, ranking, ...maybe };
  const winner = shortlist.find((t) => t.id === b.which?.choice) ?? shortlist[fits.indexOf(fit)];
  if (!winner) return { status: "none", reason: "floor", gate, ranking, ...maybe };
  return {
    status: "suggested",
    templateId: winner.id,
    name: winner.name,
    fits: fits[shortlist.indexOf(winner)] ?? fit,
    gate,
    ranking,
  };
}
