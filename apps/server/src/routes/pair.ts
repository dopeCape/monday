// Pairing routes (ADR 0006).
//   POST   /pair/setup   {setupCode, name}  first Device only, mints its token
//   POST   /pair/start   {name}             new Device gets a 6-digit code and a secret
//   POST   /pair/confirm {code}             an authenticated Device approves the code
//   POST   /pair/claim   {secret}           the new Device polls until it is paired
// Phones (the Pairing invite, ADR 0006 amendment):
//   POST   /pair/invite                     a paired computer makes an invite: PairingInvite
//   DELETE /pair/invite                     cancels every open invite
//   POST   /pair/redeem  {secret | code, name, kind?}
//                                          the phone exchanges it, once: PairingRedeemed

import {
  DEVICE_KINDS,
  encodePairingPayload,
  type LanStatus,
  normalizeInviteCode,
  type PairingInvite,
  type PairingRedeemed,
} from "@monday/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { Auth } from "../auth/index.ts";
import { PairingError } from "../auth/index.ts";
import type { AppEnv } from "../auth/middleware.ts";
import { parseBody } from "./validate.ts";

const name = z.string().trim().min(1).max(120);

const setupBody = z.object({ setupCode: z.string().trim().min(1), name });
const startBody = z.object({ name });
const confirmBody = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
});
const claimBody = z.object({ secret: z.string().trim().min(1) });
const redeemBody = z
  .object({
    secret: z.string().trim().min(1).max(200).optional(),
    code: z.string().trim().min(1).max(20).optional(),
    name,
    kind: z.enum(DEVICE_KINDS as [string, ...string[]]).default("phone"),
  })
  .refine((b) => Boolean(b.secret) !== Boolean(b.code), { message: "secret or code, not both" });

const STATUS: Record<PairingError["code"], 400 | 403 | 404 | 409 | 410 | 429> = {
  invalid_setup_code: 403,
  setup_already_done: 409,
  unknown_code: 404,
  unknown_secret: 404,
  expired: 410,
  already_used: 409,
  too_many_attempts: 429,
};

/** Where and what this Server is, for the QR code: its name, its addresses, the LAN certificate. */
export interface PairingServerInfo {
  name: string;
  /** Addresses a phone may try, best first: LAN addresses, then a public URL. */
  urls: string[];
  fingerprint: string | null;
  lan: LanStatus;
}

export interface PairRoutesOptions {
  /** Read per invite, so a changed Setting or a restarted listener shows at once. */
  serverInfo?: () => Promise<PairingServerInfo>;
}

/** No LAN listener: a Cloud, a test, a plain start. */
export const NO_LAN: LanStatus = {
  enabled: false,
  listening: false,
  port: 0,
  tls: false,
  urls: [],
  fingerprint: null,
  error: null,
  restartNeeded: false,
};

export function pairRoutes(auth: Auth, options: PairRoutesOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const serverInfo =
    options.serverInfo ??
    (async (): Promise<PairingServerInfo> => ({
      name: "monday",
      urls: [],
      fingerprint: null,
      lan: NO_LAN,
    }));

  app.onError((error, c) => {
    if (error instanceof PairingError) return c.json({ error: error.code }, STATUS[error.code]);
    throw error;
  });

  app.post("/setup", async (c) => {
    const body = await parseBody(c, setupBody);
    if (!body.ok) return body.response;
    const minted = await auth.pairSetup(body.data.setupCode, body.data.name);
    return c.json(minted, 201);
  });

  app.post("/start", async (c) => {
    const body = await parseBody(c, startBody);
    if (!body.ok) return body.response;
    const started = await auth.pairStart(body.data.name);
    return c.json({ ...started, expiresAt: started.expiresAt.toISOString() }, 201);
  });

  app.post("/confirm", async (c) => {
    if (!c.get("principal")) return c.json({ error: "unauthorized" }, 401);
    const body = await parseBody(c, confirmBody);
    if (!body.ok) return body.response;
    await auth.pairConfirm(body.data.code);
    return c.json({ ok: true });
  });

  app.post("/claim", async (c) => {
    const body = await parseBody(c, claimBody);
    if (!body.ok) return body.response;
    const result = await auth.pairClaim(body.data.secret);
    if (result.status === "pending") {
      return c.json({ status: "pending", expiresAt: result.expiresAt.toISOString() }, 202);
    }
    return c.json(result, 200);
  });

  app.post("/invite", async (c) => {
    if (!c.get("principal")) return c.json({ error: "unauthorized" }, 401);
    const [invite, info] = await Promise.all([auth.pairInvite(), serverInfo()]);
    const fields = {
      name: info.name,
      urls: info.urls,
      secret: invite.secret,
      code: invite.code,
      expiresAt: invite.expiresAt.toISOString(),
      fingerprint: info.fingerprint,
    };
    const answer: PairingInvite = {
      ...fields,
      payload: encodePairingPayload(fields),
      lan: info.lan,
    };
    return c.json(answer, 201);
  });

  app.delete("/invite", async (c) => {
    if (!c.get("principal")) return c.json({ error: "unauthorized" }, 401);
    await auth.cancelInvites();
    return c.body(null, 204);
  });

  app.post("/redeem", async (c) => {
    const body = await parseBody(c, redeemBody);
    if (!body.ok) return body.response;
    const kind = body.data.kind as (typeof DEVICE_KINDS)[number];
    let minted: { deviceId: string; token: string };
    if (body.data.secret) {
      minted = await auth.pairRedeem({ secret: body.data.secret, name: body.data.name, kind });
    } else {
      const code = normalizeInviteCode(body.data.code ?? "");
      if (!code) return c.json({ error: "invalid_code" }, 400);
      minted = await auth.pairRedeem({ code, name: body.data.name, kind });
    }
    const answer: PairingRedeemed = { ...minted, name: (await serverInfo()).name };
    return c.json(answer, 201);
  });

  return app;
}
