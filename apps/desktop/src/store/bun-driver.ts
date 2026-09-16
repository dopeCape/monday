// SqlDriver over bun:sqlite, for `bun test`. Never imported by the app bundle.

import { Database } from "bun:sqlite";
import { bindParams, type Row, type SqlDriver, type SqlParam, type Statement } from "./driver.ts";

export function bunDriver(path = ":memory:"): SqlDriver {
  const db = new Database(path, { create: true, strict: false });
  db.exec("pragma foreign_keys = on");

  const isScript = (sql: string, params: SqlParam[] | undefined) =>
    (!params || params.length === 0) && sql.trim().replace(/;\s*$/, "").includes(";");

  const run = (sql: string, params?: SqlParam[]): number => {
    if (isScript(sql, params)) {
      db.exec(sql);
      return 0;
    }
    return db.prepare(sql).run(...bindParams(params)).changes;
  };

  return {
    async exec(sql, params) {
      return run(sql, params);
    },
    async query(sql, params) {
      return db.prepare(sql).all(...bindParams(params)) as Row[];
    },
    async batch(statements: Statement[]) {
      db.transaction(() => {
        for (const s of statements) run(s.sql, s.params);
      })();
    },
    async close() {
      db.close();
    },
  };
}
