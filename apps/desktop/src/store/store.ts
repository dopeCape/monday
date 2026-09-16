// The Store: the client's only data path (ADR 0009). Reads come from the
// Cache through query and live; writes go through intent, which applies the
// change locally, appends it to the Outbox and returns before any network
// call, so a row never flickers. sync drains the Outbox in order and pulls the
// Changes feed from the stored cursor; subscribe keeps a wake connection open
// with reconnect and backoff and syncs on every wake (ADR 0005).
//
// SQL lives here and in queries.ts; the driver underneath is three calls
// (driver.ts). Live queries re-run when a table they read is written; tables
// are found with a small parser over `from` and `join`, and every write path
// names the tables it touched.

import type { Actor, Change, Id, Intent, IntentArgs, IsoDate, ThreadChange } from "@monday/shared";
import { ApiError } from "../platform/api.ts";
import type { Row, SqlDriver, SqlParam, Statement } from "./driver.ts";
import schemaSql from "./schema.sql?raw";
import type { StoreTransport, WakeConnection } from "./transport.ts";

export type { Row, SqlDriver, SqlParam, Statement } from "./driver.ts";

export interface LiveQuery<T> {
  /** The latest rows; undefined until the first run has finished. */
  readonly rows: T[] | undefined;
  /** Called with the rows now (if any) and after every change. */
  subscribe(listener: (rows: T[]) => void): () => void;
  refresh(): Promise<T[]>;
  close(): void;
}

/** An intent as a screen raises it; the Store stamps time and actor. */
export type StoreIntent = IntentArgs & { threadId: Id; actor?: Actor; at?: IsoDate };

export interface SyncResult {
  /** Outbox rows the Server accepted this round (applied or not). */
  pushed: number;
  /** Changes applied to the Cache. */
  pulled: number;
  cursor: number;
  /** Outbox rows still waiting after a transient failure. */
  pending: number;
  error: Error | null;
}

export type StoreStatus = "offline" | "connecting" | "online" | "syncing";

export interface Store {
  readonly workspaceId: Id;
  query<T = Row>(sql: string, params?: SqlParam[]): Promise<T[]>;
  live<T = Row>(sql: string, params?: SqlParam[]): LiveQuery<T>;
  /** Applies locally, appends to the Outbox, returns. The network happens in sync. */
  intent(action: StoreIntent): Promise<void>;
  /** Drains the Outbox in order, then pulls the Changes feed from the cursor. Never throws. */
  sync(): Promise<SyncResult>;
  /** Connects the wake transport and syncs on each wake, reconnecting with backoff. */
  subscribe(): () => void;
  status(): StoreStatus;
  onStatus(listener: (status: StoreStatus) => void): () => void;
  close(): Promise<void>;
}

export interface StoreOptions {
  workspaceId: Id;
  driver: SqlDriver;
  transport: StoreTransport;
  now?: () => Date;
  /** Reconnect backoff bounds; small in tests. */
  backoff?: { minMs: number; maxMs: number };
  changesPageSize?: number;
  log?: (message: string) => void;
}

const CURSOR_KEY = "cursor";

/* ------------------------------ Tables ------------------------------ */

const READ_TABLE = /\b(?:from|join)\s+["`]?([a-z_][a-z0-9_]*)/gi;

/** The tables a statement reads, for live query invalidation. */
export function tablesRead(sql: string): Set<string> {
  const out = new Set<string>();
  for (const m of sql.matchAll(READ_TABLE)) {
    const name = m[1]?.toLowerCase();
    if (name && name !== "select") out.add(name);
  }
  return out;
}

const WRITE_TABLE =
  /\b(?:insert\s+(?:or\s+\w+\s+)?into|update|delete\s+from)\s+["`]?([a-z_][a-z0-9_]*)/gi;

/** The tables a statement writes; `threads` also touches its FTS index. */
export function tablesWritten(sql: string): Set<string> {
  const out = new Set<string>();
  for (const m of sql.matchAll(WRITE_TABLE)) {
    const name = m[1]?.toLowerCase();
    if (name) out.add(name);
  }
  if (out.has("threads")) out.add("threads_fts");
  return out;
}

/* ------------------------------ Local effects of an intent ------------------------------ */

/** The Cache statements that make an intent visible, before the Server has seen it. */
export function localStatements(intent: Intent): Statement[] {
  const set = (assignments: string, params: SqlParam[]): Statement => ({
    sql: `update threads set ${assignments}, updated_at = ? where id = ?`,
    params: [...params, intent.at, intent.threadId],
  });
  switch (intent.kind) {
    case "archive":
      return [set("archived = 1", [])];
    case "unarchive":
      return [set("archived = 0", [])];
    case "star":
      return [set("starred = 1", [])];
    case "unstar":
      return [set("starred = 0", [])];
    case "read":
      return [set("unread = 0", [])];
    case "unread":
      return [set("unread = 1", [])];
    case "snooze":
      return [set("snoozed_until = ?, archived = 1", [intent.until])];
    case "unsnooze":
      return [set("snoozed_until = null, archived = 0", [])];
    case "move":
      return [set("group_id = ?, subgroup_id = ?", [intent.group, intent.subgroup])];
    case "delete":
      return [set("deleted = 1", [])];
    case "tags":
      return [
        { sql: "delete from thread_tags where thread_id = ?", params: [intent.threadId] },
        ...[...new Set(intent.tags)].map((tagId) => ({
          sql: "insert or ignore into thread_tags (thread_id, tag_id) values (?, ?)",
          params: [intent.threadId, tagId],
        })),
      ];
  }
}

/* ------------------------------ Applying the feed ------------------------------ */

function threadUpsert(t: ThreadChange, at: IsoDate): Statement[] {
  return [
    {
      // Subject and snippet are content: a feed row fills them only while they are empty.
      sql: `insert into threads (id, subject, participants, last_activity, message_count, unread, starred,
              archived, deleted, snoozed_until, section, group_id, subgroup_id, has_attachments, snippet, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict (id) do update set
              subject = case when threads.subject = '' then excluded.subject else threads.subject end,
              participants = excluded.participants,
              last_activity = excluded.last_activity,
              message_count = excluded.message_count,
              unread = excluded.unread,
              starred = excluded.starred,
              archived = excluded.archived,
              deleted = excluded.deleted,
              snoozed_until = excluded.snoozed_until,
              section = excluded.section,
              group_id = excluded.group_id,
              subgroup_id = excluded.subgroup_id,
              has_attachments = excluded.has_attachments,
              snippet = case when threads.snippet = '' then excluded.snippet else threads.snippet end,
              updated_at = excluded.updated_at`,
      params: [
        t.id,
        t.subject,
        t.participants,
        t.lastActivity,
        t.messageCount,
        t.unread,
        t.starred,
        t.archived,
        t.deleted,
        t.snoozedUntil,
        t.section,
        t.group,
        t.subgroup,
        t.hasAttachments,
        t.snippet,
        at,
      ],
    },
    ...links("thread_tags", "tag_id", t.id, t.tags),
    ...links("thread_labels", "label_id", t.id, t.labels),
  ];
}

function links(table: string, column: string, threadId: Id, ids: Id[]): Statement[] {
  return [
    { sql: `delete from ${table} where thread_id = ?`, params: [threadId] },
    ...[...new Set(ids)].map((id) => ({
      sql: `insert or ignore into ${table} (thread_id, ${column}) values (?, ?)`,
      params: [threadId, id],
    })),
  ];
}

/** The Cache statements for one feed row. */
export function changeStatements(change: Change): Statement[] {
  switch (change.kind) {
    case "thread":
      return threadUpsert(change.payload, change.at);
    case "message": {
      const m = change.payload;
      return [
        {
          // Bodies arrive through the content route; a header row never clears them.
          sql: `insert into messages (id, thread_id, sender, recipients, cc, date, has_attachments)
                values (?, ?, ?, ?, ?, ?, ?)
                on conflict (id) do update set
                  thread_id = excluded.thread_id, sender = excluded.sender, recipients = excluded.recipients,
                  cc = excluded.cc, date = excluded.date, has_attachments = excluded.has_attachments`,
          params: [m.id, m.threadId, m.from, m.to, m.cc, m.date, m.hasAttachments],
        },
      ];
    }
    case "label":
      return [
        {
          sql: `insert into labels (id, name, provider_id) values (?, ?, ?)
                on conflict (id) do update set name = excluded.name, provider_id = excluded.provider_id`,
          params: [change.payload.id, change.payload.name, change.payload.providerId],
        },
      ];
    case "tag":
      return [
        {
          sql: "insert into tags (id, name) values (?, ?) on conflict (id) do update set name = excluded.name",
          params: [change.payload.id, change.payload.name],
        },
      ];
    case "thread_tags":
      return links("thread_tags", "tag_id", change.payload.threadId, change.payload.ids);
    case "thread_labels":
      return links("thread_labels", "label_id", change.payload.threadId, change.payload.ids);
  }
}

interface OutboxRow {
  seq: number;
  thread_id: string;
  kind: Intent["kind"];
  payload: string;
  at: string;
  actor: Actor;
  attempts: number;
}

function intentOf(row: OutboxRow): Intent {
  const args = JSON.parse(row.payload) as Record<string, unknown>;
  return {
    ...args,
    kind: row.kind,
    threadId: row.thread_id,
    at: row.at,
    actor: row.actor,
  } as Intent;
}

/* ------------------------------ The Store ------------------------------ */

export async function createStore(options: StoreOptions): Promise<Store> {
  const { workspaceId, driver, transport } = options;
  const now = options.now ?? (() => new Date());
  const backoff = options.backoff ?? { minMs: 1_000, maxMs: 30_000 };
  const pageSize = options.changesPageSize ?? 500;
  const log = options.log ?? (() => {});

  await driver.exec(schemaSql);

  /* Live queries */
  interface LiveEntry {
    tables: Set<string>;
    refresh: () => Promise<unknown>;
  }
  const lives = new Set<LiveEntry>();

  const invalidate = (tables: Iterable<string>) => {
    const touched = new Set(tables);
    for (const entry of lives) {
      for (const t of entry.tables) {
        if (touched.has(t)) {
          void entry.refresh();
          break;
        }
      }
    }
  };

  /** Every write goes through here so live queries learn what changed. */
  const write = async (statements: Statement[]) => {
    if (statements.length === 0) return;
    await driver.batch(statements);
    const touched = new Set<string>();
    for (const s of statements) for (const t of tablesWritten(s.sql)) touched.add(t);
    invalidate(touched);
  };

  const readCursor = async () => {
    const rows = await driver.query("select value from meta where key = ?", [CURSOR_KEY]);
    const value = rows[0]?.value;
    return typeof value === "string" ? Number(value) || 0 : 0;
  };

  /* Status */
  let status: StoreStatus = "offline";
  const statusListeners = new Set<(s: StoreStatus) => void>();
  const setStatus = (s: StoreStatus) => {
    if (s === status) return;
    status = s;
    for (const l of statusListeners) l(s);
  };

  /* Sync */
  let inflight: Promise<SyncResult> | null = null;
  let again = false;
  let closed = false;

  const pendingFor = async (threadIds: Iterable<Id>): Promise<Intent[]> => {
    const ids = [...new Set(threadIds)];
    if (ids.length === 0) return [];
    const rows = (await driver.query(
      `select * from outbox where thread_id in (${ids.map(() => "?").join(", ")}) order by seq`,
      ids,
    )) as unknown as OutboxRow[];
    return rows.map(intentOf);
  };

  const applyChanges = async (changes: Change[], cursor: number) => {
    const statements: Statement[] = [];
    for (const c of changes) statements.push(...changeStatements(c));
    // Intents still in the Outbox are the truth for their Threads until the
    // Server has them: replay their local effect over whatever the feed said.
    const touched = changes
      .filter((c) => c.kind === "thread" || c.kind === "thread_tags")
      .map((c) => (c.kind === "thread" ? c.payload.id : c.payload.threadId));
    for (const intent of await pendingFor(touched)) statements.push(...localStatements(intent));
    statements.push({
      sql: "insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value",
      params: [CURSOR_KEY, String(cursor)],
    });
    await write(statements);
  };

  const drainOutbox = async (result: SyncResult) => {
    const rows = (await driver.query(
      "select * from outbox order by seq",
    )) as unknown as OutboxRow[];
    for (const row of rows) {
      const intent = intentOf(row);
      try {
        const answer = await transport.intent(intent);
        if (!answer.applied) log(`intent ${row.kind} on ${row.thread_id} lost: ${answer.reason}`);
        await driver.exec("delete from outbox where seq = ?", [row.seq]);
        result.pushed += 1;
      } catch (error) {
        if (error instanceof ApiError && error.permanent) {
          log(`intent ${row.kind} on ${row.thread_id} rejected (${error.status}); dropped`);
          await driver.exec("delete from outbox where seq = ?", [row.seq]);
          continue;
        }
        await driver.exec(
          "update outbox set attempts = attempts + 1, last_error = ? where seq = ?",
          [error instanceof Error ? error.message : String(error), row.seq],
        );
        throw error;
      }
    }
    invalidate(["outbox"]);
  };

  const pullChanges = async (result: SyncResult) => {
    let cursor = await readCursor();
    for (;;) {
      const page = await transport.changes(workspaceId, cursor, pageSize);
      if (page.changes.length > 0) {
        await applyChanges(page.changes, page.cursor);
        result.pulled += page.changes.length;
      }
      cursor = page.cursor;
      result.cursor = cursor;
      if (page.changes.length < pageSize) break;
    }
  };

  const runSync = async (): Promise<SyncResult> => {
    const result: SyncResult = { pushed: 0, pulled: 0, cursor: 0, pending: 0, error: null };
    setStatus("syncing");
    try {
      await drainOutbox(result);
      await pullChanges(result);
      setStatus(connection ? "online" : "offline");
    } catch (error) {
      result.error = error instanceof Error ? error : new Error(String(error));
      setStatus("offline");
    }
    if (closed) return result;
    const pending = await driver.query("select count(*) as n from outbox");
    result.pending = Number(pending[0]?.n ?? 0);
    if (result.cursor === 0) result.cursor = await readCursor();
    return result;
  };

  const sync = (): Promise<SyncResult> => {
    if (closed) {
      return Promise.resolve({
        pushed: 0,
        pulled: 0,
        cursor: 0,
        pending: 0,
        error: new Error("store closed"),
      });
    }
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = (async () => {
      let result = await runSync();
      while (again) {
        again = false;
        result = await runSync();
      }
      inflight = null;
      return result;
    })();
    return inflight;
  };

  /* Wake */
  let connection: WakeConnection | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let subscribed = false;
  let attempt = 0;

  const connect = () => {
    if (!subscribed) return;
    setStatus("connecting");
    connection = transport.connect(workspaceId, {
      onOpen() {
        attempt = 0;
        setStatus("online");
        void sync();
      },
      onWake() {
        void sync();
      },
      onClose() {
        connection = null;
        if (!subscribed) return;
        setStatus("offline");
        const delay = Math.min(backoff.maxMs, backoff.minMs * 2 ** attempt) * (0.5 + Math.random());
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      },
    });
  };

  const disconnect = () => {
    subscribed = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    connection?.close();
    connection = null;
    setStatus("offline");
  };

  const store: Store = {
    workspaceId,

    query<T = Row>(sql: string, params?: SqlParam[]) {
      return driver.query(sql, params) as Promise<T[]>;
    },

    live<T = Row>(sql: string, params: SqlParam[] = []): LiveQuery<T> {
      const listeners = new Set<(rows: T[]) => void>();
      let rows: T[] | undefined;
      let last = "";
      let closed = false;
      let running: Promise<T[]> | null = null;
      let rerun = false;
      const run = async (): Promise<T[]> => {
        const next = (await driver.query(sql, params)) as T[];
        if (closed) return next;
        const key = JSON.stringify(next);
        if (rows === undefined || key !== last) {
          rows = next;
          last = key;
          for (const l of listeners) l(next);
        }
        return next;
      };
      const refresh = (): Promise<T[]> => {
        if (running) {
          rerun = true;
          return running;
        }
        running = (async () => {
          let out = await run();
          while (rerun && !closed) {
            rerun = false;
            out = await run();
          }
          running = null;
          return out;
        })();
        return running;
      };
      const entry: LiveEntry = { tables: tablesRead(sql), refresh };
      lives.add(entry);
      void refresh();
      return {
        get rows() {
          return rows;
        },
        subscribe(listener) {
          listeners.add(listener);
          if (rows !== undefined) listener(rows);
          return () => listeners.delete(listener);
        },
        refresh,
        close() {
          closed = true;
          lives.delete(entry);
          listeners.clear();
        },
      };
    },

    async intent(action) {
      const { threadId, actor, at, ...args } = action;
      const intent: Intent = {
        ...args,
        threadId,
        at: at ?? now().toISOString(),
        actor: actor ?? "user",
      } as Intent;
      const { kind, threadId: _t, at: _a, actor: _c, ...payload } = intent;
      await write([
        ...localStatements(intent),
        {
          sql: "insert into outbox (thread_id, kind, payload, at, actor) values (?, ?, ?, ?, ?)",
          params: [threadId, kind, payload, intent.at, intent.actor],
        },
      ]);
      // The row is already on screen; a subscribed Store tells the Server in the
      // background, an unsubscribed one (tests, offline by choice) waits for sync().
      if (subscribed) void sync();
    },

    sync,

    subscribe() {
      if (subscribed) return disconnect;
      subscribed = true;
      attempt = 0;
      connect();
      return disconnect;
    },

    status: () => status,

    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },

    async close() {
      disconnect();
      closed = true;
      for (const entry of [...lives]) lives.delete(entry);
      if (inflight) await inflight.catch(() => {});
      await driver.close();
    },
  };

  return store;
}
