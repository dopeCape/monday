// The seam under the Store: three calls against one SQLite connection. The
// real one is the Rust command layer (src-tauri/src/db.rs); tests use
// bun:sqlite (bun-driver.ts) and the browser dev server uses SQLite compiled to
// WebAssembly (wasm-driver.ts). Parameters are JSON values: booleans become
// 0/1, arrays and objects become JSON text, so every driver stores the same
// bytes for the same call.

export type SqlParam = string | number | boolean | null | undefined | object;
export type Row = Record<string, unknown>;

export interface Statement {
  sql: string;
  params?: SqlParam[];
}

export interface SqlDriver {
  /** Runs one statement (or a multi-statement script without params); returns rows changed. */
  exec(sql: string, params?: SqlParam[]): Promise<number>;
  query(sql: string, params?: SqlParam[]): Promise<Row[]>;
  /** Every statement in one transaction; any failure rolls all of them back. */
  batch(statements: Statement[]): Promise<void>;
  close(): Promise<void>;
}

export type BoundParam = string | number | null;

/** The one normalisation every driver applies before binding. */
export function bindParams(params: SqlParam[] | undefined): BoundParam[] {
  if (!params) return [];
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    if (typeof p === "number" || typeof p === "string") return p;
    return JSON.stringify(p);
  });
}

/** The Rust command layer: one connection per Workspace held by Tauri. */
export async function tauriDriver(workspace: string): Promise<SqlDriver> {
  const { invoke } = await import("@tauri-apps/api/core");
  return {
    exec: (sql, params) =>
      invoke<number>("db_exec", { workspace, sql, params: bindParams(params) }),
    query: (sql, params) =>
      invoke<Row[]>("db_query", { workspace, sql, params: bindParams(params) }),
    batch: (statements) =>
      invoke("db_batch", {
        workspace,
        statements: statements.map((s) => ({ sql: s.sql, params: bindParams(s.params) })),
      }),
    close: () => invoke("db_close", { workspace }),
  };
}
