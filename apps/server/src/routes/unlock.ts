// Key provisioning (research 5, "Provisioning the key to the server"; ADR 0006
// for the channel). All three need an authenticated Device or the Sidecar
// principal; the middleware in app.ts already guarantees that.
//   POST /unlock {rootKey: base64}   put K_root in memory; 403 when it does not open this database
//   POST /lock                       drop it
//   GET  /recovery                   the root key as a downloadable text file; 423 when locked

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import { KEY_BYTES } from "../crypto/aead.ts";
import { decodeKey, encodeKey, type Keys, WrongRootKeyError } from "../crypto/keys.ts";
import { parseBody } from "./validate.ts";

const unlockBody = z.object({ rootKey: z.string().min(1) });

export const RECOVERY_FILE_NAME = "monday-recovery-key.txt";

/** The recovery file: one line saying what it is, then the key. The client stores it. */
export function recoveryFile(rootKey: Uint8Array): string {
  return [
    "monday root key. Anyone with this line can read your mail; keep it private and keep a copy somewhere safe, it is the only way back in if every device is lost.",
    encodeKey(rootKey),
    "",
  ].join("\n");
}

export function unlockRoutes(keys: Keys): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/unlock", async (c) => {
    const body = await parseBody(c, unlockBody);
    if (!body.ok) return body.response;
    const rootKey = decodeKey(body.data.rootKey);
    if (!rootKey || rootKey.length !== KEY_BYTES) {
      return c.json({ error: "invalid_root_key", expectedBytes: KEY_BYTES }, 400);
    }
    try {
      await keys.unlock(rootKey);
    } catch (error) {
      if (error instanceof WrongRootKeyError) return c.json({ error: "wrong_root_key" }, 403);
      throw error;
    }
    return c.json({ unlocked: true });
  });

  app.post("/lock", (c) => {
    keys.lock();
    return c.json({ unlocked: false });
  });

  app.get("/recovery", (c) => {
    if (!keys.isUnlocked()) return c.json({ error: "locked" }, 423);
    return c.body(recoveryFile(keys.rootKey()), 200, {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="${RECOVERY_FILE_NAME}"`,
      "cache-control": "no-store",
    });
  });

  return app;
}
