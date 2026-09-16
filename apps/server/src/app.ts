// The Hono app: a runtime-neutral fetch handler. No Bun, Node or platform API
// here; the entry under entry/ supplies the database, the loopback test and
// the process-level pieces (research 22, section 2.1).

import type { DeploymentMode } from "@monday/shared";
import { Hono } from "hono";
import type { Auth } from "./auth/index.ts";
import {
  type AppEnv,
  authenticate,
  isLoopbackAddress,
  type LoopbackCheck,
  PUBLIC_PATHS,
  requireAuth,
} from "./auth/middleware.ts";
import { capabilitiesFor } from "./capabilities.ts";
import type { Db } from "./db/client.ts";
import { devicesRoutes } from "./routes/devices.ts";
import { pairRoutes } from "./routes/pair.ts";
import { settingsRoutes } from "./routes/settings.ts";

export type { AppEnv } from "./auth/middleware.ts";

export interface AppOptions {
  db: Db;
  auth: Auth;
  mode: DeploymentMode;
  /** Peer address of a request, when the runtime can tell. Defaults to "unknown". */
  remoteAddress?: (c: Parameters<LoopbackCheck>[0]) => string | null | undefined;
  /** Milliseconds since the process started, for /health. */
  uptimeMs?: () => number;
}

export function createApp(options: AppOptions): Hono<AppEnv> {
  const { db, auth, mode } = options;
  const started = Date.now();
  const uptimeMs = options.uptimeMs ?? (() => Date.now() - started);
  const isLoopback: LoopbackCheck = (c) => isLoopbackAddress(options.remoteAddress?.(c));

  const app = new Hono<AppEnv>();

  app.use("*", authenticate(auth, isLoopback));
  app.use("*", requireAuth(PUBLIC_PATHS));

  app.get("/health", async (c) => {
    try {
      await db.execute("select 1");
      return c.json({ ok: true, mode, uptimeMs: uptimeMs() });
    } catch {
      return c.json({ ok: false, mode, uptimeMs: uptimeMs() }, 503);
    }
  });

  app.get("/capabilities", (c) => c.json(capabilitiesFor(mode)));

  app.route("/pair", pairRoutes(auth));
  app.route("/settings", settingsRoutes(db));
  app.route("/devices", devicesRoutes(auth));

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: "internal" }, 500);
  });

  return app;
}
