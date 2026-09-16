// Provider credentials at rest: one encrypted object per Account, stored
// through the Mailstore's storeContent under the "credential" kind so the
// same envelope, key hierarchy and rotation cover them. The Account row keeps
// only an opaque reference.

import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { accountCredentials, accounts } from "../db/schema.ts";
import type { ContentStore } from "../mailstore/content.ts";
import type { Credentials, OAuthAuth } from "./types.ts";
import { ProviderError } from "./types.ts";

export interface CredentialStore {
  /** Encrypts and stores; returns the reference written to accounts.credentials_ref. */
  store(workspaceId: string, accountId: string, credentials: Credentials): Promise<string>;
  load(accountId: string): Promise<Credentials>;
  /** Forgets the credentials and clears the Account's reference. */
  clear(accountId: string): Promise<void>;
  /**
   * Persists refreshed OAuth tokens. The broker only knows the Auth, so the
   * Account is found by the address and issuer the tokens belong to; every
   * Account with those credentials (API and IMAP paths) is updated.
   */
  updateAuth(auth: OAuthAuth): Promise<number>;
}

export function createCredentialStore(db: Db, content: ContentStore): CredentialStore {
  const store: CredentialStore = {
    async store(workspaceId, accountId, credentials) {
      const ref = await content.storeContent(
        workspaceId,
        "credential",
        JSON.stringify(credentials),
      );
      const envelope = ref.chunks[0];
      if (!envelope || ref.chunks.length !== 1) throw new RangeError("credential envelope missing");
      const id = crypto.randomUUID();
      await db.transaction(async (tx) => {
        await tx
          .insert(accountCredentials)
          .values({ id, accountId, workspaceId, key: ref.key, dataEnc: envelope })
          .onConflictDoUpdate({
            target: accountCredentials.accountId,
            set: { key: ref.key, dataEnc: envelope, updatedAt: new Date() },
          });
        await tx
          .update(accounts)
          .set({ credentialsRef: accountId })
          .where(eq(accounts.id, accountId));
      });
      return accountId;
    },

    async load(accountId) {
      const row = await db.query.accountCredentials.findFirst({
        where: eq(accountCredentials.accountId, accountId),
      });
      if (!row) throw new ProviderError(`no credentials for account ${accountId}`, "auth");
      const text = await content.readText({
        workspaceId: row.workspaceId,
        kind: "credential",
        key: row.key,
        chunks: [row.dataEnc],
        size: -1,
      });
      return JSON.parse(text) as Credentials;
    },

    async clear(accountId) {
      await db.transaction(async (tx) => {
        await tx.delete(accountCredentials).where(eq(accountCredentials.accountId, accountId));
        await tx.update(accounts).set({ credentialsRef: null }).where(eq(accounts.id, accountId));
      });
    },

    async updateAuth(auth) {
      const rows = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(sql`lower(${accounts.address}) = ${auth.user.toLowerCase()}`);
      let updated = 0;
      for (const row of rows) {
        let current: Credentials;
        try {
          current = await store.load(row.id);
        } catch {
          continue;
        }
        if (current.auth.kind !== "oauth" || current.auth.issuer !== auth.issuer) continue;
        // Only the tokens move; the client registration and the endpoint stay.
        const next: Credentials = {
          ...current,
          auth: {
            ...current.auth,
            accessToken: auth.accessToken,
            ...(auth.refreshToken ? { refreshToken: auth.refreshToken } : {}),
            ...(auth.expiresAt ? { expiresAt: auth.expiresAt } : {}),
          },
        };
        const cred = await db.query.accountCredentials.findFirst({
          where: eq(accountCredentials.accountId, row.id),
        });
        if (!cred) continue;
        await store.store(cred.workspaceId, row.id, next);
        updated += 1;
      }
      return updated;
    },
  };
  return store;
}
