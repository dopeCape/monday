// The Sidecar as a background service (ADR 0013), through the entry's file
// and signal helpers and the app's routes: the runtime file is written
// atomically, read back, refused when it is not one and left alone when a
// newer service owns it; a second service on the same data directory steps
// aside; the service's arguments and the app's data directory per platform;
// the log rotates by size; `monday-server stop` signals and waits; the
// desktop notification command per platform with its quoting; and
// GET /service and POST /service/stop behind the loopback token (a paired
// Device may read, only the Sidecar principal may stop). Nothing here starts
// a service or signals a real process: pids and signals are fakes.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceStatus } from "@monday/shared";
import type { Hono } from "hono";
import {
  createDesktopNotifier,
  notifyCommand,
  trimForNotification,
} from "../entry/desktop-notify.ts";
import {
  defaultDataDir,
  otherService,
  parseRuntimeInfo,
  parseServiceArgs,
  RUNTIME_FILE,
  type RuntimeInfo,
  readRuntimeFile,
  readTokenFile,
  removeRuntimeFile,
  rotateLog,
  stopService,
  writeRuntimeFile,
} from "../entry/service.ts";
import { type AppEnv, createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/index.ts";
import { createPresence } from "../src/presence.ts";
import { serviceRoutes } from "../src/routes/service.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const info = (over: Partial<RuntimeInfo> = {}): RuntimeInfo => ({
  pid: 4242,
  port: 51234,
  build: "b1",
  startedAt: "2026-09-29T08:00:00.000Z",
  state: "ready",
  managedBy: "systemd",
  ...over,
});

describe("the runtime file", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "monday-service-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("is written atomically with 0600, read back, and holds no token", async () => {
    await writeRuntimeFile(dir, info());
    expect(await readRuntimeFile(dir)).toEqual(info());
    const text = readFileSync(join(dir, RUNTIME_FILE), "utf8");
    expect(text).not.toContain("token");
    if (process.platform !== "win32") {
      expect(statSync(join(dir, RUNTIME_FILE)).mode & 0o777).toBe(0o600);
    }
    // No temporary file is left beside it.
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("a starting service has no port yet; anything else is not a runtime file", () => {
    expect(parseRuntimeInfo(JSON.stringify(info({ port: null, state: "starting" })))?.port).toBe(
      null,
    );
    expect(parseRuntimeInfo("not json")).toBeNull();
    expect(parseRuntimeInfo(JSON.stringify({ ...info(), pid: -1 }))).toBeNull();
    expect(parseRuntimeInfo(JSON.stringify({ ...info(), state: "odd" }))).toBeNull();
    expect(parseRuntimeInfo(JSON.stringify({ ...info(), port: "x" }))).toBeNull();
    // An unknown manager reads as a plain process.
    expect(parseRuntimeInfo(JSON.stringify({ ...info(), managedBy: "cron" }))?.managedBy).toBe(
      "process",
    );
  });

  test("is removed only by the service it names", async () => {
    await writeRuntimeFile(dir, info({ pid: 7 }));
    expect(await removeRuntimeFile(dir, 8)).toBe(false);
    expect(existsSync(join(dir, RUNTIME_FILE))).toBe(true);
    expect(await removeRuntimeFile(dir, 7)).toBe(true);
    expect(existsSync(join(dir, RUNTIME_FILE))).toBe(false);
    expect(await readRuntimeFile(dir)).toBeNull();
  });

  test("a second service steps aside for a live one, not for a stale file or itself", async () => {
    await writeRuntimeFile(dir, info({ pid: 100 }));
    expect((await otherService(dir, 200, () => true))?.pid).toBe(100);
    expect(await otherService(dir, 200, () => false)).toBeNull();
    expect(await otherService(dir, 100, () => true)).toBeNull();
  });

  test("monday-server stop signals the named service and waits for it to go", async () => {
    await writeRuntimeFile(dir, info({ pid: 300 }));
    let alive = true;
    const signalled: number[] = [];
    const result = await stopService(dir, {
      alive: () => alive,
      signal: (pid) => {
        signalled.push(pid);
        alive = false;
      },
      sleep: async () => {},
    });
    expect(result).toBe("stopped");
    expect(signalled).toEqual([300]);

    // A dead pid: nothing to signal, and the stale file goes.
    const none = await stopService(dir, { alive: () => false, signal: () => {} });
    expect(none).toBe("not-running");
    expect(existsSync(join(dir, RUNTIME_FILE))).toBe(false);

    await writeRuntimeFile(dir, info({ pid: 301 }));
    const stuck = await stopService(dir, {
      alive: () => true,
      signal: () => {},
      sleep: async () => {},
      timeoutMs: 5,
    });
    expect(stuck).toBe("timeout");
  });

  test("the token file is trimmed and absent reads as null", async () => {
    await writeFile(join(dir, "sidecar.token"), "abc123\n");
    expect(await readTokenFile(join(dir, "sidecar.token"))).toBe("abc123");
    expect(await readTokenFile(join(dir, "missing.token"))).toBeNull();
    await writeFile(join(dir, "empty.token"), "  \n");
    expect(await readTokenFile(join(dir, "empty.token"))).toBeNull();
  });

  test("the log rotates past its size into one older copy", async () => {
    const log = join(dir, "sidecar.log");
    await writeFile(log, "x".repeat(100));
    expect(await rotateLog(log, 200)).toBe(false);
    expect(await rotateLog(log, 50)).toBe(true);
    expect((await readFile(`${log}.1`, "utf8")).length).toBe(100);
    expect((await readFile(log, "utf8")).length).toBe(0);
    expect(await rotateLog(join(dir, "none.log"), 1)).toBe(false);
  });
});

describe("the service's arguments and data directory", () => {
  test("flags in any order; an unknown manager is ignored", () => {
    expect(
      parseServiceArgs([
        "--build",
        "abc",
        "--data-dir",
        "/d",
        "--managed-by",
        "systemd",
        "--token-file",
        "/t",
      ]),
    ).toEqual({ dataDir: "/d", build: "abc", managedBy: "systemd", tokenFile: "/t" });
    expect(parseServiceArgs(["--managed-by", "cron"]).managedBy).toBe("process");
    expect(parseServiceArgs([])).toEqual({
      dataDir: null,
      build: null,
      managedBy: "process",
      tokenFile: null,
    });
  });

  test("the app's data directory on each platform", () => {
    expect(defaultDataDir("linux", {}, "/home/u")).toBe("/home/u/.local/share/io.monday.desktop");
    expect(defaultDataDir("linux", { XDG_DATA_HOME: "/x" }, "/home/u")).toBe(
      "/x/io.monday.desktop",
    );
    expect(defaultDataDir("darwin", {}, "/Users/u")).toBe(
      "/Users/u/Library/Application Support/io.monday.desktop",
    );
    expect(defaultDataDir("win32", { APPDATA: "C:/Users/u/AppData/Roaming" }, "C:/Users/u")).toBe(
      join("C:/Users/u/AppData/Roaming", "io.monday.desktop"),
    );
  });
});

describe("desktop notifications from the Sidecar", () => {
  test("notify-send on Linux, with -- so a title is never an option", () => {
    expect(notifyCommand("linux", "-rf Kenji", "Term sheet")).toEqual({
      command: "notify-send",
      args: ["--app-name=monday", "--", "-rf Kenji", "Term sheet"],
    });
  });

  test("osascript on macOS with quotes and backslashes escaped", () => {
    const cmd = notifyCommand("darwin", 'Say "hi"', "a\\b");
    expect(cmd?.command).toBe("osascript");
    expect(cmd?.args[1]).toBe('display notification "a\\\\b" with title "Say \\"hi\\""');
  });

  test("PowerShell on Windows with single quotes doubled", () => {
    const cmd = notifyCommand("win32", "It's here", "Body");
    expect(cmd?.command).toBe("powershell.exe");
    expect(cmd?.args.at(-1)).toContain("$n.BalloonTipTitle = 'It''s here'");
  });

  test("long text is cut, and a platform without a command posts nothing", async () => {
    const cut = trimForNotification("x".repeat(100), 80);
    expect([...cut].length).toBe(80);
    expect(cut.endsWith("...")).toBe(true);
    expect(notifyCommand("aix", "t", "b")).toBeNull();
    const ran: string[][] = [];
    await createDesktopNotifier(
      "aix",
      async (c, a) => void ran.push([c, ...a]),
    )({
      title: "t",
      body: "b",
    });
    expect(ran).toEqual([]);
    await createDesktopNotifier(
      "linux",
      async (c, a) => void ran.push([c, ...a]),
    )({
      title: "t",
      body: "b",
    });
    expect(ran[0]?.[0]).toBe("notify-send");
  });
});

describe("GET /service and POST /service/stop", () => {
  let db: TestDatabase;
  let app: Hono<AppEnv>;
  let deviceToken = "";
  const stops: string[] = [];
  const presence = createPresence();
  const status: ServiceStatus = {
    pid: 4242,
    port: 51234,
    build: "b1",
    startedAt: "2026-09-29T08:00:00.000Z",
    managedBy: "systemd",
    rssBytes: 1,
    postgresRssBytes: null,
    unlocked: true,
    clientPresent: false,
    notified: { mailThrough: null, approvals: [] },
  };

  beforeAll(async () => {
    db = await testDatabase();
    const auth = createAuth({
      db: db.handle.db,
      sidecarToken: "loopback-token",
      setupCode: "123456",
    });
    deviceToken = (await auth.pairSetup("123456", "Laptop")).token;
    app = createApp({
      db: db.handle.db,
      auth,
      mode: "sidecar",
      remoteAddress: () => "127.0.0.1",
      presence,
      mounts: [serviceRoutes({ status: () => status, stop: (reason) => stops.push(reason) })],
    });
  }, 60_000);

  afterAll(async () => {
    await db.drop();
  });

  const call = (path: string, token: string | null, method = "GET") =>
    app.request(path, {
      method,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  test("both refuse a caller without a token", async () => {
    expect((await call("/service", null)).status).toBe(401);
    expect((await call("/service/stop", null, "POST")).status).toBe(401);
    expect((await call("/service/stop", "wrong", "POST")).status).toBe(401);
    expect(stops).toEqual([]);
  });

  test("a paired Device reads the status but may not stop the service", async () => {
    const res = await call("/service", deviceToken);
    expect(res.status).toBe(200);
    expect(((await res.json()) as ServiceStatus).build).toBe("b1");
    expect((await call("/service/stop", deviceToken, "POST")).status).toBe(403);
    expect(stops).toEqual([]);
  });

  test("the Sidecar's own client stops it: 202 at once, the shutdown right after", async () => {
    const res = await call("/service/stop", "loopback-token", "POST");
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ stopping: true });
    await new Promise((r) => setTimeout(r, 120));
    expect(stops).toEqual(["POST /service/stop"]);
  });

  test("a client's request counts as a client here; reading /service does not", async () => {
    const quiet = createPresence();
    const auth = createAuth({ db: db.handle.db, sidecarToken: "t2" });
    const probe = createApp({
      db: db.handle.db,
      auth,
      mode: "sidecar",
      remoteAddress: () => "127.0.0.1",
      presence: quiet,
      mounts: [serviceRoutes({ status: () => status, stop: () => {} })],
    });
    await probe.request("/service", { headers: { authorization: "Bearer t2" } });
    expect(quiet.present(60_000)).toBe(false);
    await probe.request("/settings", { headers: { authorization: "Bearer t2" } });
    expect(quiet.present(60_000)).toBe(true);
    // Without a token nothing counts.
    const other = createPresence();
    const anon = createApp({
      db: db.handle.db,
      auth,
      mode: "sidecar",
      remoteAddress: () => "127.0.0.1",
      presence: other,
    });
    await anon.request("/settings");
    expect(other.present(60_000)).toBe(false);
  });
});

describe("presence", () => {
  test("an open socket is present; after it closes, only within the grace", () => {
    let now = new Date("2026-09-29T08:00:00Z");
    const p = createPresence(() => now);
    expect(p.present(20_000)).toBe(false);
    expect(p.lastSeen()).toBeNull();
    p.open();
    now = new Date("2026-09-29T09:00:00Z");
    expect(p.present(20_000)).toBe(true);
    p.close();
    now = new Date("2026-09-29T09:00:10Z");
    expect(p.present(20_000)).toBe(true);
    now = new Date("2026-09-29T09:00:30Z");
    expect(p.present(20_000)).toBe(false);
    p.touch();
    expect(p.present(20_000)).toBe(true);
    // Closing more than opened never goes negative.
    p.close();
    p.close();
    now = new Date("2026-09-29T10:00:00Z");
    expect(p.present(20_000)).toBe(false);
  });
});
