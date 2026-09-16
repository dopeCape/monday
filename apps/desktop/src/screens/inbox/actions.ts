// The seam between the Inbox screen and the data under it. The screen reads
// Threads through InboxSource and acts through InboxActions; every action
// returns an undo token that undo(token) reverses (docs/spec/inbox.md).
//
// fixtureInbox() is the in-memory implementation over packages/ui fixtures.
// Slice 6 replaces it with the Store: same interface, the screen stays.

import type { Message, Thread } from "@monday/shared";
import { threads as fixtureThreads, messagesOf } from "@monday/ui/fixtures";

export type UndoToken = string;

export interface InboxActions {
  archive(ids: readonly string[]): Promise<UndoToken>;
  unarchive(ids: readonly string[]): Promise<UndoToken>;
  snooze(ids: readonly string[], until: Date): Promise<UndoToken>;
  star(ids: readonly string[]): Promise<UndoToken>;
  unstar(ids: readonly string[]): Promise<UndoToken>;
  markRead(ids: readonly string[]): Promise<UndoToken>;
  markUnread(ids: readonly string[]): Promise<UndoToken>;
  /** null moves the Thread out of every Group. */
  moveToGroup(ids: readonly string[], groupId: string | null): Promise<UndoToken>;
  delete(ids: readonly string[]): Promise<UndoToken>;
  /** Reverses one earlier action. Unknown or already used tokens are ignored. */
  undo(token: UndoToken): Promise<void>;
}

export interface InboxSource {
  /** Threads in the Inbox: not archived, not snoozed, not deleted. Stable between changes. */
  threads(): readonly Thread[];
  /** One Thread by id, wherever it is. */
  thread(id: string): Thread | undefined;
  subscribe(listener: () => void): () => void;
}

/** What the reader needs: a Thread's Messages, their bodies on open, attachment bytes. */
export interface ThreadReader {
  /** The Messages the Cache holds for a Thread, in date order. Stable between changes. */
  messages(threadId: string): readonly Message[];
  /** Notifies when a Thread's Messages or bodies change; opening a Thread fetches what is missing. */
  watchMessages(threadId: string, listener: () => void): () => void;
  /** Fetches headers, attachments and bodies into the Cache (within its rules). Never throws. */
  openThread(threadId: string): Promise<void>;
  attachmentBytes(attachmentId: string): Promise<{ bytes: Uint8Array; mediaType: string }>;
}

export type Inbox = InboxActions & InboxSource & ThreadReader;

/* ------------------------------ Fixture implementation ------------------------------ */

interface Row {
  thread: Thread;
  deleted: boolean;
}

export function fixtureInbox(seed: readonly Thread[] = fixtureThreads): Inbox {
  const rows = new Map<string, Row>();
  for (const t of seed) rows.set(t.id, { thread: structuredClone(t), deleted: false });
  const listeners = new Set<() => void>();
  const undos = new Map<UndoToken, Row[]>();
  let tokenSeq = 0;
  let cache: readonly Thread[] | null = null;

  const emit = () => {
    cache = null;
    for (const l of listeners) l();
  };

  /** Snapshots the rows, applies the change, records the snapshot under a new token. */
  const change = (ids: readonly string[], apply: (row: Row) => void): Promise<UndoToken> => {
    const before: Row[] = [];
    for (const id of ids) {
      const row = rows.get(id);
      if (!row) continue;
      before.push({ thread: structuredClone(row.thread), deleted: row.deleted });
      apply(row);
    }
    const token = `u${++tokenSeq}`;
    undos.set(token, before);
    emit();
    return Promise.resolve(token);
  };

  const messageListeners = new Map<string, Set<() => void>>();
  const messageCache = new Map<string, readonly Message[]>();

  return {
    messages(threadId) {
      let list = messageCache.get(threadId);
      if (!list) {
        list = messagesOf(threadId);
        messageCache.set(threadId, list);
      }
      return list;
    },
    watchMessages(threadId, listener) {
      const set = messageListeners.get(threadId) ?? new Set();
      set.add(listener);
      messageListeners.set(threadId, set);
      return () => {
        set.delete(listener);
      };
    },
    openThread: async () => {},
    attachmentBytes: async (attachmentId) => ({
      bytes: new TextEncoder().encode(attachmentId),
      mediaType: "application/octet-stream",
    }),
    threads() {
      if (!cache) {
        cache = [...rows.values()]
          .filter((r) => !r.deleted && !r.thread.archived && r.thread.snoozedUntil === null)
          .map((r) => r.thread)
          .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
      }
      return cache;
    },
    thread: (id) => rows.get(id)?.thread,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    archive: (ids) =>
      change(ids, (r) => {
        r.thread.archived = true;
      }),
    unarchive: (ids) =>
      change(ids, (r) => {
        r.thread.archived = false;
      }),
    snooze: (ids, until) =>
      change(ids, (r) => {
        r.thread.snoozedUntil = until.toISOString();
      }),
    star: (ids) =>
      change(ids, (r) => {
        r.thread.starred = true;
      }),
    unstar: (ids) =>
      change(ids, (r) => {
        r.thread.starred = false;
      }),
    markRead: (ids) =>
      change(ids, (r) => {
        r.thread.unread = false;
      }),
    markUnread: (ids) =>
      change(ids, (r) => {
        r.thread.unread = true;
      }),
    moveToGroup: (ids, groupId) =>
      change(ids, (r) => {
        r.thread.group = groupId;
        r.thread.subgroup = null;
      }),
    delete: (ids) =>
      change(ids, (r) => {
        r.deleted = true;
      }),
    undo(token) {
      const before = undos.get(token);
      if (!before) return Promise.resolve();
      undos.delete(token);
      for (const row of before) rows.set(row.thread.id, row);
      emit();
      return Promise.resolve();
    },
  };
}
