// SqlDriver over SQLite compiled to WebAssembly, for the browser dev server
// (the fakePlatform path), where there is no Rust and no bun:sqlite. In-memory
// only: the dev server reseeds from fixtures on every load. Loaded lazily so
// the Tauri bundle never pays for the wasm.

import { bindParams, type Row, type SqlDriver, type SqlParam } from "./driver.ts";

export async function wasmDriver(): Promise<SqlDriver> {
  const { default: init } = await import("@sqlite.org/sqlite-wasm");
  const sqlite3 = await init();
  const db = new sqlite3.oo1.DB(":memory:", "c");

  const isScript = (sql: string, params: SqlParam[] | undefined) =>
    (!params || params.length === 0) && sql.trim().replace(/;\s*$/, "").includes(";");

  const run = (sql: string, params?: SqlParam[]): number => {
    if (isScript(sql, params)) {
      db.exec(sql);
      return 0;
    }
    db.exec({ sql, bind: bindParams(params) });
    return db.changes();
  };

  return {
    async exec(sql, params) {
      return run(sql, params);
    },
    async query(sql, params) {
      return db.exec({
        sql,
        bind: bindParams(params),
        rowMode: "object",
        returnValue: "resultRows",
      }) as Row[];
    },
    async batch(statements) {
      db.exec("begin");
      try {
        for (const s of statements) run(s.sql, s.params);
        db.exec("commit");
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
    },
    async close() {
      db.close();
    },
  };
}
