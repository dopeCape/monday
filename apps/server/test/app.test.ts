import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Capabilities, DeploymentMode, HostedState } from "@monday/shared";
import { defaultSettings, HOSTED_PROVIDERS, rolesFor } from "@monday/shared";
import type { Hono } from "hono";
import { type AppEnv, createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/index.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const SETUP_CODE = "424242";
const SIDECAR_TOKEN = "per-launch-token-from-tauri";

/** Builds the app with a switchable peer address so loopback rules can be tested. */
function build(db: TestDatabase, mode: DeploymentMode, peer: { address: string }) {
  const auth = createAuth({ db: db.handle.db, sidecarToken: SIDECAR_TOKEN, setupCode: SETUP_CODE });
  return createApp({ db: db.handle.db, auth, mode, remoteAddress: () => peer.address });
}

const json = (body: unknown, token?: string): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body),
});

const bearer = (token: string): RequestInit => ({ headers: { authorization: `Bearer ${token}` } });

describe("app", () => {
  let db: TestDatabase;
  let app: Hono<AppEnv>;
  const peer = { address: "203.0.113.9" };

  beforeAll(async () => {
    db = await testDatabase();
    app = build(db, "container", peer);
  }, 60_000);

  afterAll(async () => {
    await db.drop();
  });

  test("health and capabilities are public; everything else is 401", async () => {
    const health = await app.request("/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, mode: "container" });

    const caps = await app.request("/capabilities");
    expect(caps.status).toBe(200);

    for (const path of ["/settings", "/devices", "/nope"]) {
      const res = await app.request(path);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    const badToken = await app.request("/settings", bearer("not-a-token"));
    expect(badToken.status).toBe(401);
    const confirm = await app.request("/pair/confirm", json({ code: "123456" }));
    expect(confirm.status).toBe(401);
  });

  test("capabilities follow the deployment mode table", async () => {
    type Own = Pick<Capabilities, "realtime" | "holdsConnections" | "publicUrl" | "localRuntimes">;
    const expected: Record<DeploymentMode, Own> = {
      sidecar: {
        realtime: "websocket",
        holdsConnections: true,
        publicUrl: false,
        localRuntimes: true,
      },
      container: {
        realtime: "websocket",
        holdsConnections: true,
        publicUrl: true,
        localRuntimes: false,
      },
      vercel: { realtime: "sse", holdsConnections: false, publicUrl: true, localRuntimes: false },
      netlify: {
        realtime: "polling",
        holdsConnections: false,
        publicUrl: true,
        localRuntimes: false,
      },
    };
    // No Settings saved and no shared key: the shipped Roles and an empty share list.
    const defaults = defaultSettings();
    const hosted: HostedState = {
      provider: "anthropic",
      roles: Object.fromEntries(
        HOSTED_PROVIDERS.map((p) => [p, rolesFor(defaults, p)]),
      ) as HostedState["roles"],
      sharedKeys: [],
    };
    for (const mode of Object.keys(expected) as DeploymentMode[]) {
      const res = await build(db, mode, peer).request("/capabilities");
      const caps = (await res.json()) as Capabilities;
      expect(caps).toMatchObject({ protocol: 1, mode, ...expected[mode], unlocked: false, hosted });
      // Alone, a Server's topology is its own kind and its features are its own.
      expect(caps.topology).toBe(mode === "sidecar" ? "sidecar" : "cloud");
      const { publicUrl, ...own } = expected[mode];
      expect(caps.features).toEqual({
        ...own,
        pushWebhooks: publicUrl,
        scheduledSendsWhileClosed: mode !== "sidecar",
        backgroundJobs: true,
      });
    }
  });

  describe("pairing", () => {
    let firstToken = "";
    let firstId = "";
    let secondToken = "";
    let secondId = "";

    test("the first device pairs with the setup code", async () => {
      const wrong = await app.request("/pair/setup", json({ setupCode: "000000", name: "Laptop" }));
      expect(wrong.status).toBe(403);

      const res = await app.request("/pair/setup", json({ setupCode: SETUP_CODE, name: "Laptop" }));
      expect(res.status).toBe(201);
      const body = (await res.json()) as { deviceId: string; token: string };
      expect(body.token.length).toBeGreaterThan(30);
      firstToken = body.token;
      firstId = body.deviceId;

      const me = await app.request("/devices", bearer(firstToken));
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject([{ id: firstId, name: "Laptop" }]);

      // The setup code is one-time: a second attempt is refused.
      const again = await app.request(
        "/pair/setup",
        json({ setupCode: SETUP_CODE, name: "Again" }),
      );
      expect(again.status).toBe(409);
    });

    test("only the token hash is stored", async () => {
      const rows = await db.handle.sql`select token_hash from devices where id = ${firstId}`;
      expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0]?.token_hash).not.toBe(firstToken);
    });

    test("a second device pairs with a code confirmed by the first", async () => {
      const start = await app.request("/pair/start", json({ name: "Phone" }));
      expect(start.status).toBe(201);
      const started = (await start.json()) as { code: string; secret: string; expiresAt: string };
      expect(started.code).toMatch(/^\d{6}$/);
      expect(Date.parse(started.expiresAt) - Date.now()).toBeGreaterThan(9 * 60 * 1000);

      // Not confirmed yet: the new device keeps polling.
      const pending = await app.request("/pair/claim", json({ secret: started.secret }));
      expect(pending.status).toBe(202);
      expect(await pending.json()).toMatchObject({ status: "pending" });

      // Unknown code from the confirming device.
      const unknown = await app.request("/pair/confirm", json({ code: "999999" }, firstToken));
      expect(unknown.status).toBe(404);

      const confirm = await app.request("/pair/confirm", json({ code: started.code }, firstToken));
      expect(confirm.status).toBe(200);

      const claim = await app.request("/pair/claim", json({ secret: started.secret }));
      expect(claim.status).toBe(200);
      const paired = (await claim.json()) as { status: string; deviceId: string; token: string };
      expect(paired.status).toBe("paired");
      secondToken = paired.token;
      secondId = paired.deviceId;

      // The code and secret are spent.
      const spent = await app.request("/pair/claim", json({ secret: started.secret }));
      expect(spent.status).toBe(409);
      const reconfirm = await app.request(
        "/pair/confirm",
        json({ code: started.code }, firstToken),
      );
      expect(reconfirm.status).toBe(409);

      const list = await app.request("/devices", bearer(secondToken));
      expect(list.status).toBe(200);
      const devices = (await list.json()) as { id: string; name: string }[];
      expect(devices.map((d) => d.name)).toEqual(["Laptop", "Phone"]);
    });

    test("an expired code cannot be confirmed", async () => {
      const auth = createAuth({ db: db.handle.db, codeTtlMs: -1 });
      const started = await auth.pairStart("Stale");
      await expect(auth.pairConfirm(started.code)).rejects.toMatchObject({ code: "expired" });
      await expect(auth.pairClaim(started.secret)).rejects.toMatchObject({ code: "expired" });
    });

    test("revoking a device invalidates its token", async () => {
      const missing = await app.request("/devices/not-a-device", {
        method: "DELETE",
        ...bearer(firstToken),
      });
      expect(missing.status).toBe(404);

      const res = await app.request(`/devices/${secondId}`, {
        method: "DELETE",
        ...bearer(firstToken),
      });
      expect(res.status).toBe(204);
      const after = await app.request("/devices", bearer(secondToken));
      expect(after.status).toBe(401);
      const list = await app.request("/devices", bearer(firstToken));
      expect(((await list.json()) as unknown[]).length).toBe(1);
    });

    test("the sidecar token works on loopback only", async () => {
      peer.address = "127.0.0.1";
      const local = await app.request("/devices", bearer(SIDECAR_TOKEN));
      expect(local.status).toBe(200);
      peer.address = "::1";
      const local6 = await app.request("/devices", bearer(SIDECAR_TOKEN));
      expect(local6.status).toBe(200);
      peer.address = "::ffff:127.0.0.1";
      const mapped = await app.request("/devices", bearer(SIDECAR_TOKEN));
      expect(mapped.status).toBe(200);

      peer.address = "192.168.1.20";
      const lan = await app.request("/devices", bearer(SIDECAR_TOKEN));
      expect(lan.status).toBe(401);
      peer.address = "203.0.113.9";
    });

    test("settings: global and per-device scope, any JSON value", async () => {
      const put = (key: string, body: unknown, token: string) =>
        app.request(`/settings/${key}`, { ...json(body, token), method: "PUT" });

      expect((await put("theme.mode", { value: "dark" }, firstToken)).status).toBe(200);
      expect(
        (await put("layout.density", { value: "compact", scope: "device" }, firstToken)).status,
      ).toBe(200);
      expect((await put("theme.mode", { value: "light" }, firstToken)).status).toBe(200);
      expect((await put("nested", { value: { a: [1, 2, { b: null }] } }, firstToken)).status).toBe(
        200,
      );

      const bad = await put("theme.mode", { nope: 1 }, firstToken);
      expect(bad.status).toBe(400);
      const badScope = await put("theme.mode", { value: 1, scope: "galaxy" }, firstToken);
      expect(badScope.status).toBe(400);
      const notJson = await app.request("/settings/x", {
        method: "PUT",
        headers: { authorization: `Bearer ${firstToken}`, "content-type": "application/json" },
        body: "{",
      });
      expect(notJson.status).toBe(400);

      const mine = await app.request("/settings", bearer(firstToken));
      expect(await mine.json()).toEqual({
        global: { "theme.mode": "light", nested: { a: [1, 2, { b: null }] } },
        device: { "layout.density": "compact" },
      });

      // The sidecar principal sees the same globals and its own device scope.
      peer.address = "127.0.0.1";
      const sidecar = await app.request("/settings", bearer(SIDECAR_TOKEN));
      expect(await sidecar.json()).toEqual({
        global: { "theme.mode": "light", nested: { a: [1, 2, { b: null }] } },
        device: {},
      });
      peer.address = "203.0.113.9";

      const del = await app.request("/settings/layout.density?scope=device", {
        method: "DELETE",
        ...bearer(firstToken),
      });
      expect(del.status).toBe(204);
      const afterDelete = await app.request("/settings", bearer(firstToken));
      expect(((await afterDelete.json()) as { device: object }).device).toEqual({});
    });
  });
});
