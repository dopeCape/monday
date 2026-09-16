// The loopback redirect receiver for the OAuth wizards (RFC 8252 section
// 7.3): a one-shot Bun.serve on a random port that waits for the browser to
// come back with the authorization code, answers a small "you can close this
// window" page, and hands the query to the route that opened it. Google's
// Desktop clients accept any http://127.0.0.1:port; Entra's "Mobile and
// desktop" platform registers http://localhost and ignores the port.

import type { LoopbackListener } from "../src/routes/oauth.ts";

export interface LoopbackOptions {
  /** Give up waiting after this long; the wizard shows a timeout. */
  timeoutMs?: number;
  /** The page shown in the browser after the redirect. */
  page?: (ok: boolean) => string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

function defaultPage(ok: boolean): string {
  const line = ok
    ? "Signed in. You can close this window and go back to monday."
    : "Sign-in did not complete. Go back to monday and try again.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>monday</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#222;background:#fafaf9}p{font-size:18px}</style></head><body><p>${line}</p></body></html>`;
}

export function createLoopbackListener(options: LoopbackOptions = {}): LoopbackListener {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const page = options.page ?? defaultPage;
  return {
    async open(provider) {
      let resolveCallback: (query: Record<string, string>) => void = () => {};
      let rejectCallback: (error: Error) => void = () => {};
      const callback = new Promise<Record<string, string>>((resolve, reject) => {
        resolveCallback = resolve;
        rejectCallback = reject;
      });
      const hostname = provider === "google" ? "127.0.0.1" : "localhost";
      const server = Bun.serve({
        hostname,
        port: 0,
        fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === "/favicon.ico") return new Response(null, { status: 404 });
          const query: Record<string, string> = {};
          for (const [k, v] of url.searchParams) query[k] = v;
          const ok = "code" in query && !("error" in query);
          resolveCallback(query);
          return new Response(page(ok), {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        },
      });
      const timer = setTimeout(() => {
        rejectCallback(new Error("timed out waiting for the browser to come back"));
        server.stop(true);
      }, timeoutMs);
      timer.unref();
      const redirectUri =
        provider === "google"
          ? `http://127.0.0.1:${server.port}/callback`
          : `http://localhost:${server.port}`;
      return {
        redirectUri,
        callback,
        close() {
          clearTimeout(timer);
          server.stop(true);
        },
      };
    },
  };
}
