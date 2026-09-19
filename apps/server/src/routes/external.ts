// The external MCP routes (docs/spec/external-mcp.md, slice 19).
//
// For other agents, authenticated by a credential (a Key or an OAuth access
// token as the bearer), never by a Device token; the Device middleware lets
// these paths through and the credential is checked here:
//   ALL  /mcp                       monday's tools over MCP streamable HTTP, filtered by the
//                                   credential's scope; X-Monday-Workspace picks the Workspace
//                                   when the credential reaches more than one
//   GET  /mcp/pending/:activityId   the status of a call parked on an approval, until it settles
//   GET  /.well-known/oauth-authorization-server     RFC 8414
//   GET  /.well-known/oauth-protected-resource[/mcp] RFC 9728
//   POST /oauth/register            dynamic client registration (RFC 7591), public clients only
//   GET  /oauth/authorize           the consent page (HTML) for a PKCE authorization request
//   GET  /oauth/consent/:id         {status, redirect?}: polled by the page until the owner decides
//   POST /oauth/consent/:id/deny    the page's Decline button
//   POST /oauth/token               authorization_code (with code_verifier) and refresh_token
//   POST /oauth/revoke              RFC 7009
//
// For the owner's client, with its Device token:
//   GET    /external/credentials            {credentials}: keys and OAuth tokens with last use
//   POST   /external/credentials            {name, scope, workspaceIds?, expiresInDays?} -> {credential, secret} (201), the secret once
//   DELETE /external/credentials/:id        204: revoke
//   GET    /external/pending?workspace=     {pending}: external calls waiting for an approval
//   POST   /external/pending/:id            {decision} answers one from the client
//   GET    /external/live?workspace=        text/event-stream of the cards of external calls
//   GET    /external/consents               {consents}: OAuth consents waiting for the owner
//   POST   /external/consents/approve       {id} or {code}, workspaceIds? -> the consent
//   POST   /external/consents/:id/deny      204

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ExternalCredential } from "@monday/shared";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { parseBearer } from "../auth/index.ts";
import type { AppEnv } from "../auth/middleware.ts";
import { type ConsentPageInput, consentPage, type External } from "../external/index.ts";
import { parseBody } from "./validate.ts";

/** Paths the Device middleware lets through: the credential is checked in these routes. */
export const EXTERNAL_PUBLIC_PATHS: readonly string[] = [
  "/mcp",
  "/oauth/register",
  "/oauth/authorize",
  "/oauth/token",
  "/oauth/revoke",
];
export const EXTERNAL_PUBLIC_PREFIXES: readonly string[] = [
  "/mcp/pending/",
  "/.well-known/",
  "/oauth/consent/",
];

export interface ExternalRoutesOptions {
  /** How often an idle /external/live stream sends a keepalive comment. */
  keepaliveMs?: number | undefined;
  external: External;
  /** The consent page's texts, from the strings Settings. */
  consentStrings(): Promise<ConsentPageInput["strings"]>;
  /** The Server's public URL when configured; the request's origin otherwise. */
  publicUrl?: (() => Promise<string | null>) | undefined;
}

const keyBody = z.object({
  name: z.string().min(1).max(80),
  scope: z.enum(["read", "act"]).default("read"),
  workspaceIds: z.array(z.string().min(1)).min(1).nullable().default(null),
  expiresInDays: z.int().min(1).max(3650).optional(),
});
const decisionBody = z.object({ decision: z.enum(["approved", "declined"]) });
const approveBody = z
  .object({
    id: z.string().min(1).optional(),
    code: z.string().min(1).optional(),
    workspaceIds: z.array(z.string().min(1)).min(1).nullable().optional(),
  })
  .refine((b) => b.id || b.code, { message: "id or code is required" });

/** The issuer: the configured public URL, else the origin the request came in on, proxies honoured. */
export function issuerOf(req: Request, configured: string | null): string {
  if (configured) return configured.replace(/\/+$/, "");
  const url = new URL(req.url);
  const proto =
    req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
  const host =
    req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    req.headers.get("host") ||
    url.host;
  return `${proto}://${host}`;
}

export function externalRoutes(options: ExternalRoutesOptions): Hono<AppEnv> {
  const keepaliveMs = options.keepaliveMs ?? 25_000;
  const { external } = options;
  const app = new Hono<AppEnv>();
  const issuer = async (req: Request) => issuerOf(req, (await options.publicUrl?.()) ?? null);

  const unauthorized = async (req: Request, reason: string) =>
    new Response(JSON.stringify({ error: "unauthorized", reason }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer realm="monday", resource_metadata="${await issuer(req)}/.well-known/oauth-protected-resource"`,
      },
    });

  /** The credential of a request, or the response that refuses it. */
  const credentialOf = async (
    req: Request,
  ): Promise<{ ok: true; credential: ExternalCredential } | { ok: false; response: Response }> => {
    const result = await external.authenticate(parseBearer(req.headers.get("authorization")));
    if (!result.ok) return { ok: false, response: await unauthorized(req, result.reason) };
    if (!(await external.admit(result.credential.id))) {
      return {
        ok: false,
        response: new Response(JSON.stringify({ error: "rate_limited" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "60" },
        }),
      };
    }
    return result;
  };

  /* ------------------------------ /mcp ------------------------------ */

  app.all("/mcp", async (c) => {
    const auth = await credentialOf(c.req.raw);
    if (!auth.ok) return auth.response;
    const { credential } = auth;
    let workspaceId = c.req.header("x-monday-workspace") ?? null;
    if (workspaceId && !external.reaches(credential, workspaceId)) {
      return c.json({ error: "forbidden", reason: "workspace" }, 403);
    }
    if (!workspaceId) {
      const reachable =
        credential.workspaceIds?.length === 1
          ? [{ id: credential.workspaceIds[0] as string }]
          : await external.workspacesFor(credential);
      if (reachable.length !== 1) {
        return c.json({ error: "workspace_required", workspaces: reachable.map((w) => w.id) }, 400);
      }
      workspaceId = (reachable[0] as { id: string }).id;
    }
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const server = await external.mcpServer(credential, workspaceId);
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close().catch(() => {});
    }
  });

  app.get("/mcp/pending/:id", async (c) => {
    const auth = await credentialOf(c.req.raw);
    if (!auth.ok) return auth.response;
    const pending = await external.pendingOne(c.req.param("id"));
    if (!pending || pending.credentialId !== auth.credential.id) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json(pending);
  });

  /* ------------------------------ OAuth 2.1 ------------------------------ */

  app.get("/.well-known/oauth-authorization-server", async (c) =>
    c.json(external.oauth.metadata(await issuer(c.req.raw))),
  );
  app.get("/.well-known/oauth-protected-resource", async (c) =>
    c.json(external.oauth.resourceMetadata(await issuer(c.req.raw))),
  );
  app.get("/.well-known/oauth-protected-resource/mcp", async (c) =>
    c.json(external.oauth.resourceMetadata(await issuer(c.req.raw))),
  );

  app.post("/oauth/register", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_client_metadata", error_description: "invalid JSON" }, 400);
    }
    const result = await external.oauth.register(body);
    if (!result.ok) {
      return c.json({ error: result.error, error_description: result.description }, 400);
    }
    return c.json(result.client, 201);
  });

  app.get("/oauth/authorize", async (c) => {
    const result = await external.oauth.authorize(c.req.query());
    if (!result.ok) {
      // A bad request with a valid client and redirect goes back to the client (RFC 6749, 4.1.2.1).
      const redirect = c.req.query("redirect_uri");
      if (redirect && result.error !== "invalid_client" && result.error !== "invalid_request") {
        const url = new URL(redirect);
        url.searchParams.set("error", result.error);
        url.searchParams.set("error_description", result.description);
        const state = c.req.query("state");
        if (state) url.searchParams.set("state", state);
        return c.redirect(url.toString(), 302);
      }
      return c.json({ error: result.error, error_description: result.description }, 400);
    }
    const base = await issuer(c.req.raw);
    const reachable = await external.workspacesFor(result.consent);
    return c.html(
      consentPage({
        consent: result.consent,
        workspaces: reachable,
        statusUrl: `${base}/oauth/consent/${result.consent.id}`,
        denyUrl: `${base}/oauth/consent/${result.consent.id}/deny`,
        strings: await options.consentStrings(),
      }),
    );
  });

  app.get("/oauth/consent/:id", async (c) =>
    c.json(await external.oauth.status(c.req.param("id"))),
  );

  app.post("/oauth/consent/:id/deny", async (c) => {
    await external.oauth.deny(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/oauth/token", async (c) => {
    const type = c.req.header("content-type") ?? "";
    let form: Record<string, string | undefined>;
    if (type.includes("application/json")) {
      form = ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, string | undefined>;
    } else {
      const parsed = await c.req.parseBody();
      form = Object.fromEntries(
        Object.entries(parsed).map(([k, v]) => [k, typeof v === "string" ? v : undefined]),
      );
    }
    const result = await external.oauth.token(form);
    if (!result.ok) {
      return c.json(
        { error: result.error, error_description: result.description },
        (result.status ?? 400) as 400,
        { "cache-control": "no-store" },
      );
    }
    return c.json(result.tokens, 200, { "cache-control": "no-store", pragma: "no-cache" });
  });

  app.post("/oauth/revoke", async (c) => {
    const parsed = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const token = typeof parsed.token === "string" ? parsed.token : null;
    if (token) await external.oauth.revoke(token);
    return c.body(null, 200);
  });

  /* ------------------------------ The owner's routes ------------------------------ */

  app.get("/external/credentials", async (c) =>
    c.json({ credentials: await external.listCredentials() }),
  );

  app.post("/external/credentials", async (c) => {
    const body = await parseBody(c, keyBody);
    if (!body.ok) return body.response;
    return c.json(await external.createKey(body.data), 201);
  });

  app.delete("/external/credentials/:id", async (c) => {
    const revoked = await external.revoke(c.req.param("id"));
    if (!revoked) return c.json({ error: "not_found" }, 404);
    return c.body(null, 204);
  });

  app.get("/external/pending", async (c) => {
    const workspace = c.req.query("workspace");
    if (!workspace) return c.json({ error: "workspace_required" }, 400);
    return c.json({ pending: await external.pending(workspace) });
  });

  app.post("/external/pending/:id", async (c) => {
    const body = await parseBody(c, decisionBody);
    if (!body.ok) return body.response;
    const decided = await external.decide(c.req.param("id"), body.data.decision);
    if (!decided) return c.json({ error: "not_found" }, 404);
    return c.json(decided);
  });

  app.get("/external/live", async (c) => {
    const workspace = c.req.query("workspace");
    if (!workspace) return c.json({ error: "workspace_required" }, 400);
    return streamSSE(c, async (stream) => {
      let chain = Promise.resolve();
      const unsubscribe = external.live(workspace, (pending) => {
        chain = chain.then(() =>
          stream.writeSSE({ event: "pending", data: JSON.stringify(pending) }).catch(() => {}),
        );
      });
      // A comment every so often, so an idle stream is not cut by the server or a proxy.
      const keepalive = setInterval(() => {
        chain = chain.then(() =>
          stream.write(": keepalive\n\n").then(
            () => {},
            () => {},
          ),
        );
      }, keepaliveMs);
      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
        c.req.raw.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      clearInterval(keepalive);
      unsubscribe();
      await chain;
    });
  });

  app.get("/external/consents", async (c) =>
    c.json({ consents: await external.oauth.listConsents() }),
  );

  app.post("/external/consents/approve", async (c) => {
    const body = await parseBody(c, approveBody);
    if (!body.ok) return body.response;
    const ref = body.data.id ? { id: body.data.id } : { code: body.data.code as string };
    const consent = await external.oauth.approve(ref, body.data.workspaceIds ?? null);
    if (!consent) return c.json({ error: "not_found" }, 404);
    const { redirectUri: _r, state: _s, ...view } = consent;
    return c.json(view);
  });

  app.post("/external/consents/:id/deny", async (c) => {
    await external.oauth.deny(c.req.param("id"));
    return c.body(null, 204);
  });

  return app;
}
