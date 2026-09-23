// The OAuth app per sign-in provider (ADR 0008), app level: one Google app
// and one Microsoft app, which every Account of that provider signs in
// through. The wizard saves it the moment its live check passes, before any
// Account exists, so a failed sign-in, a Back or a closed window never loses
// it. The secret is sealed under the root key (there may be no Workspace key
// yet) with the provider bound as associated data; nothing that leaves this
// module in a view carries it. Servers from before the store kept the app
// only inside each Account's credentials; the first read of an empty store
// imports it from there.

import { eq } from "drizzle-orm";
import { open, seal } from "../../crypto/aead.ts";
import { type Keys, LockedError } from "../../crypto/keys.ts";
import type { Db } from "../../db/client.ts";
import { accounts, oauthApps } from "../../db/schema.ts";
import type { CredentialStore } from "../credentials.ts";
import type { OAuthClient } from "../types.ts";
import type { OAuthIssuerName } from "./issuers.ts";

export type AccountType = "personal" | "work";

/** What a caller may see of a saved app: never the secret, only whether one is kept. */
export interface OAuthAppView {
  provider: OAuthIssuerName;
  clientId: string;
  hasSecret: boolean;
  tenant: string | null;
  accountType: AccountType | null;
  projectId: string | null;
  pubsubTopic: string | null;
  updatedAt: string;
}

export interface OAuthAppInput {
  clientId: string;
  clientSecret?: string | null;
  tenant?: string | null;
  accountType?: AccountType | null;
  projectId?: string | null;
  pubsubTopic?: string | null;
}

/** The parts a later wizard step fills in without touching the credentials. */
export interface OAuthAppPatch {
  projectId?: string | null | undefined;
  pubsubTopic?: string | null | undefined;
}

/** What a sign-in needs: the client in the clear and Gmail's topic. */
export interface OAuthAppLoaded {
  client: OAuthClient;
  pubsubTopic: string | null;
}

export interface OAuthAppStore {
  /** The saved app without its secret, or null. Imports from an Account on first read of an empty store. */
  get(provider: OAuthIssuerName): Promise<OAuthAppView | null>;
  /** The saved app with its secret for a sign-in, or null. Throws LockedError when a secret is sealed and the Server is locked. */
  load(provider: OAuthIssuerName): Promise<OAuthAppLoaded | null>;
  /** Saves or replaces the app. Throws LockedError when a secret is given and the Server is locked. */
  put(provider: OAuthIssuerName, input: OAuthAppInput): Promise<OAuthAppView>;
  /** Changes the non-secret extras of a saved app; null when none is saved. */
  update(provider: OAuthIssuerName, patch: OAuthAppPatch): Promise<OAuthAppView | null>;
  remove(provider: OAuthIssuerName): Promise<boolean>;
}

/** Where an app saved before the store existed can be found: inside an Account's credentials. */
export type LegacyOAuthApps = (
  provider: OAuthIssuerName,
) => Promise<(OAuthAppInput & { clientSecret?: string | null }) | null>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const secretAad = (provider: OAuthIssuerName) => encoder.encode(`monday:oauth-app:${provider}`);

const blank = (v: string | null | undefined) => {
  const t = v?.trim();
  return t ? t : null;
};

interface Row {
  provider: OAuthIssuerName;
  clientId: string;
  secret: string | null;
  tenant: string | null;
  accountType: AccountType | null;
  projectId: string | null;
  pubsubTopic: string | null;
  updatedAt: Date;
}

function viewOf(row: Omit<Row, "secret"> & { hasSecret: boolean }): OAuthAppView {
  return {
    provider: row.provider,
    clientId: row.clientId,
    hasSecret: row.hasSecret,
    tenant: row.tenant,
    accountType: row.accountType,
    projectId: row.projectId,
    pubsubTopic: row.pubsubTopic,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function clientOf(row: Pick<Row, "clientId" | "secret" | "tenant">): OAuthClient {
  return {
    id: row.clientId,
    ...(row.secret ? { secret: row.secret } : {}),
    ...(row.tenant ? { tenant: row.tenant } : {}),
  };
}

/**
 * Imports a legacy app once, when the store has none for the provider. A
 * locked Server or an unreadable Account skips the import; the next read tries again.
 */
async function importLegacy(
  store: OAuthAppStore,
  provider: OAuthIssuerName,
  legacy: LegacyOAuthApps | undefined,
): Promise<OAuthAppView | null> {
  if (!legacy) return null;
  try {
    const found = await legacy(provider);
    if (!found) return null;
    return await store.put(provider, found);
  } catch (error) {
    if (error instanceof LockedError) return null;
    throw error;
  }
}

export interface OAuthAppStoreOptions {
  db: Db;
  keys: Keys;
  legacy?: LegacyOAuthApps;
}

export function createOAuthAppStore(options: OAuthAppStoreOptions): OAuthAppStore {
  const { db, keys } = options;
  const find = (provider: OAuthIssuerName) =>
    db.query.oauthApps.findFirst({ where: eq(oauthApps.provider, provider) });

  const store: OAuthAppStore = {
    async get(provider) {
      const row = await find(provider);
      if (!row) return importLegacy(store, provider, options.legacy);
      return viewOf({ ...row, hasSecret: row.secretEnc !== null });
    },

    async load(provider) {
      const row = await find(provider);
      if (!row) {
        if (!(await importLegacy(store, provider, options.legacy))) return null;
        return store.load(provider);
      }
      const secret = row.secretEnc
        ? decoder.decode(open(keys.rootKey(), row.secretEnc, secretAad(provider)))
        : null;
      return { client: clientOf({ ...row, secret }), pubsubTopic: row.pubsubTopic };
    },

    async put(provider, input) {
      const secret = blank(input.clientSecret);
      const values = {
        provider,
        clientId: input.clientId.trim(),
        secretEnc: secret
          ? seal(keys.rootKey(), encoder.encode(secret), secretAad(provider))
          : null,
        tenant: blank(input.tenant),
        accountType: input.accountType ?? null,
        projectId: blank(input.projectId),
        pubsubTopic: blank(input.pubsubTopic),
        updatedAt: new Date(),
      };
      await db
        .insert(oauthApps)
        .values(values)
        .onConflictDoUpdate({ target: oauthApps.provider, set: values });
      return viewOf({ ...values, hasSecret: secret !== null });
    },

    async update(provider, patch) {
      const set: Partial<typeof oauthApps.$inferInsert> = { updatedAt: new Date() };
      if (patch.projectId !== undefined) set.projectId = blank(patch.projectId);
      if (patch.pubsubTopic !== undefined) set.pubsubTopic = blank(patch.pubsubTopic);
      const rows = await db
        .update(oauthApps)
        .set(set)
        .where(eq(oauthApps.provider, provider))
        .returning();
      const row = rows[0];
      return row ? viewOf({ ...row, hasSecret: row.secretEnc !== null }) : null;
    },

    async remove(provider) {
      const rows = await db
        .delete(oauthApps)
        .where(eq(oauthApps.provider, provider))
        .returning({ provider: oauthApps.provider });
      return rows.length > 0;
    },
  };
  return store;
}

/** The same store in memory, for tests and servers without a database seam. */
export function createMemoryOAuthAppStore(
  options: { legacy?: LegacyOAuthApps; now?: () => Date } = {},
): OAuthAppStore {
  const rows = new Map<OAuthIssuerName, Row>();
  const now = options.now ?? (() => new Date());
  const view = (row: Row) => viewOf({ ...row, hasSecret: row.secret !== null });
  const store: OAuthAppStore = {
    async get(provider) {
      const row = rows.get(provider);
      if (!row) return importLegacy(store, provider, options.legacy);
      return view(row);
    },
    async load(provider) {
      let row = rows.get(provider);
      if (!row) {
        await importLegacy(store, provider, options.legacy);
        row = rows.get(provider);
      }
      return row ? { client: clientOf(row), pubsubTopic: row.pubsubTopic } : null;
    },
    async put(provider, input) {
      const row: Row = {
        provider,
        clientId: input.clientId.trim(),
        secret: blank(input.clientSecret),
        tenant: blank(input.tenant),
        accountType: input.accountType ?? null,
        projectId: blank(input.projectId),
        pubsubTopic: blank(input.pubsubTopic),
        updatedAt: now(),
      };
      rows.set(provider, row);
      return view(row);
    },
    async update(provider, patch) {
      const row = rows.get(provider);
      if (!row) return null;
      if (patch.projectId !== undefined) row.projectId = blank(patch.projectId);
      if (patch.pubsubTopic !== undefined) row.pubsubTopic = blank(patch.pubsubTopic);
      row.updatedAt = now();
      return view(row);
    },
    async remove(provider) {
      return rows.delete(provider);
    },
  };
  return store;
}

/** The API path for Google is Gmail, for Microsoft Graph; either may also be the IMAP path with XOAUTH2. */
const PROVIDER_KINDS = ["gmail", "graph", "imap"] as const;

/**
 * Finds the app an existing Account signed in through: the first Account of
 * the provider whose stored OAuth credentials carry a client. Reading the
 * credentials needs the Server unlocked; a locked one throws LockedError,
 * which the store treats as "not yet".
 */
export function legacyFromAccounts(db: Db, credentials: CredentialStore): LegacyOAuthApps {
  return async (provider) => {
    const rows = await db
      .select({ id: accounts.id, provider: accounts.provider, ref: accounts.credentialsRef })
      .from(accounts);
    for (const row of rows) {
      if (!row.ref || !(PROVIDER_KINDS as readonly string[]).includes(row.provider)) continue;
      let found: Awaited<ReturnType<CredentialStore["load"]>>;
      try {
        found = await credentials.load(row.id);
      } catch (error) {
        if (error instanceof LockedError) throw error;
        continue;
      }
      const auth = found.auth;
      if (auth.kind !== "oauth" || auth.issuer !== provider || !auth.client?.id) continue;
      const tenant = auth.client.tenant ?? null;
      const endpoint = found.endpoint as { kind: string; pubsubTopic?: string | null };
      return {
        clientId: auth.client.id,
        clientSecret: auth.client.secret ?? null,
        tenant,
        accountType:
          provider === "microsoft" ? (tenant === "consumers" ? "personal" : "work") : null,
        pubsubTopic: endpoint.kind === "gmail" ? (endpoint.pubsubTopic ?? null) : null,
      };
    }
    return null;
  };
}
