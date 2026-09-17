// The root key a host provides at boot (research 5): over the environment
// from the Tauri parent's keychain (Sidecar), from a file such as a systemd
// credential (container), or derived from a passphrase behind a feature flag.
// Node APIs only, so the Cloud entries on Node share it with the Bun entry.

import { readFile } from "node:fs/promises";
import { decodeKey, type Keys, WrongRootKeyError } from "../src/crypto/keys.ts";
import { deriveRootFromPassphrase, passphraseFeatureEnabled } from "../src/crypto/passphrase.ts";

export interface ProvidedKey {
  key: Uint8Array;
  source: string;
}

/** Reads the root key the host provides, if any. Order: env, file, passphrase feature. */
export async function rootKeyFromHost(
  env: NodeJS.ProcessEnv,
  log: (message: string) => void,
): Promise<ProvidedKey | null> {
  const fromEnv = env.MONDAY_ROOT_KEY;
  if (fromEnv) {
    const key = decodeKey(fromEnv);
    if (!key) throw new Error("MONDAY_ROOT_KEY is not base64");
    return { key, source: "MONDAY_ROOT_KEY" };
  }
  const file = env.MONDAY_ROOT_KEY_FILE;
  if (file) {
    const text = await readFile(file, "utf8").catch(() => null);
    if (text === null) {
      log(`MONDAY_ROOT_KEY_FILE ${file} is not readable; starting locked`);
      return null;
    }
    // A recovery file has a sentence on the first line; the key is the last non-empty line.
    const line = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1);
    const key = line ? decodeKey(line) : null;
    if (!key) throw new Error(`MONDAY_ROOT_KEY_FILE ${file} holds no base64 key`);
    return { key, source: "MONDAY_ROOT_KEY_FILE" };
  }
  if (passphraseFeatureEnabled(env)) {
    const passphrase = env.MONDAY_ROOT_PASSPHRASE;
    const salt = env.MONDAY_ROOT_SALT ? decodeKey(env.MONDAY_ROOT_SALT) : null;
    if (passphrase && salt) {
      return { key: await deriveRootFromPassphrase(passphrase, salt), source: "passphrase" };
    }
    if (passphrase || salt) {
      log("passphrase unlock needs both MONDAY_ROOT_PASSPHRASE and MONDAY_ROOT_SALT");
    }
  }
  return null;
}

export async function unlockAtBoot(
  keys: Keys,
  env: NodeJS.ProcessEnv,
  log: (message: string) => void,
): Promise<void> {
  const provided = await rootKeyFromHost(env, log);
  if (!provided) {
    log("no root key provided; starting locked (headers only until POST /unlock)");
    return;
  }
  try {
    await keys.unlock(provided.key);
    log(`unlocked at boot from ${provided.source}`);
  } catch (error) {
    if (error instanceof WrongRootKeyError) {
      log(`the root key from ${provided.source} does not open this database; starting locked`);
      return;
    }
    throw error;
  }
}
