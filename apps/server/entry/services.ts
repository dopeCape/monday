// The Server's modules wired together, the same way in every entry: auth,
// keys, Jobs, the Mailstore, credentials, Providers, the sync engine, push
// registrations and the account service. The Bun entry adds the process
// kicker, the embedded Postgres and the WebSocket; the Cloud entries add the
// serverless kicker. Runtime-neutral apart from the env it is handed.

import type { DeploymentMode } from "@monday/shared";
import { settingsSchema } from "@monday/shared";
import { type AccountService, createAccountService } from "../src/accounts.ts";
import { type Auth, createAuth, randomCode } from "../src/auth/index.ts";
import { type CalendarModule, createCalendar } from "../src/calendar/index.ts";
import { createKeys, type Keys } from "../src/crypto/keys.ts";
import type { Db } from "../src/db/client.ts";
import { createJobs, type Jobs, type JobsOptions } from "../src/jobs/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { type CredentialStore, createCredentialStore } from "../src/providers/credentials.ts";
import { createProviderRegistry, type ProviderRegistry } from "../src/providers/index.ts";
import { createPushManager, type PushManager, readPushSettings } from "../src/providers/push.ts";
import { createSyncEngine, type SyncEngine } from "../src/providers/sync.ts";
import { readGlobalSetting } from "../src/settings/read.ts";
import { unlockAtBoot } from "./root-key.ts";

export interface ServicesOptions {
  db: Db;
  mode: DeploymentMode;
  serverId: string;
  env: NodeJS.ProcessEnv;
  log: (message: string) => void;
  debug: (message: string) => void;
  jobs?: JobsOptions;
}

export interface Services {
  auth: Auth;
  keys: Keys;
  jobs: Jobs;
  mailstore: Mailstore;
  credentials: CredentialStore;
  providers: ProviderRegistry;
  sync: SyncEngine;
  push: PushManager;
  accounts: AccountService;
  calendar: CalendarModule;
  /** The setup code printed at first boot, when this boot generated one. */
  setupCode: string | null;
  /** Enqueues every connected Account's sync, watch and push Jobs (idempotent ids). */
  startAccounts(): Promise<void>;
}

/** MONDAY_PUBLIC_URL, else the server.public_url Setting, else null (push-only providers are polled). */
export function publicUrlReader(db: Db, env: NodeJS.ProcessEnv): () => Promise<string | null> {
  return async () => {
    const fromEnv = env.MONDAY_PUBLIC_URL?.trim();
    if (fromEnv) return fromEnv.replace(/\/+$/, "");
    const s = await readPushSettings(db);
    return s.publicUrl.trim() ? s.publicUrl.trim().replace(/\/+$/, "") : null;
  };
}

export async function createServices(options: ServicesOptions): Promise<Services> {
  const { db, serverId, env, log, debug } = options;

  // The setup code pairs the very first Device (ADR 0006). Generated and printed
  // at first boot when the host did not supply one.
  const firstBoot = !(await createAuth({ db }).hasDevices());
  let setupCode = env.MONDAY_SETUP_CODE || null;
  if (!setupCode && firstBoot) setupCode = randomCode();
  const auth = createAuth({
    db,
    sidecarToken: env.MONDAY_SIDECAR_TOKEN || null,
    setupCode,
    codeTtlMs: async () => (await readGlobalSetting(db, "server.device_code_minutes")) * 60_000,
  });
  if (setupCode && firstBoot) log(`setup code for the first device: ${setupCode}`);

  const keys = createKeys(db);
  await unlockAtBoot(keys, env, log);

  const jobs = createJobs(db, options.jobs);
  const mailstore = createMailstore(db, keys);
  const credentials = createCredentialStore(db, mailstore);
  const providers = createProviderRegistry({
    oauth: {
      onRefreshed: async (auth) => {
        await credentials.updateAuth(auth).catch((error) => log(`token persist failed: ${error}`));
      },
    },
    gmail: {
      unitsPerMinute: () =>
        readGlobalSetting(db, "sync.gmail_units_per_minute").catch(
          () => settingsSchema["sync.gmail_units_per_minute"].default,
        ),
    },
    graph: {
      pollMs: async () => {
        const seconds = await readGlobalSetting(db, "sync.graph_poll_seconds").catch(
          () => settingsSchema["sync.graph_poll_seconds"].default,
        );
        return seconds * 1000;
      },
    },
  });
  const sync = createSyncEngine({ db, mailstore, providers, credentials, log: debug });
  sync.registerSteps(jobs);
  const push = createPushManager({
    db,
    engine: sync,
    serverId,
    log: debug,
    publicUrl: publicUrlReader(db, env),
  });
  push.registerSteps(jobs);
  const calendar = createCalendar({
    db,
    mailstore,
    sync,
    credentials,
    serverId,
    log: debug,
    publicUrl: publicUrlReader(db, env),
  });
  calendar.registerSteps(jobs);
  const accounts = createAccountService({
    db,
    mailstore,
    providers,
    credentials,
    onAdded: async (accountId, provider) => {
      await sync.startAccount(jobs, accountId);
      await push.startAccount(jobs, accountId, provider);
      await calendar.startAccount(jobs, accountId);
    },
    onRemoving: async (accountId) => {
      // Its Jobs would only fail against a missing row; its watcher would hold a dead connection.
      await sync.forget(accountId);
      const cancelled = await jobs.cancelByPayload("accountId", accountId);
      debug(`account ${accountId} removed: ${cancelled} job(s) cancelled`);
    },
  });

  return {
    auth,
    keys,
    jobs,
    mailstore,
    credentials,
    providers,
    sync,
    push,
    accounts,
    calendar,
    setupCode: firstBoot ? setupCode : null,
    async startAccounts() {
      for (const row of await db.query.accounts.findMany()) {
        if (!row.credentialsRef) continue;
        await sync.startAccount(jobs, row.id);
        await push.startAccount(jobs, row.id, row.provider);
        await calendar.startAccount(jobs, row.id);
      }
    },
  };
}
