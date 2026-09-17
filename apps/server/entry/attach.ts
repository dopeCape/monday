// The attached Cloud database (ADR 0005 "both" mode): a 0600 file in the
// Sidecar's data directory holding the connection string the next launch
// opens instead of the embedded Postgres. Same trust level as the embedded
// cluster's own password file next to it. DATABASE_URL in the environment
// still wins, so a container is never affected by this file.

import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AttachStore } from "../src/upgrade/index.ts";

export const ATTACH_FILE = "cloud-database-url";

export function attachFile(dataDir: string): string {
  return join(dataDir, ATTACH_FILE);
}

export async function readAttachedUrl(dataDir: string): Promise<string | null> {
  const file = attachFile(dataDir);
  if (!existsSync(file)) return null;
  const text = (await readFile(file, "utf8")).trim();
  return text || null;
}

export function fileAttachStore(dataDir: string): AttachStore {
  const file = attachFile(dataDir);
  return {
    read: () => readAttachedUrl(dataDir),
    async write(url) {
      await mkdir(dataDir, { recursive: true });
      await writeFile(file, `${url}\n`, { mode: 0o600 });
      await chmod(file, 0o600).catch(() => {});
    },
    async clear() {
      await rm(file, { force: true });
    },
  };
}
