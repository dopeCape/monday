// The Threads a Sort scope holds (packages/shared routing/scope.ts), as
// queries over the Inbox: every Thread of the Workspace that is neither
// archived nor deleted, newest first by last activity then id, the order
// the list shows and the threads_list_idx index serves. A date scope is a
// lower bound on last activity, resolved once against the clock; a count
// scope is a limit on the walk.

import type { SortScope } from "@monday/shared";
import { scopeLimit, scopeStart } from "@monday/shared";
import { and, desc, eq, gt, gte, lt, lte, or, type SQL, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { threads } from "../../db/schema.ts";

export interface ResolvedScope {
  /** The oldest last activity in scope; null for a count scope or everything. */
  since: Date | null;
  /** The count of a "latest N" scope; null otherwise. */
  limit: number | null;
}

export function resolveScope(scope: SortScope, now: Date): ResolvedScope {
  return { since: scopeStart(scope, now), limit: scopeLimit(scope) };
}

/** A place in the newest-first order. */
export interface Cursor {
  at: Date;
  id: string;
}

type ThreadRow = typeof threads.$inferSelect;

/** The Inbox of a Workspace inside a date bound. */
export function inboxInScope(workspaceId: string, since: Date | null): SQL {
  const conditions: SQL[] = [
    eq(threads.workspaceId, workspaceId),
    eq(threads.archived, false),
    eq(threads.deleted, false),
  ];
  if (since) conditions.push(gte(threads.lastActivity, since));
  return and(...conditions) ?? sql`true`;
}

/** Strictly older than a cursor in the newest-first order. */
export function below(c: Cursor): SQL {
  return (
    or(lt(threads.lastActivity, c.at), and(eq(threads.lastActivity, c.at), lt(threads.id, c.id))) ??
    sql`false`
  );
}

/** At or older than a cursor. */
export function atOrBelow(c: Cursor): SQL {
  return (
    or(
      lt(threads.lastActivity, c.at),
      and(eq(threads.lastActivity, c.at), lte(threads.id, c.id)),
    ) ?? sql`false`
  );
}

/** Strictly newer than a cursor. */
export function above(c: Cursor): SQL {
  return (
    or(gt(threads.lastActivity, c.at), and(eq(threads.lastActivity, c.at), gt(threads.id, c.id))) ??
    sql`false`
  );
}

/** How many Threads the scope holds now, capped at a count scope's count. */
export async function countInScope(db: Db, workspaceId: string, r: ResolvedScope): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(threads)
    .where(inboxInScope(workspaceId, r.since));
  const n = row?.n ?? 0;
  return r.limit === null ? n : Math.min(n, r.limit);
}

/** The newest Threads in scope, optionally only those at or below a cursor, newest first. */
export async function pageInScope(
  db: Db,
  workspaceId: string,
  r: ResolvedScope,
  options: { limit: number; below?: Cursor | null; atOrBelow?: Cursor | null },
): Promise<ThreadRow[]> {
  const conditions: SQL[] = [inboxInScope(workspaceId, r.since)];
  if (options.below) conditions.push(below(options.below));
  if (options.atOrBelow) conditions.push(atOrBelow(options.atOrBelow));
  if (options.limit <= 0) return [];
  return db
    .select()
    .from(threads)
    .where(and(...conditions))
    .orderBy(desc(threads.lastActivity), desc(threads.id))
    .limit(options.limit);
}

/** The newest Thread in the Inbox now, where a walk starts. */
export async function newestInScope(
  db: Db,
  workspaceId: string,
  r: ResolvedScope,
): Promise<Cursor | null> {
  const [row] = await db
    .select({ at: threads.lastActivity, id: threads.id })
    .from(threads)
    .where(inboxInScope(workspaceId, r.since))
    .orderBy(desc(threads.lastActivity), desc(threads.id))
    .limit(1);
  return row ? { at: row.at, id: row.id } : null;
}
