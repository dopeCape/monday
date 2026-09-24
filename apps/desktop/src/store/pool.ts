// Every Workspace's Store, kept open and syncing. Switching Workspaces hands
// over a Store that is already open and already holds the newest mail, so the
// switch is instant; the wake connection keeps each one current in the
// background. A Store is opened once (on first use, or warmed at start for
// every connected Account) and closed only when the pool is.

import type { NewMessage, Store } from "./store.ts";
import type { ContentTransport } from "./transport.ts";

export interface PoolEntry {
  status: "opening" | "open" | "failed";
  store: Store | null;
  content: ContentTransport | null;
  error: string | null;
}

export interface PoolHooks {
  /** Messages new to this Workspace's Cache (new mail notifications). */
  onNewMessages: (messages: NewMessage[]) => void;
}

export interface PoolDeps {
  /** Opens one Workspace's Store and its content routes. */
  open(workspaceId: string, hooks: PoolHooks): Promise<{ store: Store; content: ContentTransport }>;
  /** Starts its wake connection; returns the stop. */
  connect(store: Store): () => void;
  log?: (message: string) => void;
}

export interface StorePool {
  get(workspaceId: string): PoolEntry | undefined;
  /** Opens the Workspace's Store unless it is open or opening. */
  acquire(workspaceId: string): void;
  /** Opens every one of these in the background. */
  warm(workspaceIds: readonly string[]): void;
  /** Tries a failed one again. */
  retry(workspaceId: string): void;
  /** Called on any entry's change; for useSyncExternalStore. */
  subscribe(listener: () => void): () => void;
  /** New mail in any Workspace. */
  onNewMessages(listener: (workspaceId: string, messages: NewMessage[]) => void): () => void;
  /** Remakes every wake connection (the Server target changed). */
  reconnect(): void;
  close(): Promise<void>;
}

export function createStorePool(deps: PoolDeps): StorePool {
  const entries = new Map<string, PoolEntry>();
  const stops = new Map<string, () => void>();
  const listeners = new Set<() => void>();
  const mailListeners = new Set<(workspaceId: string, messages: NewMessage[]) => void>();
  let closed = false;

  const set = (workspaceId: string, entry: PoolEntry) => {
    // A new object per change, so a snapshot comparison sees it.
    entries.set(workspaceId, entry);
    for (const l of [...listeners]) l();
  };

  const open = (workspaceId: string) => {
    set(workspaceId, { status: "opening", store: null, content: null, error: null });
    deps
      .open(workspaceId, {
        onNewMessages: (messages) => {
          for (const l of [...mailListeners]) l(workspaceId, messages);
        },
      })
      .then(({ store, content }) => {
        if (closed) {
          void store.close();
          return;
        }
        stops.set(workspaceId, deps.connect(store));
        set(workspaceId, { status: "open", store, content, error: null });
      })
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        deps.log?.(`opening Workspace ${workspaceId} failed: ${message}`);
        set(workspaceId, { status: "failed", store: null, content: null, error: message });
      });
  };

  return {
    get: (workspaceId) => entries.get(workspaceId),
    acquire(workspaceId) {
      if (closed || entries.has(workspaceId)) return;
      open(workspaceId);
    },
    warm(workspaceIds) {
      for (const id of workspaceIds) this.acquire(id);
    },
    retry(workspaceId) {
      if (entries.get(workspaceId)?.status !== "failed") return;
      open(workspaceId);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onNewMessages(listener) {
      mailListeners.add(listener);
      return () => mailListeners.delete(listener);
    },
    reconnect() {
      for (const [id, entry] of entries) {
        if (entry.status !== "open" || !entry.store) continue;
        stops.get(id)?.();
        stops.set(id, deps.connect(entry.store));
      }
    },
    async close() {
      closed = true;
      for (const stop of stops.values()) stop();
      stops.clear();
      await Promise.all(
        [...entries.values()].map((e) => (e.store ? e.store.close() : Promise.resolve())),
      );
      entries.clear();
    },
  };
}
