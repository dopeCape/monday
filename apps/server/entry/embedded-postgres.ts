// Embedded Postgres for the Sidecar-only install (ADR 0005): one schema and
// one query layer everywhere. The cluster lives under MONDAY_DATA_DIR and
// listens on a random loopback port with a password kept in a 0600 file next
// to it. Node and Bun APIs are fine here; this file is entry-only.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { settingsSchema } from "@monday/shared";
import postgres from "postgres";

import { type PgBinaries, postgresBinaries } from "./resources.ts";

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
  const bin = await postgresBinaries();
  let child: ChildProcess | null = null;

  if (reusePort) {
    log(`reusing embedded postgres already running on port ${reusePort}`);
  } else {
    if (!existsSync(join(dbDir, "PG_VERSION"))) {
      log(`initialising embedded postgres in ${dbDir}`);
      await initdb(bin, dbDir, user, password, log);
    }
    child = await startPostgres(bin, dbDir, port, log, await readBuffersMb(options.dataDir));
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
      if (!child) return;
      await stopPostgres(child);
    },
    killSync: () => {
      if (child?.pid) {
        try {
          process.kill(child.pid, "SIGINT");
        } catch {}
      }
    },
  };
}

function libEnv(bin: PgBinaries): NodeJS.ProcessEnv {
  const lib = join(bin.root, "lib");
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (process.platform === "linux")
    env.LD_LIBRARY_PATH = [lib, env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  if (process.platform === "darwin")
    env.DYLD_LIBRARY_PATH = [lib, env.DYLD_LIBRARY_PATH].filter(Boolean).join(":");
  return env;
}

async function initdb(
  bin: PgBinaries,
  dbDir: string,
  user: string,
  password: string,
  log: (m: string) => void,
): Promise<void> {
  const pwfile = join(dbDir, "..", "postgres.password");
  await new Promise<void>((resolve, reject) => {
    const p = spawn(
      bin.initdb,
      [
        "-D",
        dbDir,
        "-U",
        user,
        "--pwfile",
        pwfile,
        "--auth=scram-sha-256",
        "--encoding=UTF8",
        "--no-instructions",
      ],
      { env: libEnv(bin), stdio: ["ignore", "pipe", "pipe"] },
    );
    let err = "";
    p.stderr.on("data", (d) => {
      err += String(d);
    });
    p.stdout.on("data", (d) => log(String(d).trim()));
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`initdb exited ${code}: ${err.trim()}`)),
    );
  });
  void password;
}

const BUFFERS_FILE = "postgres.buffers";

/**
 * The shared buffer size this start uses: the server.postgres_buffers_mb
 * Setting as the last run saw it (the Setting lives in this database, so it
 * is read after the start and kept here for the next one), else its default.
 */
async function readBuffersMb(dataDir: string): Promise<number> {
  try {
    const n = Number((await readFile(join(dataDir, BUFFERS_FILE), "utf8")).trim());
    if (Number.isInteger(n) && n >= 8) return n;
  } catch {
    // First start: the default.
  }
  return settingsSchema["server.postgres_buffers_mb"].default;
}

/** Keeps the Setting for the next start; true when it differs from what runs now. */
export async function rememberBuffersMb(dataDir: string, mb: number): Promise<boolean> {
  const before = await readBuffersMb(dataDir);
  if (before === mb) return false;
  await writeFile(join(dataDir, BUFFERS_FILE), `${mb}\n`);
  return true;
}

async function startPostgres(
  bin: PgBinaries,
  dbDir: string,
  port: number,
  log: (m: string) => void,
  buffersMb: number,
): Promise<ChildProcess> {
  const p = spawn(
    bin.postgres,
    [
      "-D",
      dbDir,
      "-p",
      String(port),
      "-c",
      "listen_addresses=127.0.0.1",
      "-c",
      "log_min_messages=warning",
      "-c",
      `shared_buffers=${buffersMb}MB`,
    ],
    { env: libEnv(bin), stdio: ["ignore", "pipe", "pipe"] },
  );
  await new Promise<void>((resolve, reject) => {
    let out = "";
    const onData = (d: Buffer) => {
      out += String(d);
      log(String(d).trim());
      if (out.includes("ready to accept connections")) {
        p.stderr.off("data", onData);
        resolve();
      }
    };
    p.stderr.on("data", onData);
    p.on("error", reject);
    p.on("exit", (code) =>
      reject(new Error(`postgres exited ${code} before ready: ${out.trim()}`)),
    );
    setTimeout(
      () => reject(new Error(`postgres did not become ready in 30s: ${out.trim()}`)),
      30_000,
    ).unref();
  });
  return p;
}

function stopPostgres(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const t = setTimeout(() => {
      child.kill("SIGKILL");
    }, 10_000);
    t.unref();
    child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    child.kill("SIGINT"); // fast shutdown
  });
}
