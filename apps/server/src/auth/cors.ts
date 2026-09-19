// Browser requests from the desktop webview cross origins: the app lives at
// tauri://localhost (or the dev server) and the Server on 127.0.0.1:<port> or a
// Cloud URL. Without these headers WebKit fails every fetch with "Load failed".
// The allowed origins are a Setting (ADR 0004); the preflight is answered here,
// before authentication, because a preflight carries no bearer.

import type { MiddlewareHandler } from "hono";

const PREFLIGHT_MAX_AGE = "600";
const ALLOWED_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";

/** Answers preflights and stamps CORS headers for an allowed origin. */
export function cors(allowedOrigins: () => Promise<readonly string[]>): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (!origin) return next();
    const allowed = (await allowedOrigins()).includes(origin);
    if (c.req.method === "OPTIONS") {
      if (!allowed) return c.body(null, 403);
      return c.body(null, 204, {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": ALLOWED_METHODS,
        "access-control-allow-headers":
          c.req.header("access-control-request-headers") ?? "authorization,content-type",
        "access-control-max-age": PREFLIGHT_MAX_AGE,
        vary: "Origin",
      });
    }
    await next();
    if (allowed) {
      c.res.headers.set("access-control-allow-origin", origin);
      c.res.headers.set(
        "access-control-expose-headers",
        "content-type,retry-after,www-authenticate",
      );
      c.res.headers.append("vary", "Origin");
    }
  };
}
