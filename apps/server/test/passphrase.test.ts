// Argon2id derivation of K_root. The RFC vector check is cheap (32 KiB) and
// always runs; the real parameters (64 MiB, t=3, p=4) take a while in pure
// TypeScript, so that part runs only with RUN_SLOW_TESTS=1.

import { describe, expect, test } from "bun:test";
import { argon2id } from "@noble/hashes/argon2.js";
import {
  ARGON2_PARAMS,
  deriveRootFromPassphrase,
  passphraseFeatureEnabled,
} from "../src/crypto/passphrase.ts";

const slow = process.env.RUN_SLOW_TESTS === "1" ? test : test.skip;

describe("passphrase root key", () => {
  test("the parameters are RFC 9106's memory-constrained profile", () => {
    expect(ARGON2_PARAMS).toEqual({ t: 3, p: 4, m: 64 * 1024, dkLen: 32 });
  });

  test("the feature flag is off unless set", () => {
    expect(passphraseFeatureEnabled({})).toBe(false);
    expect(passphraseFeatureEnabled({ MONDAY_FEATURE_PASSPHRASE: "0" })).toBe(false);
    expect(passphraseFeatureEnabled({ MONDAY_FEATURE_PASSPHRASE: "1" })).toBe(true);
    expect(passphraseFeatureEnabled({ MONDAY_FEATURE_PASSPHRASE: "true" })).toBe(true);
  });

  test("the underlying argon2id matches the RFC 9106 section 5.3 test vector", () => {
    const out = argon2id(new Uint8Array(32).fill(1), new Uint8Array(16).fill(2), {
      t: 3,
      m: 32,
      p: 4,
      dkLen: 32,
      key: new Uint8Array(8).fill(3),
      personalization: new Uint8Array(12).fill(4),
    });
    expect(Buffer.from(out).toString("hex")).toBe(
      "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659",
    );
  });

  test("rejects an empty passphrase and a short salt", async () => {
    await expect(deriveRootFromPassphrase("", new Uint8Array(16))).rejects.toThrow(RangeError);
    await expect(deriveRootFromPassphrase("pw", new Uint8Array(8))).rejects.toThrow(RangeError);
  });

  slow(
    "derives a deterministic 32-byte key with the real parameters",
    async () => {
      const salt = new Uint8Array(16).fill(7);
      const a = await deriveRootFromPassphrase("correct horse battery staple", salt);
      const b = await deriveRootFromPassphrase("correct horse battery staple", salt);
      const c = await deriveRootFromPassphrase("correct horse battery staple", new Uint8Array(16));
      const d = await deriveRootFromPassphrase("correct horse battery stapl", salt);
      expect(a.length).toBe(32);
      expect(a).toEqual(b);
      expect(a).not.toEqual(c);
      expect(a).not.toEqual(d);
    },
    120_000,
  );
});
