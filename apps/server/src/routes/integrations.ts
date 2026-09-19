// Workflow integration secrets (workflows/secrets.ts): set and cleared here,
// never through /settings. The secret itself is written once and never read
// back; the list says only which integrations are set up and when.
//   GET    /integrations                 {integrations: [{integration, configured}]}   works locked
//   PUT    /integrations/:name           {workspace, webhookUrl?, token?}              seals the secret (423 when locked)
//   DELETE /integrations/:name           forgets it

import { INTEGRATIONS } from "@monday/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import type { IntegrationSecretStore } from "../workflows/secrets.ts";
import { parseBody } from "./validate.ts";

const name = z.enum(INTEGRATIONS);
const putBody = z
  .object({
    workspace: z.string().min(1),
    webhookUrl: z.url().max(2000).optional(),
    token: z.string().min(1).max(4000).optional(),
  })
  .refine((b) => b.webhookUrl !== undefined || b.token !== undefined, {
    message: "a webhookUrl or a token is required",
  });

export function integrationRoutes(secrets: IntegrationSecretStore): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/integrations", async (c) => {
    const configured = new Set(await secrets.list());
    return c.json({
      integrations: INTEGRATIONS.map((integration) => ({
        integration,
        configured: configured.has(integration),
      })),
    });
  });

  app.put("/integrations/:name", async (c) => {
    const n = name.safeParse(c.req.param("name"));
    if (!n.success) return c.json({ error: "unknown_integration" }, 400);
    const body = await parseBody(c, putBody);
    if (!body.ok) return body.response;
    await secrets.put(body.data.workspace, n.data, {
      webhookUrl: body.data.webhookUrl,
      token: body.data.token,
    });
    return c.json({ integration: n.data, configured: true });
  });

  app.delete("/integrations/:name", async (c) => {
    const n = name.safeParse(c.req.param("name"));
    if (!n.success) return c.json({ error: "unknown_integration" }, 400);
    await secrets.remove(n.data);
    return c.body(null, 204);
  });

  return app;
}
