// Storage route (docs/spec/settings.md "Sync server"): what the Server holds.
//   GET /storage   {messages, bytes}   message count and the database's size on disk

import { sql } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../auth/middleware.ts";
import type { Db } from "../db/client.ts";
import { messages } from "../db/schema.ts";

export function storageRoutes(db: Db): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/storage", async (c) => {
    const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(messages);
    const rows = (await db.execute(
      sql`select pg_database_size(current_database())::text as bytes`,
    )) as unknown as Array<{ bytes: string }>;
    return c.json({ messages: count?.n ?? 0, bytes: Number(rows[0]?.bytes ?? 0) });
  });

  return app;
}
