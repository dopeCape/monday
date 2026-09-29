// The Sidecar as a background service (ADR 0013): the pieces of the process's
// life that are files and signals. The runtime file tells the app (and
// `monday-server stop`) which process serves which port and build; the token
// file holds the loopback token the app keeps in the OS keychain; the log is
// rotated by size. Node APIs only; entry-only.
//
// Files in the data directory:
//   sidecar.json    {pid, port, build, startedAt, state, managedBy}; written atomically, 0600,
//                   removed on a clean shutdown. Never holds the token.
//   sidecar.token   the loopback bearer token, 0600, written by the app from the keychain
//   sidecar.log     stdout and stderr of the service; sidecar.log.1 is the one older log

import { existsSync, readFileSync, rmSync } from "node:fs";
import {
  chmod,
  copyFile,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { ServiceManager } from "@monday/shared";

export const RUNTIME_FILE = "sidecar.json";
export const TOKEN_FILE = "sidecar.token";
export const LOG_FILE = "sidecar.log";

export interface RuntimeInfo {
  pid: number;
  /** Null while the service is starting (Postgres, migrations) and not yet listening. */
  port: number | null;
  build: string;
  startedAt: string;
  state: "starting" | "ready";
  managedBy: ServiceManager;
}

const MANAGERS: readonly ServiceManager[] = ["systemd", "launchd", "process"];

/** Parses a runtime file's text; null for anything that is not one. */
export function parseRuntimeInfo(text: string): RuntimeInfo | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const pid = r.pid;
  const port = r.port;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (port !== null && (typeof port !== "number" || !Number.isInteger(port) || port <= 0))
    return null;
  if (typeof r.build !== "string" || typeof r.startedAt !== "string") return null;
  if (r.state !== "starting" && r.state !== "ready") return null;
  const managedBy = MANAGERS.includes(r.managedBy as ServiceManager)
    ? (r.managedBy as ServiceManager)
    : "process";
  return {
    pid,
    port: port as number | null,
    build: r.build,
    startedAt: r.startedAt,
    state: r.state,
    managedBy,
  };
}

/** Writes the runtime file atomically: a temporary file beside it, then a rename. */
export async function writeRuntimeFile(dataDir: string, info: RuntimeInfo): Promise<void> {
  const path = join(dataDir, RUNTIME_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, path);
}

export async function readRuntimeFile(dataDir: string): Promise<RuntimeInfo | null> {
  const text = await readFile(join(dataDir, RUNTIME_FILE), "utf8").catch(() => null);
  return text === null ? null : parseRuntimeInfo(text);
}

/** Removes the runtime file when it still names this process; a newer service's file is kept. */
export async function removeRuntimeFile(dataDir: string, pid: number): Promise<boolean> {
  const info = await readRuntimeFile(dataDir);
  if (!info || info.pid !== pid) return false;
  await rm(join(dataDir, RUNTIME_FILE), { force: true });
  return true;
}

/** The same for an exit hook, where nothing can be awaited. */
export function removeRuntimeFileSync(dataDir: string, pid: number): void {
  try {
    const path = join(dataDir, RUNTIME_FILE);
    const info = parseRuntimeInfo(readFileSync(path, "utf8"));
    if (info?.pid === pid) rmSync(path, { force: true });
  } catch {}
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, owned by someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Another live service on this data directory, if the runtime file names one.
 * A second copy started by a race exits instead of opening the same database.
 */
export async function otherService(
  dataDir: string,
  self: number,
  alive: (pid: number) => boolean = pidAlive,
): Promise<RuntimeInfo | null> {
  const info = await readRuntimeFile(dataDir);
  if (!info || info.pid === self) return null;
  return alive(info.pid) ? info : null;
}

/** The loopback token from the token file; null when there is none. */
export async function readTokenFile(path: string): Promise<string | null> {
  const text = await readFile(path, "utf8").catch(() => null);
  const token = text?.trim();
  return token ? token : null;
}

export interface ServiceArgs {
  dataDir: string | null;
  build: string | null;
  managedBy: ServiceManager;
  tokenFile: string | null;
}

/** `monday-server service --data-dir <dir> --build <id> --managed-by <systemd|launchd|process>`. */
export function parseServiceArgs(argv: readonly string[]): ServiceArgs {
  const out: ServiceArgs = { dataDir: null, build: null, managedBy: "process", tokenFile: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) break;
    if (flag === "--data-dir") out.dataDir = value;
    else if (flag === "--build") out.build = value;
    else if (flag === "--token-file") out.tokenFile = value;
    else if (flag === "--managed-by" && MANAGERS.includes(value as ServiceManager))
      out.managedBy = value as ServiceManager;
    else continue;
    i++;
  }
  return out;
}

/**
 * Where the desktop app keeps its data (Tauri's app data directory for
 * io.monday.desktop), for `monday-server stop` run without --data-dir.
 */
export function defaultDataDir(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string {
  const id = "io.monday.desktop";
  if (platform === "darwin") return join(home, "Library", "Application Support", id);
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), id);
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), id);
}

/**
 * Rotates the log when it passed `maxBytes`: copies it to `<log>.1` and
 * truncates it in place. The service's stdout and stderr stay open on the same
 * file in append mode, so the next line lands at the start of the fresh file.
 */
export async function rotateLog(path: string, maxBytes: number): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  if (!info || info.size <= maxBytes) return false;
  await copyFile(path, `${path}.1`);
  await truncate(path, 0);
  return true;
}

/** Resident memory of a process on Linux, from /proc; null elsewhere or when unreadable. */
async function procRss(pid: number): Promise<number | null> {
  const text = await readFile(`/proc/${pid}/status`, "utf8").catch(() => null);
  const kb = text ? /^VmRSS:\s+(\d+)\s+kB/m.exec(text)?.[1] : undefined;
  return kb ? Number(kb) * 1024 : null;
}

/**
 * Resident memory of the embedded Postgres: the postmaster named by its pid
 * file and every process it forked. Linux only; null elsewhere.
 */
export async function postgresRss(dataDir: string): Promise<number | null> {
  if (process.platform !== "linux") return null;
  const pidText = await readFile(join(dataDir, "postgres", "postmaster.pid"), "utf8").catch(
    () => null,
  );
  const postmaster = Number(pidText?.split(/\r?\n/)[0]);
  if (!Number.isInteger(postmaster) || postmaster <= 0) return null;
  let total = (await procRss(postmaster)) ?? 0;
  const entries = await readdir("/proc").catch(() => [] as string[]);
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = await readFile(`/proc/${entry}/stat`, "utf8").catch(() => null);
    // pid (comm) state ppid ...; comm may hold spaces, so read after the last ")".
    const ppid = stat ? Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) : Number.NaN;
    if (ppid === postmaster) total += (await procRss(Number(entry))) ?? 0;
  }
  return total;
}

/**
 * `monday-server stop`: SIGTERM to the service the runtime file names, then
 * waits for it to go. The graceful path (leases, Postgres) is the same as a
 * stop from Settings. Returns what happened, for the message.
 */
export async function stopService(
  dataDir: string,
  options: {
    timeoutMs?: number;
    alive?: (pid: number) => boolean;
    signal?: (pid: number) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<"stopped" | "not-running" | "timeout"> {
  const alive = options.alive ?? pidAlive;
  const signal = options.signal ?? ((pid: number) => process.kill(pid, "SIGTERM"));
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const info = await readRuntimeFile(dataDir);
  if (!info || !alive(info.pid)) {
    if (info) await rm(join(dataDir, RUNTIME_FILE), { force: true });
    return "not-running";
  }
  signal(info.pid);
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    if (!alive(info.pid)) return "stopped";
    await sleep(100);
  }
  return "timeout";
}

/** Whether a data directory looks like the app's (for a clear message when it is not). */
export function looksLikeDataDir(dir: string): boolean {
  return existsSync(join(dir, RUNTIME_FILE)) || existsSync(join(dir, "postgres"));
}
