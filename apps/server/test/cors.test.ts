import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { cors } from "../src/auth/cors.ts";

const APP = "tauri://localhost";

function build(origins: string[]) {
  const app = new Hono();
  app.use(
    "*",
    cors(async () => origins),
  );
  app.put("/settings/x", (c) => c.json({ ok: true }));
  return app;
}

describe("cors", () => {
  test("the desktop webview's preflight is answered before auth and the response carries the origin", async () => {
    const app = build([APP]);
    const pre = await app.request("/settings/x", {
      method: "OPTIONS",
      headers: {
        origin: APP,
        "access-control-request-method": "PUT",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(APP);
    expect(pre.headers.get("access-control-allow-headers")).toBe("authorization,content-type");
    const res = await app.request("/settings/x", { method: "PUT", headers: { origin: APP } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP);
  });

  test("an origin outside the Setting gets no headers and a refused preflight", async () => {
    const app = build([APP]);
    const pre = await app.request("/settings/x", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "PUT" },
    });
    expect(pre.status).toBe(403);
    const res = await app.request("/settings/x", {
      method: "PUT",
      headers: { origin: "https://evil.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("a request with no Origin (curl, the sidecar's own kicker) passes untouched", async () => {
    const res = await build([APP]).request("/settings/x", { method: "PUT" });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
