// Bun entry: the container and the Sidecar. Reads the environment, starts the
// embedded Postgres when the Sidecar has no DATABASE_URL and no attached
// Cloud database, migrates, serves the app on loopback with Bun.serve, runs
// the in-process kicker, watches the parent process, and shuts down cleanly
// on SIGTERM.
//
// Environment:
//   PORT                  0 or unset picks a free port
//   HOST                  bind address; 127.0.0.1 for sidecar, 0.0.0.0 otherwise
//   MONDAY_MODE           sidecar | container | vercel | netlify
//   MONDAY_SIDECAR_TOKEN  per-launch token from the Tauri parent (loopback only)
//   MONDAY_SETUP_CODE     one-time code for the first Device; generated if unset
//   MONDAY_DATA_DIR       where the embedded Postgres lives (default ./data)
//   MONDAY_PARENT_PID     exit when this process is gone (research 4, section 2)
//   DATABASE_URL          pooled connection string; DATABASE_URL_UNPOOLED for LISTEN.
//                         Absent, a Sidecar opens the Cloud database recorded by
//                         POST /upgrade/attach (data dir, cloud-database-url) when
//                         there is one, else its embedded Postgres ("both" mode, ADR 0005).
//   DATABASE_POOLED       1 or 0 to override the pooled guess from the URL
//   MONDAY_SERVER_ID      heartbeat id; generated if unset
//   MONDAY_ROOT_KEY       base64 root key from the Tauri parent's keychain (Sidecar); unlocks at boot
//   MONDAY_ROOT_KEY_FILE  path to a file holding the base64 root key, typically
//                         $CREDENTIALS_DIRECTORY/monday-root-key under systemd (Cloud); unlocks at boot
//   MONDAY_FEATURE_PASSPHRASE=1 with MONDAY_ROOT_PASSPHRASE and MONDAY_ROOT_SALT (base64, 16+ bytes)
//                         derives the root key with Argon2id instead. Off by default.
//   With none of these the server starts locked: headers only until POST /unlock.
//   MONDAY_PUBLIC_URL     the HTTPS origin the internet reaches this Server at (Cloud modes);
//                         Gmail and Graph push subscriptions point here. Falls back to the
//                         server.public_url Setting; absent, push-only providers are polled.
//
// `monday-server mcp ...` runs the stdio MCP launcher instead (entry/mcp.ts):
// monday's tools for a Local runtime that only speaks stdio, proxied to the
// Sidecar's loopback endpoint.

import { join } from "node:path";
import type { DeploymentMode } from "@monday/shared";
import { createApp } from "../src/app.ts";
import { claimableNeeds, isDeploymentMode } from "../src/capabilities.ts";
import { createChangeBus, listenForChanges } from "../src/changes/bus.ts";
import { createDb, dbOptionsFor } from "../src/db/client.ts";
import { migrate, SchemaNewerThanBuildError } from "../src/db/migrate.ts";
import { backfillDraftMirrors } from "../src/drafts/index.ts";
import { createLineNotifier, createMemoryNotifier } from "../src/external/index.ts";
import { cloudIsAlive, readHeartbeatTiming } from "../src/heartbeat.ts";
import { createProcessKicker } from "../src/kicker/process.ts";
import { defaultDiscoveryDeps } from "../src/providers/autoconfig.ts";
import { createOAuthFlow } from "../src/providers/oauth/flow.ts";
import { upgradeRoutes } from "../src/routes/upgrade.ts";
import { readGlobalSetting } from "../src/settings/read.ts";
import { createUpgrade } from "../src/upgrade/index.ts";
import { fileAttachStore, readAttachedUrl } from "./attach.ts";
import { createChangesSocket, type SocketData } from "./changes-ws.ts";
import { createCheckpointer } from "./checkpointer.ts";
import { startEmbeddedPostgres } from "./embedded-postgres.ts";
import { createLoopbackListener } from "./oauth-loopback.ts";
import { findPgDump, pgDump } from "./pg-dump.ts";
import { migrationsFolder } from "./resources.ts";
import { createServices, publicUrlReader } from "./services.ts";

const log = (message: string) => console.error(`[monday] ${message}`);
const debug = process.env.MONDAY_LOG === "debug" ? log : () => {};

function resolveMode(): DeploymentMode {
  const raw = process.env.MONDAY_MODE;
  if (raw === undefined || raw === "") return process.env.DATABASE_URL ? "container" : "sidecar";
  if (!isDeploymentMode(raw)) {
    log(`MONDAY_MODE must be one of sidecar, container, vercel, netlify; got "${raw}"`);
    process.exit(2);
  }
  return raw;
}

async function main() {
  const mode = resolveMode();
  const serverId = process.env.MONDAY_SERVER_ID || `${mode}-${crypto.randomUUID().slice(0, 8)}`;
  const dataDir = process.env.MONDAY_DATA_DIR || "./data";

  let databaseUrl = process.env.DATABASE_URL || null;
  let unpooledUrl = process.env.DATABASE_URL_UNPOOLED || databaseUrl;
  let embedded: Awaited<ReturnType<typeof startEmbeddedPostgres>> | null = null;
  let embeddedUrl: string | null = null;

  if (!databaseUrl && mode === "sidecar") {
    // A Cloud database attached from Settings makes this the "both" mode.
    const attached = await readAttachedUrl(dataDir);
    if (attached) {
      databaseUrl = attached;
      unpooledUrl = attached;
      log(`using the attached Cloud database at ${new URL(attached).hostname}`);
    }
  }
  if (!databaseUrl) {
    if (mode !== "sidecar") {
      log(`DATABASE_URL is required in ${mode} mode`);
      process.exit(2);
    }
    embedded = await startEmbeddedPostgres({ dataDir, log: debug });
    databaseUrl = embedded.url;
    unpooledUrl = embedded.url;
    embeddedUrl = embedded.url;
    log(`embedded postgres ready on port ${embedded.port} in ${embedded.startupMs} ms`);
  }

  const handle = createDb(
    databaseUrl,
    dbOptionsFor(databaseUrl, {
      pooledFlag: process.env.DATABASE_POOLED,
      max: mode === "sidecar" ? 4 : 2,
    }),
  );
  try {
    const result = await migrate(handle.sql, { migrationsFolder: migrationsFolder() });
    if (result.applied > 0) log(`applied ${result.applied} migration(s)`);
  } catch (error) {
    if (error instanceof SchemaNewerThanBuildError) {
      log(error.message);
      await handle.close();
      await embedded?.stop();
      process.exit(3);
    }
    throw error;
  }
  const services = await createServices({
    db: handle.db,
    mode,
    serverId,
    env: process.env,
    log,
    debug,
  });
  const { auth, keys, jobs, mailstore, sync, push, accounts, calendar, judge, demo } = services;
  await services.startAccounts();
  // Drafts saved before their Provider could hold them reach its Drafts folder now.
  await backfillDraftMirrors(handle.db, jobs)
    .then((n) => n > 0 && debug(`draft mirrors queued at boot: ${n}`))
    .catch((error) => log(`draft mirror backfill failed: ${error}`));
  // LangGraph's checkpoints for paused Agent turns, sealed under the Workspace keys, set up right after our migrations.
  const checkpointer = await createCheckpointer(databaseUrl, handle.db, mailstore);

  const timing = await readHeartbeatTiming(handle.db);
  const kicker = createProcessKicker({
    jobs,
    db: handle.db,
    serverId,
    mode,
    listenUrl: unpooledUrl ?? undefined,
    log: debug,
    heartbeatMs: timing.intervalMs,
    budgetMs: async () => (await readGlobalSetting(handle.db, "server.job_lease_seconds")) * 1000,
    workers: () => readGlobalSetting(handle.db, "server.job_workers"),
    canServe: async () => {
      // When no Cloud heartbeat is fresh, the Sidecar claims every class (ADR 0005).
      const stale = (await readHeartbeatTiming(handle.db)).staleMs;
      return claimableNeeds(mode, await cloudIsAlive(handle.db, serverId, new Date(), stale));
    },
  });

  // The Changes feed wake path: Mailstore writes NOTIFY, this LISTEN feeds the
  // bus, and the WebSocket and SSE transports read the bus.
  const changeBus = createChangeBus();
  const changeListener = unpooledUrl
    ? await listenForChanges(unpooledUrl, changeBus, { onError: (e) => log(String(e)) })
    : null;
  const changesSocket = createChangesSocket({ auth, bus: changeBus, mailstore });

  // The upgrade path (ADR 0008) is the Sidecar's: export, copy and attach.
  const pgDumpBinary = mode === "sidecar" ? await findPgDump() : null;
  const upgrade = createUpgrade({
    mode,
    sourceUrl: embeddedUrl ?? databaseUrl,
    connect: (url) => createDb(url, dbOptionsFor(url, { max: 2 })),
    migrate: (sql) => migrate(sql, { migrationsFolder: migrationsFolder() }),
    dump: pgDumpBinary ? pgDump(pgDumpBinary) : undefined,
    exportPath: () =>
      join(dataDir, "export", `monday-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.dump`),
    attach: fileAttachStore(dataDir),
    log: debug,
  });

  const app = createApp({
    db: handle.db,
    auth,
    mode,
    keys,
    mailstore,
    jobs,
    sync,
    changes: changeBus,
    checkpointer,
    judge,
    ...(demo ? { demo } : {}),
    serverId,
    staleMs: async () => (await readHeartbeatTiming(handle.db)).staleMs,
    remoteAddress: (c) => {
      const server = c.env as { requestIP?: (req: Request) => { address: string } | null };
      return server?.requestIP?.(c.req.raw)?.address ?? null;
    },
    accounts: { accounts, discovery: defaultDiscoveryDeps },
    oauth: {
      flow: createOAuthFlow(),
      // Only a process on the user's machine can catch the browser's loopback redirect.
      loopback: mode === "sidecar" ? createLoopbackListener() : null,
    },
    push,
    calendar,
    mounts: mode === "sidecar" ? [upgradeRoutes(upgrade)] : [],
    // An external approval with no client open (slice 19): the Sidecar tells its
    // Tauri parent over stdout; a container has no desktop and logs it.
    notifier:
      mode === "sidecar"
        ? createLineNotifier((line) => console.log(line))
        : createMemoryNotifier((line) => log(line)),
    publicUrl: publicUrlReader(handle.db, process.env),
    log,
  });

  const hostname = process.env.HOST || (mode === "sidecar" ? "127.0.0.1" : "0.0.0.0");
  const server = Bun.serve<SocketData>({
    hostname,
    port: Number(process.env.PORT ?? 0) || 0,
    idleTimeout: 120,
    fetch: async (req, srv) => (await changesSocket.upgrade(req, srv)) ?? app.fetch(req, srv),
    websocket: changesSocket.websocket,
  });

  // The Tauri parent reads this single line to learn the port.
  console.log(`monday server listening on http://127.0.0.1:${server.port}`);
  if (hostname !== "127.0.0.1") log(`bound to ${hostname}:${server.port} in ${mode} mode`);

  await kicker.start();

  let stopping = false;
  const shutdown = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    log(`shutting down (${reason})`);
    const deadline = setTimeout(() => process.exit(1), 10_000);
    deadline.unref();
    try {
      server.stop(true);
      await kicker.stop();
      await sync.close();
      await calendar.close();
      await changeListener?.stop();
      await checkpointer.end().catch(() => {});
      await handle.close();
      await embedded?.stop();
    } finally {
      process.exit(0);
    }
  };

  // A failure nobody awaited (a Job step's background promise, a stream that
  // closed late) is logged, never the end of the Sidecar: every Device would
  // lose its Server over one bad row.
  process.on("unhandledRejection", (reason) => {
    log(
      `unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
    );
  });
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("exit", () => embedded?.killSync());
  process.on("SIGINT", () => void shutdown("SIGINT"));

  const parentPid = Number(process.env.MONDAY_PARENT_PID);
  if (Number.isInteger(parentPid) && parentPid > 0) {
    const watchdog = setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch {
        clearInterval(watchdog);
        void shutdown(`parent ${parentPid} is gone`);
      }
    }, 5_000);
    watchdog.unref();
  }
}

if (process.argv[2] === "mcp") {
  const { runMcpLauncher } = await import("./mcp.ts");
  runMcpLauncher(process.argv.slice(3)).catch((error) => {
    log(error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
} else {
  main().catch((error) => {
    log(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
}
