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

export function StoreProvider({
  workspaceId,
  children,
  fallback = null,
  failed,
}: StoreProviderProps) {
  const shell = useShell();
  const [store, setStore] = useState<Store | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [content, setContent] = useState<ContentTransport | null>(null);
  const caps = useRef<Capabilities | null>(null);
  // The transport reads its Settings live, so a change applies on the next connection.
  const settingsRef = useRef(shell.settings);
  settingsRef.current = shell.settings;
  const refreshRef = useRef(shell.refresh);
  refreshRef.current = shell.refresh;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is Try again
  useEffect(() => {
    let disposed = false;
    let opened: Store | null = null;
    setError(null);
    void (async () => {
      const p = await platform();
      if (p.isTauri) {
        const [{ createStore }, { tauriDriver }, { apiContent, apiTransport }] = await Promise.all([
          import("./store.ts"),
          import("./driver.ts"),
          import("./transport.ts"),
        ]);
        const log = (m: string) => console.warn(`[store] ${m}`);
        opened = await createStore({
          workspaceId,
          driver: await tauriDriver(workspaceId),
          transport: apiTransport(shell.api, {
            capabilities: () => caps.current,
            pollSeconds: () => settingsRef.current["server.poll_seconds"],
            fallbackAfter: () => settingsRef.current["server.wake_fallback_after"],
            log,
          }),
          log,
          // The Agent changed a Setting on the Server: read them again so it shows now.
          onSettingsChanged: () => void refreshRef.current(),
        });
        if (!disposed) setContent(apiContent(shell.api));
      } else {
        const [{ createFakeStore }, { wasmDriver }] = await Promise.all([
          import("./fake.ts"),
          import("./wasm-driver.ts"),
        ]);
        const fake = await createFakeStore({ workspaceId, driver: await wasmDriver() });
        opened = fake.store;
        if (!disposed) setContent(fake.content);
      }
      if (disposed) {
        await opened.close();
        return;
      }
      setStore(opened);
    })().catch((e: unknown) => {
      // A Cache that cannot open (a failed migration, a locked file) says so.
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[store] opening Workspace ${workspaceId} failed:`, e);
      if (!disposed) setError(message);
    });
    return () => {
      disposed = true;
      void opened?.close();
    };
  }, [workspaceId, shell.api, attempt]);

  // The wake transport follows the Server the Shell picked (the Sidecar or the
  // Cloud): its capabilities choose WebSocket, SSE or polling, and a switch of
  // target reconnects.
  const probeSeconds = shell.settings["server.probe_seconds"];
  useEffect(() => {
    if (!store) return;
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    // Unknown capabilities (the Server was down when asked) read as polling;
    // they are asked for again every reachability check, and once they answer
    // the wake connection is remade so the offered push mode takes over.
    const learn = async (): Promise<boolean> => {
      if (!shell.server) return false;
      caps.current = await shell.api.capabilities().catch(() => null);
      return caps.current !== null;
    };
    const keepLearning = () => {
      if (cancelled || caps.current !== null || !shell.server) return;
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
      }, probeSeconds * 1000);
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
  }, [store, shell.server, shell.api, probeSeconds]);

  if (error !== null) {
    const retry = () => setAttempt((n) => n + 1);
    if (failed) return <>{failed(error, retry)}</>;
    throw new Error(error);
  }
  if (!store) return <>{fallback}</>;
  return (
    <StoreContext.Provider value={store}>
      <ContentContext.Provider value={content}>{children}</ContentContext.Provider>
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
