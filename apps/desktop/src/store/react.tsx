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
  useSyncExternalStore,
} from "react";
import { platform } from "../platform/tauri.ts";
import { useShell } from "../shell/Shell.tsx";
import type { SqlParam } from "./driver.ts";
import { createStorePool, type StorePool } from "./pool.ts";
import type { Store, StoreStatus, SyncProgress } from "./store.ts";
import type { ContentTransport } from "./transport.ts";

const StoreContext = createContext<Store | null>(null);
const ContentContext = createContext<ContentTransport | null>(null);

export interface StoreProviderProps {
  workspaceId: string;
  children: ReactNode;
  /** Rendered until the Store is open; nothing by default. */
  fallback?: ReactNode;
  /**
   * Rendered when the Store could not open, with its reason and a retry. The
   * default rethrows during render, so the nearest error boundary shows it:
   * never an empty window that waits forever.
   */
  failed?: ((message: string, retry: () => void) => ReactNode) | undefined;
}

/* ------------------------------ The pool ------------------------------ */

const PoolContext = createContext<StorePool | null>(null);

/** The pool of every Workspace's Store; null outside a StorePoolProvider. */
export function useStorePool(): StorePool | null {
  return useContext(PoolContext);
}

/**
 * Keeps every Workspace's Store open and syncing for the life of the window,
 * so switching Workspaces is instant and each one already holds its new mail.
 * A new pool (and fresh Stores) only when the Shell's api itself changes.
 */
export function StorePoolProvider({ children }: { children: ReactNode }) {
  const shell = useShell();
  const settingsRef = useRef(shell.settings);
  settingsRef.current = shell.settings;
  const refreshRef = useRef(shell.refresh);
  refreshRef.current = shell.refresh;
  const serverRef = useRef(shell.server);
  serverRef.current = shell.server;
  const api = shell.api;

  const pool = useMemo(() => {
    const caps = new Map<string, Capabilities | null>();
    const log = (m: string) => console.warn(`[store] ${m}`);
    return createStorePool({
      log,
      async open(workspaceId, hooks) {
        const p = await platform();
        if (p.isTauri) {
          const [{ createStore }, { tauriDriver }, { apiContent, apiTransport }] =
            await Promise.all([
              import("./store.ts"),
              import("./driver.ts"),
              import("./transport.ts"),
            ]);
          const store = await createStore({
            workspaceId,
            driver: await tauriDriver(workspaceId),
            transport: apiTransport(api, {
              capabilities: () => caps.get(workspaceId) ?? null,
              pollSeconds: () => settingsRef.current["server.poll_seconds"],
              fallbackAfter: () => settingsRef.current["server.wake_fallback_after"],
              log,
            }),
            log,
            // The Agent changed a Setting on the Server: read them again so it shows now.
            onSettingsChanged: () => void refreshRef.current(),
            onNewMessages: hooks.onNewMessages,
          });
          return { store, content: apiContent(api) };
        }
        const [{ createFakeStore }, { wasmDriver }] = await Promise.all([
          import("./fake.ts"),
          import("./wasm-driver.ts"),
        ]);
        const fake = await createFakeStore({
          workspaceId,
          driver: await wasmDriver(),
          onNewMessages: hooks.onNewMessages,
        });
        return { store: fake.store, content: fake.content };
      },
      // The wake transport follows the Server the Shell picked (the Sidecar or
      // the Cloud): its capabilities choose WebSocket, SSE or polling. Unknown
      // capabilities (the Server was down when asked) read as polling and are
      // asked for again every reachability check; once they answer the wake
      // connection is remade so the offered push mode takes over.
      connect(store) {
        let cancelled = false;
        let unsubscribe: (() => void) | null = null;
        let retry: ReturnType<typeof setTimeout> | null = null;
        const learn = async (): Promise<boolean> => {
          if (!serverRef.current) return false;
          const known = await api.capabilities().catch(() => null);
          caps.set(store.workspaceId, known);
          return known !== null;
        };
        const keepLearning = () => {
          if (cancelled || caps.get(store.workspaceId) || !serverRef.current) return;
          retry = setTimeout(() => {
            void learn().then((known) => {
              if (cancelled) return;
              if (known) {
                unsubscribe?.();
                unsubscribe = store.subscribe();
              } else {
                keepLearning();
              }
            });
          }, settingsRef.current["server.probe_seconds"] * 1000);
        };
        void (async () => {
          const known = await learn();
          if (cancelled) return;
          unsubscribe = store.subscribe();
          if (!known) keepLearning();
        })();
        return () => {
          cancelled = true;
          if (retry) clearTimeout(retry);
          unsubscribe?.();
        };
      },
    });
  }, [api]);

  // The pool lives as long as the window: React's StrictMode unmounts and
  // remounts once in development, and closing here would leave it closed for
  // good. It closes when the page goes away.
  useEffect(() => {
    const close = () => void pool.close();
    window.addEventListener("pagehide", close);
    return () => window.removeEventListener("pagehide", close);
  }, [pool]);
  // A new Server target remakes every wake connection.
  const server = shell.server;
  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `server` is the trigger
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    pool.reconnect();
  }, [server, pool]);

  return <PoolContext.Provider value={pool}>{children}</PoolContext.Provider>;
}

/* ------------------------------ One Workspace's Store ------------------------------ */

export function StoreProvider(props: StoreProviderProps) {
  const pool = useContext(PoolContext);
  // Without a pool (a test, a lone screen) the provider brings its own.
  if (!pool) {
    return (
      <StorePoolProvider>
        <StoreProvider {...props} />
      </StorePoolProvider>
    );
  }
  return <PooledStore pool={pool} {...props} />;
}

function PooledStore({
  pool,
  workspaceId,
  children,
  fallback = null,
  failed,
}: StoreProviderProps & { pool: StorePool }) {
  useEffect(() => {
    pool.acquire(workspaceId);
  }, [pool, workspaceId]);
  const entry = useSyncExternalStore(
    pool.subscribe,
    () => pool.get(workspaceId),
    () => pool.get(workspaceId),
  );
  if (entry?.status === "failed") {
    const message = entry.error ?? "";
    const retry = () => pool.retry(workspaceId);
    if (failed) return <>{failed(message, retry)}</>;
    throw new Error(message);
  }
  if (!entry || entry.status !== "open" || !entry.store) return <>{fallback}</>;
  return (
    <StoreContext.Provider value={entry.store}>
      <ContentContext.Provider value={entry.content}>{children}</ContentContext.Provider>
    </StoreContext.Provider>
  );
}

export function useStore(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error("useStore outside StoreProvider");
  return s;
}

/** The content routes for the open Store; null until the platform is known. */
export function useContent(): ContentTransport | null {
  return useContext(ContentContext);
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

/** Catch-up progress, for the thin line at the top of the inbox. */
export function useSyncProgress(): SyncProgress | null {
  const store = useStore();
  const [progress, setProgress] = useState<SyncProgress | null>(store.progress());
  useEffect(() => store.onProgress(setProgress), [store]);
  return progress;
}
