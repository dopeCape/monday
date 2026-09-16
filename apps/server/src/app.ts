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
import { DecryptError } from "./crypto/aead.ts";
import { createKeys, type Keys, LockedError } from "./crypto/keys.ts";
import type { Db } from "./db/client.ts";
import { createMailstore, type Mailstore, NotFoundError } from "./mailstore/index.ts";
import { devicesRoutes } from "./routes/devices.ts";
import { mailRoutes } from "./routes/mail.ts";
import { pairRoutes } from "./routes/pair.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { unlockRoutes } from "./routes/unlock.ts";

export type { AppEnv } from "./auth/middleware.ts";

export interface AppOptions {
  db: Db;
  auth: Auth;
  mode: DeploymentMode;
  /** The key holder; the entry creates it so it can unlock at boot. Defaults to a locked one. */
  keys?: Keys;
  /** Defaults to a Mailstore over `db` and `keys`. Tests substitute fakes here. */
  mailstore?: Mailstore;
  /** Peer address of a request, when the runtime can tell. Defaults to "unknown". */
  remoteAddress?: (c: Parameters<LoopbackCheck>[0]) => string | null | undefined;
  /** Milliseconds since the process started, for /health. */
  uptimeMs?: () => number;
}

export function createApp(options: AppOptions): Hono<AppEnv> {
  const { db, auth, mode } = options;
  const keys = options.keys ?? createKeys(db);
  const mailstore = options.mailstore ?? createMailstore(db, keys);
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

  app.get("/capabilities", (c) => c.json(capabilitiesFor(mode, keys.isUnlocked())));

  app.route("/pair", pairRoutes(auth));
  app.route("/settings", settingsRoutes(db));
  app.route("/devices", devicesRoutes(auth));
  app.route("/", unlockRoutes(keys));
  app.route("/", mailRoutes(mailstore));

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((error, c) => {
    // A locked server answers 423 for anything that needs the root key.
    if (error instanceof LockedError) return c.json({ error: "locked" }, 423);
    if (error instanceof NotFoundError) return c.json({ error: "not_found" }, 404);
    if (error instanceof DecryptError) {
      console.error(error);
      return c.json({ error: "unreadable_content" }, 500);
    }
    console.error(error);
    return c.json({ error: "internal" }, 500);
  });

  return app;
}
