// Embedded Postgres for the Sidecar-only install (ADR 0005): one schema and
// one query layer everywhere. The cluster lives under MONDAY_DATA_DIR and
// listens on a random loopback port with a password kept in a 0600 file next
// to it. Node and Bun APIs are fine here; this file is entry-only.

import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import postgres from "postgres";

export interface EmbeddedOptions {
  dataDir: string;
  database?: string;
  user?: string;
  log?: (message: string) => void;
}

export interface EmbeddedHandle {
  url: string;
  port: number;
  /** Milliseconds from call to a usable database. */
  startupMs: number;
  stop(): Promise<void>;
  /** Last resort for process exit hooks, where nothing can be awaited. */
  killSync(): void;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function randomPassword(): string {
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function readOrCreatePassword(file: string): Promise<string> {
  if (existsSync(file)) return (await readFile(file, "utf8")).trim();
  const password = randomPassword();
  await writeFile(file, `${password}\n`, { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
  return password;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A cluster left running by a previous launch (the Tauri parent crashed) is reused. */
async function runningClusterPort(dbDir: string): Promise<number | null> {
  const pidFile = join(dbDir, "postmaster.pid");
  if (!existsSync(pidFile)) return null;
  const lines = (await readFile(pidFile, "utf8")).split(/\r?\n/);
  const pid = Number(lines[0]);
  const port = Number(lines[3]);
  if (!Number.isInteger(pid) || !Number.isInteger(port) || port <= 0) return null;
  return processAlive(pid) ? port : null;
}

export async function startEmbeddedPostgres(options: EmbeddedOptions): Promise<EmbeddedHandle> {
  const started = performance.now();
  const log = options.log ?? (() => {});
  const database = options.database ?? "monday";
  const user = options.user ?? "monday";
  const dbDir = join(options.dataDir, "postgres");
  await mkdir(options.dataDir, { recursive: true });
  const password = await readOrCreatePassword(join(options.dataDir, "postgres.password"));

  const reusePort = await runningClusterPort(dbDir);
  const port = reusePort ?? (await freePort());
  const pg = new EmbeddedPostgres({
    databaseDir: dbDir,
    user,
    password,
    port,
    persistent: true,
    authMethod: "scram-sha-256",
    initdbFlags: ["--encoding=UTF8", "--no-instructions"],
    postgresFlags: ["-c", "listen_addresses=127.0.0.1", "-c", "log_min_messages=warning"],
    onLog: (message) => log(String(message).trim()),
    onError: (message) => log(`postgres: ${String(message).trim()}`),
  });

  if (reusePort) {
    log(`reusing embedded postgres already running on port ${reusePort}`);
  } else {
    if (!existsSync(join(dbDir, "PG_VERSION"))) {
      log(`initialising embedded postgres in ${dbDir}`);
      await pg.initialise();
    }
    try {
      await pg.start();
    } catch (error) {
      throw new Error(
        `embedded postgres failed to start in ${dbDir}${error instanceof Error ? `: ${error.message}` : ""}`,
      );
    }
  }

  const adminUrl = `postgres://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    const exists = await admin`select 1 from pg_database where datname = ${database}`;
    if (exists.length === 0) await admin.unsafe(`create database "${database}"`);
  } finally {
    await admin.end({ timeout: 2 });
  }

  const url = `postgres://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
  const startupMs = Math.round(performance.now() - started);
  return {
    url,
    port,
    startupMs,
    stop: async () => {
      if (!reusePort) await pg.stop();
    },
    killSync: () => {
      if (reusePort) return;
      const pid = (pg as unknown as { process?: { pid?: number } }).process?.pid;
      if (pid) {
        try {
          process.kill(pid, "SIGINT");
        } catch {}
      }
    },
  };
}
