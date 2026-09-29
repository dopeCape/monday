// Templates' intelligence (docs/spec/templates.md, "Code, Jev, language
// model"): the stored Templates (../../templates) plus what the judge and the
// language model add to them. Slice 36 fills Placeholders from a Thread by
// span selection; the judge path is ask.ts (TypeSafe, else the language
// model's fallback, else nobody).

import type { Id, Person, Template, TemplateFillResult } from "@monday/shared";
import { findBuiltinTemplate } from "@monday/shared";
import type { Db } from "../../db/client.ts";
import type { Mailstore } from "../../mailstore/index.ts";
import { readGlobalSettings } from "../../settings/read.ts";
import { createTemplates, TemplateNotFoundError, type Templates } from "../../templates/index.ts";
import type { HostedRuntime } from "../runtime/index.ts";
import { type Ask, createAsk } from "./ask.ts";
import { type FillSettings, fillFromThread, threadForNewMessage } from "./fill.ts";
import { ownerOf, readThread } from "./thread.ts";

export type { Answerer, Ask, Asked } from "./ask.ts";
export { createAsk, PROMPT_JUDGE_SYSTEM, readPromptAnswers, unsureAnswer } from "./ask.ts";
export type { FillSettings } from "./fill.ts";
export { fillFromThread, fillQuestion, fillQuestionId, NONE } from "./fill.ts";
export { readThread, threadState } from "./thread.ts";

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
}

export interface TemplateIntelligenceOptions {
  db: Db;
  mailstore: Mailstore;
  runtime: HostedRuntime;
  now?: () => Date;
  log?: (message: string) => void;
  /** Injected in tests; defaults to the rows in `db`. */
  store?: Templates;
}

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

  return {
    store,
    ask,
    fillSettings,
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
