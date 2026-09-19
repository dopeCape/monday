// The Inbox seam (actions.ts) over the Store (ADR 0009). Threads come from
// one live query over the Cache and are handed to the screen as a stable
// external store; every action is a Store intent, applied locally before the
// Server hears of it, and every undo is the inverse intent under a new token.
// The reader side keeps two live queries per watched Thread (its Messages and
// its Brief) and fills bodies through the content routes on open, within the
// Cache rules (a body fetched once stays; an opened Thread is read again only
// when a Message has none). The Brief comes from the Cache, where the feed
// and the Store's warming put it before open; an open that finds none, or a
// stale one, asks the Server under the brief policy (slice 13).
// Sections are decided here, on the client, from the Section rules in
// Settings over Thread state and Group (CONTEXT.md "Section rule"): fast,
// local, and never waiting on the Server. A Section the Server assigned
// (the section Task) is kept as is.

import type {
  AiLevel,
  Brief,
  Group,
  Message,
  SectionRuleSetting,
  Tag,
  Thread,
} from "@monday/shared";
import { sectionOf } from "@monday/shared";
import {
  ALL_THREADS_SQL,
  BRIEF_OF_THREAD_SQL,
  GROUPS_SQL,
  type LiveQuery,
  MESSAGES_OF_THREAD_SQL,
  rowToBrief,
  rowToCachedThread,
  rowToGroup,
  rowToMessage,
  rowToTag,
  type Store,
  type StoreIntent,
  TAGS_SQL,
} from "../../store/index.ts";
import type { ContentTransport } from "../../store/transport.ts";
import type { Inbox, UndoToken } from "./actions.ts";

/**
 * What an undo puts back: the inverse intents, in the order the action ran.
 * A Thread the action found already in its target state has no inverse, so
 * undoing "mark read" on a mixed batch leaves the Threads that were read alone.
 */
type Reversal = Array<StoreIntent>;

export interface StoreInbox extends Inbox {
  /** Re-evaluates the Section rules over the cached rows, after the Settings change. */
  resection(): void;
  close(): void;
}

/** The Section rules as the Store evaluates them: the Settings, read when rows arrive, and the owner. */
export interface SectionSource {
  rules: () => readonly SectionRuleSetting[];
  order: () => readonly string[];
  /** The mailbox owner's address, for "lastFrom". */
  owner: string;
  /** Group id to name, so a rule may name a Group either way. */
  groupNames?: (() => Readonly<Record<string, string>>) | undefined;
}

export interface StoreInboxOptions {
  /** The content routes; absent when the Store has no Server (tests): bodies then stay as cached. */
  content?: ContentTransport | undefined;
  /** The reader.load_remote_images Setting, read at fetch time. */
  remoteImages?: (() => boolean) | undefined;
  /** The Section rules; absent leaves every Thread's Section as the Cache has it. */
  sections?: SectionSource | undefined;
  /** The AI level, read at open time: at `off` no Brief is asked for (CONTEXT.md "AI level"). */
  level?: (() => AiLevel) | undefined;
  log?: ((message: string) => void) | undefined;
}

interface Watched {
  live: LiveQuery<Record<string, unknown>>;
  briefLive: LiveQuery<Record<string, unknown>>;
  listeners: Set<() => void>;
  messages: readonly Message[];
  brief: Brief | undefined;
}

const EMPTY: readonly Message[] = [];

/** Opens the seam and resolves once the first rows are in, so the screen never renders empty. */
export async function createStoreInbox(
  store: Store,
  options: StoreInboxOptions = {},
): Promise<StoreInbox> {
  const byId = new Map<string, Thread>();
  const listeners = new Set<() => void>();
  const undos = new Map<UndoToken, Reversal>();
  const watched = new Map<string, Watched>();
  const opening = new Map<string, Promise<void>>();
  const log = options.log ?? (() => {});
  let tokenSeq = 0;
  let stream: readonly Thread[] = [];

  const watch = (threadId: string): Watched => {
    let w = watched.get(threadId);
    if (w) return w;
    const live = store.live<Record<string, unknown>>(MESSAGES_OF_THREAD_SQL, [threadId]);
    const briefLive = store.live<Record<string, unknown>>(BRIEF_OF_THREAD_SQL, [threadId]);
    const entry: Watched = {
      live,
      briefLive,
      listeners: new Set(),
      messages: EMPTY,
      brief: undefined,
    };
    live.subscribe((rows) => {
      entry.messages = rows.map(rowToMessage);
      for (const l of [...entry.listeners]) l();
    });
    briefLive.subscribe((rows) => {
      const row = rows[0];
      entry.brief = row ? (rowToBrief(row) ?? undefined) : undefined;
      for (const l of [...entry.listeners]) l();
    });
    watched.set(threadId, entry);
    w = entry;
    return w;
  };

  /** The Cache's Brief row for a Thread as the policy sees it: none, stale, or fresh. */
  const briefState = async (threadId: string): Promise<"none" | "stale" | "fresh"> => {
    const rows = await store.query<{ stale: number; content_stale: number }>(
      "select stale, content_stale from briefs where thread_id = ?",
      [threadId],
    );
    const row = rows[0];
    if (!row) return "none";
    // Content on its way from the feed counts as fresh: no second ask.
    return row.stale && !row.content_stale ? "stale" : "fresh";
  };

  /** Asks the Server for a Brief; the answer arrives through the feed. Never throws. */
  const askBrief = async (threadId: string, trigger: "open" | "user") => {
    if (options.level?.() === "off") return;
    const content = options.content;
    if (!content) return;
    try {
      await content.requestBrief(store.workspaceId, threadId, trigger);
    } catch (error) {
      log(`brief ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** Headers and attachments from the Server, then every body the Cache lacks. */
  const fetchThread = async (threadId: string) => {
    const content = options.content;
    if (!content) return;
    const headers = await content.messages(threadId);
    await store.cacheMessages(headers);
    const cached = await store.query<{ id: string; body_text: string | null }>(
      "select id, body_text from messages where thread_id = ?",
      [threadId],
    );
    const have = new Set(cached.filter((r) => r.body_text !== null).map((r) => r.id));
    for (const m of headers) {
      if (have.has(m.id) || m.bodyState === "pending") continue;
      try {
        const body = await content.body(m.id, { images: options.remoteImages?.() ?? false });
        await store.cacheBody(m.id, { text: body.text, html: body.display.html });
      } catch (error) {
        log(`body ${m.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  /** The Section a row lands in: the Server's when it set one, else the rules over the row. */
  const sectioned = (entry: ReturnType<typeof rowToCachedThread>): Thread => {
    const rules = options.sections;
    if (!rules || entry.thread.section !== null) return entry.thread;
    const section = sectionOf(
      entry.thread,
      {
        lastSender: entry.lastSender,
        owner: rules.owner,
        ...(rules.groupNames ? { groupNames: rules.groupNames() } : {}),
      },
      rules.rules(),
      rules.order(),
    );
    return section === null ? entry.thread : { ...entry.thread, section };
  };

  let lastRows: Record<string, unknown>[] = [];
  /** The Threads in the trash, which the domain type does not carry. */
  const deletedIds = new Set<string>();
  const project = (rows: Record<string, unknown>[]) => {
    lastRows = rows;
    byId.clear();
    deletedIds.clear();
    const all = rows.map((r) => {
      const entry = rowToCachedThread(r, store.workspaceId);
      return { thread: sectioned(entry), deleted: entry.deleted };
    });
    for (const { thread, deleted } of all) {
      byId.set(thread.id, thread);
      if (deleted) deletedIds.add(thread.id);
    }
    stream = all
      .filter(({ thread, deleted }) => !deleted && !thread.archived && thread.snoozedUntil === null)
      .map(({ thread }) => thread);
    for (const l of [...listeners]) l();
  };

  const live = store.live<Record<string, unknown>>(ALL_THREADS_SQL);
  await new Promise<void>((resolve) => {
    let first = true;
    live.subscribe((rows) => {
      project(rows);
      if (first) {
        first = false;
        resolve();
      }
    });
  });

  // Groups and Tags as the Cache holds them (the feed keeps both current).
  let groups: readonly Group[] = [];
  let tags: readonly Tag[] = [];
  const groupsLive = store.live<Record<string, unknown>>(GROUPS_SQL);
  const tagsLive = store.live<Record<string, unknown>>(TAGS_SQL);
  await Promise.all([
    new Promise<void>((resolve) => {
      groupsLive.subscribe((rows) => {
        groups = rows.map((r) => rowToGroup(r, store.workspaceId));
        for (const l of [...listeners]) l();
        resolve();
      });
    }),
    new Promise<void>((resolve) => {
      tagsLive.subscribe((rows) => {
        tags = rows.map((r) => rowToTag(r, store.workspaceId));
        for (const l of [...listeners]) l();
        resolve();
      });
    }),
  ]);

  /** Runs `make` for every known id and files the inverses under a new token. */
  const act = async (
    ids: readonly string[],
    make: (thread: Thread) => { intent: StoreIntent; reverse: StoreIntent | null },
  ): Promise<UndoToken> => {
    const reversal: Reversal = [];
    for (const id of ids) {
      const thread = byId.get(id);
      if (!thread) continue;
      const { intent, reverse } = make(thread);
      await store.intent(intent);
      if (reverse) reversal.push(reverse);
    }
    const token = `u${++tokenSeq}`;
    undos.set(token, reversal);
    return token;
  };

  type Flag =
    | "archive"
    | "unarchive"
    | "star"
    | "unstar"
    | "read"
    | "unread"
    | "delete"
    | "undelete";
  /** Whether a Thread already sits where a flag intent would put it. */
  const already = (kind: Flag, t: Thread, deleted: boolean): boolean => {
    switch (kind) {
      case "archive":
        return t.archived;
      case "unarchive":
        return !t.archived;
      case "star":
        return t.starred;
      case "unstar":
        return !t.starred;
      case "read":
        return !t.unread;
      case "unread":
        return t.unread;
      case "delete":
        return deleted;
      case "undelete":
        return !deleted;
    }
  };
  const flip = (kind: Flag, reverse: Flag) => (t: Thread) => ({
    intent: { kind, threadId: t.id },
    reverse: already(kind, t, deletedIds.has(t.id)) ? null : { kind: reverse, threadId: t.id },
  });

  return {
    threads: () => stream,
    thread: (id) => byId.get(id),
    groups: () => groups,
    tags: () => tags,
    messages: (threadId) => watch(threadId).messages,
    watchMessages(threadId, listener) {
      const w = watch(threadId);
      w.listeners.add(listener);
      return () => {
        w.listeners.delete(listener);
        if (w.listeners.size === 0) {
          w.live.close();
          w.briefLive.close();
          watched.delete(threadId);
        }
      };
    },
    brief: (threadId) => watch(threadId).brief,
    async openThread(threadId) {
      let pending = opening.get(threadId);
      if (!pending) {
        pending = fetchThread(threadId)
          .catch((error) =>
            log(`open ${threadId}: ${error instanceof Error ? error.message : String(error)}`),
          )
          // Bodies first, so the Server briefs the Thread the reader sees.
          .then(async () => {
            if ((await briefState(threadId)) !== "fresh") await askBrief(threadId, "open");
          })
          .finally(() => opening.delete(threadId));
        opening.set(threadId, pending);
      }
      await pending;
    },
    requestBrief: (threadId) => askBrief(threadId, "user"),
    async attachmentBytes(attachmentId) {
      if (!options.content) throw new Error("no content transport");
      return options.content.attachment(attachmentId);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    archive: (ids) => act(ids, flip("archive", "unarchive")),
    unarchive: (ids) => act(ids, flip("unarchive", "archive")),
    snooze: (ids, until) =>
      act(ids, (t) => ({
        intent: { kind: "snooze", threadId: t.id, until: until.toISOString() },
        reverse: { kind: "unsnooze", threadId: t.id },
      })),
    star: (ids) => act(ids, flip("star", "unstar")),
    unstar: (ids) => act(ids, flip("unstar", "star")),
    markRead: (ids) => act(ids, flip("read", "unread")),
    markUnread: (ids) => act(ids, flip("unread", "read")),
    moveToGroup: (ids, groupId) =>
      act(ids, (t) => ({
        intent: { kind: "move", threadId: t.id, group: groupId, subgroup: null },
        reverse: { kind: "move", threadId: t.id, group: t.group, subgroup: t.subgroup },
      })),
    delete: (ids) => act(ids, flip("delete", "undelete")),
    async undo(token) {
      const reversal = undos.get(token);
      if (!reversal) return;
      undos.delete(token);
      for (const intent of reversal) await store.intent(intent);
    },
    resection() {
      project(lastRows);
    },
    close() {
      live.close();
      groupsLive.close();
      tagsLive.close();
      listeners.clear();
      for (const w of watched.values()) {
        w.live.close();
        w.briefLive.close();
      }
      watched.clear();
    },
  };
}
