// Heartbeats: the row each running Server refreshes so the others can tell it
// is alive (ADR 0005). Freshness decides failover: when no Cloud heartbeat is
// fresh, the Sidecar claims every job class. A serverless Cloud has no loop;
// its cron tick and every request that runs Jobs write the heartbeat instead,
// so "alive" there means "its kicker ran within the stale window".
//
// The interval and the stale window are Settings (server.heartbeat_seconds,
// server.stale_after_seconds); the constants here are their shipped defaults.

import {
  CLOUD_MODES,
  type DeploymentMode,
  settingsSchema,
  type Topology,
  topologyOf,
} from "@monday/shared";
import { eq, gt } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { servers } from "./db/schema.ts";
import { readGlobalSettings } from "./settings/read.ts";

export const HEARTBEAT_INTERVAL_MS = settingsSchema["server.heartbeat_seconds"].default * 1000;
/** A heartbeat older than this is stale: three missed beats by default. */
export const HEARTBEAT_STALE_MS = settingsSchema["server.stale_after_seconds"].default * 1000;

export { CLOUD_MODES };

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
  staleMs: number = HEARTBEAT_STALE_MS,
): Promise<boolean> {
  const fresh = await freshServers(db, now, staleMs);
  return fresh.some((s) => s.id !== selfId && CLOUD_MODES.includes(s.mode));
}

export interface TopologyView {
  topology: Topology;
  /** The modes alive right now, this Server's own first. */
  modes: DeploymentMode[];
  servers: ServerRow[];
}

/**
 * What is alive around this database, counting this Server as present even
 * before its first heartbeat lands (it is answering the request).
 */
export async function currentTopology(
  db: Db,
  self: { id: string; mode: DeploymentMode },
  now: Date = new Date(),
  staleMs: number = HEARTBEAT_STALE_MS,
): Promise<TopologyView> {
  const fresh = await freshServers(db, now, staleMs);
  const others = fresh.filter((s) => s.id !== self.id);
  const own = fresh.find((s) => s.id === self.id) ?? {
    id: self.id,
    mode: self.mode,
    lastSeen: now,
  };
  const rows = [own, ...others];
  const modes = [...new Set(rows.map((s) => s.mode))];
  return { topology: topologyOf(modes), modes, servers: rows };
}

export interface HeartbeatTiming {
  intervalMs: number;
  staleMs: number;
}

/** The heartbeat Settings as milliseconds, read fresh each call. */
export async function readHeartbeatTiming(db: Db): Promise<HeartbeatTiming> {
  const s = await readGlobalSettings(db, [
    "server.heartbeat_seconds",
    "server.stale_after_seconds",
  ]);
  return {
    intervalMs: s["server.heartbeat_seconds"] * 1000,
    staleMs: s["server.stale_after_seconds"] * 1000,
  };
}
