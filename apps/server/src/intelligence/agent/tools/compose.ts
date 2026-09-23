// The compose tools (docs/spec/agent-composer.md; ADR 0002): the Agent reads,
// edits and opens Drafts. list_drafts and read_draft are read-only;
// update_draft is reversible (Undo puts the previous content back); open_draft
// asks the Device following this Session to open the composer on a Draft,
// through the tool card's `open` field that the agent panel already receives.
// Sending stays send_draft, which always asks. Without a draft_id, read_draft,
// update_draft and open_draft act on the Draft open in the composer, which the
// Device names in the turn context.

import type { Draft, DraftContent, Person, ToolPreview } from "@monday/shared";
import { z } from "zod";
import type { ToolContext, ToolDefinition, ToolPlan } from "./catalog.ts";

const person = z.union([
  z.string().describe("An address, or Name <address>"),
  z.object({ name: z.string().default(""), email: z.string() }),
]);

function toPerson(value: string | { name: string; email: string }): Person {
  if (typeof value !== "string") return value;
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value);
  return m ? { name: m[1] ?? "", email: m[2] ?? "" } : { name: "", email: value.trim() };
}

const personLine = (p: Person) => (p.name ? `${p.name} <${p.email}>` : p.email);
const people = (list: readonly Person[]) => list.map(personLine).join(", ") || "nobody";

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Plain text to the editor's paragraphs. */
function paragraphsHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .filter((p) => p.trim() !== "")
    .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** The quoted history a reply carries, which a new body keeps. */
function quotedPart(html: string): string {
  const at = html.indexOf('<div class="quoted"');
  return at >= 0 ? html.slice(at) : "";
}

function quotedText(html: string): string {
  return html
    .replace(/<\/(p|div|blockquote)>/g, "\n\n")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function contentOf(d: Draft): DraftContent {
  return {
    threadId: d.threadId,
    kind: d.kind,
    inReplyToMessageId: d.inReplyToMessageId,
    to: d.to,
    cc: d.cc,
    bcc: d.bcc,
    subject: d.subject,
    bodyText: d.bodyText,
    bodyHtml: d.bodyHtml,
    attachments: d.attachments,
  };
}

const openOf = (d: Draft) => ({
  action: "open_draft",
  draftId: d.id,
  threadId: d.threadId,
  kind: d.kind,
});

/** The Draft a call names, or the one open in the composer. */
async function target(
  ctx: ToolContext,
  draftId: string | undefined,
): Promise<Draft | { refused: string }> {
  const id = draftId ?? ctx.openDraftId ?? null;
  if (!id) {
    return {
      refused:
        "No draft_id given and no Draft is open in the composer. Use list_drafts to find one.",
    };
  }
  const draft = await ctx.host.readDraft(id);
  if (!draft) return { refused: `Draft ${id} not found.` };
  return draft;
}

function describe(d: Draft): string {
  return [
    `Draft ${d.id} (${d.kind}${d.threadId ? ` on Thread ${d.threadId}` : ""}, ${d.status}, last saved by ${d.updatedBy})`,
    `To: ${people(d.to)}`,
    ...(d.cc.length ? [`Cc: ${people(d.cc)}`] : []),
    ...(d.bcc.length ? [`Bcc: ${people(d.bcc)}`] : []),
    `Subject: ${d.subject || "(no subject)"}`,
    ...(d.attachments.length
      ? [`Attachments: ${d.attachments.map((a) => a.name).join(", ")}`]
      : []),
    "",
    d.bodyText,
  ].join("\n");
}

const listDrafts: ToolDefinition<{ thread_id?: string | undefined; limit: number }> = {
  name: "list_drafts",
  description:
    "List the open Drafts, newest first: new messages, replies and forwards, the user's and your own. Read-only.",
  tier: "read",
  input: z.object({
    thread_id: z.string().optional().describe("Only the Drafts on this Thread"),
    limit: z.int().min(1).max(50).default(20),
  }),
  summarize: (i) => (i.thread_id ? `on ${i.thread_id}` : "all"),
  async run(input, ctx): Promise<ToolPlan> {
    if (!ctx.host.listDrafts) {
      return { kind: "refused", text: "Drafts cannot be listed from this host." };
    }
    const all = (await ctx.host.listDrafts()).filter(
      (d) => !input.thread_id || d.threadId === input.thread_id,
    );
    const shown = all.slice(0, input.limit);
    const lines = shown.map(
      (d) =>
        `${d.id}: ${d.kind}, "${d.subject || "(no subject)"}" to ${people(d.to)}, saved ${d.updatedAt} by ${d.updatedBy}${d.id === ctx.openDraftId ? " (open in the composer)" : ""}`,
    );
    return {
      kind: "result",
      text: shown.length
        ? `${all.length} open Draft${all.length === 1 ? "" : "s"}:\n${lines.join("\n")}`
        : "No open Drafts.",
      data: {
        drafts: shown.map((d) => ({
          id: d.id,
          kind: d.kind,
          threadId: d.threadId,
          subject: d.subject,
          to: d.to,
          updatedAt: d.updatedAt,
          updatedBy: d.updatedBy,
        })),
        open: ctx.openDraftId ?? null,
      },
    };
  },
};

const readDraft: ToolDefinition<{ draft_id?: string | undefined }> = {
  name: "read_draft",
  description:
    "Read a Draft: recipients, subject, attachments and the body as text. Without draft_id, the Draft open in the composer. Read-only.",
  tier: "read",
  input: z.object({ draft_id: z.string().min(1).optional() }),
  summarize: (i) => i.draft_id ?? "the open Draft",
  async run(input, ctx): Promise<ToolPlan> {
    const d = await target(ctx, input.draft_id);
    if ("refused" in d) return { kind: "refused", text: d.refused };
    return {
      kind: "result",
      text: describe(d),
      data: {
        draftId: d.id,
        kind: d.kind,
        threadId: d.threadId,
        subject: d.subject,
        to: d.to,
        cc: d.cc,
        bcc: d.bcc,
        bodyText: d.bodyText,
        attachments: d.attachments.map((a) => ({ blobId: a.blobId, name: a.name })),
        status: d.status,
        updatedBy: d.updatedBy,
      },
    };
  },
};

interface UpdateInput {
  draft_id?: string | undefined;
  subject?: string | undefined;
  body?: string | undefined;
  to?: Array<string | { name: string; email: string }> | undefined;
  cc?: Array<string | { name: string; email: string }> | undefined;
  bcc?: Array<string | { name: string; email: string }> | undefined;
  remove_attachments?: string[] | undefined;
}

const updateDraft: ToolDefinition<UpdateInput> = {
  name: "update_draft",
  description:
    "Change a Draft: subject, body (plain text, replacing the user's own words; a reply keeps its quoted history), recipients, or remove attachments by name. Without draft_id, the Draft open in the composer. Nothing is sent. Reversible: undo puts the previous content back.",
  tier: "reversible",
  input: z.object({
    draft_id: z.string().min(1).optional(),
    subject: z.string().max(2000).optional(),
    body: z.string().max(100_000).optional().describe("The whole new body, plain text"),
    to: z.array(person).optional().describe("Replaces To"),
    cc: z.array(person).optional().describe("Replaces Cc"),
    bcc: z.array(person).optional().describe("Replaces Bcc"),
    remove_attachments: z.array(z.string().min(1)).optional().describe("Names or blob ids"),
  }),
  summarize: (i) =>
    [
      i.draft_id ?? "the open Draft",
      ...(["subject", "body", "to", "cc", "bcc", "remove_attachments"] as const).filter(
        (k) => i[k] !== undefined,
      ),
    ].join(": "),
  async run(input, ctx): Promise<ToolPlan> {
    const updateDraftOn = ctx.host.updateDraft?.bind(ctx.host);
    if (!updateDraftOn) return { kind: "refused", text: "Drafts cannot be edited from this host." };
    const d = await target(ctx, input.draft_id);
    if ("refused" in d) return { kind: "refused", text: d.refused };
    if (d.status !== "open") {
      return { kind: "refused", text: `Draft ${d.id} is ${d.status}; only an open Draft changes.` };
    }
    const previous = contentOf(d);
    const next: DraftContent = { ...previous };
    const changed: string[] = [];
    if (input.subject !== undefined) {
      next.subject = input.subject;
      changed.push("subject");
    }
    if (input.body !== undefined) {
      const quote = quotedPart(d.bodyHtml);
      next.bodyHtml = `${paragraphsHtml(input.body)}${quote}`;
      next.bodyText = quote ? `${input.body.trim()}\n\n${quotedText(quote)}` : input.body.trim();
      changed.push("body");
    }
    for (const field of ["to", "cc", "bcc"] as const) {
      const list = input[field];
      if (list !== undefined) {
        next[field] = list.map(toPerson);
        changed.push(field);
      }
    }
    if (input.remove_attachments?.length) {
      const drop = new Set(input.remove_attachments);
      next.attachments = previous.attachments.filter(
        (a) => !drop.has(a.name) && !drop.has(a.blobId),
      );
      if (next.attachments.length !== previous.attachments.length) changed.push("attachments");
    }
    if (changed.length === 0) return { kind: "refused", text: "Nothing to change was given." };
    const preview: ToolPreview = {
      kind: "text",
      text: [
        `Change Draft "${next.subject || "(no subject)"}" (${changed.join(", ")})`,
        ...(changed.some((c) => ["to", "cc", "bcc"].includes(c))
          ? [`To: ${people(next.to)}${next.cc.length ? `; Cc: ${people(next.cc)}` : ""}`]
          : []),
        ...(input.body !== undefined ? ["", input.body.trim()] : []),
      ].join("\n"),
    };
    return {
      kind: "action",
      preview,
      count: 1,
      apply: async () => {
        const saved = await updateDraftOn(d.id, next);
        return {
          text: `Draft ${saved.id} updated (${changed.join(", ")}). The open composer shows the change.`,
          data: {
            draftId: saved.id,
            kind: saved.kind,
            threadId: saved.threadId,
            subject: saved.subject,
            to: saved.to,
            changed,
            open: openOf(saved),
          },
          undo: { kind: "draft_content", draftId: d.id, previous },
        };
      },
    };
  },
};

const openDraft: ToolDefinition<{ draft_id?: string | undefined }> = {
  name: "open_draft",
  description:
    "Open a Draft in the user's composer: a new message in its window, a reply on its Thread. Needs the user's Device to be following this conversation; says so when it is not. Read-only: nothing changes.",
  tier: "read",
  input: z.object({ draft_id: z.string().min(1).optional() }),
  summarize: (i) => i.draft_id ?? "the open Draft",
  async run(input, ctx): Promise<ToolPlan> {
    const d = await target(ctx, input.draft_id);
    if ("refused" in d) return { kind: "refused", text: d.refused };
    if (!(ctx.deviceListening?.() ?? false)) {
      return {
        kind: "result",
        text: `No Device is following this conversation, so nothing opened. Draft ${d.id} is in Drafts${d.threadId ? " and on its Thread" : ""}.`,
        data: { draftId: d.id, opened: false },
      };
    }
    return {
      kind: "result",
      text: `Asked the composer to open Draft ${d.id} ("${d.subject || "(no subject)"}")${d.kind === "new" ? "" : " on its Thread"}.`,
      data: { draftId: d.id, opened: true, open: openOf(d) },
    };
  },
};

export const COMPOSE_TOOLS: readonly ToolDefinition<never>[] = [
  listDrafts,
  readDraft,
  updateDraft,
  openDraft,
] as unknown as readonly ToolDefinition<never>[];
