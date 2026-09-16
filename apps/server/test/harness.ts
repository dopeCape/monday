// Test database harness. Uses TEST_DATABASE_URL when set (any Postgres the
// caller can CREATE DATABASE on); otherwise starts one embedded Postgres in a
// temp dir for the whole test process, which test/preload.ts stops at the end
// of the run. Each call to testDatabase() gets its own fresh, migrated
// database so test files do not see each other's rows.

import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { startEmbeddedPostgres } from "../entry/embedded-postgres.ts";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import { TEST_CLUSTER_KEY, type TestCluster, type TestClusterGlobal } from "./cluster-key.ts";

let cluster: Promise<TestCluster> | null = null;

async function startCluster(): Promise<TestCluster> {
  const fromEnv = process.env.TEST_DATABASE_URL;
  if (fromEnv) return { adminUrl: fromEnv, stop: async () => {} };

  const dataDir = await mkdtemp(join(tmpdir(), "monday-test-pg-"));
  const embedded = await startEmbeddedPostgres({ dataDir, database: "postgres" });
  // Reported so the startup cost stays visible in test output.
  console.error(`[harness] embedded postgres started in ${embedded.startupMs} ms`);

  let stopped = false;
  const handle: TestCluster = {
    adminUrl: embedded.url,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await embedded.stop().catch(() => embedded.killSync());
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
  (globalThis as TestClusterGlobal)[TEST_CLUSTER_KEY] = handle;
  return handle;
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export interface TestDatabase {
  url: string;
  handle: DbHandle;
  drop(): Promise<void>;
}

export async function testDatabase(): Promise<TestDatabase> {
  cluster ??= startCluster();
  const { adminUrl } = await cluster;
  const name = `monday_test_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database "${name}"`);
  await admin.end({ timeout: 2 });

  const url = withDatabase(adminUrl, name);
  const handle = createDb(url, { max: 3 });
  await migrate(handle.sql);

  return {
    url,
    handle,
    drop: async () => {
      await handle.close();
      const cleanup = postgres(adminUrl, { max: 1, onnotice: () => {} });
      await cleanup.unsafe(`drop database "${name}" with (force)`).catch(() => {});
      await cleanup.end({ timeout: 2 });
    },
  };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits until `check` returns true, polling, or fails after `timeoutMs`. */
export async function waitFor(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 5_000,
  stepMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(stepMs);
  }
  throw new Error(`condition not met within ${timeoutMs} ms`);
}
