// The Bun entry as the background service (ADR 0013), run for real in a
// temporary data directory with its own embedded Postgres on a free loopback
// port (never the user's): it writes the runtime file (starting, then ready
// with its port and build), reads its token from the token file, ignores a
// parent pid that is gone (it outlives the app on purpose), refuses a second
// copy on the same data directory, waits locked until POST /unlock, and stops
// on POST /service/stop: exit 0, runtime file removed, Postgres stopped.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceStatus } from "@monday/shared";
import { type RuntimeInfo, readRuntimeFile } from "../entry/service.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { encodeKey } from "../src/crypto/keys.ts";

const ENTRY = join(import.meta.dir, "..", "entry", "bun.ts");
const TOKEN = "entry-test-token";

/** The environment without anything that would point the service at a real install. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("MONDAY_") || k.startsWith("DATABASE_") || k === "PORT") continue;
    env[k] = v;
  }
  return { ...env, PORT: "0", ...extra };
}

async function waitFor<T>(probe: () => Promise<T | null>, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const got = await probe();
    if (got) return got;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out");
}

describe("monday-server service", () => {
  let dir = "";
  let child: ReturnType<typeof spawn> | null = null;
  let exited: Promise<number | null> = Promise.resolve(null);
  let ready: RuntimeInfo | null = null;
  let log = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "monday-service-entry-"));
    await writeFile(join(dir, "sidecar.token"), `${TOKEN}\n`, { mode: 0o600 });
    // A parent that is already gone: a plain start would shut down, the service must not.
    const gone = spawnSync(process.execPath, ["-e", "0"]).pid ?? 999_999;
    child = spawn(
      process.execPath,
      [ENTRY, "service", "--data-dir", dir, "--build", "test-build", "--managed-by", "process"],
      {
        env: cleanEnv({ MONDAY_PARENT_PID: String(gone) }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.on("data", (d) => {
      log += String(d);
    });
    child.stderr?.on("data", (d) => {
      log += String(d);
    });
    exited = new Promise((resolve) => child?.on("exit", (code) => resolve(code)));
    ready = await waitFor(async () => {
      const info = await readRuntimeFile(dir);
      return info?.state === "ready" ? info : null;
    }, 90_000).catch((error) => {
      throw new Error(`${error}\n${log}`);
    });
  }, 120_000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000))]);
    }
    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  const call = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${ready?.port}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    });

  test("the runtime file names the process, its port and its build, and no token", async () => {
    expect(ready).toMatchObject({
      pid: child?.pid,
      build: "test-build",
      managedBy: "process",
      state: "ready",
    });
    expect(ready?.port).toBeGreaterThan(0);
    expect(JSON.stringify(ready)).not.toContain(TOKEN);
  });

  test("the token from the token file opens /service; a wrong one does not", async () => {
    const res = await call("/service");
    if (res.status !== 200) console.error(await res.text(), log);
    expect(res.status).toBe(200);
    const status = (await res.json()) as ServiceStatus;
    expect(status).toMatchObject({
      pid: child?.pid,
      build: "test-build",
      managedBy: "process",
      unlocked: false,
    });
    const wrong = await fetch(`http://127.0.0.1:${ready?.port}/service`, {
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);
  });

  test("a second copy on the same data directory steps aside", () => {
    const second = spawnSync(
      process.execPath,
      [ENTRY, "service", "--data-dir", dir, "--build", "test-build"],
      { env: cleanEnv({}), timeout: 30_000 },
    );
    expect(second.status).toBe(4);
  }, 40_000);

  test("it outlives a parent that is gone, and the app's key unlocks it", async () => {
    // The plain start's watchdog checks every 5 s; the service has none.
    await new Promise((r) => setTimeout(r, 6_000));
    expect(child?.exitCode).toBeNull();
    const unlock = await call("/unlock", {
      method: "POST",
      body: JSON.stringify({ rootKey: encodeKey(randomKey()) }),
    });
    expect(unlock.status).toBe(200);
    expect(((await (await call("/service")).json()) as ServiceStatus).unlocked).toBe(true);
  }, 20_000);

  test("POST /service/stop ends it cleanly: exit 0, no runtime file, no Postgres", async () => {
    const res = await call("/service/stop", { method: "POST" });
    expect(res.status).toBe(202);
    expect(await exited).toBe(0);
    expect(existsSync(join(dir, "sidecar.json"))).toBe(false);
    expect(existsSync(join(dir, "postgres", "postmaster.pid"))).toBe(false);
  }, 30_000);
});
