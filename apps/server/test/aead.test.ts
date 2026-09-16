import { describe, expect, test } from "bun:test";
import {
  CHUNK_BYTES,
  counterIv,
  DecryptError,
  ENVELOPE_CHUNK,
  ENVELOPE_SINGLE,
  HEADER_BYTES,
  IV_BYTES,
  open,
  openChunked,
  randomKey,
  seal,
  sealChunk,
  sealChunked,
  TAG_BYTES,
} from "../src/crypto/aead.ts";

const text = (s: string) => new TextEncoder().encode(s);
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);

function flipByte(bytes: Uint8Array, at: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  copy[at] = (copy[at] ?? 0) ^ 0x01;
  return copy;
}

describe("aead envelope", () => {
  test("round trips and has the documented layout", () => {
    const key = randomKey();
    const plaintext = text("hello, envelope");
    const envelope = seal(key, plaintext);
    expect(envelope.length).toBe(HEADER_BYTES + plaintext.length);
    expect(HEADER_BYTES).toBe(1 + IV_BYTES + TAG_BYTES);
    expect(envelope[0]).toBe(ENVELOPE_SINGLE);
    expect(utf8(open(key, envelope))).toBe("hello, envelope");
    // Two seals of the same plaintext differ (random IV).
    expect(seal(key, plaintext)).not.toEqual(envelope);
  });

  test("empty plaintext still authenticates", () => {
    const key = randomKey();
    const envelope = seal(key, new Uint8Array(0));
    expect(envelope.length).toBe(HEADER_BYTES);
    expect(open(key, envelope).length).toBe(0);
    expect(() => open(randomKey(), envelope)).toThrow(DecryptError);
  });

  test("flipping any byte of a short message is detected", () => {
    const key = randomKey();
    const envelope = seal(key, text("tamper me"), text("aad"));
    for (let at = 0; at < envelope.length; at++) {
      let caught: unknown;
      try {
        open(key, flipByte(envelope, at), text("aad"));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DecryptError);
      expect((caught as DecryptError).reason).toMatch(/tampered|unsupported_version/);
    }
  });

  test("the wrong key, wrong aad, truncation and a short envelope are all DecryptError", () => {
    const key = randomKey();
    const envelope = seal(key, text("abc"), text("kind:body"));
    expect(() => open(randomKey(), envelope, text("kind:body"))).toThrow(DecryptError);
    expect(() => open(key, envelope, text("kind:brief"))).toThrow(DecryptError);
    expect(() => open(key, envelope.subarray(0, envelope.length - 1), text("kind:body"))).toThrow(
      DecryptError,
    );
    expect(() => open(key, new Uint8Array(5))).toThrow(DecryptError);
    expect(() => open(new Uint8Array(16), envelope)).toThrow(DecryptError);
  });

  test("counter ivs are the chunk index big-endian after four zero bytes", () => {
    expect(Array.from(counterIv(0))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(counterIv(258))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]);
    expect(() => counterIv(-1)).toThrow(RangeError);
  });
});

describe("chunked envelopes", () => {
  const payload = (() => {
    const size = Math.floor(3.5 * 1024 * 1024);
    const out = new Uint8Array(size);
    let x = 12345;
    for (let i = 0; i < size; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      out[i] = x & 0xff;
    }
    return out;
  })();

  test("a 3.5 MiB payload becomes four chunks and round trips", () => {
    const key = randomKey();
    const chunks = sealChunked(key, payload);
    expect(chunks.length).toBe(4);
    expect(chunks[0]?.length).toBe(HEADER_BYTES + CHUNK_BYTES);
    expect(chunks[3]?.length).toBe(HEADER_BYTES + payload.length - 3 * CHUNK_BYTES);
    expect(chunks.every((c) => c[0] === ENVELOPE_CHUNK)).toBe(true);
    expect(chunks[2]?.subarray(1, 1 + IV_BYTES)).toEqual(counterIv(2));
    const back = openChunked(key, chunks);
    expect(back.length).toBe(payload.length);
    expect(Buffer.from(back).equals(Buffer.from(payload))).toBe(true);
  });

  test("tampering one chunk, dropping, reordering or appending a chunk fails", () => {
    const key = randomKey();
    const chunks = sealChunked(key, payload);
    const tampered = chunks.map((c, i) => (i === 1 ? flipByte(c, HEADER_BYTES + 777) : c));
    expect(() => openChunked(key, tampered)).toThrow(DecryptError);
    expect(() => openChunked(key, chunks.slice(0, 3))).toThrow(DecryptError);
    expect(() => openChunked(key, chunks.slice(1))).toThrow(DecryptError);
    const swapped = [chunks[1], chunks[0], chunks[2], chunks[3]] as Uint8Array[];
    expect(() => openChunked(key, swapped)).toThrow(DecryptError);
    const extra = [...chunks, sealChunk(key, 4, true, text("more"))];
    expect(() => openChunked(key, extra)).toThrow(DecryptError);
    // A single envelope presented as a chunk, or the reverse, is refused.
    expect(() => openChunked(key, [seal(key, text("x"))])).toThrow(DecryptError);
    expect(() => open(key, sealChunk(key, 0, true, text("x")))).toThrow(DecryptError);
  });

  test("small chunk sizes and empty payloads", () => {
    const key = randomKey();
    const small = sealChunked(key, text("abcdefghij"), text("k"), 3);
    expect(small.length).toBe(4);
    expect(utf8(openChunked(key, small, text("k")))).toBe("abcdefghij");
    const empty = sealChunked(key, new Uint8Array(0));
    expect(empty.length).toBe(1);
    expect(openChunked(key, empty).length).toBe(0);
    expect(() => openChunked(key, [])).toThrow(DecryptError);
  });
});
