// A demo of the whole first-run flow in the browser, on fake mail: a real
// Server (the Sidecar entry, from source) on a throwaway data directory, where
// connecting an IMAP or JMAP Account reaches a fake mailbox with a calendar,
// paced so the first sync can be watched. Nothing touches the app's own data
// (~/.local/share/io.monday.desktop).
//
//   bun scripts/demo.ts            fresh start: onboarding from the beginning
//   bun scripts/demo.ts --keep     keep the last demo's data
//   DEMO_LATENCY_MS=1500 bun ...   slower fake mailbox
//
// It prints the URL to open against the Vite dev server (bun run dev in
// apps/desktop, port 1420). Ctrl-C stops the Server and its Postgres.

import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const dataDir = join(root, ".demo");
const port = Number(process.env.DEMO_PORT ?? 8799);
const keep = process.argv.includes("--keep");

if (!keep) rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const token = randomBytes(24).toString("base64url");
const server = Bun.spawn(["bun", join(root, "apps/server/entry/bun.ts")], {
  cwd: join(root, "apps/server"),
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    MONDAY_MODE: "sidecar",
    MONDAY_SIDECAR_TOKEN: token,
    MONDAY_DATA_DIR: dataDir,
    MONDAY_ROOT_KEY: randomBytes(32).toString("base64"),
    MONDAY_DEMO: "1",
    MONDAY_DEMO_LATENCY_MS: process.env.DEMO_LATENCY_MS ?? "700",
  },
  stdout: "inherit",
  stderr: "inherit",
});

const url = `http://localhost:1420/?demo=${encodeURIComponent(`http://127.0.0.1:${port}`)}&token=${token}`;
for (let i = 0; i < 120; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    if (res.ok) break;
  } catch {}
  await Bun.sleep(250);
}
console.log(`\ndemo server on http://127.0.0.1:${port} (data in ${dataDir})\nopen: ${url}\n`);

const stop = () => {
  server.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await server.exited;
