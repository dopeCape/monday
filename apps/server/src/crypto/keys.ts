// The key hierarchy (research 5, "Key hierarchy"), top down:
//
//   K_root   32 random bytes generated on the user's device. Never stored in
//            Postgres. Lives in this process's memory between unlock() and
//            lock(); the client provisions it (ADR 0006 channel) or the host
//            hands it over at boot (entry/bun.ts).
//   K_ws     one random key per Workspace, wrapped under K_root with
//            AES-256-GCM and stored in workspace_keys. Rotating it re-wraps
//            data keys, never ciphertext.
//   DEK      one random key per object, wrapped under K_ws and stored next to
//            the ciphertext by the Mailstore.
//
// Every wrap is the same envelope as the data (aead.ts), with the Workspace id
// bound as associated data so a wrapped key cannot be moved between
// Workspaces.

import { eq } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { workspaceKeys } from "../db/schema.ts";
import { DecryptError, KEY_BYTES, open, randomKey, seal } from "./aead.ts";

/** A content read or write reached the envelope while no root key is in memory. */
export class LockedError extends Error {
  readonly status = 423;
  constructor() {
    super("the server is locked: no root key in memory");
    this.name = "LockedError";
  }
}

/** The supplied root key does not open this database's Workspace keys. */
export class WrongRootKeyError extends Error {
  constructor() {
    super("the root key does not match this database");
    this.name = "WrongRootKeyError";
  }
}

export class UnknownWorkspaceKeyError extends Error {
  constructor(readonly workspaceId: string) {
    super(`no Workspace key for ${workspaceId}`);
    this.name = "UnknownWorkspaceKeyError";
  }
}

export interface Keys {
  /**
   * Puts K_root in memory. When a Workspace key already exists it is unwrapped
   * first, so a wrong key is refused instead of silently producing garbage.
   */
  unlock(rootKey: Uint8Array): Promise<void>;
  lock(): void;
  isUnlocked(): boolean;
  /** The root key, for the recovery file. Throws LockedError. */
  rootKey(): Uint8Array;
  /** Generates and stores a wrapped K_ws for a new Workspace. Throws LockedError. */
  createWorkspaceKey(workspaceId: string, tx?: Tx): Promise<void>;
  /** The Workspace key in the clear, cached while unlocked. Throws LockedError. */
  workspaceKey(workspaceId: string): Promise<Uint8Array>;
  wrapKey(workspaceId: string, dek: Uint8Array): Promise<Uint8Array>;
  unwrapKey(workspaceId: string, wrapped: Uint8Array): Promise<Uint8Array>;
  /**
   * Replaces K_ws. Inside one transaction the caller receives `rewrap`, which
   * takes a data key wrapped under the old K_ws and returns it wrapped under
   * the new one; the caller applies it to every wrapped key it stores and
   * returns how many it touched. Ciphertext is not read.
   */
  rotateWorkspaceKey(
    workspaceId: string,
    rewrapAll: (tx: Tx, rewrap: (wrapped: Uint8Array) => Uint8Array) => Promise<number>,
  ): Promise<{ version: number; rewrapped: number }>;
}

const encoder = new TextEncoder();
const workspaceAad = (id: string) => encoder.encode(`monday:workspace-key:${id}`);
const dataKeyAad = (id: string) => encoder.encode(`monday:data-key:${id}`);

export function createKeys(db: Db): Keys {
  let root: Uint8Array | null = null;
  const cache = new Map<string, Uint8Array>();

  const requireRoot = (): Uint8Array => {
    if (!root) throw new LockedError();
    return root;
  };

  const unwrapWorkspace = (rootKey: Uint8Array, workspaceId: string, wrapped: Uint8Array) =>
    open(rootKey, wrapped, workspaceAad(workspaceId));

  const keys: Keys = {
    async unlock(rootKey) {
      if (rootKey.length !== KEY_BYTES) {
        throw new RangeError(`root key must be ${KEY_BYTES} bytes, got ${rootKey.length}`);
      }
      const probe = await db.select().from(workspaceKeys).limit(1);
      const row = probe[0];
      if (row) {
        try {
          unwrapWorkspace(rootKey, row.workspaceId, row.wrappedKey);
        } catch (error) {
          if (error instanceof DecryptError) throw new WrongRootKeyError();
          throw error;
        }
      }
      cache.clear();
      root = new Uint8Array(rootKey);
    },

    lock() {
      root = null;
      cache.clear();
    },

    isUnlocked: () => root !== null,

    rootKey: () => new Uint8Array(requireRoot()),

    async createWorkspaceKey(workspaceId, tx) {
      const rootKey = requireRoot();
      const key = randomKey();
      await (tx ?? db)
        .insert(workspaceKeys)
        .values({ workspaceId, wrappedKey: seal(rootKey, key, workspaceAad(workspaceId)) });
      cache.set(workspaceId, key);
    },

    async workspaceKey(workspaceId) {
      const rootKey = requireRoot();
      const cached = cache.get(workspaceId);
      if (cached) return cached;
      const row = await db.query.workspaceKeys.findFirst({
        where: eq(workspaceKeys.workspaceId, workspaceId),
      });
      if (!row) throw new UnknownWorkspaceKeyError(workspaceId);
      const key = unwrapWorkspace(rootKey, workspaceId, row.wrappedKey);
      cache.set(workspaceId, key);
      return key;
    },

    async wrapKey(workspaceId, dek) {
      return seal(await keys.workspaceKey(workspaceId), dek, dataKeyAad(workspaceId));
    },

    async unwrapKey(workspaceId, wrapped) {
      return open(await keys.workspaceKey(workspaceId), wrapped, dataKeyAad(workspaceId));
    },

    async rotateWorkspaceKey(workspaceId, rewrapAll) {
      const rootKey = requireRoot();
      const oldKey = await keys.workspaceKey(workspaceId);
      const newKey = randomKey();
      const aad = dataKeyAad(workspaceId);
      const rewrap = (wrapped: Uint8Array) => seal(newKey, open(oldKey, wrapped, aad), aad);
      const result = await db.transaction(async (tx) => {
        // Lock the key row first so two rotations cannot interleave.
        const previous = await currentVersion(tx, workspaceId);
        const rewrapped = await rewrapAll(tx, rewrap);
        const updated = await tx
          .update(workspaceKeys)
          .set({
            wrappedKey: seal(rootKey, newKey, workspaceAad(workspaceId)),
            version: previous + 1,
            rotatedAt: new Date(),
          })
          .where(eq(workspaceKeys.workspaceId, workspaceId))
          .returning({ version: workspaceKeys.version });
        const version = updated[0]?.version;
        if (version === undefined) throw new UnknownWorkspaceKeyError(workspaceId);
        return { version, rewrapped };
      });
      cache.set(workspaceId, newKey);
      return result;
    },
  };

  return keys;
}

async function currentVersion(tx: Tx, workspaceId: string): Promise<number> {
  const rows = await tx
    .select({ version: workspaceKeys.version })
    .from(workspaceKeys)
    .where(eq(workspaceKeys.workspaceId, workspaceId))
    .for("update");
  const version = rows[0]?.version;
  if (version === undefined) throw new UnknownWorkspaceKeyError(workspaceId);
  return version;
}

/** Base64 helpers for the wire and the recovery file; runtime-neutral. */
export function encodeKey(key: Uint8Array): string {
  let binary = "";
  for (const b of key) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function decodeKey(text: string): Uint8Array | null {
  const trimmed = text.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null;
  try {
    const binary = atob(trimmed);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
