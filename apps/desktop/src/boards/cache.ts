// The Workspace's Boards in the Cache (docs/spec/boards.md, "Data and sync"):
// the feed's `board` rows mark a row stale (store/boards.ts), and this module
// reads GET /boards and writes the rows whole, so the nav, the Board screen
// and the Board panel read them offline. One sync per Store; a failure
// (offline, locked) waits for the next write.

import type { Board, Id } from "@monday/shared";
import { boardStatements } from "../store/boards.ts";
import type { Store } from "../store/store.ts";

export interface BoardSync {
  /** Reads the Server's list now and writes it; resolves false when the read failed. */
  refresh(): Promise<boolean>;
  stop(): void;
}

export function createBoardSync(
  store: Store,
  list: (workspaceId: Id) => Promise<Board[]>,
  log: (message: string) => void = () => {},
): BoardSync {
  let running: Promise<boolean> | null = null;
  let again = false;
  let stopped = false;

  const once = async (): Promise<boolean> => {
    try {
      const boards = await list(store.workspaceId);
      if (stopped) return false;
      await store.write(boardStatements(boards));
      return true;
    } catch (error) {
      log(`boards: the list did not load: ${String(error)}`);
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
    if (!tables.has("boards") || stopped) return;
    void store
      .query<{ n: number }>(
        "select count(*) as n from boards where content_stale = 1 and deleted = 0",
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

const syncs = new WeakMap<Store, BoardSync>();

/** The one sync of a Store's Boards, started (and read once) on first use. */
export function ensureBoardSync(
  store: Store,
  list: (workspaceId: Id) => Promise<Board[]>,
): BoardSync {
  const existing = syncs.get(store);
  if (existing) return existing;
  const sync = createBoardSync(store, list);
  syncs.set(store, sync);
  void sync.refresh();
  return sync;
}
