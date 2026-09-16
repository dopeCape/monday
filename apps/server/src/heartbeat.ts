// Heartbeats: the row each running Server refreshes so the others can tell it
// is alive (ADR 0005). Freshness decides failover: when no Cloud heartbeat is
// fresh, the Sidecar claims every job class.

import type { DeploymentMode } from "@monday/shared";
import { eq, gt } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { servers } from "./db/schema.ts";

export const HEARTBEAT_INTERVAL_MS = 30_000;
/** A heartbeat older than this is stale: three missed beats. */
export const HEARTBEAT_STALE_MS = HEARTBEAT_INTERVAL_MS * 3;

export const CLOUD_MODES: readonly DeploymentMode[] = ["container", "vercel", "netlify"];

export interface ServerRow {
  id: string;
  mode: DeploymentMode;
  lastSeen: Date;
}

export async function writeHeartbeat(
  db: Db,
  id: string,
  mode: DeploymentMode,
  at: Date = new Date(),
): Promise<void> {
  await db
    .insert(servers)
    .values({ id, mode, lastSeen: at })
    .onConflictDoUpdate({ target: servers.id, set: { mode, lastSeen: at } });
}

export async function removeHeartbeat(db: Db, id: string): Promise<void> {
  await db.delete(servers).where(eq(servers.id, id));
}

export async function freshServers(
  db: Db,
  now: Date = new Date(),
  staleMs: number = HEARTBEAT_STALE_MS,
): Promise<ServerRow[]> {
  const since = new Date(now.getTime() - staleMs);
  const rows = await db.select().from(servers).where(gt(servers.lastSeen, since));
  return rows.map((r) => ({ id: r.id, mode: r.mode as DeploymentMode, lastSeen: r.lastSeen }));
}

/** True when some Server other than `selfId` in a Cloud mode has a fresh heartbeat. */
export async function cloudIsAlive(
  db: Db,
  selfId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const fresh = await freshServers(db, now);
  return fresh.some((s) => s.id !== selfId && CLOUD_MODES.includes(s.mode));
}
