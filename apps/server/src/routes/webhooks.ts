// Provider push webhooks, reachable without a Device token (the caller is
// Google or Microsoft) and verified by what only the registration knew: the
// per-Account secret in the Gmail push endpoint URL, the clientState of the
// Graph subscription. Each handler does nothing but verify, wake the sync
// engine and answer inside the provider's window (research 22, section 5.1).
//   POST /webhooks/gmail/:accountId?secret=   Pub/Sub push envelope
//   POST /webhooks/graph                      validation handshake or change notifications
//   POST /webhooks/graph/lifecycle            validation handshake or lifecycle notifications

import { type Context, Hono } from "hono";
import type { AppEnv } from "../auth/middleware.ts";
import type { PushManager } from "../providers/push.ts";

export function webhookRoutes(push: PushManager): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/webhooks/gmail/:accountId", async (c) => {
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    const ok = await push.gmailWebhook(
      c.req.param("accountId"),
      c.req.query("secret") ?? null,
      body,
    );
    // Pub/Sub retries anything but a 2xx; a bad secret is answered with 403 so it stops.
    return ok ? c.body(null, 204) : c.json({ error: "forbidden" }, 403);
  });

  const graph = async (c: Context<AppEnv>, handle: (body: unknown) => Promise<number>) => {
    // Graph validates a new subscription's URL by posting ?validationToken= and
    // expecting the decoded token back as text/plain within 10 seconds.
    const token = c.req.query("validationToken");
    if (token !== undefined) return c.text(token, 200);
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    await handle(body);
    // Always 202: an unknown or mismatched notification must not be retried for four hours.
    return c.body(null, 202);
  };

  app.post("/webhooks/graph", (c) => graph(c, (body) => push.graphNotifications(body)));
  app.post("/webhooks/graph/lifecycle", (c) => graph(c, (body) => push.graphLifecycle(body)));

  return app;
}
