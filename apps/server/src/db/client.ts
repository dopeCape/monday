// The shared query layer: drizzle over postgres.js. postgres.js runs on Bun,
// Node, Vercel and Netlify alike, so this file has no runtime-specific code
// (research 22, section 7.3).
//
// Two connection strings exist in Cloud modes: DATABASE_URL, pooled, for
// request handlers and Job steps; DATABASE_URL_UNPOOLED, direct, for
// migrations, LISTEN/NOTIFY and the database copy. A transaction-mode pooler
// (Neon's -pooler host, Supabase port 6543, PgBouncer) hands the connection
// back after every transaction, so prepared statements are turned off on a
// pooled URL: `pooledUrl` detects the common shapes and DATABASE_POOLED=1|0
// overrides the guess.

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema.ts";

export type Db = PostgresJsDatabase<typeof schema>;
/** What a db.transaction callback receives; accepts the same queries as Db. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface DbHandle {
  db: Db;
  sql: Sql;
  close(): Promise<void>;
}

export interface DbOptions {
  /** Pool size. Keep it small on serverless hosts. */
  max?: number;
  /** Transaction-mode poolers cannot hold prepared statements. */
  prepare?: boolean;
}

export function createDb(url: string, options: DbOptions = {}): DbHandle {
  const sql = postgres(url, {
    max: options.max ?? 4,
    prepare: options.prepare ?? true,
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  return {
    db,
    sql,
    close: () => sql.end({ timeout: 5 }),
  };
}

/**
 * Whether a connection string points at a transaction-mode pooler. Recognises
 * Neon (`-pooler` host), Supabase (Supavisor on port 6543, `pooler.supabase`
 * hosts), PgBouncer (`?pgbouncer=true`) and an explicit `?pooled=true`.
 */
export function pooledUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (host.includes("-pooler")) return true;
  if (host.includes("pooler.supabase")) return true;
  if (u.port === "6543") return true;
  const q = u.searchParams;
  if (q.get("pgbouncer") === "true" || q.get("pooled") === "true") return true;
  return false;
}

export interface ResolveDbOptions {
  /** `DATABASE_POOLED`: "1" or "true" forces pooled, "0" or "false" forces direct; anything else guesses. */
  pooledFlag?: string | undefined;
  /** A serverless host keeps one or two connections per instance. */
  serverless?: boolean;
  /** Pool size when not serverless. */
  max?: number;
}

/** The postgres.js options for a URL: small pools on serverless, no prepared statements when pooled. */
export function dbOptionsFor(url: string, options: ResolveDbOptions = {}): Required<DbOptions> {
  const flag = options.pooledFlag?.trim().toLowerCase();
  const pooled =
    flag === "1" || flag === "true"
      ? true
      : flag === "0" || flag === "false"
        ? false
        : pooledUrl(url);
  return {
    max: options.serverless ? 2 : (options.max ?? 4),
    prepare: !pooled,
  };
}

export { schema };
