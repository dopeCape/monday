// Phones pair by a Pairing invite (ADR 0006, amended): a paired computer makes
// one, the phone redeems its secret or its short code once, before it expires;
// wrong guesses cancel open invites; revoking signs the phone out; and a phone
// never reaches the root key's routes.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type LanStatus, type PairingInvite, parsePairingPayload } from "@monday/shared";
import type { Hono } from "hono";
import { type AppEnv, createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/index.ts";
import { refusedToPhones } from "../src/auth/middleware.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const SIDECAR_TOKEN = "loopback-token";

const LAN: LanStatus = {
  enabled: true,
  listening: true,
  port: 47820,
  tls: true,
  urls: ["https://192.168.1.20:47820"],
  fingerprint: "q83vEjRWeJA",
  error: null,
  restartNeeded: false,
};

const post = (body: unknown, token?: string): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body),
});
const bearer = (token: string, method = "GET"): RequestInit => ({
  method,
  headers: { authorization: `Bearer ${token}` },
});

describe("phone pairing", () => {
  let db: TestDatabase;
  let app: Hono<AppEnv>;
  let clock = new Date("2026-10-02T12:00:00Z");
  const peer = { address: "127.0.0.1" };

  beforeAll(async () => {
    db = await testDatabase();
    const auth = createAuth({
      db: db.handle.db,
      sidecarToken: SIDECAR_TOKEN,
      inviteTtlMs: 10 * 60_000,
      maxFailures: 3,
      now: () => clock,
    });
    app = createApp({
      db: db.handle.db,
      auth,
      mode: "sidecar",
      remoteAddress: () => peer.address,
      lan: () => LAN,
      hostName: "tejas-laptop",
      publicUrl: async () => null,
    });
  }, 60_000);

  afterAll(async () => {
    await db.drop();
  });

  const invite = async (): Promise<PairingInvite> => {
    peer.address = "127.0.0.1";
    const res = await app.request("/pair/invite", post({}, SIDECAR_TOKEN));
    expect(res.status).toBe(201);
    return (await res.json()) as PairingInvite;
  };

  test("an invite needs a paired device and carries the addresses, the code and the fingerprint", async () => {
    const anonymous = await app.request("/pair/invite", post({}));
    expect(anonymous.status).toBe(401);

    const made = await invite();
    expect(made.name).toBe("tejas-laptop");
    expect(made.urls).toEqual(["https://192.168.1.20:47820"]);
    expect(made.fingerprint).toBe("q83vEjRWeJA");
    expect(made.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(made.lan).toEqual(LAN);
    expect(parsePairingPayload(made.payload)).toEqual({
      name: made.name,
      urls: made.urls,
      secret: made.secret,
      code: made.code,
      expiresAt: made.expiresAt,
      fingerprint: made.fingerprint,
    });
    // An invite is not a code waiting for approval.
    const pending = await app.request("/devices/pending", bearer(SIDECAR_TOKEN));
    expect(((await pending.json()) as { pending: unknown[] }).pending).toEqual([]);
  });

  test("the scanned secret is exchanged for a phone's token once", async () => {
    const made = await invite();
    peer.address = "192.168.1.30";
    const res = await app.request("/pair/redeem", post({ secret: made.secret, name: "Pixel 9" }));
    expect(res.status).toBe(201);
    const redeemed = (await res.json()) as { deviceId: string; token: string; name: string };
    expect(redeemed.name).toBe("tejas-laptop");

    const me = await app.request("/devices/me", bearer(redeemed.token));
    expect(await me.json()).toEqual({ id: redeemed.deviceId, kind: "device", deviceKind: "phone" });
    const list = await app.request("/devices", bearer(redeemed.token));
    expect(await list.json()).toContainEqual(
      expect.objectContaining({ id: redeemed.deviceId, name: "Pixel 9", kind: "phone" }),
    );

    const again = await app.request("/pair/redeem", post({ secret: made.secret, name: "Copy" }));
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "already_used" });
  });

  test("the typed short code works too, in any case and with a dash", async () => {
    const made = await invite();
    peer.address = "127.0.0.1"; // the Android emulator reaches the host's loopback as 10.0.2.2
    const typed = `${made.code.slice(0, 4).toLowerCase()}-${made.code.slice(4)}`;
    const res = await app.request("/pair/redeem", post({ code: typed, name: "Emulator" }));
    expect(res.status).toBe(201);
    const bad = await app.request("/pair/redeem", post({ code: "nope", name: "X" }));
    expect(bad.status).toBe(400);
  });

  test("a new invite cancels the last one, and DELETE cancels every open one", async () => {
    const first = await invite();
    const second = await invite();
    const stale = await app.request("/pair/redeem", post({ secret: first.secret, name: "A" }));
    expect(stale.status).toBe(409);

    const cancel = await app.request("/pair/invite", bearer(SIDECAR_TOKEN, "DELETE"));
    expect(cancel.status).toBe(204);
    const gone = await app.request("/pair/redeem", post({ secret: second.secret, name: "B" }));
    expect(gone.status).toBe(409);
  });

  test("an invite expires", async () => {
    const made = await invite();
    clock = new Date(clock.getTime() + 11 * 60_000);
    const res = await app.request("/pair/redeem", post({ code: made.code, name: "Late" }));
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "expired" });
  });

  test("too many wrong codes cancel the open invite", async () => {
    const made = await invite();
    const wrong = made.code === "00000000" ? "11111111" : "00000000";
    const one = await app.request("/pair/redeem", post({ code: wrong, name: "Guess" }));
    expect(one.status).toBe(404);
    await app.request("/pair/redeem", post({ secret: "not-the-secret", name: "Guess" }));
    const third = await app.request("/pair/redeem", post({ code: wrong, name: "Guess" }));
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "too_many_attempts" });
    const real = await app.request("/pair/redeem", post({ code: made.code, name: "Late" }));
    expect(real.status).toBe(409);
  });

  test("a phone cannot touch the root key or other devices; revoking signs it out", async () => {
    const made = await invite();
    const res = await app.request("/pair/redeem", post({ secret: made.secret, name: "Phone" }));
    const phone = (await res.json()) as { deviceId: string; token: string };
    peer.address = "192.168.1.30";

    for (const [path, init] of [
      ["/recovery", bearer(phone.token)],
      ["/unlock", post({ rootKey: "AAAA" }, phone.token)],
      ["/lock", post({}, phone.token)],
      ["/pair/invite", post({}, phone.token)],
      ["/upgrade/export", post({}, phone.token)],
      [`/devices/${phone.deviceId}`, bearer(phone.token, "DELETE")],
    ] as const) {
      const refused = await app.request(path, init);
      expect({ path, status: refused.status }).toEqual({ path, status: 403 });
      expect(await refused.json()).toEqual({ error: "not_from_a_phone" });
    }
    // What the Server serves stays open to it.
    expect((await app.request("/capabilities", bearer(phone.token))).status).toBe(200);
    expect((await app.request("/settings", bearer(phone.token))).status).toBe(200);

    peer.address = "127.0.0.1";
    const revoke = await app.request(`/devices/${phone.deviceId}`, bearer(SIDECAR_TOKEN, "DELETE"));
    expect(revoke.status).toBe(204);
    peer.address = "192.168.1.30";
    expect((await app.request("/settings", bearer(phone.token))).status).toBe(401);
  });

  test("the refused list matches methods and prefixes", () => {
    expect(refusedToPhones("GET", "/recovery")).toBe(true);
    expect(refusedToPhones("GET", "/upgrade")).toBe(false);
    expect(refusedToPhones("POST", "/upgrade/attach")).toBe(true);
    expect(refusedToPhones("GET", "/devices")).toBe(false);
    expect(refusedToPhones("DELETE", "/devices/abc")).toBe(true);
    expect(refusedToPhones("POST", "/pair/redeem")).toBe(false);
  });
});
