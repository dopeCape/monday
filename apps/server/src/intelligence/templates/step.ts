// What a `draft_from_template` Workflow Step asks of Templates (slice 38,
// docs/spec/templates.md, "Draft from a Template in a Workflow"): the
// Template (by id, or "choose" as on open), its Placeholders filled from the
// Thread by selection, the Message written around it by the language model
// (the draft-in-voice Task), and the three checks. The runner in
// workflows/index.ts owns the tool calls, the pauses and the approvals.

import type {
  BadgeStrings,
  Draft,
  Id,
  Person,
  Template,
  TemplateChecks,
  TemplateFillResult,
} from "@monday/shared";
import { fillPlaceholders, ownWords, templateText } from "@monday/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { accounts, workspaces } from "../../db/schema.ts";
import type { Mailstore } from "../../mailstore/index.ts";
import { readGlobalSettings } from "../../settings/read.ts";
import type { HostedRuntime } from "../runtime/index.ts";
import type { Ask } from "./ask.ts";
import { readThread } from "./thread.ts";
import { verifyDraft } from "./verify.ts";

export interface TemplateStepStrings extends BadgeStrings {
  couldNotFill: string;
  gone: string;
  waitingCheck: string;
}

export interface TemplateStepSeam {
  /** A Template by id, or the one that fits the Thread when `ref` is "choose"; null when none. */
  template(
    workspaceId: Id,
    threadId: Id,
    ref: string,
    jobId: string | null,
  ): Promise<Template | null>;
  fill(
    workspaceId: Id,
    template: Template,
    threadId: Id,
    jobId: string | null,
  ): Promise<TemplateFillResult>;
  /** The Template's text with its fills in; an unfilled optional Placeholder is dropped. */
  filledText(template: Template, fills: TemplateFillResult["fills"]): string;
  /** The Message the language model writes around the filled Template. */
  write(
    workspaceId: Id,
    filled: string,
    threadId: Id,
    instructions: string | undefined,
    jobId: string | null,
  ): Promise<string>;
  /** The three checks, or null when templates.verify.enabled is off. */
  verify(
    workspaceId: Id,
    threadId: Id,
    filled: string,
    draft: string,
    jobId: string | null,
  ): Promise<TemplateChecks | null>;
  readDraft(draftId: Id): Promise<Draft | null>;
  settings(): Promise<{ standingRequiresClean: boolean; strings: TemplateStepStrings }>;
}

const personLine = (p: Person) => (p.name ? `${p.name} <${p.email}>` : p.email);

export function createTemplateStepSeam(options: {
  db: Db;
  mailstore: Mailstore;
  runtime: HostedRuntime;
  ask: Ask;
  get(id: Id): Promise<Template | null>;
  choose(workspaceId: Id, threadId: Id): Promise<Template | null>;
  fill(
    workspaceId: Id,
    template: Template,
    threadId: Id,
    jobId: string | null,
  ): Promise<TemplateFillResult>;
  readDraft(draftId: Id): Promise<Draft | null>;
}): TemplateStepSeam {
  const { db, mailstore } = options;

  const signatureOf = async (workspaceId: Id): Promise<string> => {
    const [row] = await db
      .select({ address: accounts.address })
      .from(workspaces)
      .innerJoin(accounts, eq(accounts.id, workspaces.accountId))
      .where(eq(workspaces.id, workspaceId));
    const s = await readGlobalSettings(db, ["send.signature", "send.signatures"]);
    const address = (row?.address ?? "").toLowerCase();
    const own = Object.entries(s["send.signatures"]).find(([k]) => k.toLowerCase() === address);
    return own?.[1] ?? s["send.signature"];
  };

  return {
    async template(workspaceId, threadId, ref) {
      return ref === "choose" ? options.choose(workspaceId, threadId) : options.get(ref);
    },
    fill: options.fill,
    filledText(template, fills) {
      return fillPlaceholders(templateText(template, fills), {});
    },
    async write(workspaceId, filled, threadId, instructions, jobId) {
      const thread = await readThread(db, mailstore, threadId);
      const owner = thread.owner[0] ?? "";
      const newest =
        [...thread.messages].reverse().find((m) => m.from.email.toLowerCase() !== owner) ??
        thread.messages.at(-1);
      const s = await readGlobalSettings(db, ["templates.step.write_prompt"]);
      const result = await options.runtime.run(
        "draft-in-voice",
        {
          system: s["templates.step.write_prompt"],
          prompt: [
            `Template, filled:\n${filled}`,
            instructions ? `Instructions: ${instructions}` : "",
            `Thread subject: ${thread.subject}`,
            newest
              ? `Newest message, from ${personLine(newest.from)}:\n${ownWords(newest.text)}`
              : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
        { workspaceId, jobId },
      );
      return result.output.trim();
    },
    async verify(workspaceId, threadId, filled, draft, jobId) {
      const s = await readGlobalSettings(db, [
        "templates.verify.enabled",
        "templates.verify.unsure_band",
        "templates.verify.question.asks",
        "templates.verify.question.answers",
        "templates.verify.question.commits",
        "templates.verify.question.supports",
        "templates.verify.supports.supported",
        "templates.verify.supports.partly",
        "templates.verify.supports.unsupported",
        "templates.verify.question.leak",
      ]);
      if (!s["templates.verify.enabled"]) return null;
      const thread = await readThread(db, mailstore, threadId);
      const owner = thread.owner[0] ?? "";
      const newest =
        [...thread.messages].reverse().find((m) => m.from.email.toLowerCase() !== owner) ??
        thread.messages.at(-1);
      return verifyDraft({
        ask: options.ask,
        workspaceId,
        newest: { from: newest ? personLine(newest.from) : "", text: newest?.text ?? "" },
        threadText: thread.messages
          .map(
            (m) =>
              `${personLine(m.from)} ${m.to.map(personLine).join(" ")} ${m.cc.map(personLine).join(" ")}\n${ownWords(m.text)}`,
          )
          .join("\n\n"),
        template: filled,
        draft,
        signature: await signatureOf(workspaceId),
        settings: {
          unsureBand: s["templates.verify.unsure_band"],
          questions: {
            asks: s["templates.verify.question.asks"],
            answers: s["templates.verify.question.answers"],
            commits: s["templates.verify.question.commits"],
            supports: s["templates.verify.question.supports"],
            supportsCriteria: {
              supported: s["templates.verify.supports.supported"],
              partly: s["templates.verify.supports.partly"],
              unsupported: s["templates.verify.supports.unsupported"],
            },
            leak: s["templates.verify.question.leak"],
          },
        },
        jobId,
      });
    },
    readDraft: options.readDraft,
    async settings() {
      const s = await readGlobalSettings(db, [
        "templates.verify.standing_requires_clean",
        "strings.templates.badge.answers_all",
        "strings.templates.badge.answers_some",
        "strings.templates.badge.no_promises",
        "strings.templates.badge.promises",
        "strings.templates.badge.no_details",
        "strings.templates.badge.details",
        "strings.templates.badge.confidential",
        "strings.templates.badge.could_not_check",
        "strings.templates.could_not_fill",
        "strings.templates.gone",
        "strings.templates.waiting_check",
      ]);
      return {
        standingRequiresClean: s["templates.verify.standing_requires_clean"],
        strings: {
          answersAll: s["strings.templates.badge.answers_all"],
          answersSome: s["strings.templates.badge.answers_some"],
          noPromises: s["strings.templates.badge.no_promises"],
          promises: s["strings.templates.badge.promises"],
          noDetails: s["strings.templates.badge.no_details"],
          details: s["strings.templates.badge.details"],
          confidential: s["strings.templates.badge.confidential"],
          couldNotCheck: s["strings.templates.badge.could_not_check"],
          couldNotFill: s["strings.templates.could_not_fill"],
          gone: s["strings.templates.gone"],
          waitingCheck: s["strings.templates.waiting_check"],
        },
      };
    },
  };
}
