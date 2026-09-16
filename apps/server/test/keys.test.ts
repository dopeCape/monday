import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { DecryptError, open, randomKey, seal } from "../src/crypto/aead.ts";
import {
  createKeys,
  decodeKey,
  encodeKey,
  type Keys,
  LockedError,
  UnknownWorkspaceKeyError,
  WrongRootKeyError,
} from "../src/crypto/keys.ts";
import { accounts, workspaceKeys, workspaces } from "../src/db/schema.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const text = (s: string) => new TextEncoder().encode(s);

describe("key hierarchy", () => {
  let db: TestDatabase;
  let keys: Keys;
  const root = randomKey();
  const workspaceId = "ws-1";

  beforeAll(async () => {
    db = await testDatabase();
    keys = createKeys(db.handle.db);
    await db.handle.db.insert(accounts).values({
      id: "acct-1",
      provider: "jmap",
      address: "me@example.test",
      capabilities: {
        push: true,
        labels: true,
        snooze: false,
        mute: false,
        calendar: false,
        meetingLink: null,
      },
    });
    await db.handle.db.insert(workspaces).values({ id: workspaceId, accountId: "acct-1" });
  }, 60_000);

  afterAll(async () => {
    await db.drop();
  });

  test("starts locked and refuses key work until unlocked", async () => {
    expect(keys.isUnlocked()).toBe(false);
    expect(() => keys.rootKey()).toThrow(LockedError);
    await expect(keys.createWorkspaceKey(workspaceId)).rejects.toBeInstanceOf(LockedError);
    await expect(keys.workspaceKey(workspaceId)).rejects.toBeInstanceOf(LockedError);
    await expect(keys.unlock(new Uint8Array(16))).rejects.toThrow(RangeError);
  });

  test("unlock, create a workspace key, wrap and unwrap a data key", async () => {
    await keys.unlock(root);
    expect(keys.isUnlocked()).toBe(true);
    expect(keys.rootKey()).toEqual(root);
    await expect(keys.workspaceKey(workspaceId)).rejects.toBeInstanceOf(UnknownWorkspaceKeyError);

    await keys.createWorkspaceKey(workspaceId);
    const kws = await keys.workspaceKey(workspaceId);
    expect(kws.length).toBe(32);

    // Stored wrapped under K_root with the Workspace id as associated data.
    const row = await db.handle.db.query.workspaceKeys.findFirst({
      where: eq(workspaceKeys.workspaceId, workspaceId),
    });
    expect(row?.version).toBe(1);
    expect(row?.wrappedKey.length).toBe(29 + 32);
    expect(
      open(root, row?.wrappedKey ?? new Uint8Array(), text("monday:workspace-key:ws-1")),
    ).toEqual(kws);
    expect(() =>
      open(root, row?.wrappedKey ?? new Uint8Array(), text("monday:workspace-key:ws-2")),
    ).toThrow(DecryptError);

    const dek = randomKey();
    const wrapped = await keys.wrapKey(workspaceId, dek);
    expect(wrapped).not.toEqual(dek);
    expect(await keys.unwrapKey(workspaceId, wrapped)).toEqual(dek);
    await expect(keys.unwrapKey("ws-other", wrapped)).rejects.toBeInstanceOf(
      UnknownWorkspaceKeyError,
    );
  });

  test("lock clears memory; a fresh holder with the wrong root key is refused", async () => {
    keys.lock();
    expect(keys.isUnlocked()).toBe(false);
    await expect(keys.workspaceKey(workspaceId)).rejects.toBeInstanceOf(LockedError);

    const other = createKeys(db.handle.db);
    await expect(other.unlock(randomKey())).rejects.toBeInstanceOf(WrongRootKeyError);
    expect(other.isUnlocked()).toBe(false);
    await other.unlock(root);
    expect(other.isUnlocked()).toBe(true);
    await keys.unlock(root);
  });

  test("rotating K_ws re-wraps data keys and leaves ciphertext untouched", async () => {
    const dek = randomKey();
    const ciphertext = seal(dek, text("body bytes"), text("monday:content:body"));
    let wrapped = await keys.wrapKey(workspaceId, dek);
    const before = await keys.workspaceKey(workspaceId);

    const result = await keys.rotateWorkspaceKey(workspaceId, async (_tx, rewrap) => {
      wrapped = rewrap(wrapped);
      return 1;
    });
    expect(result).toEqual({ version: 2, rewrapped: 1 });

    const after = await keys.workspaceKey(workspaceId);
    expect(after).not.toEqual(before);
    expect(await keys.unwrapKey(workspaceId, wrapped)).toEqual(dek);
    expect(open(dek, ciphertext, text("monday:content:body"))).toEqual(text("body bytes"));

    // The stored row moved to version 2 and no longer opens under the old K_ws.
    const row = await db.handle.db.query.workspaceKeys.findFirst({
      where: eq(workspaceKeys.workspaceId, workspaceId),
    });
    expect(row?.version).toBe(2);
    expect(row?.rotatedAt).toBeInstanceOf(Date);
    expect(() => open(before, wrapped, text("monday:data-key:ws-1"))).toThrow(DecryptError);

    // A second holder unlocked with the same root sees the rotated key.
    const other = createKeys(db.handle.db);
    await other.unlock(root);
    expect(await other.unwrapKey(workspaceId, wrapped)).toEqual(dek);
  });

  test("a failing rewrap rolls the rotation back", async () => {
    const before = await keys.workspaceKey(workspaceId);
    await expect(
      keys.rotateWorkspaceKey(workspaceId, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const row = await db.handle.db.query.workspaceKeys.findFirst({
      where: eq(workspaceKeys.workspaceId, workspaceId),
    });
    expect(row?.version).toBe(2);
    const fresh = createKeys(db.handle.db);
    await fresh.unlock(root);
    expect(await fresh.workspaceKey(workspaceId)).toEqual(before);
  });

  test("base64 helpers round trip and reject junk", () => {
    const key = randomKey();
    expect(decodeKey(encodeKey(key))).toEqual(key);
    expect(decodeKey(` ${encodeKey(key)}\n`)).toEqual(key);
    expect(decodeKey("not base64!")).toBeNull();
    expect(decodeKey("")).toBeNull();
  });
});
