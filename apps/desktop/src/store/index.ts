// The Store module (ADR 0009): the client's only data path. One interface,
// `Store`, opened per Workspace; the SQL, the drivers and the fake live behind it.

export type { Row, SqlDriver, SqlParam, Statement } from "./driver.ts";
export { tauriDriver } from "./driver.ts";
export {
  createFakeServer,
  createFakeStore,
  type FakeServer,
  type FakeStore,
  fakeContent,
  fakeTransport,
} from "./fake.ts";
export * from "./queries.ts";
export {
  StoreProvider,
  useContent,
  useLive,
  useStore,
  useStoreStatus,
  useSyncProgress,
} from "./react.tsx";
export { fixtureSeed, type SeedData, seedStatements } from "./seed.ts";
export {
  type AnyIntent,
  type CachedMessageHeader,
  createStore,
  type DraftStoreIntent,
  type LiveQuery,
  type Store,
  type StoreIntent,
  type StoreOptions,
  type StoreStatus,
  type SyncProgress,
  type SyncResult,
} from "./store.ts";
export {
  apiContent,
  apiTransport,
  type ContentTransport,
  type StoreTransport,
} from "./transport.ts";
