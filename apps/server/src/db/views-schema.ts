// Views (docs/spec/views.md, "Data and sync"): `views` holds each View's
// place in the nav and its current version; `view_versions` one immutable
// document per version; `view_drafts` what the Agent proposed and tested
// before the user clicked Pin view or Apply. Documents, drafts and the
// user's placements are sealed under the Workspace key (they name people and
// domains). Kept in their own file, re-exported by schema.ts, so the
// schema's other slices merge without touching these.

import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { threads, workspaces } from "./schema.ts";

/** Raw bytes, as schema.ts declares them. */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
  toDriver: (value) => value,
  fromDriver: (value) => new Uint8Array(value),
});

export const views = pgTable(
  "views",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The version in effect; an Undo points it back at an older one. */
    version: integer("version").notNull(),
    pinned: boolean("pinned").notNull().default(true),
    position: integer("position").notNull().default(0),
    /** The user's placements and the corrections they made on the View, sealed JSON; null when none. */
    extrasEnc: bytea("extras_enc"),
    extrasKey: bytea("extras_key"),
    /** Pinned without a test: the "check its first placements" bar shows until dismissed. */
    checkBar: boolean("check_bar").notNull().default(false),
    /** Deleted with Undo: kept until signals.keep_inactive_days have passed. */
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("views_workspace_idx").on(t.workspaceId, t.position)],
);

export const viewVersions = pgTable(
  "view_versions",
  {
    /** `<viewId>@<version>`: one id per row, so a key rotation re-wraps each version on its own. */
    id: text("id").primaryKey(),
    viewId: text("view_id")
      .notNull()
      .references(() => views.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    contentEnc: bytea("content_enc").notNull(),
    contentKey: bytea("content_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("view_versions_view_version_idx").on(t.viewId, t.version)],
);

/**
 * A View the Agent proposed and tried (create_view, update_view): the
 * document, the test's Threads and placements, the user's corrections. It
 * becomes a View only on Pin view (or Apply for an edit); Not now marks it
 * discarded.
 */
export const viewDrafts = pgTable(
  "view_drafts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The pinned View an edit changes; null for a new View. */
    viewId: text("view_id"),
    status: text("status").$type<"open" | "pinned" | "applied" | "discarded">().notNull(),
    contentEnc: bytea("content_enc").notNull(),
    contentKey: bytea("content_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("view_drafts_workspace_idx").on(t.workspaceId, t.status)],
);

/**
 * A pinned View reading its own scope (docs/spec/views.md, "Reading a pinned
 * View"): one walk per View, newest first, asking only the View's questions a
 * Thread lacks, resumable from its cursor, under the monthly background
 * budget. Headers only: counts and where the walk is, nothing from the mail.
 */
export const viewBackfills = pgTable(
  "view_backfills",
  {
    viewId: text("view_id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    status: text("status")
      .$type<"running" | "waiting" | "paused" | "done" | "cancelled">()
      .notNull(),
    reason: text("reason").$type<"budget" | "no_judge" | "level" | "locked">(),
    /** The View version the walk reads for. */
    version: integer("version").notNull(),
    /** The stored Signal ids it asks (only the questions a new version changed). */
    signalIds: jsonb("signal_ids").$type<string[]>().notNull().default([]),
    cursorAt: timestamp("cursor_at", { withTimezone: true, mode: "date" }),
    cursorId: text("cursor_id"),
    done: integer("done").notNull().default(0),
    total: integer("total").notNull().default(0),
    asked: integer("asked").notNull().default(0),
    calls: integer("calls").notNull().default(0),
    lastError: text("last_error"),
    /**
     * A search scope (docs/spec/views.md, "Scope by a search"): the key of the query
     * and facts its members were found for (memberKey), whether every Thread its
     * other facts admit was searched, how many matched, and whether questions were
     * held back while the members were found (no judge, budget, level), so the walk
     * reads the members again once it may ask.
     */
    membersKey: text("members_key"),
    membersDone: boolean("members_done").notNull().default(false),
    found: integer("found").notNull().default(0),
    asksHeld: boolean("asks_held").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [index("view_backfills_workspace_idx").on(t.workspaceId)],
);

/**
 * A search scope's members (docs/spec/views.md, "Scope by a search"): the
 * Threads a pinned View's full-search `query` matched, found on the Server by
 * reading the mail in memory and kept as ids only (nothing from the mail), at
 * the Thread's version when it was matched, so a new Message tests it again.
 * The Changes feed carries the same ids to the Device's Cache.
 */
export const viewMembers = pgTable(
  "view_members",
  {
    viewId: text("view_id")
      .notNull()
      .references(() => views.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The Thread's message count when it matched. */
    messageCount: integer("message_count").notNull(),
    matchedAt: timestamp("matched_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.viewId, t.threadId] }),
    index("view_members_thread_idx").on(t.threadId),
  ],
);
