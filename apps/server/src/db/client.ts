// The shared query layer: drizzle over postgres.js. postgres.js runs on Bun,
// Node, Vercel and Netlify alike, so this file has no runtime-specific code
// (research 22, section 7.3).

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema.ts";

export type Db = PostgresJsDatabase<typeof schema>;

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

export { schema };
