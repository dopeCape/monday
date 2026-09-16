import { app } from "../src/app.ts";
const port = Number(process.env.PORT ?? 0);
const server = Bun.serve({ port, fetch: app.fetch });
console.log(`monday server listening on http://127.0.0.1:${server.port}`);
