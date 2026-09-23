// The Mail folders the stream shows beside the Inbox (docs/spec/inbox.md):
// Starred, Snoozed, Sent and Archive are the same Cache rows under another
// filter, so they are pure functions over what the Inbox seam already holds.
// Drafts are the composer's, not Threads, and have their own screen.

import type { Thread } from "@monday/shared";

/** The folders the stream renders through its `folder` lens. */
export const STREAM_FOLDERS = ["starred", "snoozed", "sent", "archive"] as const;
export type FolderKey = (typeof STREAM_FOLDERS)[number];

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
