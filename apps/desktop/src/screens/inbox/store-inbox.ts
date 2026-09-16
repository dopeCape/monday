// The Inbox seam (actions.ts) over the Store (ADR 0009). Threads come from
// one live query over the Cache and are handed to the screen as a stable
// external store; every action is a Store intent, applied locally before the
// Server hears of it, and every undo is the inverse intent under a new token.

import type { Thread } from "@monday/shared";
import {
  ALL_THREADS_SQL,
  rowToCachedThread,
  type Store,
  type StoreIntent,
} from "../../store/index.ts";
import type { Inbox, UndoToken } from "./actions.ts";

/** What an undo puts back: the inverse intents, in the order the action ran. */
type Reversal = Array<StoreIntent>;

export interface StoreInbox extends Inbox {
  close(): void;
}

/** Opens the seam and resolves once the first rows are in, so the screen never renders empty. */
export async function createStoreInbox(store: Store): Promise<StoreInbox> {
  const byId = new Map<string, Thread>();
  const listeners = new Set<() => void>();
  const undos = new Map<UndoToken, Reversal>();
  let tokenSeq = 0;
  let stream: readonly Thread[] = [];

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
    },
  };
}
