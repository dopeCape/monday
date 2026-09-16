// The Store module (ADR 0009): the client's only data path. One interface,
// `Store`, opened per Workspace; the SQL, the drivers and the fake live behind it.

export type { Row, SqlDriver, SqlParam, Statement } from "./driver.ts";
export { tauriDriver } from "./driver.ts";
export {
  createFakeServer,
  createFakeStore,
  type FakeServer,
  type FakeStore,
  fakeTransport,
} from "./fake.ts";
export * from "./queries.ts";
export { StoreProvider, useLive, useStore, useStoreStatus } from "./react.tsx";
export { fixtureSeed, type SeedData, seedStatements } from "./seed.ts";
export {
  createStore,
  type LiveQuery,
  type Store,
  type StoreIntent,
  type StoreOptions,
  type StoreStatus,
  type SyncResult,
} from "./store.ts";
export { apiTransport, type StoreTransport } from "./transport.ts";
