// Pairing a phone with an existing monday (ADR 0006, amended for phones).
// A Device already paired (the desktop, on its Sidecar) asks the Server for a
// Pairing invite: a one-time secret and a short code with an expiry. The
// Devices panel shows both as a QR code that also carries the Server's
// addresses and, for LAN access over TLS, the certificate's fingerprint the
// phone pins. The phone redeems the secret (scanned) or the short code (typed
// with the address) for its own Device token.
//
// Runtime-neutral: no Bun, no DOM, no Node.

/** What kind of client a Device is. A phone never holds the root key and cannot reach its routes. */
export type DeviceKind = "computer" | "phone";

export const DEVICE_KINDS: readonly DeviceKind[] = ["computer", "phone"];

/** The scheme and path of the QR code's text. */
export const PAIRING_URI_PREFIX = "monday://pair";

/** Crockford base32: no I, L, O or U, so a typed code survives a misread letter. */
export const INVITE_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Characters in a short code: 40 bits, shown as two groups of four. */
export const INVITE_CODE_LENGTH = 8;

/** What the QR code carries. */
export interface PairingPayload {
  /** The Server's name as the phone shows it: "Connected to {name}". */
  name: string;
  /** Addresses to try in order: LAN addresses, then a public URL. */
  urls: string[];
  /** The one-time secret, redeemed for a Device token. */
  secret: string;
  /** The short code, for typing instead of scanning. */
  code: string;
  expiresAt: string;
  /** SHA-256 of the LAN certificate (base64url), pinned by the phone; null over plain HTTP. */
  fingerprint: string | null;
}

/** What POST /pair/invite answers. */
export interface PairingInvite extends PairingPayload {
  /** The text the QR code encodes. */
  payload: string;
  /** Whether LAN access is on and listening, so the panel can warn when it is not. */
  lan: LanStatus;
}

/** What POST /pair/redeem answers. */
export interface PairingRedeemed {
  deviceId: string;
  token: string;
  /** The Server's name, for "Connected to {name}". */
  name: string;
}

/** The Sidecar's LAN listener as it runs now (it changes on a restart of the background service). */
export interface LanStatus {
  /** The Setting as saved. */
  enabled: boolean;
  /** Whether the listener is up in this process. */
  listening: boolean;
  port: number;
  tls: boolean;
  /** The addresses a phone on the same network can try, empty when not listening. */
  urls: string[];
  fingerprint: string | null;
  /** Why it is not listening when it should be (the port is taken), in plain words. */
  error: string | null;
  /** The saved Settings differ from what runs: a restart of the background service applies them. */
  restartNeeded: boolean;
}

export function encodePairingPayload(payload: PairingPayload): string {
  const q = new URLSearchParams();
  q.set("v", "1");
  q.set("n", payload.name);
  for (const url of payload.urls) q.append("u", url);
  q.set("s", payload.secret);
  q.set("c", payload.code);
  q.set("e", payload.expiresAt);
  if (payload.fingerprint) q.set("f", payload.fingerprint);
  return `${PAIRING_URI_PREFIX}?${q}`;
}

/** Reads a scanned QR code's text; null when it is not a monday pairing code. */
export function parsePairingPayload(text: string): PairingPayload | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(`${PAIRING_URI_PREFIX}?`)) return null;
  const q = new URLSearchParams(trimmed.slice(PAIRING_URI_PREFIX.length + 1));
  if (q.get("v") !== "1") return null;
  const secret = q.get("s");
  const code = normalizeInviteCode(q.get("c") ?? "");
  const expiresAt = q.get("e");
  const urls = q.getAll("u").filter((u) => checkServerUrl(u).ok);
  if (!secret || !code || !expiresAt || urls.length === 0) return null;
  return {
    name: q.get("n") || "monday",
    urls,
    secret,
    code,
    expiresAt,
    fingerprint: q.get("f") || null,
  };
}

/**
 * The short code as typed: case and separators ignored, the letters Crockford
 * reads as digits mapped (O to 0, I and L to 1). Null when it cannot be one.
 */
export function normalizeInviteCode(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replaceAll("O", "0")
    .replace(/[IL]/g, "1");
  if (cleaned.length !== INVITE_CODE_LENGTH) return null;
  for (const ch of cleaned) if (!INVITE_CODE_ALPHABET.includes(ch)) return null;
  return cleaned;
}

/** "ABCD-EFGH", easier to read aloud and to type. */
export function formatInviteCode(code: string): string {
  return code.length === INVITE_CODE_LENGTH ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/** The first bytes of a fingerprint as hex pairs, for a person to compare at a glance. */
export function shortFingerprint(fingerprint: string, bytes = 6): string {
  const b64 = fingerprint.replaceAll("-", "+").replaceAll("_", "/");
  let binary: string;
  try {
    binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  } catch {
    return fingerprint.slice(0, bytes * 2);
  }
  return Array.from(binary.slice(0, bytes), (c) =>
    c.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase(),
  ).join(":");
}

/**
 * Whether a host is on this machine or a private network: loopback, the
 * RFC 1918 ranges (the Android emulator's 10.0.2.2 among them), link-local,
 * IPv6 unique-local, and mDNS `.local` names.
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h === "::1") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
}

export type ServerUrlCheck =
  | { ok: true; url: string }
  | { ok: false; reason: "invalid" | "insecure" };

/**
 * A Server address a phone may use: https anywhere, plain http only to a host
 * on a private network (ADR 0006). Trailing slashes are dropped; a bare host
 * gets https.
 */
export function checkServerUrl(input: string): ServerUrlCheck {
  const text = input.trim();
  if (!text) return { ok: false, reason: "invalid" };
  const withScheme = /^[a-z]+:\/\//i.test(text) ? text : `https://${text}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "invalid" };
  if (u.protocol === "http:" && !isPrivateHost(u.hostname))
    return { ok: false, reason: "insecure" };
  return { ok: true, url: `${u.origin}${u.pathname.replace(/\/+$/, "")}` };
}
