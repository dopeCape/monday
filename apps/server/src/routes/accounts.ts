// Accounts (docs/spec/settings.md, "Accounts"): the list the settings section
// shows, the token and password paths of adding one, autoconfig discovery for
// the IMAP form, and removal. The OAuth paths live in oauth.ts.
//   GET    /accounts
//   POST   /accounts/discover  {address}                       autoconfig ladder result
//   POST   /accounts           {provider: jmap | imap, address, displayName?, auth, endpoint}
//   DELETE /accounts/:id

import { Hono } from "hono";
import { z } from "zod";
import type { AccountService } from "../accounts.ts";
import type { AppEnv } from "../auth/middleware.ts";
import type { Discovery, DiscoveryDeps } from "../providers/autoconfig.ts";
import { discover } from "../providers/autoconfig.ts";
import type { Credentials } from "../providers/types.ts";
import { parseBody } from "./validate.ts";

const hostPort = z.object({
  host: z.string().min(1),
  port: z.int().min(1).max(65535),
  tls: z.enum(["tls", "starttls", "none"]),
});

const addBody = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("jmap"),
    address: z.string().email(),
    displayName: z.string().optional(),
    auth: z.union([
      z.object({ kind: z.literal("token"), token: z.string().min(1) }),
      z.object({
        kind: z.literal("password"),
        user: z.string().min(1),
        password: z.string().min(1),
      }),
    ]),
    endpoint: z.object({ kind: z.literal("jmap"), sessionUrl: z.string().url() }),
  }),
  z.object({
    provider: z.literal("imap"),
    address: z.string().email(),
    displayName: z.string().optional(),
    auth: z.object({
      kind: z.literal("password"),
      user: z.string().min(1),
      password: z.string().min(1),
    }),
    endpoint: z.object({ kind: z.literal("imap"), imap: hostPort, smtp: hostPort }),
  }),
]);

const discoverBody = z.object({ address: z.string().email() });

export interface AccountRoutesOptions {
  accounts: AccountService;
  /** The autoconfig ladder's network; defaults to none, which answers "manual". */
  discovery?: () => Promise<DiscoveryDeps>;
}

export function accountRoutes(options: AccountRoutesOptions): Hono<AppEnv> {
  const { accounts } = options;
  const app = new Hono<AppEnv>();

  app.get("/accounts", async (c) => c.json({ accounts: await accounts.list() }));

  app.post("/accounts/discover", async (c) => {
    const body = await parseBody(c, discoverBody);
    if (!body.ok) return body.response;
    if (!options.discovery) {
      const manual: Discovery = { kind: "manual", tried: [] };
      return c.json(manual);
    }
    return c.json(await discover(body.data.address, await options.discovery()));
  });

  app.post("/accounts", async (c) => {
    const body = await parseBody(c, addBody);
    if (!body.ok) return body.response;
    const input = body.data;
    const credentials: Credentials = {
      address: input.address,
      auth: input.auth,
      endpoint: input.endpoint,
    };
    try {
      const account = await accounts.add({
        provider: input.provider,
        credentials,
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      });
      return c.json({ account }, 201);
    } catch (error) {
      const code = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : String(error);
      if (code === "auth") return c.json({ error: "auth", message }, 401);
      if (code === "network") return c.json({ error: "network", message }, 502);
      if (code === "unsupported") return c.json({ error: "unsupported", message }, 400);
      throw error;
    }
  });

  app.delete("/accounts/:id", async (c) => {
    const removed = await accounts.remove(c.req.param("id"));
    return removed ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
  });

  return app;
}
