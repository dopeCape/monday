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
//
// The background service (ADR 0013), how the desktop app runs the Sidecar:
//   monday-server service --data-dir <dir> --build <id> --managed-by <systemd|launchd|process>
// is the Sidecar with no parent to watch: it keeps running when the window
// closes, reads its loopback token from <dir>/sidecar.token (the app keeps it
// in the OS keychain and writes this 0600 copy), writes <dir>/sidecar.json
// (pid, port, build) for the next app launch, waits
// server.sidecar.unlock_wait_seconds for the app to POST /unlock before it
// starts work locked, rotates <dir>/sidecar.log, and posts desktop
// notifications itself while no client is connected. It stops on SIGTERM or
// POST /service/stop, finishing leases and closing Postgres.
//   monday-server stop [--data-dir <dir>]    SIGTERM to the running service, and wait
//   monday-server status [--data-dir <dir>]  the runtime file, or "not running"

import { homedir } from "node:os";
import { join } from "node:path";
import type { DeploymentMode, ServiceManager, ServiceStatus } from "@monday/shared";
import { createApp } from "../src/app.ts";
import { SIDECAR_DEVICE_ID } from "../src/auth/index.ts";
import { claimableNeeds, isDeploymentMode } from "../src/capabilities.ts";
import { createChangeBus, listenForChanges } from "../src/changes/bus.ts";
import { createDb, dbOptionsFor } from "../src/db/client.ts";
import { migrate, SchemaNewerThanBuildError } from "../src/db/migrate.ts";
import { backfillDraftMirrors } from "../src/drafts/index.ts";
import { createMemoryNotifier } from "../src/external/index.ts";
import { cloudIsAlive, readHeartbeatTiming } from "../src/heartbeat.ts";
import { createProcessKicker } from "../src/kicker/process.ts";
import { createPresence } from "../src/presence.ts";
import { defaultDiscoveryDeps } from "../src/providers/autoconfig.ts";
import { createOAuthFlow } from "../src/providers/oauth/flow.ts";
import { serviceRoutes } from "../src/routes/service.ts";
import { upgradeRoutes } from "../src/routes/upgrade.ts";
import {
  createDbNoticeSource,
  createSidecarNotices,
  SIDECAR_NOTICE_KEYS,
} from "../src/service/notices.ts";
import { readDeviceSettings, readGlobalSetting } from "../src/settings/read.ts";
import { createUpgrade } from "../src/upgrade/index.ts";
import { fileAttachStore, readAttachedUrl } from "./attach.ts";
import { createChangesSocket, type SocketData } from "./changes-ws.ts";
import { createCheckpointer } from "./checkpointer.ts";
import { createDesktopNotifier } from "./desktop-notify.ts";
import { rememberBuffersMb, startEmbeddedPostgres } from "./embedded-postgres.ts";
import { createLoopbackListener } from "./oauth-loopback.ts";
import { findPgDump, pgDump } from "./pg-dump.ts";
import { migrationsFolder } from "./resources.ts";
import {
  defaultDataDir,
  LOG_FILE,
  otherService,
  parseServiceArgs,
  postgresRss,
  readRuntimeFile,
  readTokenFile,
  removeRuntimeFile,
  removeRuntimeFileSync,
  rotateLog,
  type ServiceArgs,
  stopService,
  TOKEN_FILE,
  writeRuntimeFile,
} from "./service.ts";
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

/** The background service's settings from its arguments, or null for a plain start. */
function serviceOf(argv: readonly string[]): (ServiceArgs & { dataDir: string }) | null {
  if (argv[2] !== "service") return null;
  const args = parseServiceArgs(argv.slice(3));
  return {
    ...args,
    dataDir:
      args.dataDir ||
      process.env.MONDAY_DATA_DIR ||
      defaultDataDir(process.platform, process.env, homedir()),
  };
}

async function main(service: (ServiceArgs & { dataDir: string }) | null) {
  if (service) {
    // The service is always the Sidecar, on loopback, on a port of its choosing.
    process.env.MONDAY_MODE = "sidecar";
    process.env.MONDAY_DATA_DIR = service.dataDir;
    const tokenFile = service.tokenFile ?? join(service.dataDir, TOKEN_FILE);
    const token = process.env.MONDAY_SIDECAR_TOKEN || (await readTokenFile(tokenFile));
    if (!token) {
      log(`no loopback token in ${tokenFile}; open monday once to create it`);
      process.exit(2);
    }
    process.env.MONDAY_SIDECAR_TOKEN = token;
  }
  const mode = resolveMode();
  const serverId = process.env.MONDAY_SERVER_ID || `${mode}-${crypto.randomUUID().slice(0, 8)}`;
  const dataDir = process.env.MONDAY_DATA_DIR || "./data";
  const startedAt = new Date();
  const build = service?.build ?? "dev";
  const managedBy: ServiceManager = service?.managedBy ?? "process";

  if (service) {
    // Two services on one data directory would share one Postgres cluster and
    // double every Job: a second copy (two app launches at once) steps aside.
    const other = await otherService(dataDir, process.pid);
    if (other) {
      log(`the background service already runs as pid ${other.pid}; exiting`);
      process.exit(4);
    }
    await writeRuntimeFile(dataDir, {
      pid: process.pid,
      port: null,
      build,
      startedAt: startedAt.toISOString(),
      state: "starting",
      managedBy,
    });
    process.on("exit", () => removeRuntimeFileSync(dataDir, process.pid));
  }

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
  if (embedded) {
    // The built-in database's memory is a Setting that lives in it: kept for the next start.
    const buffersMb = await readGlobalSetting(handle.db, "server.postgres_buffers_mb");
    if (await rememberBuffersMb(dataDir, buffersMb)) {
      log(`database memory set to ${buffersMb} MB; takes effect at the next start`);
    }
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
  // A background service started without its key (a login start, or systemd
  // starting it for the app) gives the app a moment to unlock it first, so its
  // Jobs do not start locked when a key is on its way (ADR 0013).
  const waitForKey = service !== null && !keys.isUnlocked();
  if (!waitForKey) await services.startAccounts();
  // Drafts saved before their Provider could hold them reach its Drafts folder now.
  await backfillDraftMirrors(handle.db, jobs)
    .then((n) => n > 0 && debug(`draft mirrors queued at boot: ${n}`))
    .catch((error) => log(`draft mirror backfill failed: ${error}`));
  // LangGraph's checkpoints for paused Agent turns, sealed under the Workspace keys; loaded and set
  // up by the first Hosted turn, so an idle Sidecar never carries LangGraph or its pool.
  const checkpointer = createCheckpointer(databaseUrl, handle.db, mailstore);

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
  // Whether a client is here: its Changes feed socket and its requests (ADR 0013).
  const presence = createPresence();
  const changesSocket = createChangesSocket({ auth, bus: changeBus, mailstore, presence });
  const desktopNotify = createDesktopNotifier();
  const localSettings = <K extends Parameters<typeof readDeviceSettings>[2][number]>(
    keys: readonly K[],
  ) => readDeviceSettings(handle.db, SIDECAR_DEVICE_ID, keys);

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
    checkpointer: checkpointer.load,
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
    // An MCP server's sign-in: the same loopback on the Sidecar, the public callback on a Cloud server.
    mcp: {
      // Search answers from the Server's copy of the registry; filling it takes a few minutes.
      warmCatalogAfterMs: 20_000,
      loopback:
        mode === "sidecar"
          ? {
              open: async () =>
                createLoopbackListener({
                  timeoutMs:
                    (await readGlobalSetting(handle.db, "workflows.mcp_connect.sign_in_minutes")) *
                    60_000,
                }).open("mcp"),
            }
          : null,
    },
    push,
    calendar,
    mounts:
      mode === "sidecar"
        ? [
            upgradeRoutes(upgrade),
            serviceRoutes({ status: serviceStatus, stop: (r) => void shutdown(r) }),
          ]
        : [],
    // An external approval with no client open (slice 19): the Sidecar posts the
    // desktop notification itself (it runs on the owner's computer, ADR 0013);
    // a container has no desktop and logs it.
    notifier:
      mode === "sidecar"
        ? {
            notify: async (n) => {
              if (!(await localSettings(["notifications.enabled"]))["notifications.enabled"])
                return;
              await desktopNotify(n).catch((error) => log(`notification failed: ${error}`));
            },
          }
        : createMemoryNotifier((line) => log(line)),
    presence,
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

  // A plain start prints this line for whoever started it; the service also
  // writes the runtime file, which is how the app finds it (ADR 0013).
  console.log(`monday server listening on http://127.0.0.1:${server.port}`);
  if (hostname !== "127.0.0.1") log(`bound to ${hostname}:${server.port} in ${mode} mode`);
  if (service) {
    await writeRuntimeFile(dataDir, {
      pid: process.pid,
      port: server.port ?? 0,
      build,
      startedAt: startedAt.toISOString(),
      state: "ready",
      managedBy,
    });
    log(`background service ready on port ${server.port} (build ${build}, ${managedBy})`);
  }

  // New mail and waiting approvals told by the Sidecar itself while no client
  // is connected (ADR 0013), under the local client's notification Settings.
  const notices =
    mode === "sidecar"
      ? createSidecarNotices({
          source: createDbNoticeSource(handle.db, (threadId) =>
            mailstore.readThreadSubject(threadId),
          ),
          settings: () => localSettings(SIDECAR_NOTICE_KEYS),
          present: (graceMs) => presence.present(graceMs),
          post: desktopNotify,
          log,
        })
      : null;
  const stopNotices = notices?.start();

  // The service's log is its stdout and stderr, appended to by whoever
  // started it; rotated by size (server.sidecar.log_max_mb), checked hourly.
  let logTimer: ReturnType<typeof setInterval> | null = null;
  if (service) {
    const logPath = join(dataDir, LOG_FILE);
    const rotate = async () => {
      const mb = await readGlobalSetting(handle.db, "server.sidecar.log_max_mb").catch(() => 10);
      if (await rotateLog(logPath, mb * 1024 * 1024).catch(() => false)) log("log rotated");
    };
    void rotate();
    logTimer = setInterval(() => void rotate(), 60 * 60_000);
    logTimer.unref();
  }

  async function serviceStatus(): Promise<ServiceStatus> {
    return {
      pid: process.pid,
      port: server.port ?? 0,
      build,
      startedAt: startedAt.toISOString(),
      managedBy,
      rssBytes: process.memoryUsage().rss,
      postgresRssBytes: embedded ? await postgresRss(dataDir) : null,
      unlocked: keys.isUnlocked(),
      clientPresent: presence.present(
        (await localSettings(["notifications.sidecar.absent_seconds"]))[
          "notifications.sidecar.absent_seconds"
        ] * 1000,
      ),
      notified: notices?.told() ?? { mailThrough: null, approvals: [] },
    };
  }

  let stopping = false;
  const shutdown = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    log(`shutting down (${reason})`);
    const deadline = setTimeout(() => process.exit(1), 10_000);
    deadline.unref();
    try {
      stopNotices?.();
      if (logTimer) clearInterval(logTimer);
      server.stop(true);
      await kicker.stop();
      await sync.close();
      await calendar.close();
      await changeListener?.stop();
      await checkpointer.end().catch(() => {});
      await handle.close();
      await embedded?.stop();
      if (service) await removeRuntimeFile(dataDir, process.pid).catch(() => {});
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

  // A plain start by a parent that wants it gone with itself; the background
  // service outlives the app on purpose and never watches one (ADR 0013).
  const parentPid = service ? Number.NaN : Number(process.env.MONDAY_PARENT_PID);
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

  // Everything above answers already (GET /service, POST /unlock, a stop);
  // the work starts now, or once the key came, or after the wait.
  if (waitForKey) {
    const seconds = await readGlobalSetting(handle.db, "server.sidecar.unlock_wait_seconds");
    const unlocked = await new Promise<boolean>((resolve) => {
      if (keys.isUnlocked()) return resolve(true);
      const timer = setTimeout(() => {
        off();
        resolve(false);
      }, seconds * 1000);
      const off = keys.onUnlock(() => {
        clearTimeout(timer);
        off();
        resolve(true);
      });
    });
    if (stopping) return;
    if (!unlocked) log(`no key after ${seconds}s; working locked until monday unlocks it`);
    await services.startAccounts();
  }
  if (!stopping) await kicker.start();
}

if (process.argv[2] === "mcp") {
  const { runMcpLauncher } = await import("./mcp.ts");
  runMcpLauncher(process.argv.slice(3)).catch((error) => {
    log(error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
} else if (process.argv[2] === "stop" || process.argv[2] === "status") {
  const args = parseServiceArgs(process.argv.slice(3));
  const dataDir =
    args.dataDir ||
    process.env.MONDAY_DATA_DIR ||
    defaultDataDir(process.platform, process.env, homedir());
  if (process.argv[2] === "status") {
    const info = await readRuntimeFile(dataDir);
    console.log(info ? JSON.stringify(info, null, 2) : `not running (${dataDir})`);
  } else {
    const result = await stopService(dataDir);
    console.log(
      result === "stopped"
        ? "the background service stopped"
        : result === "not-running"
          ? `the background service is not running (${dataDir})`
          : "the background service did not stop in time",
    );
    process.exit(result === "timeout" ? 1 : 0);
  }
} else {
  main(serviceOf(process.argv)).catch((error) => {
    log(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
}
