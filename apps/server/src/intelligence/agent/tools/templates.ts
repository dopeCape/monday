// The Agent's Template tools (slice 37, docs/spec/templates.md, "The Agent"):
// list_templates reads the library; use_template makes a Draft from a
// Template filled for a Thread (reversible: Undo deletes the Draft);
// create_template, update_template and delete_template write the
// Workspace's Templates behind the Template card with Undo. create_template
// can write the Template from example Messages the way "Make a template from
// this" does, and every new or changed Template carries the duplicate check
// on its card. Approvals stay in the tool server (ADR 0002).

import type {
  DuplicateVerdict,
  Placeholder,
  Template,
  TemplateDraftResult,
  TemplateFillResult,
  TemplateInput,
  TemplatePreview,
  TemplateScope,
  ToolPreview,
} from "@monday/shared";
import {
  PLACEHOLDER_TYPES,
  placeholdersIn,
  templateErrors,
  templateHtml,
  templateSubject,
  templateText,
  tidyTemplate,
} from "@monday/shared";
import { z } from "zod";
import { draftContent, type ToolContext, type ToolDefinition, type ToolPlan } from "./catalog.ts";

/** What the Template tools act through: the Templates module on the Server. */
export interface TemplatesSeam {
  store: {
    library(workspaceId: string): Promise<Template[]>;
    get(id: string): Promise<Template | null>;
    create(
      workspaceId: string,
      input: TemplateInput,
      options?: { scope?: TemplateScope; createdBy?: "user" | "agent" },
    ): Promise<Template[]>;
    update(
      id: string,
      input: TemplateInput,
      options?: { everywhere?: boolean; workspaceId?: string },
    ): Promise<Template[]>;
    remove(id: string, options?: { everywhere?: boolean }): Promise<Template[]>;
    restore(ids: readonly string[]): Promise<Template[]>;
  };
  fill(
    workspaceId: string,
    templateId: string,
    request?: { threadId?: string | null; to?: Array<{ name: string; email: string }> },
  ): Promise<TemplateFillResult>;
  draftFromExamples(
    workspaceId: string,
    from: { messageIds?: readonly string[] },
  ): Promise<TemplateDraftResult>;
  duplicateOf(workspaceId: string, candidate: TemplateInput): Promise<DuplicateVerdict | null>;
}

const refused = (text: string): ToolPlan => ({ kind: "refused", text });

function seamOf(ctx: ToolContext): TemplatesSeam | null {
  return ctx.extensions?.templates ?? null;
}

const placeholder = z.object({
  name: z.string().min(1).max(64).describe("lowercase with underscores, as written in the body"),
  type: z.enum(PLACEHOLDER_TYPES),
  optional: z.boolean().default(false).describe("true when the body writes it {name?}"),
  hint: z.string().max(300).default("").describe("what it is, in a few words"),
});

const fields = {
  name: z.string().min(1).max(120).optional(),
  fits_when: z.string().max(500).optional().describe("One line: when it fits"),
  kind: z.enum(["reply", "starter"]).optional(),
  subject: z.string().max(500).nullable().optional().describe("Starters only"),
  body: z
    .string()
    .max(20_000)
    .optional()
    .describe("Plain text; a Placeholder is {name}, or {name?} when it may stay empty"),
  placeholders: z.array(placeholder).max(40).optional(),
};

/** Placeholders the body uses but the call did not declare get type text; declared ones keep theirs. */
function declared(
  body: string,
  subject: string | null,
  given: readonly Placeholder[] | undefined,
): Placeholder[] {
  const known = new Map((given ?? []).map((p) => [p.name, p]));
  return placeholdersIn(`${subject ?? ""}\n${body}`).map(
    (u) => known.get(u.name) ?? { name: u.name, type: "text", optional: u.optional, hint: "" },
  );
}

const inputOf = (t: Template): TemplateInput => ({
  name: t.name,
  fitsWhen: t.fitsWhen,
  kind: t.kind,
  subject: t.subject,
  body: t.body,
  placeholders: t.placeholders,
});

const card = (p: Omit<TemplatePreview, "kind">): ToolPreview => ({ kind: "template", ...p });

const describe = (t: Template) =>
  `${t.id}: ${t.name} (${t.kind}${t.workspaceId ? "" : ", built in"}). Fits when: ${t.fitsWhen}. Placeholders: ${
    t.placeholders.map((p) => `{${p.name}${p.optional ? "?" : ""}} ${p.type}`).join(", ") || "none"
  }`;

/* ------------------------------ list_templates ------------------------------ */

const listTemplates: ToolDefinition<{ query?: string | undefined }> = {
  name: "list_templates",
  description:
    "List the Templates this account can use: its own, then the built-ins, each with its id, name, kind, when it fits and its Placeholders. Read-only.",
  tier: "read",
  input: z.object({ query: z.string().max(200).optional().describe("Words to filter by") }),
  summarize: (i) => i.query ?? "all",
  async run(input, ctx) {
    const seam = seamOf(ctx);
    if (!seam) return refused("Templates are not available from this host.");
    const words = (input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const all = (await seam.store.library(ctx.host.workspaceId)).filter((t) =>
      words.every((w) => `${t.name} ${t.fitsWhen}`.toLowerCase().includes(w)),
    );
    return {
      kind: "result",
      text: all.length ? all.map(describe).join("\n") : "No template matches.",
      data: { templates: all.map((t) => ({ id: t.id, name: t.name, kind: t.kind })) },
    };
  },
};

/* ------------------------------ use_template ------------------------------ */

const useTemplate: ToolDefinition<{
  template_id: string;
  thread_id?: string | undefined;
  to?: Array<string | { name: string; email: string }> | undefined;
}> = {
  name: "use_template",
  description:
    "Start a Draft from a Template: a reply on thread_id (its Placeholders filled from the thread by picking what the thread says, never inventing), or a new message to `to`. Unfilled Placeholders stay for the user and block Send. Reversible: undo deletes the Draft. Say which Template you started from.",
  tier: "reversible",
  input: z.object({
    template_id: z.string().min(1),
    thread_id: z.string().optional(),
    to: z
      .array(z.union([z.string(), z.object({ name: z.string().default(""), email: z.string() })]))
      .optional(),
  }),
  summarize: (i) => `${i.template_id}${i.thread_id ? ` on ${i.thread_id}` : ""}`,
  async run(input, ctx) {
    const seam = seamOf(ctx);
    if (!seam) return refused("Templates are not available from this host.");
    const template = await seam.store.get(input.template_id);
    if (!template)
      return refused(`Template ${input.template_id} not found; list_templates names them.`);
    const reply = Boolean(input.thread_id);
    const base = await draftContent(ctx, {
      kind: reply ? "reply" : "new",
      thread_id: input.thread_id,
      to: input.to,
      subject: !reply && template.subject ? template.subject : undefined,
      body: template.body,
    });
    if ("refused" in base) return refused(base.refused);
    const fill = await seam.fill(ctx.host.workspaceId, template.id, {
      threadId: input.thread_id ?? null,
      to: base.to,
    });
    const content = {
      ...base,
      subject:
        !reply && template.subject ? templateSubject(template.subject, fill.fills) : base.subject,
      bodyHtml: templateHtml(template, fill.fills),
      bodyText: templateText(template, fill.fills),
    };
    const unfilled = fill.fills.filter((f) => !f.value).map((f) => f.name);
    return {
      kind: "action",
      preview: card({
        action: "use",
        template: inputOf(template),
        templateId: template.id,
        previous: null,
        duplicate: null,
        threadId: input.thread_id ?? null,
      }),
      count: 1,
      apply: async () => {
        const draft = await ctx.host.createDraft(content);
        return {
          text: `Started from ${template.name}. Draft ${draft.id} saved.${
            unfilled.length ? ` Left for the user to fill: ${unfilled.join(", ")}.` : ""
          }`,
          data: {
            draftId: draft.id,
            templateId: template.id,
            unfilled,
            open: {
              action: "open_draft",
              draftId: draft.id,
              threadId: draft.threadId,
              kind: draft.kind,
            },
          },
          undo: { kind: "draft", draftId: draft.id },
        };
      },
    };
  },
};

/* ------------------------------ create, update, delete ------------------------------ */

type CreateInput = {
  name?: string | undefined;
  fits_when?: string | undefined;
  kind?: "reply" | "starter" | undefined;
  subject?: string | null | undefined;
  body?: string | undefined;
  placeholders?: z.output<typeof placeholder>[] | undefined;
  from_message_ids?: string[] | undefined;
  everywhere?: boolean | undefined;
};

const createTemplate: ToolDefinition<CreateInput> = {
  name: "create_template",
  description:
    "Write a new Template for this account: give name, fits_when, kind, body (and subject for a starter) with its Placeholders, or give from_message_ids (one to five Messages the user sent) to have it written from them, keeping their wording where they agree and a Placeholder where they differ. The card shows the Template and any existing one it duplicates. everywhere saves a copy in every account. Reversible: undo deletes it.",
  tier: "reversible",
  input: z.object({
    ...fields,
    from_message_ids: z.array(z.string().min(1)).min(1).max(5).optional(),
    everywhere: z.boolean().optional(),
  }),
  summarize: (i) =>
    i.name ?? (i.from_message_ids ? `from ${i.from_message_ids.length} messages` : "template"),
  async run(input, ctx) {
    const seam = seamOf(ctx);
    if (!seam) return refused("Templates are not available from this host.");
    let template: TemplateInput;
    let duplicate: DuplicateVerdict | null;
    if (input.from_message_ids) {
      try {
        const drafted = await seam.draftFromExamples(ctx.host.workspaceId, {
          messageIds: input.from_message_ids,
        });
        template = drafted.template;
        duplicate = drafted.duplicate;
      } catch (error) {
        return refused(
          `The Template could not be written: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      if (!input.name || !input.body)
        return refused("A Template needs a name and a body, or from_message_ids.");
      const kind = input.kind ?? "reply";
      const subject = kind === "starter" ? (input.subject ?? null) : null;
      template = tidyTemplate({
        name: input.name,
        fitsWhen: input.fits_when ?? "",
        kind,
        subject,
        body: input.body,
        placeholders: declared(input.body, subject, input.placeholders),
      });
      const errors = templateErrors(template);
      if (errors.length) return refused(`The Template does not save: ${errors.join(" ")}`);
      duplicate = await seam.duplicateOf(ctx.host.workspaceId, template);
    }
    const scope: TemplateScope | undefined = input.everywhere ? "everywhere" : undefined;
    return {
      kind: "action",
      preview: card({
        action: "create",
        template,
        templateId: null,
        previous: null,
        duplicate,
        scope,
      }),
      count: 1,
      apply: async () => {
        const made = await seam.store.create(ctx.host.workspaceId, template, {
          ...(scope ? { scope } : {}),
          createdBy: "agent",
        });
        const first = made[0];
        return {
          text: `Template ${first?.id} saved: ${template.name}${made.length > 1 ? ` in ${made.length} accounts` : ""}.${
            duplicate
              ? ` Note: ${duplicate.level === "same" ? "the user already has" : "it is similar to"} ${duplicate.name}.`
              : ""
          }`,
          data: { templateIds: made.map((t) => t.id), duplicate },
          undo: { kind: "template", action: "create", ids: made.map((t) => t.id), previous: null },
        };
      },
    };
  },
};

const updateTemplate: ToolDefinition<
  Omit<CreateInput, "from_message_ids"> & { template_id: string }
> = {
  name: "update_template",
  description:
    "Change a Template: any of name, fits_when, kind, subject, body, placeholders. A built-in is changed by saving an edited copy for this account. For a Template used in every account, everywhere: true changes every copy, otherwise only this one. Reversible: undo puts the previous words back.",
  tier: "reversible",
  input: z.object({
    template_id: z.string().min(1),
    ...fields,
    everywhere: z.boolean().optional(),
  }),
  summarize: (i) => i.template_id,
  async run(input, ctx) {
    const seam = seamOf(ctx);
    if (!seam) return refused("Templates are not available from this host.");
    const current = await seam.store.get(input.template_id);
    if (!current)
      return refused(`Template ${input.template_id} not found; list_templates names them.`);
    const kind = input.kind ?? current.kind;
    const subject =
      kind === "starter" ? (input.subject !== undefined ? input.subject : current.subject) : null;
    const body = input.body ?? current.body;
    const next = tidyTemplate({
      name: input.name ?? current.name,
      fitsWhen: input.fits_when ?? current.fitsWhen,
      kind,
      subject,
      body,
      placeholders: declared(body, subject, input.placeholders ?? current.placeholders),
    });
    const errors = templateErrors(next);
    if (errors.length) return refused(`The Template does not save: ${errors.join(" ")}`);
    const builtin = current.workspaceId === null;
    return {
      kind: "action",
      preview: card({
        action: "update",
        template: next,
        templateId: current.id,
        previous: inputOf(current),
        duplicate: null,
      }),
      count: 1,
      apply: async () => {
        const written = await seam.store.update(current.id, next, {
          everywhere: input.everywhere ?? false,
          workspaceId: ctx.host.workspaceId,
        });
        const ids = written.map((t) => t.id);
        return {
          text: builtin
            ? `Saved an edited copy of ${current.name} (${ids[0]}); it replaces the built-in here.`
            : `Template ${current.name} changed${ids.length > 1 ? ` in ${ids.length} accounts` : ""}.`,
          data: { templateIds: ids },
          // An edited built-in is a new copy: Undo deletes it, which restores the original.
          undo: builtin
            ? { kind: "template", action: "create", ids, previous: null }
            : { kind: "template", action: "update", ids, previous: inputOf(current) },
        };
      },
    };
  },
};

const deleteTemplate: ToolDefinition<{ template_id: string; everywhere?: boolean | undefined }> = {
  name: "delete_template",
  description:
    "Delete one of the account's Templates (a built-in cannot be deleted; hide it with the setting templates.builtin.hidden). everywhere deletes every copy. A Draft that used it keeps its text. Reversible: undo puts it back.",
  tier: "reversible",
  input: z.object({ template_id: z.string().min(1), everywhere: z.boolean().optional() }),
  summarize: (i) => i.template_id,
  async run(input, ctx) {
    const seam = seamOf(ctx);
    if (!seam) return refused("Templates are not available from this host.");
    const current = await seam.store.get(input.template_id);
    if (!current)
      return refused(`Template ${input.template_id} not found; list_templates names them.`);
    if (current.workspaceId === null) {
      return refused(`${current.name} is built in; hide it with templates.builtin.hidden instead.`);
    }
    return {
      kind: "action",
      preview: card({
        action: "delete",
        template: inputOf(current),
        templateId: current.id,
        previous: null,
        duplicate: null,
      }),
      count: 1,
      apply: async () => {
        const removed = await seam.store.remove(current.id, {
          everywhere: input.everywhere ?? false,
        });
        return {
          text: `Template ${current.name} deleted.`,
          data: { templateIds: removed.map((t) => t.id) },
          undo: {
            kind: "template",
            action: "delete",
            ids: removed.map((t) => t.id),
            previous: null,
          },
        };
      },
    };
  },
};

export const TEMPLATE_TOOLS: readonly ToolDefinition<never>[] = [
  listTemplates,
  useTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
] as unknown as readonly ToolDefinition<never>[];

/** Replays a Template undo record through the seam; the wording is what the card and the model read. */
export async function undoTemplate(
  seam: TemplatesSeam | undefined,
  undo: { action: "create" | "update" | "delete"; ids: string[]; previous: TemplateInput | null },
): Promise<string> {
  if (!seam) return "Cannot undo: Templates are not available from this host.";
  if (undo.action === "create") {
    for (const id of undo.ids) {
      if (await seam.store.get(id)) await seam.store.remove(id);
    }
    return "Undone: the Template was deleted.";
  }
  if (undo.action === "delete") {
    await seam.store.restore(undo.ids);
    return "Undone: the Template is back.";
  }
  if (!undo.previous) return "Nothing to undo.";
  for (const id of undo.ids) await seam.store.update(id, undo.previous, { everywhere: false });
  return "Undone: the Template has its previous words.";
}
