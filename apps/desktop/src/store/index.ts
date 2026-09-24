// The Store module (ADR 0009): the client's only data path. One interface,
// `Store`, opened per Workspace; the SQL, the drivers and the fake live behind it.

export type { Row, SqlDriver, SqlParam, Statement } from "./driver.ts";
export { tauriDriver } from "./driver.ts";
// The fake Store and the fixture seed are not exported here: they carry the
// design fixtures, which only the tests and the browser dev server (through
// react.tsx's lazy import) may load. Import them from "./fake.ts" and
// "./seed.ts" directly.
export * from "./queries.ts";
export {
  StorePoolProvider,
  StoreProvider,
  useContent,
  useLive,
  useStore,
  useStorePool,
  useStoreStatus,
  useSyncProgress,
} from "./react.tsx";
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
