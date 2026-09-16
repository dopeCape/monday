// Shared between the harness (which starts the embedded cluster) and the
// preload (which stops it). Kept dependency-free so the preload stays cheap.

export const TEST_CLUSTER_KEY = Symbol.for("monday.test.cluster");

export interface TestCluster {
  adminUrl: string;
  stop(): Promise<void>;
}

export type TestClusterGlobal = typeof globalThis & {
  [TEST_CLUSTER_KEY]?: TestCluster;
};
