// The Cloud upgrade from a Sidecar-only install (ADR 0008): the embedded
// database moves into the Cloud's Postgres and this Device re-pairs with the
// Cloud URL. Two paths move the data:
//
//   export   pg_dump of the embedded cluster to a file the user restores by
//            hand (`pg_restore --no-owner --no-acl -d "$DATABASE_URL_UNPOOLED"`);
//            the binary comes from the entry, which knows where resources live;
//   copy     table by table over COPY from the embedded database into the
//            target, in foreign key order, after migrating the target. Pure
//            SQL, so it needs no binary and runs from the Sidecar itself.
//
// `attach` records the Cloud's connection string in the data directory so the
// next Sidecar launch opens that database instead of the embedded one: the
// "both" mode of ADR 0005, one Postgres and two workers.
//
// Runtime-neutral apart from node:stream, which Bun and Node both provide.

import { pipeline } from "node:stream/promises";
import type { DeploymentMode } from "@monday/shared";
import type { Sql } from "postgres";
import type { DbHandle } from "../db/client.ts";

/** Process state and transient rows never move between databases. */
export const SKIPPED_TABLES: readonly string[] = ["servers", "pairing_codes"];

export interface ExportResult {
  path: string;
  bytes: number;
  at: string;
}

export interface CopyResult {
  tables: Array<{ name: string; rows: number }>;
  /** Milliseconds from first connection to last sequence reset. */
  elapsedMs: number;
}

export interface UpgradeStatus {
  mode: DeploymentMode;
  /** Whether a pg_dump binary was found, so export is offered. */
  canExport: boolean;
  lastExport: ExportResult | null;
  /** The host of the attached Cloud database, when one is recorded; null on embedded. */
  attachedHost: string | null;
  /** True when the attach file changed since boot and the Sidecar must restart to use it. */
  restartRequired: boolean;
}

export interface AttachStore {
  read(): Promise<string | null>;
  write(url: string): Promise<void>;
  clear(): Promise<void>;
}

export interface UpgradeOptions {
  mode: DeploymentMode;
  /** The embedded database's own connection string (the copy source). */
  sourceUrl: string;
  /** Opens a connection to any URL; the entry supplies createDb with pooling detection. */
  connect: (url: string) => DbHandle;
  /** Applies this build's migrations to a target; drizzle's migrate over a raw Sql. */
  migrate: (sql: Sql) => Promise<unknown>;
  /** Runs pg_dump into the path; absent when no binary is available. */
  dump?: ((sourceUrl: string, path: string) => Promise<number>) | undefined;
  /** Where an export lands; the entry chooses a directory and a name. */
  exportPath: () => string;
  /** The attach file in the data directory. */
  attach: AttachStore;
  now?: () => Date;
  log?: (message: string) => void;
}

export class UpgradeError extends Error {
  constructor(
    readonly code:
      | "export_unavailable"
      | "not_sidecar"
      | "target_unreachable"
      | "target_not_empty"
      | "invalid_url",
    message: string,
  ) {
    super(message);
    this.name = "UpgradeError";
  }
}

export interface Upgrade {
  status(): Promise<UpgradeStatus>;
  exportDatabase(): Promise<ExportResult>;
  /** Copies every table into `targetUrl`, replacing what is there. Refuses a target with Accounts. */
  copyDatabase(targetUrl: string, options?: { replace?: boolean }): Promise<CopyResult>;
  /** Checks the target answers and carries the schema, then records it for the next launch. */
  attach(targetUrl: string): Promise<{ restartRequired: boolean }>;
  detach(): Promise<{ restartRequired: boolean }>;
}

interface ColumnInfo {
  table: string;
  column: string;
  serial: boolean;
}

interface TablePlan {
  name: string;
  columns: string[];
  serials: string[];
}

const quote = (ident: string) => `"${ident.replaceAll('"', '""')}"`;

/** Public tables in an order that satisfies every foreign key (parents first). */
export async function tablePlan(sql: Sql): Promise<TablePlan[]> {
  const cols = await sql<
    { table_name: string; column_name: string; column_default: string | null }[]
  >`
    select table_name, column_name, column_default
    from information_schema.columns
    where table_schema = 'public' and is_generated = 'NEVER'
    order by table_name, ordinal_position
  `;
  const fks = await sql<{ child: string; parent: string }[]>`
    select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent
    from pg_constraint c
    join pg_namespace n on n.oid = c.connamespace
    where c.contype = 'f' and n.nspname = 'public'
  `;
  const byTable = new Map<string, ColumnInfo[]>();
  for (const c of cols) {
    const list = byTable.get(c.table_name) ?? [];
    list.push({
      table: c.table_name,
      column: c.column_name,
      serial: (c.column_default ?? "").startsWith("nextval("),
    });
    byTable.set(c.table_name, list);
  }
  const strip = (name: string) => name.replace(/^public\./, "").replaceAll('"', "");
  const parents = new Map<string, Set<string>>();
  for (const name of byTable.keys()) parents.set(name, new Set());
  for (const fk of fks) {
    const child = strip(fk.child);
    const parent = strip(fk.parent);
    if (child !== parent) parents.get(child)?.add(parent);
  }
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string, trail: Set<string>) => {
    if (seen.has(name)) return;
    if (trail.has(name)) return; // a cycle: the schema has none, so this never fires
    trail.add(name);
    for (const p of parents.get(name) ?? []) visit(p, trail);
    trail.delete(name);
    seen.add(name);
    ordered.push(name);
  };
  for (const name of [...byTable.keys()].sort()) visit(name, new Set());
  return ordered
    .filter((name) => !SKIPPED_TABLES.includes(name))
    .map((name) => {
      const list = byTable.get(name) ?? [];
      return {
        name,
        columns: list.map((c) => c.column),
        serials: list.filter((c) => c.serial).map((c) => c.column),
      };
    });
}

export function createUpgrade(options: UpgradeOptions): Upgrade {
  const { mode, sourceUrl, connect, migrate, dump, attach } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  let lastExport: ExportResult | null = null;
  let attachedAtBoot: string | null | undefined;
  let attachedNow: string | null | undefined;

  const bootAttach = async () => {
    if (attachedAtBoot === undefined) attachedAtBoot = await attach.read();
    return attachedAtBoot;
  };

  const parseTarget = (url: string): URL => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new UpgradeError("invalid_url", "the connection string is not a URL");
    }
    if (!/^postgres(ql)?:$/.test(u.protocol)) {
      throw new UpgradeError("invalid_url", "the connection string must start with postgres://");
    }
    return u;
  };

  const api: Upgrade = {
    async status() {
      const boot = await bootAttach();
      const current = attachedNow === undefined ? boot : attachedNow;
      return {
        mode,
        canExport: Boolean(dump),
        lastExport,
        attachedHost: current ? parseTarget(current).hostname : null,
        restartRequired: current !== boot,
      };
    },

    async exportDatabase() {
      if (!dump) {
        throw new UpgradeError(
          "export_unavailable",
          "pg_dump is not available beside this server; copy the database instead, or run pg_dump by hand",
        );
      }
      const path = options.exportPath();
      const bytes = await dump(sourceUrl, path);
      lastExport = { path, bytes, at: now().toISOString() };
      log(`exported ${bytes} bytes to ${path}`);
      return lastExport;
    },

    async copyDatabase(targetUrl, copyOptions = {}) {
      parseTarget(targetUrl);
      const started = now().getTime();
      const source = connect(sourceUrl);
      const target = connect(targetUrl);
      try {
        try {
          await target.sql`select 1`;
        } catch (error) {
          throw new UpgradeError(
            "target_unreachable",
            `the target database did not answer: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        await migrate(target.sql);
        const plan = await tablePlan(source.sql);
        if (!copyOptions.replace) {
          const [row] = await target.sql<{ n: string }[]>`select count(*)::text as n from accounts`;
          if (Number(row?.n ?? 0) > 0) {
            throw new UpgradeError(
              "target_not_empty",
              "the target database already holds accounts; copy again with replace to overwrite it",
            );
          }
        }
        const tables: CopyResult["tables"] = [];
        await target.sql.begin(async (tx) => {
          // Children first so nothing references a row about to go.
          for (const t of [...plan].reverse()) await tx.unsafe(`truncate ${quote(t.name)} cascade`);
          for (const t of plan) {
            const list = t.columns.map(quote).join(", ");
            const readable = await source.sql
              .unsafe(`copy ${quote(t.name)} (${list}) to stdout`)
              .readable();
            const writable = await tx
              .unsafe(`copy ${quote(t.name)} (${list}) from stdin`)
              .writable();
            await pipeline(readable, writable);
            const [count] = await tx.unsafe(`select count(*)::text as n from ${quote(t.name)}`);
            tables.push({
              name: t.name,
              rows: Number((count as { n: string } | undefined)?.n ?? 0),
            });
            for (const col of t.serials) {
              await tx.unsafe(
                `select setval(pg_get_serial_sequence('${t.name}', '${col}'), coalesce(max(${quote(col)}), 0) + 1, false) from ${quote(t.name)}`,
              );
            }
          }
        });
        log(`copied ${tables.length} table(s) in ${now().getTime() - started} ms`);
        return { tables, elapsedMs: now().getTime() - started };
      } finally {
        await source.close().catch(() => {});
        await target.close().catch(() => {});
      }
    },

    async attach(targetUrl) {
      if (mode !== "sidecar") {
        throw new UpgradeError("not_sidecar", "only the Sidecar attaches to a Cloud database");
      }
      parseTarget(targetUrl);
      const boot = await bootAttach();
      const target = connect(targetUrl);
      try {
        await target.sql`select 1 from accounts limit 1`;
      } catch (error) {
        throw new UpgradeError(
          "target_unreachable",
          `the target database did not answer with monday's schema: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        await target.close().catch(() => {});
      }
      await attach.write(targetUrl);
      attachedNow = targetUrl;
      return { restartRequired: targetUrl !== boot };
    },

    async detach() {
      const boot = await bootAttach();
      await attach.clear();
      attachedNow = null;
      return { restartRequired: boot !== null };
    },
  };
  return api;
}
