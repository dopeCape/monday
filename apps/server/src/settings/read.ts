// Reads global Settings the Server itself acts on, typed by the schema and
// falling back to the shipped default (ADR 0004: every behavior is a Setting,
// never a constant). Runtime-neutral.

import { type SettingKey, type Settings, settingsSchema } from "@monday/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { settings } from "../db/schema.ts";

/** The named global Settings, each the stored value when it validates, else the default. */
export async function readGlobalSettings<K extends SettingKey>(
  db: Db,
  keys: readonly K[],
): Promise<Pick<Settings, K>> {
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = structuredClone(settingsSchema[key].default);
  if (keys.length === 0) return out as Pick<Settings, K>;
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.scope, "global"),
        isNull(settings.deviceId),
        inArray(settings.key, [...keys]),
      ),
    );
  for (const row of rows) {
    const key = row.key as K;
    const parsed = settingsSchema[key].type.safeParse(row.value);
    if (parsed.success) out[key] = parsed.data;
  }
  return out as Pick<Settings, K>;
}

/** One global Setting. */
export async function readGlobalSetting<K extends SettingKey>(
  db: Db,
  key: K,
): Promise<Settings[K]> {
  return (await readGlobalSettings(db, [key]))[key];
}
