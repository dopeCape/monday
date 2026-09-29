// Boards (docs/spec/boards.md, "Data and sync"): `boards` holds each Board's
// place in the nav and its current version; `board_versions` one immutable
// document per version; `board_drafts` what the Agent proposed and tested
// before the user clicked Pin board or Apply. Documents, drafts and the
// user's placements are sealed under the Workspace key (they name people and
// domains). Kept in their own file, re-exported by schema.ts, so the
// schema's other slices merge without touching these.

import {
  boolean,
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { workspaces } from "./schema.ts";

/** Raw bytes, as schema.ts declares them. */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
  toDriver: (value) => value,
  fromDriver: (value) => new Uint8Array(value),
});

export const boards = pgTable(
  "boards",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The version in effect; an Undo points it back at an older one. */
    version: integer("version").notNull(),
    pinned: boolean("pinned").notNull().default(true),
    position: integer("position").notNull().default(0),
    /** The user's placements and the corrections they made on the Board, sealed JSON; null when none. */
    extrasEnc: bytea("extras_enc"),
    extrasKey: bytea("extras_key"),
    /** Pinned without a test: the "check its first placements" bar shows until dismissed. */
    checkBar: boolean("check_bar").notNull().default(false),
    /** Deleted with Undo: kept until signals.keep_inactive_days have passed. */
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("boards_workspace_idx").on(t.workspaceId, t.position)],
);

export const boardVersions = pgTable(
  "board_versions",
  {
    /** `<boardId>@<version>`: one id per row, so a key rotation re-wraps each version on its own. */
    id: text("id").primaryKey(),
    boardId: text("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    contentEnc: bytea("content_enc").notNull(),
    contentKey: bytea("content_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("board_versions_board_version_idx").on(t.boardId, t.version)],
);

/**
 * A Board the Agent proposed and tried (create_board, update_board): the
 * document, the test's Threads and placements, the user's corrections. It
 * becomes a Board only on Pin board (or Apply for an edit); Not now marks it
 * discarded.
 */
export const boardDrafts = pgTable(
  "board_drafts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The pinned Board an edit changes; null for a new Board. */
    boardId: text("board_id"),
    status: text("status").$type<"open" | "pinned" | "applied" | "discarded">().notNull(),
    contentEnc: bytea("content_enc").notNull(),
    contentKey: bytea("content_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("board_drafts_workspace_idx").on(t.workspaceId, t.status)],
);
