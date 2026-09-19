// The OIDC token on a Pub/Sub push delivery (the hardening follow-up on the
// record; research 3). A push subscription registered with an
// `oidcToken` makes Pub/Sub sign every delivery with a Google-issued JWT in
// the Authorization header: issuer accounts.google.com, audience the endpoint
// URL the registration named, `email` the service account it was told to
// sign as. The webhook verifies that signature against Google's published
// keys before it looks at the per-Account secret in the URL, so a
// notification has to come from Google and carry what only the registration
// knew. Web Crypto only, so the Cloud entries verify on Node as well.

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_ISSUERS: readonly string[] = [
  "https://accounts.google.com",
  "accounts.google.com",
];
/** How long a fetched key set is reused before a refresh, when the response says nothing. */
export const JWKS_CACHE_MS = 60 * 60_000;
/** Clock skew tolerated on exp and iat. */
export const CLOCK_SKEW_MS = 60_000;

export type OidcFailure =
  | "malformed"
  | "unsupported_alg"
  | "unknown_key"
  | "bad_signature"
  | "issuer"
  | "audience"
  | "email"
  | "expired"
  | "not_yet_valid";

export type OidcVerdict =
  | { ok: true; email: string; subject: string }
  | { ok: false; reason: OidcFailure };

export interface OidcExpectation {
  /** The push endpoint URL the registration named as the audience. */
  audience: string;
  /** The service account the registration told Pub/Sub to sign as. */
  email: string;
}

/** A JSON Web Key as Google publishes it. */
export interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

export interface JwkSource {
  /** The key for a key id, fetching or refreshing as needed; null when Google has no such key. */
  keyFor(kid: string): Promise<Jwk | null>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64UrlDecode(text: string): Uint8Array {
  const padded =
    text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface JwtClaims {
  iss?: string;
  aud?: string | string[];
  email?: string;
  email_verified?: boolean;
  sub?: string;
  exp?: number;
  iat?: number;
  nbf?: number;
}

function parseJson<T>(bytes: Uint8Array): T | null {
  try {
    return JSON.parse(decoder.decode(bytes)) as T;
  } catch {
    return null;
  }
}

/**
 * Google's key set, fetched on demand and kept until its Cache-Control
 * max-age (or an hour) passes. An unknown key id refreshes once, since
 * Google rotates keys.
 */
export function createGoogleJwks(
  options: { fetch?: typeof fetch; url?: string; now?: () => number } = {},
): JwkSource {
  const doFetch = options.fetch ?? fetch;
  const url = options.url ?? GOOGLE_JWKS_URL;
  const now = options.now ?? (() => Date.now());
  let keys: Map<string, Jwk> = new Map();
  let freshUntil = 0;
  let inFlight: Promise<void> | null = null;

  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const response = await doFetch(url);
      if (!response.ok) throw new Error(`JWKS fetch failed (${response.status})`);
      const body = (await response.json()) as { keys?: Jwk[] };
      const next = new Map<string, Jwk>();
      for (const key of body.keys ?? []) if (key.kid) next.set(key.kid, key);
      keys = next;
      const maxAge = /max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "")?.[1];
      freshUntil = now() + (maxAge ? Number(maxAge) * 1000 : JWKS_CACHE_MS);
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    async keyFor(kid) {
      if (now() >= freshUntil) await refresh();
      const found = keys.get(kid);
      if (found) return found;
      // Rotation: refresh once for a key id we have not seen.
      freshUntil = 0;
      await refresh();
      return keys.get(kid) ?? null;
    },
  };
}

/**
 * Verifies a Google-signed RS256 ID token: signature against the published
 * key, issuer, audience, the signing service account's email, and the time
 * window. Never throws for a bad token; the verdict says why.
 */
export async function verifyGoogleIdToken(
  token: string,
  expected: OidcExpectation,
  jwks: JwkSource,
  now: () => number = () => Date.now(),
): Promise<OidcVerdict> {
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts.some((p) => p === undefined || p === "")) {
    return { ok: false, reason: "malformed" };
  }
  const [head, payload, signature] = parts as [string, string, string];
  let header: JwtHeader | null;
  let claims: JwtClaims | null;
  let signatureBytes: Uint8Array;
  try {
    header = parseJson<JwtHeader>(base64UrlDecode(head));
    claims = parseJson<JwtClaims>(base64UrlDecode(payload));
    signatureBytes = base64UrlDecode(signature);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!header || !claims || typeof header.kid !== "string") {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "RS256") return { ok: false, reason: "unsupported_alg" };
  const jwk = await jwks.keyFor(header.kid);
  if (jwk?.kty !== "RSA" || !jwk.n || !jwk.e) return { ok: false, reason: "unknown_key" };
  let valid = false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signatureBytes,
      encoder.encode(`${head}.${payload}`),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad_signature" };
  if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.includes(claims.iss)) {
    return { ok: false, reason: "issuer" };
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!audiences.includes(expected.audience)) return { ok: false, reason: "audience" };
  if (
    typeof claims.email !== "string" ||
    claims.email.toLowerCase() !== expected.email.toLowerCase() ||
    claims.email_verified === false
  ) {
    return { ok: false, reason: "email" };
  }
  const at = now();
  if (typeof claims.exp !== "number" || claims.exp * 1000 + CLOCK_SKEW_MS < at) {
    return { ok: false, reason: "expired" };
  }
  const start = typeof claims.nbf === "number" ? claims.nbf : claims.iat;
  if (typeof start === "number" && start * 1000 - CLOCK_SKEW_MS > at) {
    return { ok: false, reason: "not_yet_valid" };
  }
  return { ok: true, email: claims.email, subject: claims.sub ?? "" };
}
