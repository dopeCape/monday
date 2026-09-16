// Pairing routes (ADR 0006).
//   POST /pair/setup   {setupCode, name}  first Device only, mints its token
//   POST /pair/start   {name}             new Device gets a 6-digit code and a secret
//   POST /pair/confirm {code}             an authenticated Device approves the code
//   POST /pair/claim   {secret}           the new Device polls until it is paired

import { Hono } from "hono";
import { z } from "zod";
import type { Auth } from "../auth/index.ts";
import { PairingError } from "../auth/index.ts";
import type { AppEnv } from "../auth/middleware.ts";
import { parseBody } from "./validate.ts";

const name = z.string().trim().min(1).max(120);

const setupBody = z.object({ setupCode: z.string().trim().min(1), name });
const startBody = z.object({ name });
const confirmBody = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
});
const claimBody = z.object({ secret: z.string().trim().min(1) });

const STATUS: Record<PairingError["code"], 400 | 403 | 404 | 409 | 410> = {
  invalid_setup_code: 403,
  setup_already_done: 409,
  unknown_code: 404,
  unknown_secret: 404,
  expired: 410,
  already_used: 409,
};

export function pairRoutes(auth: Auth): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.onError((error, c) => {
    if (error instanceof PairingError) return c.json({ error: error.code }, STATUS[error.code]);
    throw error;
  });

  app.post("/setup", async (c) => {
    const body = await parseBody(c, setupBody);
    if (!body.ok) return body.response;
    const minted = await auth.pairSetup(body.data.setupCode, body.data.name);
    return c.json(minted, 201);
  });

  app.post("/start", async (c) => {
    const body = await parseBody(c, startBody);
    if (!body.ok) return body.response;
    const started = await auth.pairStart(body.data.name);
    return c.json({ ...started, expiresAt: started.expiresAt.toISOString() }, 201);
  });

  app.post("/confirm", async (c) => {
    if (!c.get("principal")) return c.json({ error: "unauthorized" }, 401);
    const body = await parseBody(c, confirmBody);
    if (!body.ok) return body.response;
    await auth.pairConfirm(body.data.code);
    return c.json({ ok: true });
  });

  app.post("/claim", async (c) => {
    const body = await parseBody(c, claimBody);
    if (!body.ok) return body.response;
    const result = await auth.pairClaim(body.data.secret);
    if (result.status === "pending") {
      return c.json({ status: "pending", expiresAt: result.expiresAt.toISOString() }, 202);
    }
    return c.json(result, 200);
  });

  return app;
}
