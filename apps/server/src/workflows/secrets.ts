// Workflow integration secrets (the hardening follow-up on the record): the
// Slack token or webhook URL, the Discord webhook URL, the Notion and Drive
// tokens and the plain webhook's bearer live as sealed rows, one per
// integration, under the envelope as the "integration" kind, exactly like a
// shared provider key (intelligence/keys.ts). The workflows.integrations
// Setting says only which integrations are set up, so the plaintext
// settings table never holds anything that opens a third party. list()
// never decrypts, so a locked Server still knows what is configured; load()
// needs the root key.
//
// Rows written before migration 0014 lived inside the Setting; adopt() moves
// them here once the Server is unlocked and rewrites the Setting to flags.

import type { Integration } from "@monday/shared";
import { INTEGRATIONS } from "@monday/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { integrationSecrets, settings } from "../db/schema.ts";
import type { ContentStore } from "../mailstore/content.ts";

export const INTEGRATIONS_SETTING = "workflows.integrations";

/** What one integration needs to post; either field may be absent. */
export interface IntegrationSecret {
  webhookUrl?: string | undefined;
  token?: string | undefined;
}

/** Which integrations hold a secret, as the Setting carries it. */
export type IntegrationFlags = Partial<Record<Integration, boolean>>;

export interface IntegrationSecretStore {
  /** Seals and stores; replaces the earlier secret. Throws LockedError. */
  put(workspaceId: string, integration: Integration, secret: IntegrationSecret): Promise<void>;
  remove(integration: Integration): Promise<void>;
  /** The integrations with a secret, in catalog order. Works locked. */
  list(): Promise<Integration[]>;
  /** The secret in the clear, or null when none is stored. Throws LockedError. */
  load(integration: Integration): Promise<IntegrationSecret | null>;
  /** Every secret in the clear, by integration. Throws LockedError. */
  loadAll(): Promise<Partial<Record<Integration, IntegrationSecret>>>;
  /**
   * Moves secrets still inside the workflows.integrations Setting (rows from
   * before migration 0014) into sealed rows under `workspaceId`, and rewrites
   * the Setting to flags. Returns how many integrations it moved. Needs the
   * root key; a Setting already in the flag shape is left alone.
   */
  adopt(workspaceId: string): Promise<number>;
}

function isIntegration(value: string): value is Integration {
  return (INTEGRATIONS as readonly string[]).includes(value);
}

/** The strings a legacy Setting value holds per integration, if any. */
export function legacySecretsOf(value: unknown): Partial<Record<Integration, IntegrationSecret>> {
  const out: Partial<Record<Integration, IntegrationSecret>> = {};
  if (!value || typeof value !== "object") return out;
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!isIntegration(name) || !entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const secret: IntegrationSecret = {};
    if (typeof e.webhookUrl === "string" && e.webhookUrl.trim()) secret.webhookUrl = e.webhookUrl;
    if (typeof e.token === "string" && e.token.trim()) secret.token = e.token;
    if (secret.webhookUrl || secret.token) out[name] = secret;
  }
  return out;
}

export function createIntegrationSecretStore(
  db: Db,
  content: ContentStore,
  options: { now?: () => Date } = {},
): IntegrationSecretStore {
  const now = options.now ?? (() => new Date());

  /** Rewrites the Setting to the flags the rows imply, so clients know what is set up. */
  const writeFlags = async (): Promise<void> => {
    const flags: IntegrationFlags = {};
    for (const integration of await store.list()) flags[integration] = true;
    await db
      .insert(settings)
      .values({
        scope: "global",
        deviceId: null,
        key: INTEGRATIONS_SETTING,
        value: flags,
        updatedAt: now(),
      })
      .onConflictDoUpdate({
        target: [settings.scope, settings.deviceId, settings.key],
        set: { value: flags, updatedAt: now() },
      });
  };

  const store: IntegrationSecretStore = {
    async put(workspaceId, integration, secret) {
      const clean: IntegrationSecret = {
        ...(secret.webhookUrl?.trim() ? { webhookUrl: secret.webhookUrl.trim() } : {}),
        ...(secret.token?.trim() ? { token: secret.token.trim() } : {}),
      };
      if (!clean.webhookUrl && !clean.token) {
        await store.remove(integration);
        return;
      }
      const ref = await content.storeContent(workspaceId, "integration", JSON.stringify(clean));
      const envelope = ref.chunks[0];
      if (!envelope || ref.chunks.length !== 1)
        throw new RangeError("integration envelope missing");
      await db
        .insert(integrationSecrets)
        .values({ integration, workspaceId, key: ref.key, dataEnc: envelope, updatedAt: now() })
        .onConflictDoUpdate({
          target: integrationSecrets.integration,
          set: { workspaceId, key: ref.key, dataEnc: envelope, updatedAt: now() },
        });
      await writeFlags();
    },

    async remove(integration) {
      await db.delete(integrationSecrets).where(eq(integrationSecrets.integration, integration));
      await writeFlags();
    },

    async list() {
      const rows = await db
        .select({ integration: integrationSecrets.integration })
        .from(integrationSecrets);
      const present = new Set(rows.map((r) => r.integration));
      return INTEGRATIONS.filter((i) => present.has(i));
    },

    async load(integration) {
      const row = await db.query.integrationSecrets.findFirst({
        where: eq(integrationSecrets.integration, integration),
      });
      if (!row) return null;
      return JSON.parse(
        await content.readText({
          workspaceId: row.workspaceId,
          kind: "integration",
          key: row.key,
          chunks: [row.dataEnc],
          size: -1,
        }),
      ) as IntegrationSecret;
    },

    async loadAll() {
      const out: Partial<Record<Integration, IntegrationSecret>> = {};
      for (const integration of await store.list()) {
        const secret = await store.load(integration);
        if (secret) out[integration] = secret;
      }
      return out;
    },

    async adopt(workspaceId) {
      const row = await db.query.settings.findFirst({
        where: and(
          eq(settings.scope, "global"),
          isNull(settings.deviceId),
          eq(settings.key, INTEGRATIONS_SETTING),
        ),
      });
      if (!row) return 0;
      const legacy = legacySecretsOf(row.value);
      const names = Object.keys(legacy) as Integration[];
      for (const integration of names) {
        const secret = legacy[integration];
        if (secret) await store.put(workspaceId, integration, secret);
      }
      // A Setting still holding strings (an integration with nothing usable) becomes flags too.
      const flagsOnly =
        row.value &&
        typeof row.value === "object" &&
        Object.values(row.value as Record<string, unknown>).every((v) => typeof v === "boolean");
      if (!flagsOnly || names.length > 0) await writeFlags();
      return names.length;
    },
  };
  return store;
}
