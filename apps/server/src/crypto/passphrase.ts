// Optional: derive K_root from a passphrase instead of generating it. Argon2id
// with RFC 9106's memory-constrained parameters (t=3, p=4, m=64 MiB), per
// research 5, "Cipher and runtime". Off unless the passphrase feature flag is
// on: a passphrase is weaker than 256 random bits and the default stays the
// random key plus recovery file.
//
// Bun 1.3 has no argon2 KDF that takes a caller's salt and parallelism
// (Bun.password fixes p=1 and generates its own salt), so this uses
// @noble/hashes, a pure-TypeScript audited implementation of the same RFC.

import { argon2idAsync } from "@noble/hashes/argon2.js";
import { KEY_BYTES } from "./aead.ts";

export const PASSPHRASE_FEATURE_FLAG = "MONDAY_FEATURE_PASSPHRASE";
export const SALT_MIN_BYTES = 16;

/** RFC 9106 section 4, second recommendation: the memory-constrained profile. */
export const ARGON2_PARAMS = { t: 3, p: 4, m: 64 * 1024, dkLen: KEY_BYTES } as const;

export function passphraseFeatureEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env[PASSPHRASE_FEATURE_FLAG];
  return raw === "1" || raw === "true";
}

/**
 * Derives a 32-byte root key. The salt must be at least 16 random bytes kept
 * beside the passphrase's use site (it is not secret; it makes the derivation
 * unique per install). Takes a few hundred milliseconds by design.
 */
export async function deriveRootFromPassphrase(
  passphrase: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  if (passphrase.length === 0) throw new RangeError("passphrase is empty");
  if (salt.length < SALT_MIN_BYTES) throw new RangeError(`salt must be ${SALT_MIN_BYTES}+ bytes`);
  const key = await argon2idAsync(new TextEncoder().encode(passphrase.normalize("NFKC")), salt, {
    ...ARGON2_PARAMS,
    maxmem: ARGON2_PARAMS.m * 1024 * 2,
  });
  return new Uint8Array(key);
}
