// The tool catalog (ADR 0002): every tool the Agent can reach, each with its
// tier, its input schema and a two-phase body. A read tool answers at once.
// Anything else plans first (the preview: the Threads it would touch, the
// message it would send, the Setting it would change) and hands back an
// apply, so the tool server can ask before running it and record what Undo
// replays. Tools see only the ToolHost seam; nothing here knows Postgres or
// the Store.

import type {
  DraftContent,
  IntentArgs,
  Person,
  PreviewThread,
  ThreadSummary,
  ToolHost,
  ToolPreview,
  ToolTier,
  UndoRecord,
} from "@monday/shared";
import { isSettingKey, PREVIEW_LIST_MAX, settingsSchema, validateSetting } from "@monday/shared";
import { z } from "zod";
import { EXTENSION_TOOLS, type ToolExtensions } from "./extensions.ts";
import { ONBOARDING_TOOLS } from "./onboarding.ts";

export interface ToolSettings {
  /** A reversible batch above this many Threads previews first. */
  previewAbove: number;
  /** Tools promoted to always-ask. */
  alwaysAsk: readonly string[];
  /** The most Threads one search returns. */
  searchLimit: number;
}

export interface ToolContext {
  host: ToolHost;
  /** Setting keys the calling Device's Config file pins. */
  pinned: ReadonlySet<string>;
  settings: ToolSettings;
  now: () => Date;
  /** The latest undoable call, for the undo tool; the tool server supplies it. */
  latestUndoable(): Promise<{ id: string; tool: string; undo: UndoRecord | null } | null>;
  undoActivity(id: string): Promise<{ text: string }>;
  /** The integrations, MCP servers and Workflows seams, when this host has them (slice 16). */
  extensions?: ToolExtensions | undefined;
}

export interface Applied {
  text: string;
  data: unknown;
  undo: UndoRecord | null;
}

export type ToolPlan =
  | { kind: "result"; text: string; data: unknown }
  | { kind: "refused"; text: string }
  | {
      kind: "action";
      preview: ToolPreview;
      /** How many things it touches, for the preview threshold. */
      count: number;
      apply(): Promise<Applied>;
    };

export interface ToolDefinition<I = unknown> {
  name: string;
  description: string;
  tier: ToolTier;
  input: z.ZodType<I>;
  /** The one-line input summary the card shows. */
  summarize(input: I): string;
  run(input: I, ctx: ToolContext): Promise<ToolPlan>;
}

const ids = z.array(z.string().min(1)).min(1).max(2000).describe("Thread ids");
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

export function previewThread(t: ThreadSummary): PreviewThread {
  return { id: t.id, subject: t.subject, from: t.from, lastActivity: t.lastActivity };
}

export function threadsPreview(action: string, threads: readonly ThreadSummary[]): ToolPreview {
  return {
    kind: "threads",
    action,
    count: threads.length,
    threads: threads.slice(0, PREVIEW_LIST_MAX).map(previewThread),
  };
}

const compact = (t: ThreadSummary) => ({
  id: t.id,
  subject: t.subject,
  from: t.from,
  lastActivity: t.lastActivity,
  unread: t.unread,
  archived: t.archived,
  snoozedUntil: t.snoozedUntil,
  section: t.section,
  group: t.group,
});

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function textToHtml(text: string): string {
  return `<div>${escapeHtml(text).split(/\r?\n/).join("<br>")}</div>`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * A batch write over Threads: the preview lists what it touches, apply
 * sends one intent per Thread and remembers the inverse for Undo.
 */
async function threadBatch(
  ctx: ToolContext,
  threadIds: readonly string[],
  action: string,
  make: (t: ThreadSummary) => { intent: IntentArgs; reverse: IntentArgs } | null,
): Promise<ToolPlan> {
  const found = await ctx.host.threadsById(threadIds);
  const pairs = found.flatMap((t) => {
    const made = make(t);
    return made ? [{ thread: t, ...made }] : [];
  });
  const missing = threadIds.length - found.length;
  if (pairs.length === 0) {
    return {
      kind: "result",
      text: `Nothing to ${action}: ${missing > 0 ? `${plural(missing, "id")} not found` : "every Thread is already in that state"}.`,
      data: { applied: 0, missing },
    };
  }
  return {
    kind: "action",
    preview: threadsPreview(
      action,
      pairs.map((p) => p.thread),
    ),
    count: pairs.length,
    apply: async () => {
      const { applied } = await ctx.host.applyIntents(
        pairs.map((p) => ({ ...p.intent, threadId: p.thread.id })),
      );
      const note = missing > 0 ? ` (${plural(missing, "id")} not found)` : "";
      return {
        text: `${action}: ${plural(applied, "thread")}${note}.`,
        data: { applied, missing, threadIds: pairs.map((p) => p.thread.id) },
        undo: {
          kind: "intents",
          intents: pairs.map((p) => ({ ...p.reverse, threadId: p.thread.id })),
        },
      };
    },
  };
}

/* ------------------------------ Read tools ------------------------------ */

const searchThreads: ToolDefinition<{
  query?: string | undefined;
  section?: string | undefined;
  group?: string | undefined;
  older_than_days?: number | undefined;
  before?: string | undefined;
  unread?: boolean | undefined;
  include_archived?: boolean | undefined;
  limit?: number | undefined;
}> = {
  name: "search_threads",
  description:
    "Find Threads in the current Workspace. Filters combine: free text over subject and participants, a Section (needs-reply, waiting, fyi, newsletters), a Group, only Threads older than N days, unread only. Returns ids to act on with the other tools.",
  tier: "read",
  input: z.object({
    query: z.string().max(500).optional().describe("Words from the subject or a participant"),
    section: z.string().optional().describe("A Section id such as newsletters"),
    group: z.string().optional().describe("A Group id"),
    older_than_days: z
      .int()
      .min(0)
      .optional()
      .describe("Only Threads with no activity for this many days"),
    before: z.iso
      .datetime({ offset: true })
      .optional()
      .describe("Only Threads last active before this moment"),
    unread: z.boolean().optional(),
    include_archived: z.boolean().optional().describe("Include archived Threads; off by default"),
    limit: z.int().min(1).max(500).optional(),
  }),
  summarize: (i) =>
    [
      i.query ? `"${i.query}"` : null,
      i.section ? `section:${i.section}` : null,
      i.group ? `group:${i.group}` : null,
      i.older_than_days !== undefined ? `older than ${plural(i.older_than_days, "day")}` : null,
      i.before ? `before ${i.before}` : null,
      i.unread ? "unread" : null,
    ]
      .filter(Boolean)
      .join(" · ") || "everything",
  async run(input, ctx) {
    let olderThan = input.before;
    if (input.older_than_days !== undefined) {
      const cutoff = new Date(ctx.now().getTime() - input.older_than_days * 86_400_000);
      olderThan = olderThan && olderThan < cutoff.toISOString() ? olderThan : cutoff.toISOString();
    }
    const threads = await ctx.host.listThreads({
      query: input.query,
      section: input.section,
      group: input.group,
      olderThan,
      unread: input.unread,
      includeArchived: input.include_archived,
      limit: Math.min(input.limit ?? ctx.settings.searchLimit, ctx.settings.searchLimit),
    });
    const rows = threads.map(compact);
    return {
      kind: "result",
      text: `${plural(rows.length, "thread")}${rows.length ? `:\n${JSON.stringify(rows)}` : "."}`,
      data: { threads: rows },
    };
  },
};

const readThread: ToolDefinition<{ thread_id: string }> = {
  name: "read_thread",
  description: "Read one Thread: its subject and every Message with sender, date and text.",
  tier: "read",
  input: z.object({ thread_id: z.string().min(1) }),
  summarize: (i) => i.thread_id,
  async run(input, ctx) {
    const thread = await ctx.host.readThread(input.thread_id);
    if (!thread) return { kind: "result", text: "No such Thread.", data: null };
    const text = [
      `Subject: ${thread.subject}`,
      ...thread.messages.map(
        (m) =>
          `--- ${m.id}\nFrom: ${personLine(m.from)}\nTo: ${m.to.map(personLine).join(", ")}\nDate: ${m.date}\n\n${m.text ?? "[text not available]"}`,
      ),
    ].join("\n\n");
    return { kind: "result", text, data: thread };
  },
};

const listGroupsAndSections: ToolDefinition<Record<string, never>> = {
  name: "list_groups_and_sections",
  description: "The Sections of the stream and the Groups of this Workspace, with their ids.",
  tier: "read",
  input: z.object({}),
  summarize: () => "",
  async run(_input, ctx) {
    const [sections, groups] = await Promise.all([ctx.host.listSections(), ctx.host.listGroups()]);
    return {
      kind: "result",
      text: JSON.stringify({ sections, groups }),
      data: { sections, groups },
    };
  },
};

/* ------------------------------ Reversible tools ------------------------------ */

const archiveThreads: ToolDefinition<{ thread_ids: string[] }> = {
  name: "archive_threads",
  description: "Archive Threads: out of the Inbox, kept and searchable. Reversible.",
  tier: "reversible",
  input: z.object({ thread_ids: ids }),
  summarize: (i) => plural(i.thread_ids.length, "thread"),
  run: (input, ctx) =>
    threadBatch(ctx, input.thread_ids, "Archive", (t) =>
      t.archived ? null : { intent: { kind: "archive" }, reverse: { kind: "unarchive" } },
    ),
};

const snoozeThreads: ToolDefinition<{ thread_ids: string[]; until: string }> = {
  name: "snooze_threads",
  description: "Snooze Threads until a moment; they leave the Inbox and return then. Reversible.",
  tier: "reversible",
  input: z.object({ thread_ids: ids, until: z.iso.datetime({ offset: true }) }),
  summarize: (i) => `${plural(i.thread_ids.length, "thread")} until ${i.until}`,
  run: (input, ctx) =>
    threadBatch(ctx, input.thread_ids, "Snooze", (t) => ({
      intent: { kind: "snooze", until: input.until },
      reverse: t.snoozedUntil ? { kind: "snooze", until: t.snoozedUntil } : { kind: "unsnooze" },
    })),
};

const tagThreads: ToolDefinition<{
  thread_ids: string[];
  add?: string[] | undefined;
  remove?: string[] | undefined;
}> = {
  name: "tag_threads",
  description:
    "Add or remove monday Tags on Threads by name; a Tag that does not exist is created. Tags stay in monday and never reach the Provider. Reversible.",
  tier: "reversible",
  input: z.object({
    thread_ids: ids,
    add: z.array(z.string().min(1)).optional(),
    remove: z.array(z.string().min(1)).optional(),
  }),
  summarize: (i) =>
    `${[
      i.add?.length ? `+${i.add.join(", ")}` : null,
      i.remove?.length ? `-${i.remove.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join(" ")} on ${plural(i.thread_ids.length, "thread")}`,
  async run(input, ctx) {
    const addIds = await ctx.host.tagIds(input.add ?? []);
    const removeIds = new Set(await ctx.host.tagIds(input.remove ?? []));
    return threadBatch(ctx, input.thread_ids, "Tag", (t) => {
      const next = [...new Set([...t.tags.filter((id) => !removeIds.has(id)), ...addIds])];
      const same = next.length === t.tags.length && next.every((id) => t.tags.includes(id));
      return same
        ? null
        : { intent: { kind: "tags", tags: next }, reverse: { kind: "tags", tags: [...t.tags] } };
    });
  },
};

const moveThreads: ToolDefinition<{ thread_ids: string[]; group: string | null }> = {
  name: "move_threads",
  description:
    "Move Threads into a Group, or out of every Group with null. A Group is a lens on the Inbox, not a folder. Reversible.",
  tier: "reversible",
  input: z.object({ thread_ids: ids, group: z.string().min(1).nullable() }),
  summarize: (i) => `${plural(i.thread_ids.length, "thread")} to ${i.group ?? "no group"}`,
  run: (input, ctx) =>
    threadBatch(ctx, input.thread_ids, "Move", (t) =>
      t.group === input.group && input.group !== null
        ? null
        : {
            intent: { kind: "move", group: input.group, subgroup: null },
            reverse: { kind: "move", group: t.group, subgroup: t.subgroup },
          },
    ),
};

const draftMessage: ToolDefinition<{
  kind: "new" | "reply" | "forward";
  thread_id?: string | undefined;
  to?: Array<string | { name: string; email: string }> | undefined;
  cc?: Array<string | { name: string; email: string }> | undefined;
  subject?: string | undefined;
  body: string;
}> = {
  name: "draft_message",
  description:
    "Write a Draft: a new message, a reply to a Thread, or a forward of one. Creates the Draft only; nothing is sent until send_draft asks the user. Reversible: undo deletes the Draft.",
  tier: "reversible",
  input: z.object({
    kind: z.enum(["new", "reply", "forward"]),
    thread_id: z.string().optional().describe("The Thread a reply or forward belongs to"),
    to: z.array(person).optional().describe("Recipients; a reply defaults to the last sender"),
    cc: z.array(person).optional(),
    subject: z.string().optional().describe("Defaults to the Thread subject with Re: or Fwd:"),
    body: z.string().min(1).describe("Plain text"),
  }),
  summarize: (i) => `${i.kind}${i.subject ? `: ${i.subject}` : ""}`,
  async run(input, ctx) {
    const content = await draftContent(ctx, input);
    if ("refused" in content) return { kind: "refused", text: content.refused };
    return {
      kind: "action",
      preview: {
        kind: "send",
        to: content.to,
        cc: content.cc,
        subject: content.subject,
        text: content.bodyText,
      },
      count: 1,
      apply: async () => {
        const draft = await ctx.host.createDraft(content);
        return {
          text: `Draft ${draft.id} saved: "${draft.subject}" to ${draft.to.map(personLine).join(", ") || "nobody yet"}.`,
          data: { draftId: draft.id, subject: draft.subject, to: draft.to },
          undo: { kind: "draft", draftId: draft.id },
        };
      },
    };
  },
};

async function draftContent(
  ctx: ToolContext,
  input: z.output<typeof draftMessage.input>,
): Promise<DraftContent | { refused: string }> {
  const to = (input.to ?? []).map(toPerson);
  const cc = (input.cc ?? []).map(toPerson);
  if (input.kind === "new") {
    return {
      threadId: null,
      kind: "new",
      inReplyToMessageId: null,
      to,
      cc,
      bcc: [],
      subject: input.subject ?? "",
      bodyText: input.body,
      bodyHtml: textToHtml(input.body),
      attachments: [],
    };
  }
  if (!input.thread_id) return { refused: `A ${input.kind} needs a thread_id.` };
  const thread = await ctx.host.readThread(input.thread_id);
  if (!thread) return { refused: `Thread ${input.thread_id} not found.` };
  const last = thread.messages.at(-1);
  const prefix = input.kind === "reply" ? "Re: " : "Fwd: ";
  const subject =
    input.subject ??
    (thread.subject.toLowerCase().startsWith(prefix.toLowerCase())
      ? thread.subject
      : `${prefix}${thread.subject}`);
  if (input.kind === "reply") {
    return {
      threadId: thread.id,
      kind: "reply",
      inReplyToMessageId: last?.id ?? null,
      to: to.length > 0 ? to : last ? [last.from] : [],
      cc,
      bcc: [],
      subject,
      bodyText: input.body,
      bodyHtml: textToHtml(input.body),
      attachments: [],
    };
  }
  const quoted = thread.messages
    .map((m) => `From: ${personLine(m.from)}\nDate: ${m.date}\n\n${m.text ?? ""}`)
    .join("\n\n");
  const bodyText = `${input.body}\n\n---------- Forwarded message ----------\n${quoted}`;
  return {
    threadId: thread.id,
    kind: "forward",
    inReplyToMessageId: last?.id ?? null,
    to,
    cc,
    bcc: [],
    subject,
    bodyText,
    bodyHtml: textToHtml(bodyText),
    attachments: [],
  };
}

const changeSetting: ToolDefinition<{ key: string; value: unknown }> = {
  name: "change_setting",
  description:
    "Change any Setting by its dotted key (appearance.palette, appearance.font_size, layout.list, sections.order, routing.threshold.route, inbox.batch_preview_above, agent.preview_above and every other key in the schema). The value must fit the schema. A key the user's monday.toml pins cannot be changed here. Reversible.",
  tier: "reversible",
  input: z.object({ key: z.string().min(1), value: z.unknown() }),
  summarize: (i) => `${i.key} = ${JSON.stringify(i.value)}`,
  run: (input, ctx) => settingsPlan(ctx, [input]),
};

const changeLayout: ToolDefinition<{
  nav?: "full" | "rail" | "hidden" | undefined;
  agent?: "bottom" | "left" | "right" | undefined;
  list?: "stream" | "split" | undefined;
}> = {
  name: "change_layout",
  description:
    "Change the Layout knobs: nav (full, rail, hidden), agent (bottom, left, right), list (stream, split). Sugar over change_setting for the layout.* keys. Reversible.",
  tier: "reversible",
  input: z.object({
    nav: z.enum(["full", "rail", "hidden"]).optional(),
    agent: z.enum(["bottom", "left", "right"]).optional(),
    list: z.enum(["stream", "split"]).optional(),
  }),
  summarize: (i) =>
    Object.entries(i)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${v}`)
      .join(" · "),
  run: (input, ctx) =>
    settingsPlan(
      ctx,
      Object.entries(input)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => ({ key: `layout.${k}`, value: v })),
    ),
};

async function settingsPlan(
  ctx: ToolContext,
  changes: Array<{ key: string; value: unknown }>,
): Promise<ToolPlan> {
  if (changes.length === 0) return { kind: "refused", text: "Nothing to change." };
  const checked: Array<{ key: string; value: unknown; previous: unknown }> = [];
  for (const change of changes) {
    if (!isSettingKey(change.key)) {
      return { kind: "refused", text: `Unknown setting "${change.key}".` };
    }
    const valid = validateSetting(change.key, change.value);
    if (!valid.ok) return { kind: "refused", text: `${change.key}: ${valid.error}` };
    const current = await ctx.host.readSetting(change.key);
    if (ctx.pinned.has(change.key) || current.pinned) {
      return {
        kind: "refused",
        text: `${change.key} is set in monday.toml; the file wins. Offer to edit the file only if the user says yes.`,
      };
    }
    checked.push({ key: change.key, value: valid.value, previous: current.value });
  }
  const first = checked[0];
  if (!first) return { kind: "refused", text: "Nothing to change." };
  const preview: ToolPreview =
    checked.length === 1
      ? { kind: "setting", key: first.key, from: first.previous, to: first.value }
      : {
          kind: "text",
          text: checked
            .map((c) => `${c.key}: ${JSON.stringify(c.previous)} to ${JSON.stringify(c.value)}`)
            .join("\n"),
        };
  return {
    kind: "action",
    preview,
    count: checked.length,
    apply: async () => {
      for (const c of checked) await ctx.host.writeSetting(c.key, c.value);
      return {
        text: checked
          .map(
            (c) =>
              `${settingsSchema[c.key as keyof typeof settingsSchema].label}: ${JSON.stringify(c.value)}`,
          )
          .join("; "),
        data: { changed: checked.map((c) => ({ key: c.key, value: c.value })) },
        undo: {
          kind: "settings",
          entries: checked.map((c) => ({ key: c.key, previous: c.previous })),
        },
      };
    },
  };
}

/* ------------------------------ Tools that ask first ------------------------------ */

const trashThreads: ToolDefinition<{ thread_ids: string[] }> = {
  name: "trash_threads",
  description:
    "Move Threads to the trash. Asks the user first; undo brings them back while they are still in the trash.",
  tier: "destructive",
  input: z.object({ thread_ids: ids }),
  summarize: (i) => plural(i.thread_ids.length, "thread"),
  run: (input, ctx) =>
    threadBatch(ctx, input.thread_ids, "Trash", () => ({
      intent: { kind: "delete" },
      reverse: { kind: "undelete" },
    })),
};

const sendDraft: ToolDefinition<{ draft_id: string }> = {
  name: "send_draft",
  description:
    "Send a Draft. Leaves the mailbox, so it always asks the user first with the recipients and text. Sending is scheduled with an undo window; undo cancels it while the window is open.",
  tier: "leaves_mailbox",
  input: z.object({ draft_id: z.string().min(1) }),
  summarize: (i) => i.draft_id,
  async run(input, ctx) {
    const draft = await ctx.host.readDraft(input.draft_id);
    if (!draft) return { kind: "refused", text: `Draft ${input.draft_id} not found.` };
    if (draft.to.length === 0) return { kind: "refused", text: "The Draft has no recipients." };
    return {
      kind: "action",
      preview: {
        kind: "send",
        to: draft.to,
        cc: draft.cc,
        subject: draft.subject,
        text: draft.bodyText,
      },
      count: 1,
      apply: async () => {
        const send = await ctx.host.scheduleSend(draft.id);
        return {
          text: `Scheduled: "${draft.subject}" to ${draft.to.map(personLine).join(", ")} at ${send.runAt}.`,
          data: { sendId: send.sendId, runAt: send.runAt },
          undo: { kind: "send", sendId: send.sendId },
        };
      },
    };
  },
};

const forwardThread: ToolDefinition<{
  thread_id: string;
  to: Array<string | { name: string; email: string }>;
  note?: string | undefined;
}> = {
  name: "forward_thread",
  description:
    "Forward a Thread to someone with an optional note. Leaves the mailbox, so it always asks the user first with the recipients and text.",
  tier: "leaves_mailbox",
  input: z.object({
    thread_id: z.string().min(1),
    to: z.array(person).min(1),
    note: z.string().optional(),
  }),
  summarize: (i) => `${i.thread_id} to ${i.to.map(toPerson).map(personLine).join(", ")}`,
  async run(input, ctx) {
    const content = await draftContent(ctx, {
      kind: "forward",
      thread_id: input.thread_id,
      to: input.to,
      body: input.note ?? "",
    });
    if ("refused" in content) return { kind: "refused", text: content.refused };
    return {
      kind: "action",
      preview: {
        kind: "send",
        to: content.to,
        cc: content.cc,
        subject: content.subject,
        text: content.bodyText,
      },
      count: 1,
      apply: async () => {
        const draft = await ctx.host.createDraft(content);
        const send = await ctx.host.scheduleSend(draft.id);
        return {
          text: `Forwarded "${draft.subject}" to ${draft.to.map(personLine).join(", ")}; sending at ${send.runAt}.`,
          data: { draftId: draft.id, sendId: send.sendId, runAt: send.runAt },
          undo: { kind: "send", sendId: send.sendId },
        };
      },
    };
  },
};

/* ------------------------------ Undo ------------------------------ */

const undo: ToolDefinition<{ activity_id?: string | undefined }> = {
  name: "undo",
  description:
    "Reverse the last reversible action of this Session, or a specific one by its activity id.",
  tier: "read",
  input: z.object({ activity_id: z.string().optional() }),
  summarize: (i) => i.activity_id ?? "last action",
  async run(input, ctx) {
    let id = input.activity_id;
    if (!id) {
      const latest = await ctx.latestUndoable();
      if (!latest) return { kind: "result", text: "Nothing to undo.", data: null };
      id = latest.id;
    }
    const outcome = await ctx.undoActivity(id);
    return { kind: "result", text: outcome.text, data: { activityId: id } };
  },
};

/* ------------------------------ The catalog ------------------------------ */

export const TOOL_CATALOG: readonly ToolDefinition<never>[] = [
  searchThreads,
  readThread,
  listGroupsAndSections,
  archiveThreads,
  snoozeThreads,
  tagThreads,
  moveThreads,
  draftMessage,
  changeSetting,
  changeLayout,
  trashThreads,
  sendDraft,
  forwardThread,
  undo,
  ...EXTENSION_TOOLS,
  ...ONBOARDING_TOOLS,
] as unknown as readonly ToolDefinition<never>[];

export function findTool(name: string): ToolDefinition<unknown> | undefined {
  return (TOOL_CATALOG as readonly ToolDefinition<unknown>[]).find((t) => t.name === name);
}
