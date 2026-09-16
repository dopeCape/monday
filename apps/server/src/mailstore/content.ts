// The seam every body-derived write goes through (docs/spec/slices.md, slice 4).
// storeContent takes plaintext and returns a ContentRef: a fresh data key
// wrapped under the Workspace key plus the ciphertext envelopes. readContent
// takes the ref back and returns the plaintext. Nothing outside src/crypto
// touches a cipher; nothing outside this file calls the AEAD.
//
// Per kind: "attachment" is chunked (1 MiB, counter IV under the one data
// key); every other kind is one envelope. The kind is bound as associated
// data so a ciphertext read back under the wrong kind fails the tag check.

import type { ContentKind, ContentRef } from "@monday/shared";
import { CHUNK_BYTES, open, openChunked, randomKey, seal, sealChunked } from "../crypto/aead.ts";
import type { Keys } from "../crypto/keys.ts";

export const CONTENT_KINDS: readonly ContentKind[] = [
  "body",
  "snippet",
  "subject",
  "attachment",
  "attachment-text",
  "brief",
  "tag-rationale",
  "summary",
  "embedding",
  "credential",
];

export function isContentKind(value: unknown): value is ContentKind {
  return typeof value === "string" && (CONTENT_KINDS as readonly string[]).includes(value);
}

export interface ContentStore {
  /** Encrypts plaintext for a Workspace. Throws LockedError when no root key is in memory. */
  storeContent(
    workspaceId: string,
    kind: ContentKind,
    plaintext: Uint8Array | string,
  ): Promise<ContentRef>;
  /** Decrypts a ref. Throws LockedError when locked, DecryptError on tampering. */
  readContent(ref: ContentRef): Promise<Uint8Array>;
  /** readContent for text kinds. */
  readText(ref: ContentRef): Promise<string>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const kindAad = (kind: ContentKind) => encoder.encode(`monday:content:${kind}`);

export function createContentStore(keys: Keys, chunkSize: number = CHUNK_BYTES): ContentStore {
  const store: ContentStore = {
    async storeContent(workspaceId, kind, plaintext) {
      const bytes = typeof plaintext === "string" ? encoder.encode(plaintext) : plaintext;
      const dek = randomKey();
      const key = await keys.wrapKey(workspaceId, dek);
      const aad = kindAad(kind);
      const chunks =
        kind === "attachment" ? sealChunked(dek, bytes, aad, chunkSize) : [seal(dek, bytes, aad)];
      return { workspaceId, kind, key, chunks, size: bytes.length };
    },

    async readContent(ref) {
      const dek = await keys.unwrapKey(ref.workspaceId, ref.key);
      const aad = kindAad(ref.kind);
      if (ref.kind === "attachment") return openChunked(dek, ref.chunks, aad);
      const [only] = ref.chunks;
      if (!only || ref.chunks.length !== 1) {
        throw new RangeError(`${ref.kind} content must have exactly one envelope`);
      }
      return open(dek, only, aad);
    },

    async readText(ref) {
      return decoder.decode(await store.readContent(ref));
    },
  };
  return store;
}
