// The Device's ToolHost (ADR 0002, ADR 0009): the same seam the Server's
// tool server acts through, over what the client already has. Threads come
// from the Inbox source, searches from the Cache's FTS, writes go through
// InboxActions so they enter the Outbox and the same undo tokens as a manual
// action, Drafts and sends through the compose seam, Settings through the
// Shell (which knows what the Config file pins). The Hosted composer runs on
// the Server; the Local runtimes of slice 15 drive this one while the client
// is open.

import type {
  Draft,
  IntentArgs,
  SettingKey,
  Settings,
  Thread,
  ThreadSummary,
  ToolHost,
} from "@monday/shared";
import { isSettingKey } from "@monday/shared";
import type { Composer } from "../screens/compose/composer.ts";
import type { Inbox, UndoToken } from "../screens/inbox/actions.ts";
import type { SearchModule } from "../search/index.ts";
import type { SetResult } from "../shell/Shell.tsx";

/** What the host needs of the Shell: read, write and pinning of Settings. */
export interface SettingsSeam {
  settings: Settings;
  pinned: ReadonlySet<SettingKey>;
  set<K extends SettingKey>(key: K, value: Settings[K]): Promise<SetResult>;
}

export interface ClientToolHostOptions {
  workspaceId: string;
  inbox: Inbox;
  composer?: Composer | undefined;
  search?: SearchModule | null | undefined;
  shell: SettingsSeam;
  /** Tag ids by name; the Cache's tags table in the app, a map in tests. */
  tagIds?: ((names: readonly string[]) => Promise<string[]>) | undefined;
  now?: () => Date;
}

export interface ClientToolHost extends ToolHost {
  /** The undo tokens of every batch applied, newest last, for the toast path. */
  undoTokens: UndoToken[];
}

const personLine = (p: { name: string; email: string }) =>
  p.name ? `${p.name} <${p.email}>` : p.email;

export function threadSummary(t: Thread): ThreadSummary {
  return {
    id: t.id,
    subject: t.subject,
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
  };
}

export function createClientToolHost(options: ClientToolHostOptions): ClientToolHost {
  const { workspaceId, inbox, composer, search, shell } = options;
  const now = options.now ?? (() => new Date());
  const undoTokens: UndoToken[] = [];

  /** One InboxActions call per intent kind, so each batch gets one undo token. */
  const applyKind = async (
    kind: IntentArgs["kind"],
    ids: string[],
    args: IntentArgs,
  ): Promise<void> => {
    if (ids.length === 0) return;
    let token: UndoToken;
    switch (kind) {
      case "archive":
        token = await inbox.archive(ids);
        break;
      case "unarchive":
        token = await inbox.unarchive(ids);
        break;
      case "star":
        token = await inbox.star(ids);
        break;
      case "unstar":
        token = await inbox.unstar(ids);
        break;
      case "read":
        token = await inbox.markRead(ids);
        break;
      case "unread":
        token = await inbox.markUnread(ids);
        break;
      case "snooze":
        token = await inbox.snooze(ids, new Date(args.kind === "snooze" ? args.until : now()));
        break;
      case "unsnooze":
        // The Inbox seam has no unsnooze; the snooze's own undo token reverses it.
        return;
      case "move":
        token = await inbox.moveToGroup(ids, args.kind === "move" ? args.group : null);
        break;
      case "delete":
        token = await inbox.delete(ids);
        break;
      case "undelete":
      case "tags":
        // Not on the Inbox seam yet; the Server host covers them until slice 15 widens this one.
        return;
    }
    undoTokens.push(token);
  };

  const host: ClientToolHost = {
    workspaceId,
    undoTokens,

    async listThreads(filter) {
      let candidates: Thread[];
      if (filter.query?.trim() && search) {
        const result = await search.search(filter.query, {
          workspace: workspaceId,
          limit: filter.limit,
          now: now(),
        });
        candidates = result.hits.map((h) => h.thread);
      } else {
        candidates = [...inbox.threads()];
      }
      return candidates
        .filter((t) => filter.includeArchived || !t.archived)
        .filter((t) => filter.section === undefined || t.section === filter.section)
        .filter((t) => filter.group === undefined || t.group === filter.group)
        .filter((t) => filter.unread === undefined || t.unread === filter.unread)
        .filter((t) => filter.olderThan === undefined || t.lastActivity < filter.olderThan)
        .slice(0, filter.limit)
        .map(threadSummary);
    },

    async threadsById(ids) {
      return ids.flatMap((id) => {
        const t = inbox.thread(id);
        return t ? [threadSummary(t)] : [];
      });
    },

    async readThread(threadId) {
      const t = inbox.thread(threadId);
      if (!t) return null;
      await inbox.openThread(threadId);
      return {
        id: t.id,
        subject: t.subject,
        messages: inbox.messages(threadId).map((m) => ({
          id: m.id,
          from: m.from,
          to: m.to,
          date: m.date,
          text: m.bodyText ?? null,
        })),
      };
    },

    async listGroups() {
      const ids = new Set(inbox.threads().flatMap((t) => (t.group ? [t.group] : [])));
      return [...ids].map((id) => ({ id, name: id }));
    },

    async listSections() {
      return shell.settings["sections.order"].map((id) => {
        const key = `strings.section.${id}`;
        return { id, name: isSettingKey(key) ? String(shell.settings[key]) : id };
      });
    },

    async tagIds(names) {
      return options.tagIds ? options.tagIds(names) : names.map((n) => `tag:${n}`);
    },

    async applyIntents(intents) {
      // Group by kind (and by snooze time or group target) so a batch is one undo token.
      const groups = new Map<
        string,
        { kind: IntentArgs["kind"]; args: IntentArgs; ids: string[] }
      >();
      let applied = 0;
      for (const intent of intents) {
        if (!inbox.thread(intent.threadId)) continue;
        applied += 1;
        const key =
          intent.kind === "snooze"
            ? `snooze:${intent.until}`
            : intent.kind === "move"
              ? `move:${intent.group ?? ""}`
              : intent.kind;
        const group = groups.get(key) ?? { kind: intent.kind, args: intent, ids: [] };
        group.ids.push(intent.threadId);
        groups.set(key, group);
      }
      for (const group of groups.values()) await applyKind(group.kind, group.ids, group.args);
      return { applied };
    },

    async createDraft(content) {
      if (!composer) throw new Error("drafts are not available on this Device");
      const id = crypto.randomUUID();
      await composer.save(id, content);
      const draft = composer.draft(id);
      if (!draft) throw new Error("draft not saved");
      return draft;
    },

    async deleteDraft(draftId) {
      await composer?.discard(draftId);
    },

    async readDraft(draftId): Promise<Draft | null> {
      return composer?.draft(draftId) ?? null;
    },

    async scheduleSend(draftId) {
      if (!composer) throw new Error("sending is not available on this Device");
      return composer.send(draftId);
    },

    async cancelSend(sendId) {
      if (!composer) return { applied: false };
      await composer.cancel(sendId);
      return { applied: true };
    },

    async readSetting(key) {
      if (!isSettingKey(key)) return { value: undefined, pinned: false };
      return { value: shell.settings[key], pinned: shell.pinned.has(key) };
    },

    async writeSetting(key, value) {
      if (!isSettingKey(key)) throw new Error(`unknown setting ${key}`);
      const result = await shell.set(key, value as Settings[typeof key]);
      if (!result.ok) throw new Error(result.message);
    },
  };
  return host;
}
