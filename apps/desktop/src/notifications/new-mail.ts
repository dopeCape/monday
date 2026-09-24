// New mail, told as it arrives in any Workspace: every Workspace's Store stays
// open and syncing (store/pool.ts), and each Message new to its Cache is a
// candidate. Only recent ones count (a first pull or a catch-up brings old
// mail too), only unread Threads in the Inbox (not archived, snoozed or
// deleted), not the Account's own sends, and not bulk mail unless the Setting
// says so. Several at once are one notice. While the window is in front and
// showing that Workspace the list itself shows the mail, so nothing pops up.

import type { Settings } from "@monday/shared";
import type { NewMessage, Store } from "../store/store.ts";

export type NewMailSettings = Pick<
  Settings,
  | "notifications.enabled"
  | "notifications.new_mail"
  | "notifications.new_mail_bulk"
  | "notifications.new_mail_recent_minutes"
  | "strings.notifications.new_mail_many"
>;

export interface NewMailNotice {
  workspaceId: string;
  title: string;
  body: string;
}

interface ThreadRow {
  id: string;
  subject: string;
  unread: number;
  archived: number;
  deleted: number;
  snoozed_until: string | null;
  bulk: number;
}

/** Which of these Messages to tell about, and in what words; null for none. */
export async function newMailNotice(input: {
  workspaceId: string;
  /** The Workspace's own address: its sends are never news. */
  address: string;
  messages: readonly NewMessage[];
  store: Pick<Store, "query">;
  settings: NewMailSettings;
  now: Date;
}): Promise<NewMailNotice | null> {
  const { settings: s } = input;
  if (!s["notifications.enabled"] || !s["notifications.new_mail"]) return null;
  const since = input.now.getTime() - s["notifications.new_mail_recent_minutes"] * 60_000;
  const own = input.address.toLowerCase();
  const recent = input.messages.filter(
    (m) => Date.parse(m.date) >= since && m.from.email.toLowerCase() !== own,
  );
  if (recent.length === 0) return null;
  const ids = [...new Set(recent.map((m) => m.threadId))];
  const rows = await input.store.query<ThreadRow>(
    `select id, subject, unread, archived, deleted, snoozed_until, bulk from threads where id in (${ids
      .map(() => "?")
      .join(", ")})`,
    ids,
  );
  const inbox = new Map(
    rows
      .filter(
        (t) =>
          t.unread &&
          !t.archived &&
          !t.deleted &&
          !t.snoozed_until &&
          (s["notifications.new_mail_bulk"] || !t.bulk),
      )
      .map((t) => [t.id, t]),
  );
  const told = recent.filter((m) => inbox.has(m.threadId));
  if (told.length === 0) return null;
  const first = told[told.length - 1];
  if (told.length === 1 && first) {
    const thread = inbox.get(first.threadId);
    return {
      workspaceId: input.workspaceId,
      title: first.from.name || first.from.email,
      body: thread?.subject ?? "",
    };
  }
  return {
    workspaceId: input.workspaceId,
    title: s["strings.notifications.new_mail_many"].replace("{n}", String(told.length)),
    body: input.address,
  };
}
