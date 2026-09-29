// bun q.ts "<sql>" : read-only queries against the running Sidecar's database.
import { readFileSync } from "node:fs";
import postgres from "postgres";
const port = process.env.PGPORT;
const password = readFileSync(`${process.env.HOME}/.local/share/io.monday.desktop/postgres.password`, "utf8").trim();
const sql = postgres({ host: "127.0.0.1", port: Number(port), user: "monday", password, database: "monday", max: 1 });
try {
  await sql.begin("read only", async (tx) => {
    const rows = await tx.unsafe(process.argv[2] as string);
    console.log(JSON.stringify(rows, null, 1).slice(0, 12000));
  });
} finally {
  await sql.end();
}
