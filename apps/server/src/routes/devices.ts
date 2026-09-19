// Devices routes (ADR 0006): list, who the caller is, the codes waiting for
// approval, and revoke. Revoking deletes the token hash, so the Device's next
// request is a 401.
//   GET    /devices          Device[]
//   GET    /devices/me       {id, kind}                      the caller
//   GET    /devices/pending  {pending: [{code, name, expiresAt}], setupAvailable}
//   DELETE /devices/:id      204

import { Hono } from "hono";
import type { Auth } from "../auth/index.ts";
import type { AppEnv } from "../auth/middleware.ts";
import { principalOf } from "../auth/middleware.ts";

export function devicesRoutes(auth: Auth): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => c.json(await auth.listDevices()));

  app.get("/me", (c) => {
    const principal = principalOf(c);
    return c.json({ id: principal.deviceId, kind: principal.kind });
  });

  app.get("/pending", async (c) => {
    const [pending, setupAvailable] = await Promise.all([
      auth.listPendingCodes(),
      auth.setupAvailable(),
    ]);
    return c.json({
      pending: pending.map((p) => ({ ...p, expiresAt: p.expiresAt.toISOString() })),
      setupAvailable,
    });
  });

  app.delete("/:id", async (c) => {
    const removed = await auth.revokeDevice(c.req.param("id"));
    if (!removed) return c.json({ error: "not_found" }, 404);
    return c.body(null, 204);
  });

  return app;
}
