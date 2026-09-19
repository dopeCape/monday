// Accounts: adding one proves the credentials with a single connect, records
// the Provider's capabilities, creates the Workspace, stores the credentials
// through the envelope and starts the Account's Jobs. The OAuth finish route,
// the token paste and the IMAP form all end here.

import type { Account, AccountCapabilities, Provider as ProviderKind } from "@monday/shared";
import { eq } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { accounts, syncState, workspaces } from "./db/schema.ts";
import type { Mailstore } from "./mailstore/index.ts";
import type { CredentialStore } from "./providers/credentials.ts";
import type { ProviderRegistry } from "./providers/index.ts";
import type { Credentials } from "./providers/types.ts";

export interface AccountView {
  id: string;
  workspaceId: string;
  provider: ProviderKind;
  address: string;
  displayName: string;
  capabilities: AccountCapabilities;
  connected: boolean;
  lastSync: string | null;
  lastError: string | null;
}

export interface AddAccountInput {
  provider: ProviderKind;
  credentials: Credentials;
  displayName?: string;
}

export interface AccountService {
  list(): Promise<AccountView[]>;
  add(input: AddAccountInput): Promise<AccountView>;
  remove(accountId: string): Promise<boolean>;
}

export interface AccountServiceOptions {
  db: Db;
  mailstore: Mailstore;
  providers: ProviderRegistry;
  credentials: CredentialStore;
  /** Starts the Account's Jobs (sync, watch, reconcile, push registrations). */
  onAdded?: (accountId: string, provider: ProviderKind) => Promise<void>;
  /** Called before the rows go: stop the watcher, drop the Session, cancel the Account's Jobs. */
  onRemoving?: (accountId: string, provider: ProviderKind) => Promise<void>;
}

export function createAccountService(options: AccountServiceOptions): AccountService {
  const { db, mailstore, providers, credentials } = options;

  async function view(accountId: string): Promise<AccountView | null> {
    const [row] = await db
      .select({
        id: accounts.id,
        provider: accounts.provider,
        address: accounts.address,
        displayName: accounts.displayName,
        capabilities: accounts.capabilities,
        credentialsRef: accounts.credentialsRef,
        workspaceId: workspaces.id,
      })
      .from(accounts)
      .innerJoin(workspaces, eq(workspaces.accountId, accounts.id))
      .where(eq(accounts.id, accountId));
    if (!row) return null;
    const state = await db.query.syncState.findFirst({
      where: eq(syncState.workspaceId, row.workspaceId),
    });
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      provider: row.provider,
      address: row.address,
      displayName: row.displayName,
      capabilities: row.capabilities,
      connected: row.credentialsRef !== null,
      lastSync: state?.lastReconcile?.toISOString() ?? null,
      lastError: state?.lastError ?? null,
    };
  }

  return {
    async list() {
      const rows = await db.select({ id: accounts.id }).from(accounts).orderBy(accounts.createdAt);
      const out: AccountView[] = [];
      for (const row of rows) {
        const v = await view(row.id);
        if (v) out.push(v);
      }
      return out;
    },

    async add(input) {
      const session = await providers(input.provider).connect(input.credentials);
      const caps = session.capabilities();
      await session.close();
      const account: Account = {
        id: crypto.randomUUID(),
        provider: input.provider,
        address: input.credentials.address.toLowerCase(),
        displayName: input.displayName ?? "",
        capabilities: {
          push: caps.push,
          labels: caps.labels,
          snooze: caps.snooze,
          mute: caps.mute,
          calendar: caps.calendar,
          meetingLink: caps.meetingLink,
        },
      };
      const workspace = await mailstore.createWorkspace(account);
      await credentials.store(workspace.id, account.id, {
        ...input.credentials,
        address: account.address,
      });
      await options.onAdded?.(account.id, input.provider);
      const created = await view(account.id);
      if (!created) throw new Error("account vanished after creation");
      return created;
    },

    async remove(accountId) {
      const existing = await db.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
      if (!existing) return false;
      await options.onRemoving?.(accountId, existing.provider);
      await credentials.clear(accountId);
      await db.delete(accounts).where(eq(accounts.id, accountId));
      return true;
    },
  };
}
