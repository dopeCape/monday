// The Workspace's Views in the Cache (docs/spec/views.md, "Data and sync"):
// the feed's `view` rows mark a row stale (store/views.ts), and this module
// reads GET /views and writes the rows whole, so the nav, the View screen
// and the View panel read them offline. One sync per Store; a failure
// (offline, locked) waits for the next write.

import type { Id, View } from "@monday/shared";
import type { Store } from "../store/store.ts";
import { viewStatements } from "../store/views.ts";

export interface ViewSync {
  /** Reads the Server's list now and writes it; resolves false when the read failed. */
  refresh(): Promise<boolean>;
  stop(): void;
}

export function createViewSync(
  store: Store,
  list: (workspaceId: Id) => Promise<View[]>,
  log: (message: string) => void = () => {},
): ViewSync {
  let running: Promise<boolean> | null = null;
  let again = false;
  let stopped = false;

  const once = async (): Promise<boolean> => {
    try {
      const views = await list(store.workspaceId);
      if (stopped) return false;
      await store.write(viewStatements(views));
      return true;
    } catch (error) {
      log(`views: the list did not load: ${String(error)}`);
      return false;
    }
  };

  const refresh = (): Promise<boolean> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      let ok = await once();
      while (again && !stopped) {
        again = false;
        ok = await once();
      }
      running = null;
      return ok;
    })();
    return running;
  };

  const off = store.onWrite((tables) => {
    if (!tables.has("views") || stopped) return;
    void store
      .query<{ n: number }>(
        "select count(*) as n from views where content_stale = 1 and deleted = 0",
      )
      .then((rows) => {
        if ((rows[0]?.n ?? 0) > 0) void refresh();
      })
      .catch(() => {});
  });

  return {
    refresh,
    stop() {
      stopped = true;
      off();
    },
  };
}

const syncs = new WeakMap<Store, ViewSync>();

/** The one sync of a Store's Views, started (and read once) on first use. */
export function ensureViewSync(store: Store, list: (workspaceId: Id) => Promise<View[]>): ViewSync {
  const existing = syncs.get(store);
  if (existing) return existing;
  const sync = createViewSync(store, list);
  syncs.set(store, sync);
  void sync.refresh();
  return sync;
}
