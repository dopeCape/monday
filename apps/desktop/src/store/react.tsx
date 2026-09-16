// React glue for the Store: a provider that opens the Workspace's Store from
// the platform (Rust commands in Tauri, SQLite in WebAssembly seeded from the
// fixtures in the browser dev server) and a hook that renders a live query.

import type { Capabilities } from "@monday/shared";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { platform } from "../platform/tauri.ts";
import { useShell } from "../shell/Shell.tsx";
import type { SqlParam } from "./driver.ts";
import type { Store, StoreStatus } from "./store.ts";

const StoreContext = createContext<Store | null>(null);

export interface StoreProviderProps {
  workspaceId: string;
  children: ReactNode;
  /** Rendered until the Store is open; nothing by default. */
  fallback?: ReactNode;
}

export function StoreProvider({ workspaceId, children, fallback = null }: StoreProviderProps) {
  const shell = useShell();
  const [store, setStore] = useState<Store | null>(null);
  const caps = useRef<Capabilities | null>(null);

  useEffect(() => {
    let disposed = false;
    let opened: Store | null = null;
    void (async () => {
      const p = await platform();
      if (p.isTauri) {
        const [{ createStore }, { tauriDriver }, { apiTransport }] = await Promise.all([
          import("./store.ts"),
          import("./driver.ts"),
          import("./transport.ts"),
        ]);
        opened = await createStore({
          workspaceId,
          driver: await tauriDriver(workspaceId),
          transport: apiTransport(shell.api, () => caps.current),
          log: (m) => console.warn(`[store] ${m}`),
        });
      } else {
        const [{ createFakeStore }, { wasmDriver }] = await Promise.all([
          import("./fake.ts"),
          import("./wasm-driver.ts"),
        ]);
        opened = (await createFakeStore({ workspaceId, driver: await wasmDriver() })).store;
      }
      if (disposed) {
        await opened.close();
        return;
      }
      setStore(opened);
    })();
    return () => {
      disposed = true;
      void opened?.close();
    };
  }, [workspaceId, shell.api]);

  // The wake transport follows the Server: connect once the Sidecar is up.
  useEffect(() => {
    if (!store) return;
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    void (async () => {
      if (shell.sidecar?.running) {
        caps.current = await shell.api.capabilities().catch(() => null);
      }
      if (cancelled) return;
      unsubscribe = store.subscribe();
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [store, shell.sidecar, shell.api]);

  if (!store) return <>{fallback}</>;
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error("useStore outside StoreProvider");
  return s;
}

/**
 * Rows of a live query, mapped, re-rendered when a table it reads changes.
 * `undefined` until the first run. Params are compared by value.
 */
export function useLive<T>(
  sql: string,
  params: SqlParam[],
  map: (rows: Record<string, unknown>[]) => T[],
): T[] | undefined {
  const store = useStore();
  const key = useMemo(() => JSON.stringify(params), [params]);
  const mapRef = useRef(map);
  mapRef.current = map;
  const [rows, setRows] = useState<T[] | undefined>(undefined);
  useEffect(() => {
    const live = store.live<Record<string, unknown>>(sql, JSON.parse(key) as SqlParam[]);
    const un = live.subscribe((r) => setRows(mapRef.current(r)));
    return () => {
      un();
      live.close();
    };
  }, [store, sql, key]);
  return rows;
}

/** The Store's connection state, for the header dot. */
export function useStoreStatus(): StoreStatus {
  const store = useStore();
  const [status, setStatus] = useState<StoreStatus>(store.status());
  useEffect(() => store.onStatus(setStatus), [store]);
  return status;
}
