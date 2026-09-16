// Devices routes (ADR 0006): list and revoke. Revoking deletes the token hash,
// so the Device's next request is a 401.

import { Hono } from "hono";
import type { Auth } from "../auth/index.ts";
import type { AppEnv } from "../auth/middleware.ts";

export function devicesRoutes(auth: Auth): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => c.json(await auth.listDevices()));

  app.delete("/:id", async (c) => {
    const removed = await auth.revokeDevice(c.req.param("id"));
    if (!removed) return c.json({ error: "not_found" }, 404);
    return c.body(null, 204);
  });

  return app;
}
