// The one place in the server that touches a cipher. AES-256-GCM through
// node:crypto (research 5, "Cipher and runtime"): 12-byte IV, 16-byte tag,
// tampering surfaces as a DecryptError because the tag check fails.
//
// Envelope, one per object or per chunk, always exactly this layout:
//
//   byte 0        version: 1 = single envelope with a random IV,
//                          2 = one chunk of a larger object, counter IV
//   bytes 1..12   IV (12 bytes). Version 1: random. Version 2: the chunk
//                 counter, 4 zero bytes then the chunk index as a 64-bit
//                 big-endian integer. A DEK encrypts exactly one object, so a
//                 counter never repeats under a key.
//   bytes 13..28  GCM authentication tag (16 bytes)
//   bytes 29..    ciphertext, the same length as the plaintext
//
// A chunk additionally binds its index and whether it is the last chunk into
// the associated data, so chunks cannot be reordered, dropped or truncated
// without the tag failing.
//
// Only src/crypto may import node:crypto's cipher functions; test/seam.test.ts
// greps for it. Everyone else goes through the Mailstore's storeContent.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const KEY_BYTES = 32;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;
export const CHUNK_BYTES = 1024 * 1024;

export const ENVELOPE_SINGLE = 1;
export const ENVELOPE_CHUNK = 2;
export type EnvelopeVersion = typeof ENVELOPE_SINGLE | typeof ENVELOPE_CHUNK;

export type DecryptReason = "malformed" | "unsupported_version" | "tampered" | "bad_key";

/** Every failure to open an envelope, including tampering, is this one typed error. */
export class DecryptError extends Error {
  constructor(
    readonly reason: DecryptReason,
    detail?: string,
  ) {
    super(detail ? `${reason.replaceAll("_", " ")}: ${detail}` : reason.replaceAll("_", " "));
    this.name = "DecryptError";
  }
}

const EMPTY = new Uint8Array(0);

export function randomKey(): Uint8Array {
  return new Uint8Array(randomBytes(KEY_BYTES));
}

function assertKey(key: Uint8Array): void {
  if (key.length !== KEY_BYTES) {
    throw new DecryptError("bad_key", `expected ${KEY_BYTES} bytes, got ${key.length}`);
  }
}

/** The IV of chunk `index`: four zero bytes then the index, big-endian. */
export function counterIv(index: number): Uint8Array {
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError("chunk index");
  const iv = new Uint8Array(IV_BYTES);
  new DataView(iv.buffer).setBigUint64(4, BigInt(index));
  return iv;
}

/** Associated data for a chunk: the caller's AAD, the index, and the last flag. */
export function chunkAad(aad: Uint8Array, index: number, last: boolean): Uint8Array {
  const out = new Uint8Array(aad.length + 9);
  out.set(aad, 0);
  new DataView(out.buffer).setBigUint64(aad.length, BigInt(index));
  out[aad.length + 8] = last ? 1 : 0;
  return out;
}

function sealWith(
  version: EnvelopeVersion,
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  assertKey(key);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const body = cipher.update(plaintext);
  const tail = cipher.final();
  const tag = cipher.getAuthTag();
  const out = new Uint8Array(HEADER_BYTES + body.length + tail.length);
  out[0] = version;
  out.set(iv, 1);
  out.set(tag, 1 + IV_BYTES);
  out.set(body, HEADER_BYTES);
  out.set(tail, HEADER_BYTES + body.length);
  return out;
}

function openWith(
  expectedVersion: EnvelopeVersion,
  key: Uint8Array,
  envelope: Uint8Array,
  aad: Uint8Array,
  expectedIv?: Uint8Array,
): Uint8Array {
  assertKey(key);
  if (envelope.length < HEADER_BYTES) {
    throw new DecryptError("malformed", `envelope is ${envelope.length} bytes`);
  }
  const version = envelope[0];
  if (version !== ENVELOPE_SINGLE && version !== ENVELOPE_CHUNK) {
    throw new DecryptError("unsupported_version", `version ${version}`);
  }
  if (version !== expectedVersion) {
    throw new DecryptError("tampered", `expected version ${expectedVersion}, got ${version}`);
  }
  const iv = envelope.subarray(1, 1 + IV_BYTES);
  if (expectedIv && !equalBytes(iv, expectedIv)) throw new DecryptError("tampered", "chunk iv");
  const tag = envelope.subarray(1 + IV_BYTES, HEADER_BYTES);
  const ciphertext = envelope.subarray(HEADER_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  try {
    const body = decipher.update(ciphertext);
    const tail = decipher.final();
    if (tail.length === 0) return new Uint8Array(body);
    const out = new Uint8Array(body.length + tail.length);
    out.set(body, 0);
    out.set(tail, body.length);
    return out;
  } catch {
    throw new DecryptError("tampered");
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** One envelope with a fresh random IV. Use a key for one object only. */
export function seal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array = EMPTY): Uint8Array {
  return sealWith(ENVELOPE_SINGLE, key, new Uint8Array(randomBytes(IV_BYTES)), plaintext, aad);
}

export function open(key: Uint8Array, envelope: Uint8Array, aad: Uint8Array = EMPTY): Uint8Array {
  return openWith(ENVELOPE_SINGLE, key, envelope, aad);
}

export function sealChunk(
  key: Uint8Array,
  index: number,
  last: boolean,
  plaintext: Uint8Array,
  aad: Uint8Array = EMPTY,
): Uint8Array {
  return sealWith(ENVELOPE_CHUNK, key, counterIv(index), plaintext, chunkAad(aad, index, last));
}

export function openChunk(
  key: Uint8Array,
  index: number,
  last: boolean,
  envelope: Uint8Array,
  aad: Uint8Array = EMPTY,
): Uint8Array {
  return openWith(ENVELOPE_CHUNK, key, envelope, chunkAad(aad, index, last), counterIv(index));
}

/**
 * Splits a large plaintext into chunks of `chunkSize` and seals each under
 * the same key with a counter IV. An empty plaintext yields one empty chunk so
 * the last-chunk flag always exists.
 */
export function sealChunked(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array = EMPTY,
  chunkSize: number = CHUNK_BYTES,
): Uint8Array[] {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) throw new RangeError("chunk size");
  const count = Math.max(1, Math.ceil(plaintext.length / chunkSize));
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const slice = plaintext.subarray(
      i * chunkSize,
      Math.min((i + 1) * chunkSize, plaintext.length),
    );
    chunks.push(sealChunk(key, i, i === count - 1, slice, aad));
  }
  return chunks;
}

/** Opens chunks produced by sealChunked; any missing, extra, moved or altered chunk fails. */
export function openChunked(
  key: Uint8Array,
  chunks: Uint8Array[],
  aad: Uint8Array = EMPTY,
): Uint8Array {
  if (chunks.length === 0) throw new DecryptError("malformed", "no chunks");
  const parts: Uint8Array[] = [];
  let total = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) throw new DecryptError("malformed", `chunk ${i} missing`);
    const part = openChunk(key, i, i === chunks.length - 1, chunk, aad);
    parts.push(part);
    total += part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
