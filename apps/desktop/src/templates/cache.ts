// The Workspace's Templates in the Cache (docs/spec/templates.md, "Where
// Templates live"): the feed's `template` rows mark the content stale
// (store.ts, templateUpsert), and this module reads GET /templates and writes
// the rows whole, so the picker, the palette and search read them offline.
// One sync per Store; a failure (offline, locked) waits for the next write.

import type { Id, Template } from "@monday/shared";
import type { Statement, Store } from "../store/store.ts";

/** The own Templates the picker lists, oldest first. */
export const OWN_TEMPLATES_SQL =
  "select * from templates where deleted = 0 and content_stale = 0 order by rowid";

export function rowToTemplate(row: Record<string, unknown>, workspaceId: Id): Template {
  let placeholders: Template["placeholders"] = [];
  try {
    const parsed = JSON.parse(String(row.placeholders ?? "[]")) as unknown;
    if (Array.isArray(parsed)) placeholders = parsed as Template["placeholders"];
  } catch {}
  return {
    id: String(row.id),
    workspaceId,
    shareGroupId: (row.share_group_id as string | null) ?? null,
    builtIn: (row.built_in as string | null) ?? null,
    createdBy: row.created_by === "agent" ? "agent" : "user",
    updatedAt: String(row.updated_at ?? ""),
    kind: row.kind === "starter" ? "starter" : "reply",
    name: String(row.name ?? ""),
    fitsWhen: String(row.fits_when ?? ""),
    subject: (row.subject as string | null) ?? null,
    body: String(row.body ?? ""),
    placeholders,
  };
}

/**
 * The Cache after a full read of the Server's list: every row written with
 * its content, and a row the Server no longer lists marked deleted.
 */
export function templateStatements(templates: readonly Template[]): Statement[] {
  const ids = templates.map((t) => t.id);
  const out: Statement[] = templates.map((t) => ({
    sql: `insert into templates (id, kind, built_in, share_group_id, created_by, name, fits_when, subject, body,
            placeholders, updated_at, deleted, content_stale)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
          on conflict (id) do update set kind = excluded.kind, built_in = excluded.built_in,
            share_group_id = excluded.share_group_id, created_by = excluded.created_by, name = excluded.name,
            fits_when = excluded.fits_when, subject = excluded.subject, body = excluded.body,
            placeholders = excluded.placeholders, updated_at = excluded.updated_at, deleted = 0, content_stale = 0`,
    params: [
      t.id,
      t.kind,
      t.builtIn,
      t.shareGroupId,
      t.createdBy,
      t.name,
      t.fitsWhen,
      t.subject,
      t.body,
      JSON.stringify(t.placeholders),
      t.updatedAt,
    ],
  }));
  // Everything else is gone on the Server: deleted here, and nothing left to read.
  out.push(
    ids.length === 0
      ? { sql: "update templates set deleted = 1, content_stale = 0", params: [] }
      : {
          sql: `update templates set deleted = 1, content_stale = 0 where id not in (${ids
            .map(() => "?")
            .join(", ")})`,
          params: ids,
        },
  );
  return out;
}

export interface TemplateSync {
  /** Reads the Server's list now and writes it; resolves false when the read failed. */
  refresh(): Promise<boolean>;
  stop(): void;
}

export function createTemplateSync(
  store: Store,
  list: (workspaceId: Id) => Promise<Template[]>,
  log: (message: string) => void = () => {},
): TemplateSync {
  let running: Promise<boolean> | null = null;
  let again = false;
  let stopped = false;

  const once = async (): Promise<boolean> => {
    try {
      const templates = await list(store.workspaceId);
      if (stopped) return false;
      await store.write(templateStatements(templates));
      return true;
    } catch (error) {
      log(`templates: the list did not load: ${String(error)}`);
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
    if (!tables.has("templates") || stopped) return;
    void store
      .query<{ n: number }>(
        "select count(*) as n from templates where content_stale = 1 and deleted = 0",
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

const syncs = new WeakMap<Store, TemplateSync>();

/** The one sync of a Store's Templates, started (and read once) on first use. */
export function ensureTemplateSync(
  store: Store,
  list: (workspaceId: Id) => Promise<Template[]>,
): TemplateSync {
  const existing = syncs.get(store);
  if (existing) return existing;
  const sync = createTemplateSync(store, list);
  syncs.set(store, sync);
  void sync.refresh();
  return sync;
}
