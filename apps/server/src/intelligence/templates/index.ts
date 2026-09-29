// Templates' intelligence (docs/spec/templates.md, "Code, Jev, language
// model"): the stored Templates (../../templates) plus what the judge and the
// language model add to them. Slice 36 fills Placeholders from a Thread by
// span selection; the judge path is ask.ts (TypeSafe, else the language
// model's fallback, else nobody).

import type {
  Draft,
  DuplicateVerdict,
  Id,
  Person,
  Template,
  TemplateDraftResult,
  TemplateFillResult,
  TemplateInput,
  TemplateSuggestRequest,
  TemplateSuggestResult,
} from "@monday/shared";
import { findBuiltinTemplate } from "@monday/shared";
import type { Db } from "../../db/client.ts";
import { type Mailstore, NotFoundError } from "../../mailstore/index.ts";
import { readGlobalSettings } from "../../settings/read.ts";
import {
  createTemplates,
  TemplateInvalidError,
  TemplateNotFoundError,
  type Templates,
} from "../../templates/index.ts";
import type { HostedRuntime } from "../runtime/index.ts";
import { type Ask, createAsk } from "./ask.ts";
import { draftTemplate, type Example, findDuplicate } from "./author.ts";
import { type FillSettings, fillFromThread, threadForNewMessage } from "./fill.ts";
import { createTemplateStepSeam, type TemplateStepSeam } from "./step.ts";
import { suggestTemplate } from "./suggest.ts";
import { ownerOf, readThread, threadState } from "./thread.ts";

export type { Answerer, Ask, Asked } from "./ask.ts";
export { createAsk, PROMPT_JUDGE_SYSTEM, readPromptAnswers, unsureAnswer } from "./ask.ts";
export type { AuthorSettings, DuplicateSettings, Example } from "./author.ts";
export { authorPrompt, draftTemplate, findDuplicate, parseTemplateDraft } from "./author.ts";
export type { FillSettings } from "./fill.ts";
export { fillFromThread, fillQuestion, fillQuestionId, NONE } from "./fill.ts";
export type { TemplateStepSeam, TemplateStepStrings } from "./step.ts";
export { createTemplateStepSeam } from "./step.ts";
export type { SuggestSettings } from "./suggest.ts";
export { rankQuestions, rerankQuestions, suggestState, suggestTemplate } from "./suggest.ts";
export { readThread, threadState } from "./thread.ts";
export type { VerifySettings } from "./verify.ts";
export { detailsNotInThread, verifyDraft, verifyQuestions } from "./verify.ts";

const FILL_KEYS = [
  "templates.fill.confidence",
  "templates.fill.candidates_max",
  "templates.fill.state_chars",
  "templates.fill.question",
  "templates.fill.none",
  "templates.fill.date_format",
  "templates.fill.time_format",
] as const;

export interface FillRequest {
  /** The Thread a reply answers; null or absent for a new Message. */
  threadId?: Id | null | undefined;
  /** A new Message's To field, whose one name may fill first_name. */
  to?: Person[] | undefined;
  /** The Template as the caller holds it, when it is not saved (a draft from examples). */
  template?: Template | undefined;
  jobId?: string | null | undefined;
}

export interface TemplateIntelligence {
  store: Templates;
  /** The judge path the Templates questions take. */
  ask: Ask;
  fillSettings(): Promise<FillSettings>;
  /** Fills a Template's Placeholders from a Thread by span selection. Throws TemplateNotFoundError. */
  fill(workspaceId: Id, templateId: Id, request?: FillRequest): Promise<TemplateFillResult>;
  /** The two requests while the owner types (slice 37). */
  suggest(request: TemplateSuggestRequest): Promise<TemplateSuggestResult>;
  /**
   * On open: a Thread whose needs-reply holds gets the same two requests
   * with nothing typed, so the Reply chip can name the Template. Remembered
   * per Thread version.
   */
  suggestOnOpen(workspaceId: Id, threadId: Id): Promise<TemplateSuggestResult>;
  /**
   * Writes a Template from one to five example Messages (or texts) with the
   * language model, then asks the judge for a duplicate. Throws
   * TemplateInvalidError when the model's Template does not validate twice.
   */
  draftFromExamples(workspaceId: Id, from: ExampleSource): Promise<TemplateDraftResult>;
  /** The duplicate check alone, for a Template written by hand or by the Agent. */
  duplicateOf(workspaceId: Id, candidate: TemplateInput): Promise<DuplicateVerdict | null>;
  /** What a draft_from_template Workflow Step asks of Templates (slice 38). */
  step: TemplateStepSeam;
}

/** Where examples come from: sent Messages by id, or texts as the caller holds them (a Draft). */
export interface ExampleSource {
  messageIds?: readonly Id[] | undefined;
  texts?: readonly Example[] | undefined;
}

export interface TemplateIntelligenceOptions {
  db: Db;
  mailstore: Mailstore;
  runtime: HostedRuntime;
  now?: () => Date;
  log?: (message: string) => void;
  /** Injected in tests; defaults to the rows in `db`. */
  store?: Templates;
  /** The Voice profile's description when it is on, for drafting in the owner's voice. */
  voice?: ((workspaceId: Id) => Promise<string | null>) | undefined;
  /** How likely a Thread needs a reply, from its stored Judgments; null when none are stored. */
  needsReply?: ((threadId: Id) => Promise<number | null>) | undefined;
  /** A Draft by id, for a Workflow Step that waits on the user to fill it. */
  readDraft?: ((draftId: Id) => Promise<Draft | null>) | undefined;
}

const SUGGEST_KEYS = [
  "templates.enabled",
  "templates.suggest.enabled",
  "templates.suggest.max_typed_chars",
  "templates.suggest.gate",
  "templates.suggest.fits_floor",
  "templates.suggest.shortlist",
  "templates.suggest.choice_max",
  "templates.suggest.on_open",
  "templates.suggest.needs_reply_at",
  "templates.suggest.question.which",
  "templates.suggest.question.none",
  "templates.suggest.question.gate_standard",
  "templates.suggest.question.gate_purpose",
  "templates.suggest.question.gate_personal",
  "templates.suggest.question.rerank",
  "templates.suggest.question.fits",
  "templates.fill.state_chars",
] as const;

const AUTHOR_KEYS = [
  "templates.author.prompt",
  "templates.author.example_chars",
  "templates.author.examples_max",
  "templates.duplicate.same_at",
  "templates.duplicate.related_at",
  "templates.duplicate.question",
  "templates.duplicate.levels",
  "templates.duplicate.shortlist_question",
  "templates.suggest.shortlist",
  "templates.suggest.choice_max",
  "templates.suggest.question.none",
] as const;

/** How many on-open answers are remembered, one per Thread version. */
const ON_OPEN_REMEMBERED = 200;

export function createTemplateIntelligence(
  options: TemplateIntelligenceOptions,
): TemplateIntelligence {
  const { db, mailstore } = options;
  const store =
    options.store ??
    createTemplates({ db, mailstore, ...(options.now ? { now: options.now } : {}) });
  const ask = createAsk({
    db,
    runtime: options.runtime,
    ...(options.log ? { log: options.log } : {}),
  });

  const fillSettings = async (): Promise<FillSettings> => {
    const s = await readGlobalSettings(db, FILL_KEYS);
    return {
      confidence: s["templates.fill.confidence"],
      candidatesMax: s["templates.fill.candidates_max"],
      stateChars: s["templates.fill.state_chars"],
      question: s["templates.fill.question"],
      none: s["templates.fill.none"],
      normalize: {
        dateFormat: s["templates.fill.date_format"],
        timeFormat: s["templates.fill.time_format"],
      },
    };
  };

  const suggestWith = async (
    workspaceId: Id,
    threadId: Id | null,
    draft: TemplateSuggestRequest["draft"],
    s: Awaited<ReturnType<typeof readSuggest>>,
  ): Promise<TemplateSuggestResult> => {
    const library = await store.library(workspaceId);
    const thread = threadId
      ? threadState(await readThread(db, mailstore, threadId), s["templates.fill.state_chars"])
      : null;
    return suggestTemplate({
      ask,
      workspaceId,
      library,
      thread,
      draft,
      settings: {
        gate: s["templates.suggest.gate"],
        fitsFloor: s["templates.suggest.fits_floor"],
        shortlist: s["templates.suggest.shortlist"],
        choiceMax: s["templates.suggest.choice_max"],
        questions: {
          which: s["templates.suggest.question.which"],
          none: s["templates.suggest.question.none"],
          gateStandard: s["templates.suggest.question.gate_standard"],
          gatePurpose: s["templates.suggest.question.gate_purpose"],
          gatePersonal: s["templates.suggest.question.gate_personal"],
          rerank: s["templates.suggest.question.rerank"],
          fits: s["templates.suggest.question.fits"],
        },
      },
    });
  };
  const readSuggest = () => readGlobalSettings(db, SUGGEST_KEYS);
  const onOpen = new Map<string, TemplateSuggestResult>();

  const examplesOf = async (from: ExampleSource, max: number): Promise<Example[]> => {
    const out: Example[] = [...(from.texts ?? [])];
    for (const id of from.messageIds ?? []) {
      const header = await mailstore.findMessage(id);
      if (!header) throw new NotFoundError("message", id);
      out.push({
        subject: await mailstore.readThreadSubject(header.threadId),
        text: (await mailstore.readMessageBody(id)).text,
      });
    }
    return out.slice(0, max);
  };

  const duplicateSettings = (s: Awaited<ReturnType<typeof readAuthor>>) => ({
    sameAt: s["templates.duplicate.same_at"],
    relatedAt: s["templates.duplicate.related_at"],
    shortlist: s["templates.suggest.shortlist"],
    choiceMax: s["templates.suggest.choice_max"],
    shortlistQuestion: s["templates.duplicate.shortlist_question"],
    none: s["templates.suggest.question.none"],
    question: s["templates.duplicate.question"],
    levels: s["templates.duplicate.levels"],
  });
  const readAuthor = () => readGlobalSettings(db, AUTHOR_KEYS);

  const duplicateOf = async (workspaceId: Id, candidate: TemplateInput) =>
    findDuplicate({
      ask,
      workspaceId,
      candidate,
      library: await store.library(workspaceId),
      settings: duplicateSettings(await readAuthor()),
    });

  const step = createTemplateStepSeam({
    db,
    mailstore,
    runtime: options.runtime,
    ask,
    get: (id) => store.get(id),
    // "choose": the judge picks from the library as it does on open, with nothing typed.
    choose: async (workspaceId, threadId) => {
      const r = await suggestWith(
        workspaceId,
        threadId,
        { to: [], subject: "", typed: "" },
        await readSuggest(),
      );
      return r.status === "suggested" ? store.get(r.templateId) : null;
    },
    fill: async (workspaceId, template, threadId, jobId) =>
      fillFromThread({
        ask,
        workspaceId,
        template,
        thread: await readThread(db, mailstore, threadId),
        settings: await fillSettings(),
        jobId,
      }),
    readDraft: async (id) => (await options.readDraft?.(id)) ?? null,
  });

  return {
    store,
    ask,
    fillSettings,
    step,

    async suggest(request) {
      const s = await readSuggest();
      if (!s["templates.enabled"] || !s["templates.suggest.enabled"]) {
        return { status: "none", reason: "disabled" };
      }
      if (request.draft.typed.length >= s["templates.suggest.max_typed_chars"]) {
        return { status: "none", reason: "disabled" };
      }
      return suggestWith(request.workspace, request.threadId, request.draft, s);
    },

    async suggestOnOpen(workspaceId, threadId) {
      const s = await readSuggest();
      if (
        !s["templates.enabled"] ||
        !s["templates.suggest.enabled"] ||
        !s["templates.suggest.on_open"]
      ) {
        return { status: "none", reason: "disabled" };
      }
      const needs = (await options.needsReply?.(threadId)) ?? null;
      if (needs === null || needs < s["templates.suggest.needs_reply_at"]) {
        return { status: "none", reason: "gate" };
      }
      const headers = await mailstore.listMessages(threadId);
      const key = `${threadId}:${headers.at(-1)?.id ?? ""}`;
      const known = onOpen.get(key);
      if (known) return known;
      const newest = headers.at(-1);
      const result = await suggestWith(
        workspaceId,
        threadId,
        { to: newest ? [newest.from] : [], subject: "", typed: "" },
        s,
      );
      if (result.status !== "unavailable") {
        onOpen.set(key, result);
        if (onOpen.size > ON_OPEN_REMEMBERED) onOpen.delete(onOpen.keys().next().value ?? "");
      }
      return result;
    },

    async draftFromExamples(workspaceId, from) {
      const s = await readAuthor();
      const examples = await examplesOf(from, s["templates.author.examples_max"]);
      if (examples.length === 0) throw new TemplateInvalidError(["No example message was given."]);
      const template = await draftTemplate({
        runtime: options.runtime,
        workspaceId,
        examples,
        voice: (await options.voice?.(workspaceId).catch(() => null)) ?? null,
        settings: {
          prompt: s["templates.author.prompt"],
          exampleChars: s["templates.author.example_chars"],
        },
      });
      const duplicate = await findDuplicate({
        ask,
        workspaceId,
        candidate: template,
        library: await store.library(workspaceId),
        settings: duplicateSettings(s),
      });
      return { template, duplicate };
    },

    duplicateOf,

    async fill(workspaceId, templateId, request = {}) {
      const template =
        request.template ?? findBuiltinTemplate(templateId) ?? (await store.get(templateId));
      if (!template) throw new TemplateNotFoundError(templateId);
      const settings = await fillSettings();
      if (request.threadId) {
        const thread = await readThread(db, mailstore, request.threadId);
        return fillFromThread({
          ask,
          workspaceId,
          template,
          thread,
          settings,
          jobId: request.jobId ?? null,
        });
      }
      return fillFromThread({
        ask,
        workspaceId,
        template,
        thread: threadForNewMessage(request.to ?? [], await ownerOf(db, workspaceId)),
        settings,
        newMessage: true,
      });
    },
  };
}
