// Connect a tool (docs/spec/settings.md "MCP servers"). The desktop app asks
// the Server for everything here, so the catalog search, the probe and the
// sign-in all run where the calls will run, and no secret goes back out.
//   GET    /mcp-servers/catalog?q=&limit=         {enabled, entries}      the registry search, cached briefly
//   GET    /mcp-servers                            {servers}               each with its status, never a secret
//   POST   /mcp-servers                            {workspace, ...McpConnectInput} -> {server, next, tools}
//   GET    /mcp-servers/:name/tools                {server, tools}         connects and lists every tool
//   PATCH  /mcp-servers/:name                      {tools}                 the allowlist; [] is every tool
//   DELETE /mcp-servers/:name                                              forgets the server and its secrets
//   POST   /mcp-servers/:name/sign-in              {workspace} -> {state, url}  the browser goes to url
//   GET    /mcp-servers/sign-in/status?state=&wait=  pending | done | error | cancelled, long-polled
//   POST   /mcp-servers/sign-in/cancel             {state}                 a late redirect then adds nothing
//   GET    /mcp-servers/oauth/callback?code&state  public: a Cloud server's redirect target

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import type { McpConnections } from "../workflows/mcp-connections.ts";
import {
  type McpRegistry,
  McpRegistryOffError,
  McpRegistryUnavailableError,
} from "../workflows/mcp-registry.ts";
import { parseBody } from "./validate.ts";

export const MCP_CALLBACK_PATH = "/mcp-servers/oauth/callback";

export interface McpServerRoutesOptions {
  connections: McpConnections;
  registry: McpRegistry;
  /** The Server's public URL, for a Cloud server's redirect; the request's origin when absent. */
  publicUrl?: (() => Promise<string | null>) | undefined;
  /** How long /sign-in/status waits before answering pending. */
  statusWaitMs?: number | undefined;
  pollMs?: number | undefined;
  /** The page the browser shows after the redirect. */
  page?: ((ok: boolean) => string) | undefined;
}

const record = z.record(z.string().min(1).max(200), z.string().max(4000));
const addBody = z.object({
  workspace: z.string().min(1),
  name: z.string().min(1).max(60),
  title: z.string().max(120).optional(),
  registry: z.string().max(200).optional(),
  url: z.url().max(2000).optional(),
  transport: z.enum(["streamable-http", "sse"]).optional(),
  headers: record.optional(),
  command: z.string().min(1).max(2000).optional(),
  args: z.array(z.string().max(2000)).max(100).optional(),
  env: record.optional(),
  values: record.optional(),
  secret: z.array(z.string().min(1).max(200)).max(100).optional(),
  token: z.string().max(8000).optional(),
  auth: z.enum(["auto", "none", "bearer", "oauth", "inputs"]).optional(),
  tools: z.array(z.string().min(1)).optional(),
  replace: z.boolean().optional(),
});
const patchBody = z.object({ tools: z.array(z.string().min(1).max(200)).max(1000) });
const signInBody = z.object({ workspace: z.string().min(1) });
const cancelBody = z.object({ state: z.string().min(1) });

function defaultPage(ok: boolean): string {
  const line = ok
    ? "Signed in. You can close this window and go back to monday."
    : "Sign-in did not complete. Go back to monday and try again.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>monday</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#222;background:#fafaf9}p{font-size:18px}</style></head><body><p>${line}</p></body></html>`;
}

export function mcpServerRoutes(options: McpServerRoutesOptions): Hono<AppEnv> {
  const { connections, registry } = options;
  const statusWait = options.statusWaitMs ?? 20_000;
  const pollMs = options.pollMs ?? 400;
  const page = options.page ?? defaultPage;
  const app = new Hono<AppEnv>();

  app.get("/mcp-servers/catalog", async (c) => {
    const q = c.req.query("q") ?? "";
    const limitRaw = Number(c.req.query("limit") ?? "");
    try {
      const entries = await registry.search(
        q,
        Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
      );
      return c.json({ enabled: true, entries });
    } catch (error) {
      if (error instanceof McpRegistryOffError) return c.json({ enabled: false, entries: [] });
      if (error instanceof McpRegistryUnavailableError) {
        return c.json({ error: "registry_unavailable", message: error.message }, 502);
      }
      throw error;
    }
  });

  app.get("/mcp-servers", async (c) => c.json({ servers: await connections.list() }));

  app.post("/mcp-servers", async (c) => {
    const body = await parseBody(c, addBody);
    if (!body.ok) return body.response;
    const { workspace, ...input } = body.data;
    return c.json(await connections.add(workspace, input));
  });

  // Before /mcp-servers/:name/*, so "sign-in" and "oauth" are never read as a name.
  app.get("/mcp-servers/sign-in/status", async (c) => {
    const state = c.req.query("state") ?? "";
    // `wait` shortens the long poll (0 answers at once); it never lengthens it.
    const raw = c.req.query("wait");
    const asked = raw === undefined || raw === "" ? Number.NaN : Number(raw);
    const wait = Number.isFinite(asked) && asked >= 0 ? Math.min(asked, statusWait) : statusWait;
    const deadline = Date.now() + wait;
    for (;;) {
      const status = await connections.signInStatus(state);
      if (status.status !== "pending" || Date.now() >= deadline) return c.json(status);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  });

  app.post("/mcp-servers/sign-in/cancel", async (c) => {
    const body = await parseBody(c, cancelBody);
    if (!body.ok) return body.response;
    return c.json(await connections.cancelSignIn(body.data.state));
  });

  app.get(MCP_CALLBACK_PATH, async (c) => {
    const query: Record<string, string> = {};
    for (const [k, v] of new URL(c.req.url).searchParams) query[k] = v;
    const status = await connections.finishSignIn(query);
    return c.html(page(status.status === "done"));
  });

  app.get("/mcp-servers/:name/tools", async (c) =>
    c.json(await connections.tools(c.req.param("name"))),
  );

  app.patch("/mcp-servers/:name", async (c) => {
    const body = await parseBody(c, patchBody);
    if (!body.ok) return body.response;
    return c.json({ server: await connections.setTools(c.req.param("name"), body.data.tools) });
  });

  app.delete("/mcp-servers/:name", async (c) => {
    await connections.remove(c.req.param("name"));
    return c.body(null, 204);
  });

  app.post("/mcp-servers/:name/sign-in", async (c) => {
    const body = await parseBody(c, signInBody);
    if (!body.ok) return body.response;
    const base = (await options.publicUrl?.()) ?? new URL(c.req.url).origin;
    return c.json(await connections.signIn(body.data.workspace, c.req.param("name"), base));
  });

  return app;
}
