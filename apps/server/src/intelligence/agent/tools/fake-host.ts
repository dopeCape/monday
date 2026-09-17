// The fake at the ToolHost seam: Threads, Drafts, sends and Settings in
// memory, with every intent and setting write recorded, so the tool server
// and the LangGraph loop are tested without Postgres.

import type {
  Actor,
  Draft,
  DraftContent,
  IntentArgs,
  ThreadReading,
  ThreadSummary,
  ToolHost,
} from "@monday/shared";
import { defaultSettings, settingsSchema } from "@monday/shared";

export interface FakeHostThread extends ThreadSummary {
  deleted: boolean;
  messages: ThreadReading["messages"];
}

export interface FakeToolHost extends ToolHost {
  threads: Map<string, FakeHostThread>;
  drafts: Map<string, Draft>;
  sends: Map<string, { draftId: string; runAt: string; cancelled: boolean }>;
  settings: Map<string, unknown>;
  pinned: Set<string>;
  /** Every intent applied, in order, with its actor. */
  intents: Array<IntentArgs & { threadId: string; actor: Actor }>;
  writes: Array<{ key: string; value: unknown }>;
}

export interface FakeThreadInput extends Partial<ThreadSummary> {
  id: string;
  subject: string;
  lastActivity: string;
  text?: string;
}

export function fakeThread(input: FakeThreadInput): FakeHostThread {
  const from = input.from ?? "someone@example.test";
  const email = /<([^>]+)>/.exec(from)?.[1] ?? from;
  return {
    id: input.id,
    subject: input.subject,
    from,
    participants: input.participants ?? [{ name: "", email }],
    lastActivity: input.lastActivity,
    unread: input.unread ?? false,
    archived: input.archived ?? false,
    snoozedUntil: input.snoozedUntil ?? null,
    section: input.section ?? null,
    group: input.group ?? null,
    subgroup: input.subgroup ?? null,
    tags: input.tags ?? [],
    deleted: false,
    messages: [
      {
        id: `${input.id}-m1`,
        from: { name: "", email },
        to: [{ name: "", email: "me@example.test" }],
        date: input.lastActivity,
        text: input.text ?? `Body of ${input.subject}`,
      },
    ],
  };
}

export function createFakeToolHost(
  seed: readonly FakeThreadInput[] = [],
  options: { workspaceId?: string; now?: () => Date } = {},
): FakeToolHost {
  const now = options.now ?? (() => new Date());
  const threads = new Map<string, FakeHostThread>();
  for (const t of seed) threads.set(t.id, fakeThread(t));
  const drafts = new Map<string, Draft>();
  const sends = new Map<string, { draftId: string; runAt: string; cancelled: boolean }>();
  const settings = new Map<string, unknown>();
  const tagNames = new Map<string, string>();
  const intents: FakeToolHost["intents"] = [];
  const writes: FakeToolHost["writes"] = [];
  const pinned = new Set<string>();
  let seq = 0;

  const summary = (t: FakeHostThread): ThreadSummary => {
    const { deleted: _d, messages: _m, ...rest } = t;
    return { ...rest, tags: [...rest.tags] };
  };

  return {
    workspaceId: options.workspaceId ?? "ws-fake",
    threads,
    drafts,
    sends,
    settings,
    pinned,
    intents,
    writes,

    async listThreads(filter) {
      const q = filter.query?.toLowerCase();
      return [...threads.values()]
        .filter((t) => !t.deleted)
        .filter((t) => filter.includeArchived || !t.archived)
        .filter((t) => filter.section === undefined || t.section === filter.section)
        .filter((t) => filter.group === undefined || t.group === filter.group)
        .filter((t) => filter.unread === undefined || t.unread === filter.unread)
        .filter((t) => filter.olderThan === undefined || t.lastActivity < filter.olderThan)
        .filter(
          (t) =>
            !q ||
            t.subject.toLowerCase().includes(q) ||
            t.participants.some((p) => `${p.name} ${p.email}`.toLowerCase().includes(q)),
        )
        .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
        .slice(0, filter.limit)
        .map(summary);
    },

    async threadsById(ids) {
      return ids.flatMap((id) => {
        const t = threads.get(id);
        return t && !t.deleted ? [summary(t)] : [];
      });
    },

    async readThread(threadId) {
      const t = threads.get(threadId);
      if (!t || t.deleted) return null;
      return { id: t.id, subject: t.subject, messages: t.messages };
    },

    async listGroups() {
      const ids = new Set([...threads.values()].flatMap((t) => (t.group ? [t.group] : [])));
      return [...ids].map((id) => ({ id, name: id }));
    },

    async listSections() {
      return defaultSettings()["sections.order"].map((id) => ({ id, name: id }));
    },

    async tagIds(names) {
      return names.map((name) => {
        let id = tagNames.get(name);
        if (!id) {
          id = `tag-${name}`;
          tagNames.set(name, id);
        }
        return id;
      });
    },

    async applyIntents(list, opts = {}) {
      const actor = opts.actor ?? "automation";
      let applied = 0;
      for (const intent of list) {
        const t = threads.get(intent.threadId);
        if (!t) continue;
        intents.push({ ...intent, actor });
        applied += 1;
        switch (intent.kind) {
          case "archive":
            t.archived = true;
            break;
          case "unarchive":
            t.archived = false;
            break;
          case "star":
          case "unstar":
            break;
          case "read":
            t.unread = false;
            break;
          case "unread":
            t.unread = true;
            break;
          case "snooze":
            t.snoozedUntil = intent.until;
            break;
          case "unsnooze":
            t.snoozedUntil = null;
            break;
          case "move":
            t.group = intent.group;
            t.subgroup = intent.subgroup;
            break;
          case "delete":
            t.deleted = true;
            break;
          case "undelete":
            t.deleted = false;
            break;
          case "tags":
            t.tags = [...intent.tags];
            break;
        }
      }
      return { applied };
    },

    async createDraft(content: DraftContent) {
      const id = `draft-${++seq}`;
      const draft: Draft = {
        id,
        workspaceId: options.workspaceId ?? "ws-fake",
        threadId: content.threadId,
        kind: content.kind,
        inReplyToMessageId: content.inReplyToMessageId,
        to: content.to,
        cc: content.cc,
        bcc: content.bcc,
        subject: content.subject,
        bodyHtml: content.bodyHtml,
        bodyText: content.bodyText,
        attachmentBlobIds: content.attachments.map((a) => a.blobId),
        attachments: content.attachments,
        status: "open",
        updatedAt: now().toISOString(),
        updatedBy: "agent",
      };
      drafts.set(id, draft);
      return draft;
    },

    async deleteDraft(draftId) {
      drafts.delete(draftId);
    },

    async readDraft(draftId) {
      return drafts.get(draftId) ?? null;
    },

    async scheduleSend(draftId) {
      const draft = drafts.get(draftId);
      if (!draft) throw new Error(`draft ${draftId} not found`);
      const sendId = `send-${++seq}`;
      const runAt = new Date(now().getTime() + 30_000).toISOString();
      sends.set(sendId, { draftId, runAt, cancelled: false });
      drafts.set(draftId, { ...draft, status: "scheduled" });
      return { sendId, runAt };
    },

    async cancelSend(sendId) {
      const send = sends.get(sendId);
      if (!send || send.cancelled) return { applied: false };
      send.cancelled = true;
      const draft = drafts.get(send.draftId);
      if (draft) drafts.set(draft.id, { ...draft, status: "open" });
      return { applied: true };
    },

    async readSetting(key) {
      const stored = settings.get(key);
      const entry = (settingsSchema as Record<string, { default: unknown }>)[key];
      return {
        value: stored !== undefined ? stored : structuredClone(entry?.default),
        pinned: pinned.has(key),
      };
    },

    async writeSetting(key, value) {
      settings.set(key, value);
      writes.push({ key, value });
    },
  };
}
