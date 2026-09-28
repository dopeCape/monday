// The Mail folders the stream shows beside the Inbox (docs/spec/inbox.md):
// Starred, Snoozed, Sent and Archive are the same Cache rows under another
// filter. The Store's seam reads each as its own bounded query (threadList),
// the Inbox and a Group lens too, and keeps a re-read row in the list by the
// same filter over the raw row; the fixture seam filters its rows with
// folderThreads. Drafts are the composer's, not Threads, and have their own
// screen.

import type { Thread } from "@monday/shared";
import type { Row } from "../../store/driver.ts";
import {
  INBOX_WHERE,
  LAST_SENDER_SQL,
  NEWEST_FIRST,
  type ThreadListQuery,
} from "../../store/queries.ts";
import {
  filteredQuery,
  filterKeepsRow,
  filterKeepsThread,
  parseFilterListKey,
  type ResolvedFilter,
} from "./list-filter.ts";

/** The folders the stream renders through its `folder` lens. */
export const STREAM_FOLDERS = ["starred", "snoozed", "sent", "archive"] as const;
export type FolderKey = (typeof STREAM_FOLDERS)[number];

/**
 * A Thread list the seam can hold in part: the Inbox, a Mail folder, the
 * Inbox within one Group, or one of those narrowed by the Filter menu
 * (`filter:` and the resolved filter, list-filter.ts).
 */
export type ThreadListKey = "inbox" | FolderKey | `group:${string}` | `filter:${string}`;

/** A Thread list as the Store's seam reads it: its SQL, and the same filter over a row and a Thread. */
export interface ThreadList {
  query: ThreadListQuery;
  /**
   * Whether a Cache row (as ALL_THREADS_SQL reads it) belongs in the list.
   * `held` says the list holds the row already, which a filtered list lets
   * keep its place when only a flag changed.
   */
  keepsRow(row: Row, held?: boolean): boolean;
  /** Whether a Thread an action just changed still belongs, before the Cache says so. */
  keepsThread(thread: Thread): boolean;
  /** Whether the list is a narrowed one, whose total the seam counts on its own. */
  filtered?: boolean;
}

const flag = (v: unknown) => v === 1 || v === true;
const inInboxRow = (r: Row) =>
  !flag(r.archived) && !flag(r.deleted) && (r.snoozed_until ?? null) === null;
const inInbox = (t: Thread) => !t.archived && t.snoozedUntil === null;

/** The SQL and the filters of one list; `owner` is the address Sent reads. */
export function threadList(key: ThreadListKey, owner: string): ThreadList {
  const narrowed = parseFilterListKey(key);
  if (narrowed) {
    const base = threadList(narrowed.base, owner);
    const f = narrowed.filter;
    const spanOnly: ResolvedFilter = {
      ...(f.from !== undefined ? { from: f.from } : {}),
      ...(f.to !== undefined ? { to: f.to } : {}),
    };
    return {
      query: filteredQuery(base.query, f),
      keepsRow: (r, held) => base.keepsRow(r, held) && filterKeepsRow(f, r, held === true),
      // An action changes flags, never senders or dates: a Thread the list
      // holds keeps its place until the filter changes, as long as the base
      // list still wants it.
      keepsThread: (t) => base.keepsThread(t) && filterKeepsThread(spanOnly, t),
      filtered: true,
    };
  }
  if (key.startsWith("group:")) {
    const id = key.slice("group:".length);
    return {
      query: {
        where: `${INBOX_WHERE} and (t.group_id = ? or t.subgroup_id = ?)`,
        params: [id, id],
        order: NEWEST_FIRST,
      },
      keepsRow: (r) => inInboxRow(r) && (r.group_id === id || r.subgroup_id === id),
      keepsThread: (t) => inInbox(t) && (t.group === id || t.subgroup === id),
    };
  }
  switch (key as "inbox" | FolderKey | `filter:${string}`) {
    case "inbox":
      return {
        query: { where: INBOX_WHERE, params: [], order: NEWEST_FIRST },
        keepsRow: inInboxRow,
        keepsThread: inInbox,
      };
    case "starred":
      return {
        query: { where: "t.starred = 1 and t.deleted = 0", params: [], order: NEWEST_FIRST },
        keepsRow: (r) => flag(r.starred) && !flag(r.deleted),
        keepsThread: (t) => t.starred,
      };
    case "snoozed":
      return {
        query: {
          where: "t.snoozed_until is not null and t.deleted = 0",
          params: [],
          order: [{ column: "snoozed_until", desc: false }, ...NEWEST_FIRST],
        },
        keepsRow: (r) => (r.snoozed_until ?? null) !== null && !flag(r.deleted),
        keepsThread: (t) => t.snoozedUntil !== null,
      };
    case "sent": {
      const me = owner.trim().toLowerCase();
      return {
        query: me
          ? {
              where: `lower(trim(coalesce(${LAST_SENDER_SQL}, ''))) = ? and t.deleted = 0`,
              params: [me],
              order: NEWEST_FIRST,
            }
          : { where: "0", params: [], order: NEWEST_FIRST },
        keepsRow: (r) =>
          me !== "" &&
          !flag(r.deleted) &&
          String(r.last_sender ?? "")
            .trim()
            .toLowerCase() === me,
        keepsThread: () => true,
      };
    }
    case "archive":
      return {
        query: { where: "t.archived = 1 and t.deleted = 0", params: [], order: NEWEST_FIRST },
        keepsRow: (r) => flag(r.archived) && !flag(r.deleted),
        keepsThread: (t) => t.archived,
      };
  }
  // A `filter:` key that does not parse names no list.
  return {
    query: { where: "0", params: [], order: NEWEST_FIRST },
    keepsRow: () => false,
    keepsThread: () => false,
    filtered: true,
  };
}

export function isStreamFolder(key: string): key is FolderKey {
  return (STREAM_FOLDERS as readonly string[]).includes(key);
}

/** One cached Thread as the folders read it: the row, the trash flag, the newest Message's sender. */
export interface FolderEntry {
  thread: Thread;
  deleted: boolean;
  lastSender: string | null;
}

/**
 * The Threads of a folder, from entries already newest first: Starred is
 * every starred Thread outside the trash, wherever it sits; Snoozed is every
 * snoozed Thread, the soonest to wake first; Sent is every Thread whose
 * newest Message is from the owner; Archive is every archived Thread.
 */
export function folderThreads(
  key: FolderKey,
  entries: readonly FolderEntry[],
  owner: string,
): Thread[] {
  const live = entries.filter((e) => !e.deleted);
  switch (key) {
    case "starred":
      return live.filter((e) => e.thread.starred).map((e) => e.thread);
    case "snoozed":
      return live
        .filter((e) => e.thread.snoozedUntil !== null)
        .map((e) => e.thread)
        .sort((a, b) => (a.snoozedUntil ?? "").localeCompare(b.snoozedUntil ?? ""));
    case "sent": {
      const me = owner.trim().toLowerCase();
      if (!me) return [];
      return live
        .filter((e) => (e.lastSender ?? "").trim().toLowerCase() === me)
        .map((e) => e.thread);
    }
    case "archive":
      return live.filter((e) => e.thread.archived).map((e) => e.thread);
  }
}
