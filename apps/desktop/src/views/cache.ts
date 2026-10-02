// The Workspace's Views in the Cache (docs/spec/views.md, "Data and sync"):
// the feed's `view` rows mark a row stale (store/views.ts), and this module
// reads GET /views and writes the rows whole, so the nav, the View screen
// and the View panel read them offline. The values the Views' Extractions
// picked follow the same way: after a list is read each View's values are
// read once, and a `view_values` feed row marks its Thread stale until
// POST /views/values reads it again. A View whose scope is a full search has
// its members read whole once per version (GET /views/:id/members); the feed's
// `view_members` rows keep them current after that. One sync per Store; a
// failure (offline, locked) waits for the next write.

import type { ExtractedValue, Id, View } from "@monday/shared";
import { viewExtractionId } from "@monday/shared";
import type { Store } from "../store/store.ts";
import {
  VIEW_VALUES_STALE_SQL,
  viewMembersStatements,
  viewStatements,
  viewValuesStatements,
} from "../store/views.ts";

export interface ViewSync {
  /** Reads the Server's list now and writes it; resolves false when the read failed. */
  refresh(): Promise<boolean>;
  stop(): void;
}

type Values = Record<Id, Record<string, ExtractedValue>>;

/** Where the Views come from: the Server's list, and the values their Extractions picked. */
export interface ViewSource {
  list(workspaceId: Id): Promise<View[]>;
  values?: ((viewId: Id) => Promise<Values>) | undefined;
  valuesFor?: ((workspaceId: Id, threadIds: readonly Id[]) => Promise<Values>) | undefined;
  /** A search scope's members, ids only. */
  members?: ((viewId: Id) => Promise<Id[]>) | undefined;
}

/** How many stale Threads one read of POST /views/values covers. */
const VALUES_BATCH = 200;

export function createViewSync(
  store: Store,
  source: ViewSource | ((workspaceId: Id) => Promise<View[]>),
  log: (message: string) => void = () => {},
): ViewSync {
  const src: ViewSource = typeof source === "function" ? { list: source } : source;
  let running: Promise<boolean> | null = null;
  let again = false;
  let stopped = false;
  /** The version of each View whose values were read, so a list read reads them once per version. */
  const valuesRead = new Map<Id, number>();
  /** The version of each search View whose members were read whole. */
  const membersRead = new Map<Id, number>();

  const readMembers = async (views: readonly View[]) => {
    if (!src.members) return;
    for (const v of views) {
      if (!v.doc.scope.facts.query || membersRead.get(v.id) === v.version) continue;
      const ids = await src.members(v.id);
      if (stopped) return;
      await store.write(
        viewMembersStatements({ viewId: v.id, added: ids, removed: [], reset: true }),
      );
      membersRead.set(v.id, v.version);
    }
  };

  const readValues = async (views: readonly View[]) => {
    if (!src.values) return;
    for (const v of views) {
      if (v.doc.extractions.length === 0 || valuesRead.get(v.id) === v.version) continue;
      const values = await src.values(v.id);
      if (stopped) return;
      const ids = v.doc.extractions.map((x) => viewExtractionId(v.id, x.id));
      await store.write(viewValuesStatements(values, Object.keys(values), ids));
      valuesRead.set(v.id, v.version);
    }
  };

  const once = async (): Promise<boolean> => {
    try {
      const views = await src.list(store.workspaceId);
      if (stopped) return false;
      await store.write(viewStatements(views));
      await readMembers(views);
      await readValues(views);
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

  let reading = false;
  /** Reads the values of the Threads the feed marked stale, a batch at a time. */
  const readStale = async () => {
    if (reading || !src.valuesFor || stopped) return;
    reading = true;
    try {
      for (;;) {
        const rows = await store.query<{ thread_id: string }>(VIEW_VALUES_STALE_SQL, [
          VALUES_BATCH,
        ]);
        const ids = rows.map((r) => r.thread_id);
        if (ids.length === 0 || stopped) break;
        const values = await src.valuesFor(store.workspaceId, ids);
        await store.write(viewValuesStatements(values, ids));
        if (ids.length < VALUES_BATCH) break;
      }
    } catch (error) {
      log(`views: the values did not load: ${String(error)}`);
    } finally {
      reading = false;
    }
  };

  const off = store.onWrite((tables) => {
    if (stopped) return;
    if (tables.has("view_values_stale")) void readStale();
    if (!tables.has("views")) return;
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
export function ensureViewSync(store: Store, source: ViewSource): ViewSync {
  const existing = syncs.get(store);
  if (existing) return existing;
  const sync = createViewSync(store, source);
  syncs.set(store, sync);
  void sync.refresh();
  return sync;
}
