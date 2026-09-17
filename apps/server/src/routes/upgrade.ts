// Upgrade routes (ADR 0008), served by the Sidecar to its own client:
//   GET    /upgrade          status: mode, export availability, attached Cloud database
//   POST   /upgrade/export   pg_dump the embedded database to a file
//   POST   /upgrade/copy     {databaseUrl, replace?} copy every table into the Cloud database
//   POST   /upgrade/attach   {databaseUrl} use that database from the next launch on ("both" mode)
//   DELETE /upgrade/attach   back to the embedded database from the next launch on

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import { type Upgrade, UpgradeError } from "../upgrade/index.ts";
import { parseBody } from "./validate.ts";

const databaseUrl = z.string().trim().min(1).max(2000);
const copyBody = z.object({ databaseUrl, replace: z.boolean().optional() });
const attachBody = z.object({ databaseUrl });

const STATUS: Record<UpgradeError["code"], 400 | 409 | 501 | 502> = {
  export_unavailable: 501,
  not_sidecar: 409,
  target_unreachable: 502,
  target_not_empty: 409,
  invalid_url: 400,
};

export function upgradeRoutes(upgrade: Upgrade): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.onError((error, c) => {
    if (error instanceof UpgradeError) {
      return c.json({ error: error.code, message: error.message }, STATUS[error.code]);
    }
    throw error;
  });

  app.get("/upgrade", async (c) => c.json(await upgrade.status()));

  app.post("/upgrade/export", async (c) => c.json(await upgrade.exportDatabase(), 201));

  app.post("/upgrade/copy", async (c) => {
    const body = await parseBody(c, copyBody);
    if (!body.ok) return body.response;
    const result = await upgrade.copyDatabase(body.data.databaseUrl, {
      replace: body.data.replace ?? false,
    });
    return c.json(result, 201);
  });

  app.post("/upgrade/attach", async (c) => {
    const body = await parseBody(c, attachBody);
    if (!body.ok) return body.response;
    return c.json(await upgrade.attach(body.data.databaseUrl));
  });

  app.delete("/upgrade/attach", async (c) => c.json(await upgrade.detach()));

  return app;
}
