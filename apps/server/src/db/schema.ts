// Postgres schema, the source of truth (docs/spec/architecture.md, "Data model").
// This slice carries only the tables the Server core needs: heartbeats, jobs,
// devices, settings and pairing. Mail tables arrive with the Mailstore.

import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

/** One row per running Server, refreshed every 30 s (ADR 0005). */
export const servers = pgTable("servers", {
  id: text("id").primaryKey(),
  mode: text("mode").notNull(),
  lastSeen: timestamp("last_seen", { withTimezone: true, mode: "date" }).notNull(),
});

export type JobStatus = "queued" | "running" | "done" | "failed";

/** The only coordination between Servers: leased, idempotent, time-budgeted rows. */
export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    class: text("class").notNull(),
    /** Need tags such as needs-public-url or needs-process. Empty means anyone. */
    needs: text("needs").array().notNull().default([]),
    payload: jsonb("payload").notNull().default({}),
    runAt: timestamp("run_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    leaseUntil: timestamp("lease_until", { withTimezone: true, mode: "date" }),
    leaseOwner: text("lease_owner"),
    attempts: integer("attempts").notNull().default(0),
    status: text("status").$type<JobStatus>().notNull().default("queued"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("jobs_claim_idx").on(t.status, t.runAt),
    index("jobs_lease_idx").on(t.status, t.leaseUntil),
  ],
);

/** One installed client holding a per-Device token (ADR 0006). */
export const devices = pgTable("devices", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** SHA-256 of the bearer token, hex. The token itself is never stored. */
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  lastSeen: timestamp("last_seen", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export type SettingScope = "global" | "device";

/** A Setting saved by the UI or the Agent; global or per Device (ADR 0004). */
export const settings = pgTable(
  "settings",
  {
    scope: text("scope").$type<SettingScope>().notNull(),
    /** Null for global scope. */
    deviceId: text("device_id"),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [unique("settings_scope_device_key").on(t.scope, t.deviceId, t.key).nullsNotDistinct()],
);

/** A short code shown on the new Device and confirmed from an existing one. */
export const pairingCodes = pgTable("pairing_codes", {
  code: text("code").primaryKey(),
  /** SHA-256 of the secret the pending Device holds to claim its token. */
  secretHash: text("secret_hash").notNull(),
  deviceName: text("device_name").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "date" }),
  used: boolean("used").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
