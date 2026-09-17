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

import type { Brief, Message, Thread } from "@monday/shared";
import {
  ALL_THREADS_SQL,
  BRIEF_OF_THREAD_SQL,
  type LiveQuery,
  MESSAGES_OF_THREAD_SQL,
  rowToBrief,
  rowToCachedThread,
  rowToMessage,
  type Store,
  type StoreIntent,
} from "../../store/index.ts";
import type { ContentTransport } from "../../store/transport.ts";
import type { Inbox, UndoToken } from "./actions.ts";

/** What an undo puts back: the inverse intents, in the order the action ran. */
type Reversal = Array<StoreIntent>;

export interface StoreInbox extends Inbox {
  close(): void;
}

export interface StoreInboxOptions {
  /** The content routes; absent when the Store has no Server (tests): bodies then stay as cached. */
  content?: ContentTransport | undefined;
  /** The reader.load_remote_images Setting, read at fetch time. */
  remoteImages?: (() => boolean) | undefined;
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

  const live = store.live<Record<string, unknown>>(ALL_THREADS_SQL);
  await new Promise<void>((resolve) => {
    let first = true;
    live.subscribe((rows) => {
      byId.clear();
      const all = rows.map((r) => rowToCachedThread(r, store.workspaceId));
      for (const { thread } of all) byId.set(thread.id, thread);
      stream = all
        .filter(
          ({ thread, deleted }) => !deleted && !thread.archived && thread.snoozedUntil === null,
        )
        .map(({ thread }) => thread);
      for (const l of [...listeners]) l();
      if (first) {
        first = false;
        resolve();
      }
    });
  });

  /** Runs `make` for every known id and files the inverse under a new token. */
  const act = async (
    ids: readonly string[],
    make: (thread: Thread) => { intent: StoreIntent; reverse: StoreIntent },
  ): Promise<UndoToken> => {
    const reversal: Reversal = [];
    for (const id of ids) {
      const thread = byId.get(id);
      if (!thread) continue;
      const { intent, reverse } = make(thread);
      await store.intent(intent);
      reversal.push(reverse);
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
  const flip = (kind: Flag, reverse: Flag) => (t: Thread) => ({
    intent: { kind, threadId: t.id },
    reverse: { kind: reverse, threadId: t.id },
  });

  return {
    threads: () => stream,
    thread: (id) => byId.get(id),
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
    close() {
      live.close();
      listeners.clear();
      for (const w of watched.values()) {
        w.live.close();
        w.briefLive.close();
      }
      watched.clear();
    },
  };
}
