// Device authentication and pairing (ADR 0006). No passwords: the first Device
// pairs with a one-time setup code, every later Device is confirmed from an
// existing one with a short code, and the Server mints a long-lived per-Device
// bearer token of which only the SHA-256 is stored. The Sidecar additionally
// accepts its per-launch token, on loopback only.
//
// Runtime-neutral: Web Crypto only.

import type { Device } from "@monday/shared";
import { settingsSchema } from "@monday/shared";
import { and, desc, eq, gt, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { devices, pairingCodes } from "../db/schema.ts";

export const SIDECAR_DEVICE_ID = "local";
/** The shipped default of server.pairing_code_minutes, as milliseconds. */
export const PAIRING_CODE_TTL_MS = settingsSchema["server.pairing_code_minutes"].default * 60_000;
/** How often a Device's last_seen is written. */
export const LAST_SEEN_RESOLUTION_MS = 60_000;

export type Principal =
  | { kind: "sidecar"; deviceId: typeof SIDECAR_DEVICE_ID }
  | { kind: "device"; deviceId: string };

export type PairingErrorCode =
  | "invalid_setup_code"
  | "setup_already_done"
  | "unknown_code"
  | "expired"
  | "already_used"
  | "unknown_secret";

export class PairingError extends Error {
  constructor(readonly code: PairingErrorCode) {
    super(code.replaceAll("_", " "));
    this.name = "PairingError";
  }
}

export interface PairStartResult {
  code: string;
  /** Held by the pending Device; presented to claim the token once confirmed. */
  secret: string;
  expiresAt: Date;
}

export type PairClaimResult =
  | { status: "pending"; expiresAt: Date }
  | { status: "paired"; deviceId: string; token: string };

/** A pairing code waiting for an existing Device to approve it. */
export interface PendingCode {
  code: string;
  name: string;
  expiresAt: Date;
}

export interface AuthOptions {
  db: Db;
  /** Per-launch token from the Tauri parent (env MONDAY_SIDECAR_TOKEN). */
  sidecarToken?: string | null;
  /** One-time code that pairs the very first Device. */
  setupCode?: string | null;
  /** How long a pairing code lives; the Setting server.pairing_code_minutes when read from the table. */
  codeTtlMs?: number | (() => Promise<number> | number);
  now?: () => Date;
}

export interface Auth {
  /** Resolve a bearer token to a principal; null when it is not valid. */
  authenticate(bearer: string | null, loopback: boolean): Promise<Principal | null>;
  pairSetup(setupCode: string, name: string): Promise<{ deviceId: string; token: string }>;
  pairStart(name: string): Promise<PairStartResult>;
  pairConfirm(code: string): Promise<void>;
  pairClaim(secret: string): Promise<PairClaimResult>;
  listDevices(): Promise<Device[]>;
  revokeDevice(id: string): Promise<boolean>;
  hasDevices(): Promise<boolean>;
  /** Codes new Devices are showing right now: started, not yet confirmed, not expired. */
  listPendingCodes(): Promise<PendingCode[]>;
  /** Whether the setup code would currently be accepted. */
  setupAvailable(): Promise<boolean>;
}

const encoder = new TextEncoder();

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let binary = "";
  for (const b of buf) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Six digits, uniformly distributed, with leading zeros kept. */
export function randomCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String((buf[0] ?? 0) % 1_000_000).padStart(6, "0");
}

/** Compares two strings without leaking where they differ. */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export function createAuth(options: AuthOptions): Auth {
  const { db } = options;
  const sidecarToken = options.sidecarToken || null;
  const setupCode = options.setupCode || null;
  const codeTtl = options.codeTtlMs ?? PAIRING_CODE_TTL_MS;
  const codeTtlMs = async () => (typeof codeTtl === "function" ? await codeTtl() : codeTtl);
  const now = options.now ?? (() => new Date());

  const mintDevice = async (name: string) => {
    const token = randomToken();
    const deviceId = crypto.randomUUID();
    await db.insert(devices).values({
      id: deviceId,
      name,
      tokenHash: await sha256Hex(token),
      createdAt: now(),
      lastSeen: now(),
    });
    return { deviceId, token };
  };

  const api: Auth = {
    async authenticate(bearer, loopback) {
      if (!bearer) return null;
      if (sidecarToken && loopback && timingSafeEqual(bearer, sidecarToken)) {
        return { kind: "sidecar", deviceId: SIDECAR_DEVICE_ID };
      }
      const hash = await sha256Hex(bearer);
      const row = await db.query.devices.findFirst({ where: eq(devices.tokenHash, hash) });
      if (!row) return null;
      // Last seen is a minute's resolution: one write per Device per minute, not one per request.
      if (now().getTime() - row.lastSeen.getTime() >= LAST_SEEN_RESOLUTION_MS) {
        await db.update(devices).set({ lastSeen: now() }).where(eq(devices.id, row.id));
      }
      return { kind: "device", deviceId: row.id };
    },

    async pairSetup(code, name) {
      if (!setupCode || !timingSafeEqual(code, setupCode)) {
        throw new PairingError("invalid_setup_code");
      }
      if (await api.hasDevices()) throw new PairingError("setup_already_done");
      return mintDevice(name);
    },

    async pairStart(name) {
      const secret = randomToken();
      const secretHash = await sha256Hex(secret);
      const expiresAt = new Date(now().getTime() + (await codeTtlMs()));
      for (let attempt = 0; attempt < 20; attempt++) {
        const code = randomCode();
        const inserted = await db
          .insert(pairingCodes)
          .values({ code, secretHash, deviceName: name, expiresAt, createdAt: now() })
          .onConflictDoNothing({ target: pairingCodes.code })
          .returning({ code: pairingCodes.code });
        if (inserted.length > 0) return { code, secret, expiresAt };
        // A stale row holds this code; reclaim it if it is expired or spent.
        const reclaimed = await db
          .update(pairingCodes)
          .set({ secretHash, deviceName: name, expiresAt, confirmedAt: null, used: false })
          .where(
            and(
              eq(pairingCodes.code, code),
              or(eq(pairingCodes.used, true), lt(pairingCodes.expiresAt, now())),
            ),
          )
          .returning({ code: pairingCodes.code });
        if (reclaimed.length > 0) return { code, secret, expiresAt };
      }
      throw new Error("could not allocate a pairing code");
    },

    async pairConfirm(code) {
      const row = await db.query.pairingCodes.findFirst({ where: eq(pairingCodes.code, code) });
      if (!row) throw new PairingError("unknown_code");
      if (row.used) throw new PairingError("already_used");
      if (row.expiresAt.getTime() < now().getTime()) throw new PairingError("expired");
      await db.update(pairingCodes).set({ confirmedAt: now() }).where(eq(pairingCodes.code, code));
    },

    async pairClaim(secret) {
      const secretHash = await sha256Hex(secret);
      const row = await db.query.pairingCodes.findFirst({
        where: eq(pairingCodes.secretHash, secretHash),
        orderBy: desc(pairingCodes.createdAt),
      });
      if (!row) throw new PairingError("unknown_secret");
      if (row.used) throw new PairingError("already_used");
      if (row.expiresAt.getTime() < now().getTime()) throw new PairingError("expired");
      if (!row.confirmedAt) return { status: "pending", expiresAt: row.expiresAt };
      const spent = await db
        .update(pairingCodes)
        .set({ used: true })
        .where(
          and(
            eq(pairingCodes.code, row.code),
            eq(pairingCodes.used, false),
            isNotNull(pairingCodes.confirmedAt),
          ),
        )
        .returning({ code: pairingCodes.code });
      if (spent.length === 0) throw new PairingError("already_used");
      const minted = await mintDevice(row.deviceName);
      return { status: "paired", ...minted };
    },

    async listDevices() {
      const rows = await db.select().from(devices).orderBy(devices.createdAt);
      return rows.map((r) => ({ id: r.id, name: r.name, lastSeen: r.lastSeen.toISOString() }));
    },

    async revokeDevice(id) {
      const deleted = await db
        .delete(devices)
        .where(eq(devices.id, id))
        .returning({ id: devices.id });
      return deleted.length > 0;
    },

    async hasDevices() {
      const row = await db.select({ id: devices.id }).from(devices).limit(1);
      return row.length > 0;
    },

    async listPendingCodes() {
      const rows = await db
        .select()
        .from(pairingCodes)
        .where(
          and(
            eq(pairingCodes.used, false),
            isNull(pairingCodes.confirmedAt),
            gt(pairingCodes.expiresAt, now()),
          ),
        )
        .orderBy(desc(pairingCodes.createdAt));
      return rows.map((r) => ({ code: r.code, name: r.deviceName, expiresAt: r.expiresAt }));
    },

    async setupAvailable() {
      return Boolean(setupCode) && !(await api.hasDevices());
    },
  };

  return api;
}
