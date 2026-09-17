// Global Settings as a Server module reads them (ADR 0004): the saved value
// when the schema accepts it, the shipped default otherwise. Device-scoped
// values are the client's business; a Server-side Task runs under the global
// ones. Modules take a `settings` function so tests hand in values directly.

import { type SettingKey, type Settings, settingsSchema, validateSetting } from "@monday/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { settings } from "../db/schema.ts";

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
        inArray(settings.key, keys as readonly string[] as string[]),
      ),
    );
  for (const row of rows) {
    const checked = validateSetting(row.key, row.value);
    if (checked.ok) out[row.key] = checked.value;
  }
  return out as Pick<Settings, K>;
}
