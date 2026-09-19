// The Cloud boot shared by the Vercel and Netlify entries (research 22,
// section 2): one pooled database handle per function instance, migrations
// on cold start, the same services as the Bun entry, the serverless kicker
// in place of the process loop. No embedded Postgres, no LISTEN, no
// WebSocket, no OAuth loopback: those are Sidecar and container matters.
//
// Environment (both platforms):
//   MONDAY_MODE             vercel | netlify (the entry sets it when unset)
//   DATABASE_URL            pooled connection string (Neon -pooler, Supabase 6543); required
//   DATABASE_URL_UNPOOLED   direct connection string for migrations; falls back to DATABASE_URL
//   DATABASE_POOLED         1 or 0 to override the pooled guess (prepared statements off when pooled)
//   MONDAY_SETUP_CODE       one-time code the first Device pairs with; generated and logged if unset
//   MONDAY_PUBLIC_URL       the https:// origin of this deployment, for push webhooks
//   MONDAY_SERVER_ID        heartbeat id; a stable one per deployment is best (defaults to the
//                           platform's deployment id when it exposes one, else random per instance)
//   MONDAY_ROOT_KEY         base64 root key, only if the Cloud should decrypt (server.share_root_key)
//   MONDAY_MIGRATE_ON_BOOT  0 to skip migrations on cold start (default 1)
//   MONDAY_LOG              debug for verbose logs
//
// The pooled/unpooled split is also a Setting-free choice on purpose: the
// connection is what reads the Settings.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DeploymentMode } from "@monday/shared";
import type { Hono } from "hono";
import { type AppEnv, createApp } from "../src/app.ts";
import { claimableNeeds } from "../src/capabilities.ts";
import { createDb, type DbHandle, dbOptionsFor } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import { createMemoryNotifier } from "../src/external/index.ts";
import { cloudIsAlive, readHeartbeatTiming } from "../src/heartbeat.ts";
import { createNetlifyKicker } from "../src/kicker/netlify.ts";
import type { ServerlessKicker } from "../src/kicker/serverless.ts";
import { createVercelKicker } from "../src/kicker/vercel.ts";
import { defaultDiscoveryDeps } from "../src/providers/autoconfig.ts";
import { createOAuthFlow } from "../src/providers/oauth/flow.ts";
import { createCheckpointer } from "./checkpointer.ts";
import { migrationsFolder } from "./resources.ts";
import { createServices, publicUrlReader, type Services } from "./services.ts";

export type CloudMode = Extract<DeploymentMode, "vercel" | "netlify">;

export interface CloudBoot {
  mode: CloudMode;
  serverId: string;
  app: Hono<AppEnv>;
  kicker: ServerlessKicker;
  services: Services;
  handle: DbHandle;
  /**
   * The request handler. `waitUntil`, when the platform hands one over, keeps
   * a Job pass started by this request alive after the response; without it
   * the pass runs detached and the cron sweeps whatever a frozen instance left.
   */
  fetch(req: Request, waitUntil?: (p: Promise<unknown>) => void): Promise<Response>;
  close(): Promise<void>;
}

const log = (message: string) => console.error(`[monday] ${message}`);

/** The drizzle folder: bundled resources, the function's working directory, or the source tree. */
function findMigrations(): string {
  for (const dir of [
    join(process.cwd(), "drizzle"),
    join(process.cwd(), "apps", "server", "drizzle"),
  ]) {
    if (existsSync(join(dir, "meta", "_journal.json"))) return dir;
  }
  return migrationsFolder();
}

function serverIdFor(mode: CloudMode, env: NodeJS.ProcessEnv): string {
  const explicit = env.MONDAY_SERVER_ID?.trim();
  if (explicit) return explicit;
  const deployment = env.VERCEL_DEPLOYMENT_ID || env.DEPLOY_ID || env.NETLIFY_DEPLOY_ID;
  return deployment
    ? `${mode}-${deployment.slice(0, 12)}`
    : `${mode}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function bootCloud(
  mode: CloudMode,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CloudBoot> {
  const debug = env.MONDAY_LOG === "debug" ? log : () => {};
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error(`DATABASE_URL is required in ${mode} mode`);
  const unpooledUrl = env.DATABASE_URL_UNPOOLED || databaseUrl;
  const serverId = serverIdFor(mode, env);

  const handle = createDb(
    databaseUrl,
    dbOptionsFor(databaseUrl, { pooledFlag: env.DATABASE_POOLED, serverless: true }),
  );
  if (env.MONDAY_MIGRATE_ON_BOOT !== "0") {
    const direct =
      unpooledUrl === databaseUrl
        ? handle
        : createDb(unpooledUrl, dbOptionsFor(unpooledUrl, { pooledFlag: "0", serverless: true }));
    try {
      const result = await migrate(direct.sql, { migrationsFolder: findMigrations() });
      if (result.applied > 0) log(`applied ${result.applied} migration(s)`);
    } finally {
      if (direct !== handle) await direct.close();
    }
  }

  // The kicker is created after the Jobs it wakes; the Jobs get a late-bound hook.
  let kicker: ServerlessKicker | null = null;
  let waitUntilNow: ((p: Promise<unknown>) => void) | undefined;
  const services = await createServices({
    db: handle.db,
    mode,
    serverId,
    env,
    log,
    debug,
    jobs: { onEnqueue: () => kicker?.wake() },
  });
  const kickerOptions = {
    jobs: services.jobs,
    db: handle.db,
    serverId,
    mode,
    log: debug,
    canServe: async () => {
      const timing = await readHeartbeatTiming(handle.db);
      return claimableNeeds(
        mode,
        await cloudIsAlive(handle.db, serverId, new Date(), timing.staleMs),
      );
    },
  };
  kicker =
    mode === "vercel"
      ? createVercelKicker({ ...kickerOptions, cronSecret: env.CRON_SECRET })
      : createNetlifyKicker({ ...kickerOptions, waitUntil: (p) => waitUntilNow?.(p) });
  await services.startAccounts();
  // LangGraph checkpoints for paused Agent turns, sealed under the Workspace keys, set up right after the migrations.
  const checkpointer = await createCheckpointer(databaseUrl, handle.db, services.mailstore);

  const app = createApp({
    db: handle.db,
    auth: services.auth,
    mode,
    keys: services.keys,
    mailstore: services.mailstore,
    jobs: services.jobs,
    sync: services.sync,
    checkpointer,
    serverId,
    staleMs: async () => (await readHeartbeatTiming(handle.db)).staleMs,
    accounts: { accounts: services.accounts, discovery: defaultDiscoveryDeps },
    // No loopback listener off the user's machine: the wizard pastes the code instead.
    oauth: { flow: createOAuthFlow(), loopback: null },
    push: services.push,
    calendar: services.calendar,
    mounts: [kicker.routes()],
    // No desktop on a Cloud Server: an external approval waits in the pending items and is logged.
    notifier: createMemoryNotifier((line) => log(line)),
    publicUrl: publicUrlReader(handle.db, env),
    log,
  });

  const boot: CloudBoot = {
    mode,
    serverId,
    app,
    kicker,
    services,
    handle,
    async fetch(req, waitUntil) {
      waitUntilNow = waitUntil;
      try {
        return await app.fetch(req);
      } finally {
        waitUntilNow = undefined;
      }
    },
    async close() {
      await kicker?.stop();
      await services.sync.close();
      await services.calendar.close();
      await checkpointer.end().catch(() => {});
      await handle.close();
    },
  };
  return boot;
}
