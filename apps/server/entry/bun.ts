// Bun entry: the container and the Sidecar. Reads the environment, starts the
// embedded Postgres when the Sidecar has no DATABASE_URL, migrates, serves the
// app on loopback with Bun.serve, runs the in-process kicker, watches the
// parent process, and shuts down cleanly on SIGTERM.
//
// Environment:
//   PORT                  0 or unset picks a free port
//   HOST                  bind address; 127.0.0.1 for sidecar, 0.0.0.0 otherwise
//   MONDAY_MODE           sidecar | container | vercel | netlify
//   MONDAY_SIDECAR_TOKEN  per-launch token from the Tauri parent (loopback only)
//   MONDAY_SETUP_CODE     one-time code for the first Device; generated if unset
//   MONDAY_DATA_DIR       where the embedded Postgres lives (default ./data)
//   MONDAY_PARENT_PID     exit when this process is gone (research 4, section 2)
//   DATABASE_URL          pooled connection string; DATABASE_URL_UNPOOLED for LISTEN
//   MONDAY_SERVER_ID      heartbeat id; generated if unset

import type { DeploymentMode } from "@monday/shared";
import { createApp } from "../src/app.ts";
import { createAuth, randomCode } from "../src/auth/index.ts";
import { isDeploymentMode, needsServedBy } from "../src/capabilities.ts";
import { createDb } from "../src/db/client.ts";
import { migrate, SchemaNewerThanBuildError } from "../src/db/migrate.ts";
import { cloudIsAlive } from "../src/heartbeat.ts";
import { createJobs } from "../src/jobs/index.ts";
import { createProcessKicker } from "../src/kicker/process.ts";
import { startEmbeddedPostgres } from "./embedded-postgres.ts";

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
  const sidecarToken = process.env.MONDAY_SIDECAR_TOKEN || null;

  let databaseUrl = process.env.DATABASE_URL || null;
  let unpooledUrl = process.env.DATABASE_URL_UNPOOLED || databaseUrl;
  let embedded: Awaited<ReturnType<typeof startEmbeddedPostgres>> | null = null;

  if (!databaseUrl) {
    if (mode !== "sidecar") {
      log(`DATABASE_URL is required in ${mode} mode`);
      process.exit(2);
    }
    embedded = await startEmbeddedPostgres({ dataDir, log: debug });
    databaseUrl = embedded.url;
    unpooledUrl = embedded.url;
    log(`embedded postgres ready on port ${embedded.port} in ${embedded.startupMs} ms`);
  }

  const handle = createDb(databaseUrl, { max: mode === "sidecar" ? 4 : 2 });
  try {
    const result = await migrate(handle.sql);
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

  // The setup code pairs the very first Device (ADR 0006). Generated and printed
  // at first boot when the host did not supply one.
  const firstBoot = !(await createAuth({ db: handle.db }).hasDevices());
  let setupCode = process.env.MONDAY_SETUP_CODE || null;
  if (!setupCode && firstBoot) setupCode = randomCode();
  const auth = createAuth({ db: handle.db, sidecarToken, setupCode });
  if (setupCode && firstBoot) log(`setup code for the first device: ${setupCode}`);

  const jobs = createJobs(handle.db);
  const ownNeeds = needsServedBy(mode);
  const kicker = createProcessKicker({
    jobs,
    db: handle.db,
    serverId,
    mode,
    listenUrl: unpooledUrl ?? undefined,
    log: debug,
    canServe: async () => {
      // When no Cloud heartbeat is fresh, the Sidecar claims every class (ADR 0005).
      if (mode === "sidecar" && !(await cloudIsAlive(handle.db, serverId))) {
        return [...new Set([...ownNeeds, "needs-public-url"])];
      }
      return ownNeeds;
    },
  });

  const app = createApp({
    db: handle.db,
    auth,
    mode,
    remoteAddress: (c) => {
      const server = c.env as { requestIP?: (req: Request) => { address: string } | null };
      return server?.requestIP?.(c.req.raw)?.address ?? null;
    },
  });

  const hostname = process.env.HOST || (mode === "sidecar" ? "127.0.0.1" : "0.0.0.0");
  const server = Bun.serve({
    hostname,
    port: Number(process.env.PORT ?? 0) || 0,
    idleTimeout: 120,
    fetch: (req, srv) => app.fetch(req, srv),
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
      await handle.close();
      await embedded?.stop();
    } finally {
      process.exit(0);
    }
  };

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

main().catch((error) => {
  log(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
