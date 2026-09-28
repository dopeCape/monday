// The MCP Registry kept on the Server (docs/spec/settings.md "MCP servers").
// The registry's own `search` takes 10 to 30 seconds a query while a plain
// page of the list takes about one, so Connect a tool searches a copy in
// Postgres instead: a background pass fills it page by page (resuming where a
// stopped pass left off, so a serverless instance that dies part way loses
// nothing), then refreshes it with `updated_since` once the copy is older than
// workflows.mcp_registry.refresh_hours. Until the first fill has anything, a
// search asks the registry live, as before. The copy lives in the database,
// not in memory, so it costs the Sidecar nothing between searches.
//
// Ranking: every word must appear; then an exact short name, a name that
// starts with the query, a title that does, remote servers (they connect on
// any Server) and, last, the namespaces workflows.mcp_registry.demote names
// (hosted re-publishers that need their own key) sink below the rest.

import type { McpCatalogEntry } from "@monday/shared";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { mcpCatalog, mcpCatalogSync } from "../db/schema.ts";
import {
  catalogEntryOf,
  type FetchLike,
  type McpRegistry,
  McpRegistryOffError,
  McpRegistryUnavailableError,
} from "./mcp-registry.ts";

export interface McpCatalogSettings {
  enabled: boolean;
  url: string;
  results: number;
  refreshHours: number;
  demote: readonly string[];
  /** How long a search waits on the live registry while the copy lacks an answer; 0 never asks it. */
  liveWaitMs: number;
}

export interface McpCatalogStatus {
  count: number;
  complete: boolean;
  syncing: boolean;
  lastError: string | null;
}

export interface McpCatalog extends McpRegistry {
  status(): Promise<McpCatalogStatus>;
  /** Runs one pass now (fill, resume or refresh) unless one holds the lease; for tests and the kick. */
  syncOnce(): Promise<void>;
}

export interface McpCatalogOptions {
  db: Db;
  /** The live registry: the fallback while the copy is empty, and `get`. */
  live: McpRegistry;
  settings: () => Promise<McpCatalogSettings>;
  fetch?: FetchLike;
  now?: () => number;
  /** Page size of a pass; the registry allows up to 100. */
  pageSize?: number;
  /** How long a pass holds the lease before another may take over. */
  leaseMs?: number;
  log?: (message: string) => void;
}

const SYNC_ROW = 1;

export function createMcpCatalog(options: McpCatalogOptions): McpCatalog {
  const { db, live } = options;
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? (() => Date.now());
  const pageSize = options.pageSize ?? 100;
  const leaseMs = options.leaseMs ?? 10 * 60_000;
  const log = options.log ?? (() => {});
  let running: Promise<void> | null = null;

  const base = (url: string) => url.replace(/\/+$/, "");

  const readSync = async () =>
    (await db.select().from(mcpCatalogSync).where(eq(mcpCatalogSync.id, SYNC_ROW)))[0] ?? null;

  /** Takes the lease, starting over when the registry Setting names another source. */
  const takeLease = async (source: string) => {
    const at = new Date(now());
    await db
      .insert(mcpCatalogSync)
      .values({ id: SYNC_ROW, source })
      .onConflictDoNothing({ target: mcpCatalogSync.id });
    const row = await readSync();
    if (row && row.source !== source) {
      await db.delete(mcpCatalog);
      await db
        .update(mcpCatalogSync)
        .set({
          source,
          cursor: null,
          completeAt: null,
          passStartedAt: null,
          count: 0,
          lastError: null,
        })
        .where(eq(mcpCatalogSync.id, SYNC_ROW));
    }
    const taken = await db
      .update(mcpCatalogSync)
      .set({ leaseUntil: new Date(at.getTime() + leaseMs) })
      .where(
        and(
          eq(mcpCatalogSync.id, SYNC_ROW),
          or(isNull(mcpCatalogSync.leaseUntil), lt(mcpCatalogSync.leaseUntil, at)),
        ),
      )
      .returning();
    return taken[0] ?? null;
  };

  const upsert = async (entries: McpCatalogEntry[]) => {
    if (entries.length === 0) return;
    const at = new Date(now());
    await db
      .insert(mcpCatalog)
      .values(
        entries.map((e) => ({
          id: e.id,
          haystack: [e.id, e.title, e.description, e.publisher].join(" ").toLowerCase(),
          entry: e,
          remote: e.remote !== null,
          updatedAt: at,
        })),
      )
      .onConflictDoUpdate({
        target: mcpCatalog.id,
        set: {
          haystack: sql`excluded.haystack`,
          entry: sql`excluded.entry`,
          remote: sql`excluded.remote`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  };

  const fetchPage = async (url: string) => {
    let res: Response;
    try {
      res = await fetchImpl(url, { headers: { accept: "application/json" } });
    } catch (error) {
      throw new McpRegistryUnavailableError(error instanceof Error ? error.message : String(error));
    }
    if (!res.ok) throw new McpRegistryUnavailableError(`the registry answered ${res.status}`);
    const body = (await res.json()) as {
      servers?: unknown[];
      metadata?: { nextCursor?: string | null };
    };
    const seen = new Set<string>();
    const entries: McpCatalogEntry[] = [];
    for (const row of body.servers ?? []) {
      const entry = catalogEntryOf(row);
      if (!entry || seen.has(entry.id)) continue;
      seen.add(entry.id);
      entries.push(entry);
    }
    return { entries, next: body.metadata?.nextCursor ?? null };
  };

  const pass = async () => {
    const s = await options.settings();
    if (!s.enabled) return;
    const source = base(s.url);
    const lease = await takeLease(source);
    if (!lease) return;
    const started = new Date(now());
    // A first fill resumes at its cursor; a refresh asks only what changed since the last pass.
    const refreshing = lease.completeAt !== null;
    let cursor = refreshing ? null : lease.cursor;
    const since = refreshing ? lease.passStartedAt : null;
    try {
      for (;;) {
        const params = new URLSearchParams({ limit: String(pageSize), version: "latest" });
        if (cursor) params.set("cursor", cursor);
        if (since) params.set("updated_since", since.toISOString());
        const page = await fetchPage(`${source}/servers?${params}`);
        await upsert(page.entries);
        cursor = page.next;
        const count = Number(
          (await db.select({ n: sql<number>`count(*)` }).from(mcpCatalog))[0]?.n ?? 0,
        );
        await db
          .update(mcpCatalogSync)
          .set({
            // Only a first fill keeps its place; a refresh starts from its date again.
            cursor: refreshing ? null : cursor,
            count,
            lastError: null,
            leaseUntil: new Date(now() + leaseMs),
          })
          .where(eq(mcpCatalogSync.id, SYNC_ROW));
        if (!cursor || page.entries.length === 0) break;
      }
      await db
        .update(mcpCatalogSync)
        .set({
          completeAt: lease.completeAt ?? new Date(now()),
          passStartedAt: started,
          cursor: null,
          leaseUntil: null,
        })
        .where(eq(mcpCatalogSync.id, SYNC_ROW));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`mcp catalog: ${message}`);
      await db
        .update(mcpCatalogSync)
        .set({ lastError: message, leaseUntil: null })
        .where(eq(mcpCatalogSync.id, SYNC_ROW));
    }
  };

  const syncOnce = () => {
    running ??= pass().finally(() => {
      running = null;
    });
    return running;
  };

  /** Starts a pass in the background when the copy is unfinished or older than the Setting says. */
  const kick = async (s: McpCatalogSettings) => {
    const row = await readSync();
    const stale =
      !row ||
      row.source !== base(s.url) ||
      row.completeAt === null ||
      row.passStartedAt === null ||
      now() - row.passStartedAt.getTime() > s.refreshHours * 3_600_000;
    if (stale) void syncOnce();
  };

  const searchLocal = async (query: string, limit: number, demote: readonly string[]) => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    const q = words.join(" ");
    const short = sql`lower(split_part(${mcpCatalog.id}, '/', 2))`;
    const title = sql`lower(${mcpCatalog.entry}->>'title')`;
    const match = words.length
      ? sql.join(
          words.map((w) => sql`${mcpCatalog.haystack} like ${`%${escapeLike(w)}%`} escape '\\'`),
          sql` and `,
        )
      : sql`true`;
    const demoted = demote.length
      ? sql.join(
          demote.map((p) => sql`${mcpCatalog.id} like ${`${escapeLike(p)}%`} escape '\\'`),
          sql` or `,
        )
      : sql`false`;
    const score = q
      ? sql`(case when ${short} = ${q} then 100 else 0 end)
          + (case when ${short} like ${`${escapeLike(q)}%`} escape '\\' then 40 else 0 end)
          + (case when ${title} like ${`${escapeLike(q)}%`} escape '\\' then 30 else 0 end)
          + (case when ${short} like ${`%${escapeLike(q)}%`} escape '\\' then 10 else 0 end)
          + (case when ${mcpCatalog.remote} then 15 else 0 end)
          - (case when ${demoted} then 60 else 0 end)`
      : sql`(case when ${mcpCatalog.remote} then 15 else 0 end) - (case when ${demoted} then 60 else 0 end)`;
    const rows = await db
      .select({ entry: mcpCatalog.entry })
      .from(mcpCatalog)
      .where(match)
      .orderBy(sql`${score} desc`, sql`length(${mcpCatalog.id})`, mcpCatalog.id)
      .limit(limit);
    return rows.map((r) => r.entry);
  };

  return {
    async search(query, limit) {
      const s = await options.settings();
      if (!s.enabled) throw new McpRegistryOffError();
      const n = Math.max(1, Math.min(100, limit ?? s.results));
      await kick(s);
      const row = await readSync();
      const filled = row !== null && row.source === base(s.url) && row.count > 0;
      const local = filled ? await searchLocal(query, n, s.demote) : [];
      // Part way through the first fill, a word the copy does not hold yet may
      // still be found live, but only within liveWaitMs: the registry's own
      // search can take half a minute, and the copy's answer is never held up.
      if (local.length > 0 || row?.completeAt != null || s.liveWaitMs <= 0) return local;
      return (await withTimeout(live.search(query, n), s.liveWaitMs)) ?? local;
    },
    get: (id) => live.get(id),
    async status() {
      const row = await readSync();
      return {
        count: row?.count ?? 0,
        complete: row?.completeAt != null,
        syncing: running !== null,
        lastError: row?.lastError ?? null,
      };
    },
    syncOnce,
  };
}

/** The promise's value, or null once `ms` has passed; a failure also reads as null. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise.catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** A LIKE pattern's own wildcards, taken literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
