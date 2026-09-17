// Hono middleware: resolves the bearer token to a principal and rejects
// unauthenticated requests except the public paths (health, capabilities,
// pairing). The loopback test is injected by the entry because only the
// runtime knows the peer address.

import type { Context, MiddlewareHandler } from "hono";
import { type Auth, type Principal, parseBearer } from "./index.ts";

export type AppEnv = {
  Variables: { principal: Principal | null };
  Bindings: Record<string, unknown>;
};

export type LoopbackCheck = (c: Context<AppEnv>) => boolean;

/** Paths reachable without a token. Pairing confirm is not among them. */
export const PUBLIC_PATHS: readonly string[] = [
  "/health",
  "/capabilities",
  "/pair/setup",
  "/pair/start",
  "/pair/claim",
];

/**
 * Path prefixes reachable without a token: provider webhooks and the cron
 * tick, each verified by its own secret.
 */
export const PUBLIC_PREFIXES: readonly string[] = ["/webhooks/", "/cron/"];

export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const a = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (a === "::1" || a === "localhost") return true;
  const v4 = a.startsWith("::ffff:") ? a.slice(7) : a;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/**
 * Paths whose clients cannot set headers (EventSource), so the Device token
 * may ride in `?token=`. Query tokens are accepted nowhere else.
 */
export const QUERY_TOKEN_PATHS: readonly string[] = ["/changes/sse"];

export function authenticate(auth: Auth, isLoopback: LoopbackCheck): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const bearer =
      parseBearer(c.req.header("authorization")) ??
      (QUERY_TOKEN_PATHS.includes(c.req.path) ? c.req.query("token")?.trim() || null : null);
    const principal = bearer ? await auth.authenticate(bearer, isLoopback(c)) : null;
    c.set("principal", principal);
    await next();
  };
}

export function requireAuth(
  publicPaths: readonly string[] = PUBLIC_PATHS,
  publicPrefixes: readonly string[] = PUBLIC_PREFIXES,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (publicPaths.includes(c.req.path)) return next();
    if (publicPrefixes.some((prefix) => c.req.path.startsWith(prefix))) return next();
    if (!c.get("principal")) {
      return c.json({ error: "unauthorized" }, 401, {
        "www-authenticate": 'Bearer realm="monday"',
      });
    }
    return next();
  };
}

export function principalOf(c: Context<AppEnv>): Principal {
  const principal = c.get("principal");
  if (!principal) throw new Error("route reached without a principal");
  return principal;
}
