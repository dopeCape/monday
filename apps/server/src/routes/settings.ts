// Settings routes (ADR 0004). A Setting is global or per Device; the Device is
// the caller. Values are any JSON for now: the settings schema from
// packages/shared arrives on another branch and will validate keys here.
//   GET /settings           {global: {key: value}, device: {key: value}}
//   PUT /settings/:key      {value, scope?: "global" | "device"}
//   DELETE /settings/:key   ?scope=global|device

import { and, eq, isNull, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import { principalOf } from "../auth/middleware.ts";
import type { Db } from "../db/client.ts";
import { type SettingScope, settings } from "../db/schema.ts";
import { parseBody } from "./validate.ts";

const scope = z.enum(["global", "device"]).default("global");
const putBody = z.object({ value: z.json(), scope });
const key = z.string().min(1).max(200);

export function settingsRoutes(db: Db): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    const { deviceId } = principalOf(c);
    const rows = await db
      .select()
      .from(settings)
      .where(
        or(
          eq(settings.scope, "global"),
          and(eq(settings.scope, "device"), eq(settings.deviceId, deviceId)),
        ),
      );
    const global: Record<string, unknown> = {};
    const device: Record<string, unknown> = {};
    for (const row of rows) (row.scope === "global" ? global : device)[row.key] = row.value;
    return c.json({ global, device });
  });

  app.put("/:key", async (c) => {
    const k = key.safeParse(c.req.param("key"));
    if (!k.success) return c.json({ error: "invalid_key" }, 400);
    const body = await parseBody(c, putBody);
    if (!body.ok) return body.response;
    const { deviceId } = principalOf(c);
    const target: { scope: SettingScope; deviceId: string | null } =
      body.data.scope === "device"
        ? { scope: "device", deviceId }
        : { scope: "global", deviceId: null };
    await db
      .insert(settings)
      .values({ ...target, key: k.data, value: body.data.value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [settings.scope, settings.deviceId, settings.key],
        set: { value: body.data.value, updatedAt: new Date() },
      });
    return c.json({ key: k.data, scope: target.scope, value: body.data.value });
  });

  app.delete("/:key", async (c) => {
    const k = key.safeParse(c.req.param("key"));
    if (!k.success) return c.json({ error: "invalid_key" }, 400);
    const s = scope.safeParse(c.req.query("scope"));
    if (!s.success) return c.json({ error: "invalid_scope" }, 400);
    const { deviceId } = principalOf(c);
    const where =
      s.data === "device"
        ? and(
            eq(settings.scope, "device"),
            eq(settings.deviceId, deviceId),
            eq(settings.key, k.data),
          )
        : and(eq(settings.scope, "global"), isNull(settings.deviceId), eq(settings.key, k.data));
    await db.delete(settings).where(where);
    return c.body(null, 204);
  });

  return app;
}
