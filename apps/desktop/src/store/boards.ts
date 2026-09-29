// The Cache's Boards (docs/spec/boards.md, "Data and sync"): `boards` mirrors
// each Board's current document, its place in the nav and the user's
// placements. The feed's `board` rows carry headers only (the documents are
// sealed on the Server) and mark a row's content stale; the Boards module
// reads GET /boards and writes the rows whole (boards/cache.ts). A Board's
// Lanes are computed on the Device from thread_signals and thread_facts in
// SQLite (boardThreadsSql), so opening a Board never waits on the network
// (ADR 0011) and works offline with the answers already there.

import type {
  Board,
  BoardChange,
  BoardDoc,
  BoardPlacement,
  BoardScopeFacts,
  BoardThread,
  Id,
  Thread,
} from "@monday/shared";
import type { Row, SqlParam, Statement } from "./driver.ts";
import { ALL_THREADS_SQL, rowSignals, rowToThread } from "./queries.ts";

export const BOARDS_SCHEMA_SQL = `
  create table if not exists boards (
    id text primary key,
    version integer not null default 0,
    pinned integer not null default 1,
    position integer not null default 0,
    deleted integer not null default 0,
    check_bar integer not null default 0,
    doc text,
    placements text not null default '{}',
    updated_at text not null default '',
    content_stale integer not null default 1
  );
`;

/** The Boards the nav and the screens read: not deleted, content read, in nav order. */
export const BOARDS_SQL =
  "select * from boards where deleted = 0 and doc is not null order by position, id";

/** A Board's headers from the feed: a newer row marks the content stale until GET /boards is read. */
export function boardUpsert(b: BoardChange): Statement {
  return {
    sql: `insert into boards (id, version, pinned, position, deleted, updated_at, content_stale)
          values (?, ?, ?, ?, ?, ?, 1)
          on conflict (id) do update set
            version = excluded.version, pinned = excluded.pinned, position = excluded.position,
            deleted = excluded.deleted,
            content_stale = case when excluded.updated_at > boards.updated_at then 1 else boards.content_stale end,
            updated_at = max(boards.updated_at, excluded.updated_at)`,
    params: [b.id, b.version, b.pinned ? 1 : 0, b.position, b.deleted ? 1 : 0, b.updatedAt],
  };
}

/** The Cache after a full read of the Server's list: every Board written whole, the rest marked deleted. */
export function boardStatements(boards: readonly Board[]): Statement[] {
  const out: Statement[] = boards.map((b) => ({
    sql: `insert into boards (id, version, pinned, position, deleted, check_bar, doc, placements, updated_at, content_stale)
          values (?, ?, ?, ?, 0, ?, ?, ?, ?, 0)
          on conflict (id) do update set version = excluded.version, pinned = excluded.pinned,
            position = excluded.position, deleted = 0, check_bar = excluded.check_bar, doc = excluded.doc,
            placements = excluded.placements, updated_at = excluded.updated_at, content_stale = 0`,
    params: [
      b.id,
      b.version,
      b.pinned ? 1 : 0,
      b.position,
      b.checkBar ? 1 : 0,
      JSON.stringify(b.doc),
      JSON.stringify(b.placements),
      b.updatedAt,
    ],
  }));
  const ids = boards.map((b) => b.id);
  out.push(
    ids.length === 0
      ? { sql: "update boards set deleted = 1, content_stale = 0", params: [] }
      : {
          sql: `update boards set deleted = 1, content_stale = 0 where id not in (${ids.map(() => "?").join(", ")})`,
          params: ids,
        },
  );
  return out;
}

const json = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string" || value === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

/** A Board row as the screens read it; null when its content was never read. */
export function rowToBoard(r: Row, workspaceId: Id): Board | null {
  const doc = json<BoardDoc | null>(r.doc, null);
  if (!doc) return null;
  return {
    id: String(r.id),
    workspaceId,
    version: Number(r.version ?? doc.version),
    pinned: r.pinned === 1,
    position: Number(r.position ?? 0),
    deletedAt: r.deleted === 1 ? String(r.updated_at ?? "") : null,
    createdAt: "",
    updatedAt: String(r.updated_at ?? ""),
    doc,
    placements: json<Record<Id, BoardPlacement>>(r.placements, {}),
    checkBar: r.check_bar === 1,
  };
}

/** A Thread on a Board: what the Board code reads and the Thread the row renders. */
export type CachedBoardThread = BoardThread & { thread: Thread };

/**
 * The Threads a Board looks at, newest first, as one query over the Cache:
 * each Thread row with its Signal answers (`j_signals`), its clear Facts,
 * who started it and every address it was sent to. SQL narrows by the
 * scope's folder and date; the exact addresses and the Lanes are decided by
 * the Board code over these rows.
 */
export function boardThreadsSql(
  facts: BoardScopeFacts,
  since: Date | null,
  limit: number,
): { sql: string; params: SqlParam[] } {
  const where: string[] = ["t.deleted = 0"];
  const params: SqlParam[] = [];
  const folder = facts.folder ?? "inbox";
  if (folder === "inbox") where.push("t.archived = 0 and t.snoozed_until is null");
  else if (folder === "archive") where.push("t.archived = 1");
  else if (folder.startsWith("group:")) {
    where.push("(t.group_id = ? or t.subgroup_id = ?)");
    const g = folder.slice("group:".length);
    params.push(g, g);
  } else if (folder.startsWith("section:")) {
    where.push("t.section = ? and t.archived = 0 and t.snoozed_until is null");
    params.push(folder.slice("section:".length));
  }
  if (since) {
    where.push("t.last_activity >= ?");
    params.push(since.toISOString());
  }
  const at = ALL_THREADS_SQL.lastIndexOf("order by");
  const sql = `select * from (${ALL_THREADS_SQL.slice(0, at).replace(
    "select ",
    `select
    (select json_extract(m.sender, '$.email') from messages m where m.thread_id = t.id order by m.date asc, m.id asc limit 1) as first_from,
    (select min(m.date) from messages m where m.thread_id = t.id) as received,
    (select group_concat(lower(json_extract(r.value, '$.email')), ' ')
       from messages m, json_each(m.recipients) r where m.thread_id = t.id) as to_emails,
    (select group_concat(lower(json_extract(r.value, '$.email')), ' ')
       from messages m, json_each(m.cc) r where m.thread_id = t.id) as cc_emails,
    f.facts as f_facts,
    `,
  )} left join thread_facts f on f.thread_id = t.id where ${where.join(" and ")} ${ALL_THREADS_SQL.slice(at)} limit ${Math.max(1, Math.floor(limit))})`;
  return { sql, params };
}

/** One row of boardThreadsSql as the Board code and the row read it. */
export function rowToBoardThread(r: Row, workspaceId: Id): CachedBoardThread {
  const thread = rowToThread(r, workspaceId);
  const words = (v: unknown) =>
    typeof v === "string" && v !== "" ? v.split(" ").filter(Boolean) : [];
  return {
    id: thread.id,
    messageCount: thread.messageCount,
    lastActivity: thread.lastActivity,
    receivedAt: typeof r.received === "string" ? r.received : null,
    unread: thread.unread,
    starred: thread.starred,
    archived: thread.archived,
    deleted: r.deleted === 1,
    snoozed: thread.snoozedUntil !== null,
    group: thread.group,
    subgroup: thread.subgroup,
    section: thread.section,
    hasAttachments: thread.hasAttachments,
    from: typeof r.first_from === "string" ? r.first_from.toLowerCase() : null,
    recipients: [...words(r.to_emails), ...words(r.cc_emails)],
    facts: json<Record<string, unknown> | null>(r.f_facts, null),
    readings: rowSignals(r),
    thread,
  };
}
