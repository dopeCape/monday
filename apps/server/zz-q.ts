import postgres from "postgres";
const pw = (await Bun.file(`${process.env.HOME}/.local/share/io.monday.desktop/postgres.password`).text()).trim();
const port = Number(process.argv[2]);
const sql = postgres({ host: "127.0.0.1", port, user: "monday", password: pw, database: process.argv[3] ?? "monday", max: 1 });
const q = process.argv.slice(4).join(" ");
console.log(JSON.stringify(await sql.unsafe(q), null, 1));
await sql.end();
