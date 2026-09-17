// PKCE (RFC 7636) with S256, the code challenge both Google and Entra
// recommend for public clients. WebCrypto only, so it runs on every runtime.

/** Standard base64 of arbitrary bytes, built in slices so large bodies do not blow the stack. */
export function base64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const step = 8192;
  for (let i = 0; i < bytes.byteLength; i += step) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + step) as unknown as number[]));
  }
  return btoa(parts.join(""));
}

export function base64url(bytes: Uint8Array): string {
  return base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeBase64url(text: string): Uint8Array {
  const padded = text
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** 43 to 128 unreserved characters; 32 random bytes gives 43. */
export function generateVerifier(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return base64url(buffer);
}

export async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function randomState(): string {
  return generateVerifier(16);
}
