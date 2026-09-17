// Shared provider keys (ADR 0007, "Hosted keys per device unless explicitly
// shared with the Server, then stored under the envelope"). A key arrives
// when the user turns on "Let the server use this key"; it is sealed as a
// "credential" object under the Workspace the Device was showing and kept
// one row per provider. list() never decrypts, so a locked Server can still
// say which providers have a key; load() needs the root key.

import type { HostedProvider } from "@monday/shared";
import { HOSTED_PROVIDERS } from "@monday/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { providerKeys } from "../db/schema.ts";
import type { ContentStore } from "../mailstore/content.ts";

export interface ProviderKeyStore {
  /** Seals and stores; replaces an earlier key for the provider. Throws LockedError. */
  put(workspaceId: string, provider: HostedProvider, key: string): Promise<void>;
  remove(provider: HostedProvider): Promise<void>;
  /** Providers with a shared key, in the schema's provider order. Works locked. */
  list(): Promise<HostedProvider[]>;
  /** The key in the clear, or null when none is shared. Throws LockedError. */
  load(provider: HostedProvider): Promise<string | null>;
}

export function createProviderKeyStore(db: Db, content: ContentStore): ProviderKeyStore {
  return {
    async put(workspaceId, provider, key) {
      const ref = await content.storeContent(workspaceId, "credential", key);
      const envelope = ref.chunks[0];
      if (!envelope || ref.chunks.length !== 1) throw new RangeError("credential envelope missing");
      await db
        .insert(providerKeys)
        .values({ provider, workspaceId, key: ref.key, dataEnc: envelope })
        .onConflictDoUpdate({
          target: providerKeys.provider,
          set: { workspaceId, key: ref.key, dataEnc: envelope, updatedAt: new Date() },
        });
    },

    async remove(provider) {
      await db.delete(providerKeys).where(eq(providerKeys.provider, provider));
    },

    async list() {
      const rows = await db.select({ provider: providerKeys.provider }).from(providerKeys);
      const present = new Set(rows.map((r) => r.provider));
      return HOSTED_PROVIDERS.filter((p) => present.has(p));
    },

    async load(provider) {
      const row = await db.query.providerKeys.findFirst({
        where: eq(providerKeys.provider, provider),
      });
      if (!row) return null;
      return content.readText({
        workspaceId: row.workspaceId,
        kind: "credential",
        key: row.key,
        chunks: [row.dataEnc],
        size: -1,
      });
    },
  };
}
