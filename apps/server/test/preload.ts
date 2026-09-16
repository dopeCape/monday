// Test preload (bunfig.toml [test].preload): stops the embedded Postgres the
// harness may have started, once the whole run is over. Bun runs `afterAll`
// from a preload after every test file, and process exit hooks do not fire
// under `bun test`, so this is the one place the cluster can be stopped.
// Nothing is imported eagerly; a run that never touches the database pays
// nothing.

import { afterAll } from "bun:test";
import { TEST_CLUSTER_KEY, type TestClusterGlobal } from "./cluster-key.ts";

afterAll(async () => {
  const cluster = (globalThis as TestClusterGlobal)[TEST_CLUSTER_KEY];
  if (cluster) await cluster.stop();
});
