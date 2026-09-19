// A stand-in for Google's token signer: an RSA key pair, its public half as
// the JWKS the verifier reads, and RS256 tokens with whatever claims a test
// wants. Web Crypto only, like the verifier.

import { base64UrlEncode, type Jwk, type JwkSource } from "../../src/providers/gmail/oidc.ts";

export interface OidcSigner {
  kid: string;
  jwks: JwkSource;
  /** The published key set as Google would serve it. */
  document(): { keys: Jwk[] };
  /** A signed token; `overrides` replace the sensible defaults for the claims. */
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
}

const encoder = new TextEncoder();

export async function createOidcSigner(kid = "test-key-1"): Promise<OidcSigner> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const exported = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  if (!exported.n || !exported.e) throw new Error("exported key lacks n or e");
  const jwk: Jwk = { kid, kty: "RSA", alg: "RS256", use: "sig", n: exported.n, e: exported.e };
  const keys = new Map<string, Jwk>([[kid, jwk]]);
  const encode = (value: unknown) => base64UrlEncode(encoder.encode(JSON.stringify(value)));
  return {
    kid,
    jwks: { keyFor: async (id) => keys.get(id) ?? null },
    document: () => ({ keys: [...keys.values()] }),
    async sign(claims, header = {}) {
      const head = encode({ alg: "RS256", typ: "JWT", kid, ...header });
      const payload = encode(claims);
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        encoder.encode(`${head}.${payload}`),
      );
      return `${head}.${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
    },
  };
}

/** The claims Google puts on a Pub/Sub push token, for `at` (epoch ms). */
export function googlePushClaims(
  audience: string,
  email: string,
  at: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const iat = Math.floor(at / 1000);
  return {
    iss: "https://accounts.google.com",
    aud: audience,
    azp: "1234567890",
    sub: "1234567890",
    email,
    email_verified: true,
    iat,
    exp: iat + 3600,
    ...extra,
  };
}
