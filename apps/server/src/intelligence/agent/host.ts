// The Server's ToolHost: the tools act on Postgres through the same paths the
// routes use. Thread writes go through Mailstore.applyIntent, so every one
// lands in the Changes feed for each Device, obeys last-writer-wins and is
// reversed by the inverse intent the tool server recorded. Drafts and sends
// go through the Drafts module (a send is a scheduled Job with its undo
// window, ADR 0010). Settings are the global rows; pinning is the calling
// Device's business and arrives with the turn.

import type {
  IntentArgs,
  SettingRead,
  ThreadFilter,
  ThreadReading,
  ThreadSummary,
  ToolHost,
} from "@monday/shared";
import { defaultSettings, isSettingKey, type Settings } from "@monday/shared";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { LockedError } from "../../crypto/keys.ts";
import type { Db } from "../../db/client.ts";
import { settings as settingsTable, threads } from "../../db/schema.ts";
import type { Drafts } from "../../drafts/index.ts";
import type { Mailstore } from "../../mailstore/index.ts";
import { NotFoundError } from "../../mailstore/index.ts";
import { readGlobalSettings } from "../../settings/read.ts";

export interface ServerToolHostOptions {
  db: Db;
  mailstore: Mailstore;
  drafts: Drafts;
  workspaceId: string;
  now?: () => Date;
}

const personLine = (p: { name: string; email: string }) =>
  p.name ? `${p.name} <${p.email}>` : p.email;

export function createServerToolHost(options: ServerToolHostOptions): ToolHost {
  const { db, mailstore, drafts, workspaceId } = options;
  const now = options.now ?? (() => new Date());

  /** The real subject when the Server is unlocked; the index prefix otherwise. */
  const subjectOf = async (threadId: string, fallback: string): Promise<string> => {
    try {
      return await mailstore.readThreadSubject(threadId);
    } catch (error) {
      if (error instanceof LockedError || error instanceof NotFoundError) return fallback;
      throw error;
    }
  };

  const summarize = async (t: {
    id: string;
    subject: string;
    participants: ThreadSummary["participants"];
    lastActivity: string;
    unread: boolean;
    archived: boolean;
    snoozedUntil: string | null;
    section: string | null;
    group: string | null;
    subgroup: string | null;
    tags: string[];
  }): Promise<ThreadSummary> => ({
    id: t.id,
    subject: await subjectOf(t.id, t.subject),
    from: t.participants[0] ? personLine(t.participants[0]) : "",
    participants: t.participants,
    lastActivity: t.lastActivity,
    unread: t.unread,
    archived: t.archived,
    snoozedUntil: t.snoozedUntil,
    section: t.section,
    group: t.group,
    subgroup: t.subgroup,
    tags: t.tags,
  });

  const host: ToolHost = {
    workspaceId,

    async listThreads(filter: ThreadFilter) {
      if (filter.query?.trim()) {
        const { hits } = await mailstore.searchHeaders(workspaceId, {
          q: filter.query,
          limit: Math.min(200, Math.max(filter.limit * 2, filter.limit)),
        });
        const ids = hits.map((h) => h.threadId);
        const page = await mailstore.listThreads(workspaceId, {
          ids,
          limit: 500,
          includeArchived: filter.includeArchived ?? false,
          ...(filter.section !== undefined ? { section: filter.section } : {}),
          ...(filter.group !== undefined ? { group: filter.group } : {}),
        });
        const rank = new Map(ids.map((id, i) => [id, i]));
        const kept = page.threads
          .filter((t) => filter.unread === undefined || t.unread === filter.unread)
          .filter((t) => filter.olderThan === undefined || t.lastActivity < filter.olderThan)
          .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
          .slice(0, filter.limit);
        return Promise.all(kept.map(summarize));
      }
      const out: ThreadSummary[] = [];
      let cursor: string | null = null;
      // Pages of the list until the limit is met; the filters not in the index are applied here.
      while (out.length < filter.limit) {
        const page = await mailstore.listThreads(workspaceId, {
          limit: 500,
          cursor,
          includeArchived: filter.includeArchived ?? false,
          ...(filter.section !== undefined ? { section: filter.section } : {}),
          ...(filter.group !== undefined ? { group: filter.group } : {}),
        });
        for (const t of page.threads) {
          if (filter.unread !== undefined && t.unread !== filter.unread) continue;
          if (filter.olderThan !== undefined && t.lastActivity >= filter.olderThan) continue;
          out.push(await summarize(t));
          if (out.length >= filter.limit) break;
        }
        if (!page.cursor) break;
        cursor = page.cursor;
      }
      return out;
    },

    async threadsById(ids) {
      if (ids.length === 0) return [];
      const page = await mailstore.listThreads(workspaceId, {
        ids: [...ids],
        limit: 500,
        includeArchived: true,
      });
      const byId = new Map(page.threads.map((t) => [t.id, t]));
      const ordered = ids.flatMap((id) => {
        const t = byId.get(id);
        return t ? [t] : [];
      });
      return Promise.all(ordered.map(summarize));
    },

    async readThread(threadId) {
      let subject: string;
      try {
        subject = await mailstore.readThreadSubject(threadId);
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        if (error instanceof LockedError) subject = "[subject unavailable while locked]";
        else throw error;
      }
      const headers = await mailstore.listMessages(threadId);
      const messages: ThreadReading["messages"] = [];
      for (const m of headers) {
        let text: string | null = null;
        try {
          text = (await mailstore.readMessageBody(m.id)).text;
        } catch (error) {
          if (!(error instanceof LockedError) && !(error instanceof NotFoundError)) throw error;
        }
        messages.push({ id: m.id, from: m.from, to: m.to, date: m.date, text });
      }
      return { id: threadId, subject, messages };
    },

    async listGroups() {
      const rows = await db
        .selectDistinct({ id: threads.groupId })
        .from(threads)
        .where(and(eq(threads.workspaceId, workspaceId), isNotNull(threads.groupId)));
      return rows.flatMap((r) => (r.id ? [{ id: r.id, name: r.id }] : []));
    },

    async listSections() {
      const s = await readGlobalSettings(db, ["sections.order"]);
      const strings = await readGlobalSettings(
        db,
        s["sections.order"].flatMap((id) => {
          const key = `strings.section.${id}`;
          return isSettingKey(key) ? [key] : [];
        }),
      );
      return s["sections.order"].map((id) => {
        const key = `strings.section.${id}`;
        const name = isSettingKey(key)
          ? String((strings as Record<string, unknown>)[key] ?? id)
          : id;
        return { id, name };
      });
    },

    async tagIds(names) {
      const out: string[] = [];
      for (const name of names) out.push(await mailstore.upsertTag(workspaceId, name));
      return out;
    },

    async applyIntents(list: readonly (IntentArgs & { threadId: string })[], opts = {}) {
      const actor = opts.actor ?? "automation";
      let applied = 0;
      for (const intent of list) {
        try {
          const result = await mailstore.applyIntent({
            ...intent,
            at: now().toISOString(),
            actor,
          });
          if (result.applied) applied += 1;
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error;
        }
      }
      return { applied };
    },

    async createDraft(content) {
      const saved = await drafts.save({
        id: crypto.randomUUID(),
        workspaceId,
        content,
        updatedBy: "agent",
        actor: "automation",
      });
      if (!saved.draft) throw new Error(saved.reason ?? "draft not saved");
      return saved.draft;
    },

    async deleteDraft(draftId) {
      await drafts.remove(draftId, { actor: "user" });
    },

    async readDraft(draftId) {
      try {
        return await drafts.get(draftId);
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },

    async scheduleSend(draftId) {
      const outcome = await drafts.schedule(draftId, { actor: "automation" });
      return { sendId: outcome.sendId, runAt: outcome.runAt };
    },

    async cancelSend(sendId) {
      const result = await drafts.cancel(sendId);
      return { applied: result.applied };
    },

    async readSetting(key): Promise<SettingRead> {
      if (!isSettingKey(key)) return { value: undefined, pinned: false };
      const rows = await db
        .select({ value: settingsTable.value })
        .from(settingsTable)
        .where(
          and(
            eq(settingsTable.scope, "global"),
            isNull(settingsTable.deviceId),
            eq(settingsTable.key, key),
          ),
        );
      const stored = rows[0]?.value;
      const value =
        stored !== undefined ? stored : structuredClone((defaultSettings() as Settings)[key]);
      return { value, pinned: false };
    },

    async readAttachment(attachmentId) {
      try {
        const a = await mailstore.readAttachment(attachmentId);
        return { name: a.name, mediaType: a.mediaType, bytes: a.bytes };
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },

    async writeSetting(key, value) {
      if (!isSettingKey(key)) throw new Error(`unknown setting ${key}`);
      // A Device-scoped Setting changed by the Agent lands in the global row,
      // which every Device without its own value reads (ADR 0004).
      await db
        .insert(settingsTable)
        .values({ scope: "global", deviceId: null, key, value: value as object, updatedAt: now() })
        .onConflictDoUpdate({
          target: [settingsTable.scope, settingsTable.deviceId, settingsTable.key],
          set: { value: value as object, updatedAt: now() },
        });
    },
  };
  return host;
}
