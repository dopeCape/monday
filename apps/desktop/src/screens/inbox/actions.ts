// The seam between the Inbox screen and the data under it. The screen reads
// Threads through InboxSource and acts through InboxActions; every action
// returns an undo token that undo(token) reverses (docs/spec/inbox.md).
//
// fixtureInbox() is the in-memory implementation over packages/ui fixtures,
// for tests; store-inbox.ts is the Store's, with the same interface.

import type {
  Brief,
  Group,
  MeetingChip,
  Message,
  RecommendationEventsRequest,
  SectionJudged,
  Tag,
  Thread,
  ThreadJudgments,
} from "@monday/shared";
import {
  briefOf,
  groups as fixtureGroups,
  recommendations as fixtureRecommendations,
  tags as fixtureTags,
  threads as fixtureThreads,
  messagesOf,
} from "@monday/ui/fixtures";
import type { ListExit } from "../../platform/api.ts";
import type { CachedRecommendations } from "../../store/recommendations.ts";
import { type FolderKey, folderThreads, type ThreadListKey } from "./folders.ts";
import type { Facet, FacetKind } from "./list-filter.ts";

export type { ThreadListKey } from "./folders.ts";

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
  /** Replaces the Tags (by id) on each Thread; a custom action's tag_threads runs through it (slice 26). */
  setTags?(ids: readonly string[], tagIds: readonly string[]): Promise<UndoToken>;
  /** Reverses one earlier action. Unknown or already used tokens are ignored. */
  undo(token: UndoToken): Promise<void>;
}

/**
 * The Inbox's totals over every Thread the Cache holds, not only the ones a
 * list holds in memory: the nav's counts read these.
 */
export interface InboxCounts {
  /** Threads in the Inbox. */
  inbox: number;
  /** Snoozed Threads outside the trash. */
  snoozed: number;
  /**
   * Unread Inbox Threads by nav key: "inbox", "starred" and each Group id (a
   * Sub-group's count also rolls up into its parent). Sections are not here:
   * they are decided on the client, over the Threads held.
   */
  unread: Readonly<Record<string, number>>;
}

export interface InboxSource {
  /**
   * Threads in the Inbox: not archived, not snoozed, not deleted, newest
   * first. A seam over a large Cache may hold only the newest of them (the
   * inbox.memory_window Setting) and read more on more("inbox"). Stable
   * between changes.
   */
  threads(): readonly Thread[];
  /**
   * One Thread by id, wherever it is. A seam that holds only part of the
   * Cache reads a Thread it does not hold in the background and answers
   * undefined meanwhile; its subscribers hear when it lands, and resolve()
   * waits for it.
   */
  thread(id: string): Thread | undefined;
  /** The Thread by id, read from the Cache when the seam does not hold it; undefined when there is none. */
  resolve?(id: string): Promise<Thread | undefined>;
  /** The Inbox Threads in a Group or Sub-group, newest first, held like threads(). Stable between changes. */
  group?(groupId: string): readonly Thread[];
  /** Reads the next Threads of a list the seam holds only in part; nothing once it holds them all. */
  more?(list: ThreadListKey): void;
  /**
   * Subscribes to one list, so the seam holds it while someone shows it and
   * lets it go after the last one leaves. The same notifications as subscribe().
   */
  watchList?(list: ThreadListKey, listener: () => void): () => void;
  /**
   * Any list by key, held like threads(): the Filter menu's narrowed lists
   * (`filter:`) are read this way. Absent, the screen filters the Threads it
   * holds instead.
   */
  list?(key: ThreadListKey): readonly Thread[];
  /**
   * How many Threads a list holds over the whole Cache; null until counted.
   * A narrowed list is counted as soon as it is read; any other list once
   * someone asks (the selection bar's "Select all").
   */
  listTotal?(key: ThreadListKey): number | null;
  /**
   * Every Thread id of a list over the whole Cache, in the list's order, not
   * only the ones held in memory: "Select all" acts on these.
   */
  listIds?(key: ThreadListKey): Promise<string[]>;
  /** The Filter menu's choices over a list, with how many of its Threads carry each. */
  facets?(
    key: ThreadListKey,
    kind: FacetKind,
    options: { needle?: string | undefined; limit: number; now?: Date | undefined },
  ): Promise<Facet[]>;
  /** Totals over the whole Cache. Stable between changes; the same subscription as threads(). */
  counts?(): InboxCounts;
  /** Every Group of the Workspace, top-level first, for the move picker. Stable between changes. */
  groups(): readonly Group[];
  /** Every Tag of the Workspace, so a row can name the ones its Thread carries. Stable between changes. */
  tags(): readonly Tag[];
  /** The judged answers held for a Thread (slice 26), by Section or custom action id; absent means none. */
  judged?(threadId: string): SectionJudged;
  /**
   * The Threads of a Mail folder (Starred, Snoozed, Sent, Archive), newest
   * first, Snoozed soonest to wake first. Stable between changes; the same
   * subscription as threads().
   */
  folder?(key: FolderKey): readonly Thread[];
  subscribe(listener: () => void): () => void;
}

/** What the reader needs: a Thread's Messages, their bodies on open, its Brief, attachment bytes. */
export interface ThreadReader {
  /** The Messages the Cache holds for a Thread, in date order. Stable between changes. */
  messages(threadId: string): readonly Message[];
  /** Notifies when a Thread's Messages, bodies or Brief change; opening a Thread fetches what is missing. */
  watchMessages(threadId: string, listener: () => void): () => void;
  /**
   * Fetches headers, attachments and bodies into the Cache (within its
   * rules), then asks for a Brief under the brief policy when the Cache has
   * none or a stale one (docs/spec/inbox.md, Briefs). Never throws.
   */
  openThread(threadId: string): Promise<void>;
  /**
   * Keeps these Threads' Messages read and their bodies fetched, so moving to
   * one (j and k, the next row) shows it at once. The last call wins: ones not
   * named again are let go. Optional: a seam without a Cache has nothing to warm.
   */
  prefetch?(threadIds: readonly string[]): void;
  /** The Brief the Cache holds for a Thread, computed before or after open; undefined when none. */
  brief(threadId: string): Brief | undefined;
  /**
   * The Thread's Judgments from the Cache (slice 25), for the action chips
   * the reader shows before a Brief exists; undefined when not judged yet.
   * Changes reach the stream's subscribers, not watchMessages.
   */
  judgments?(threadId: string): ThreadJudgments | undefined;
  /** The Thread's meeting chip from the Cache (docs/spec/meetings.md), for the row's hover. */
  meeting?(threadId: string): MeetingChip | undefined;
  /**
   * The Thread's Recommended actions from the Cache (docs/spec/actions.md),
   * for the reader's chips and the row's hover; undefined when none yet.
   * Changes reach the stream's subscribers.
   */
  recommendations?(threadId: string): CachedRecommendations | undefined;
  /**
   * The reader opened the Thread: asks the Server to work its Recommended
   * actions out again (a Thread without current answers is asked the Signal
   * request once), and caches the answer. `zone` is the Device's. Never throws.
   */
  askRecommendations?(threadId: string, zone?: string): Promise<void>;
  /** Tells the Server which chips showed or what became of one (learning). Never throws. */
  recommendationEvents?(body: Omit<RecommendationEventsRequest, "workspace">): void;
  /** How the Thread's list is left: the exact request the unsubscribe card shows. */
  listExit?(threadId: string): Promise<ListExit | null>;
  /** The user approved that exact request on the card. */
  unsubscribe?(
    threadId: string,
    approved: { method: "one_click" | "mailto"; target: string },
  ): Promise<{ ok: boolean; text: string }>;
  /** A Workflow started on the Thread by hand. */
  runWorkflow?(workflowId: string, threadId: string): Promise<void>;
  /** The Threads of a mailing list still in the Inbox, from the Cache's Facts. */
  listThreads?(listId: string): Promise<string[]>;
  /**
   * Why the last open left bodies missing: the Server did not answer
   * (offline), it is locked, or the read failed; null when nothing went
   * wrong. Changes reach watchMessages listeners. The reader words it.
   */
  unavailable(threadId: string): BodyUnavailable | null;
  /** Asks the Server for a Brief by hand ("or when the user asks"). Never throws. */
  requestBrief(threadId: string): Promise<void>;
  attachmentBytes(attachmentId: string): Promise<{ bytes: Uint8Array; mediaType: string }>;
}

export type BodyUnavailable = "offline" | "locked" | "failed";

export type Inbox = InboxActions & InboxSource & ThreadReader;

/* ------------------------------ Fixture implementation ------------------------------ */

interface Row {
  thread: Thread;
  deleted: boolean;
}

export interface FixtureInboxOptions {
  groups?: readonly Group[] | undefined;
  tags?: readonly Tag[] | undefined;
  /** The owner's address, for Sent. Defaults to the fixture Workspace's. */
  owner?: string | undefined;
}

export function fixtureInbox(
  seed: readonly Thread[] = fixtureThreads,
  options: FixtureInboxOptions = {},
): Inbox {
  const groupList = options.groups ?? fixtureGroups;
  const tagList = options.tags ?? fixtureTags;
  const rows = new Map<string, Row>();
  for (const t of seed) rows.set(t.id, { thread: structuredClone(t), deleted: false });
  const listeners = new Set<() => void>();
  const undos = new Map<UndoToken, Row[]>();
  const recommended = new Map<string, CachedRecommendations>();
  let tokenSeq = 0;
  let cache: readonly Thread[] | null = null;
  const folderCache = new Map<FolderKey, readonly Thread[]>();
  const owner = options.owner ?? "tejas@genai-labs.io";

  const emit = () => {
    cache = null;
    folderCache.clear();
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
    brief: (threadId) => briefOf(threadId),
    judgments: () => undefined,
    // The mock's chips as Recommended actions, so the fixture reader looks like the design.
    recommendations: (threadId) => {
      const r = fixtureRecommendations.find((x) => x.threadId === threadId);
      const t = rows.get(threadId)?.thread;
      if (!r || !t) return undefined;
      // One object per Thread version, so a subscriber reads a stable snapshot.
      const held = recommended.get(threadId);
      if (held && held.messageCount === t.messageCount) return held;
      const fresh = { actions: r.actions, messageCount: t.messageCount, fromDomain: null };
      recommended.set(threadId, fresh);
      return fresh;
    },
    unavailable: () => null,
    requestBrief: async () => {},
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
    folder(key) {
      let list = folderCache.get(key);
      if (!list) {
        const entries = [...rows.values()]
          .sort((a, b) => b.thread.lastActivity.localeCompare(a.thread.lastActivity))
          .map((r) => ({
            thread: r.thread,
            deleted: r.deleted,
            lastSender: messagesOf(r.thread.id).at(-1)?.from.email ?? null,
          }));
        list = folderThreads(key, entries, owner);
        folderCache.set(key, list);
      }
      return list;
    },
    groups: () => groupList,
    tags: () => tagList,
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
    setTags: (ids, tagIds) =>
      change(ids, (r) => {
        r.thread.tags = [...tagIds];
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
