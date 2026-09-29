// Signals (ADR 0014; docs/spec/signals.md, "Where answers live"): the Signal
// definitions and their Question versions, and one answer per Thread and
// Signal. Kept in their own file, re-exported by schema.ts, so the schema's
// other slices merge without touching these.
//
// Answers are numbers in the clear, like routes: a probability, a picked
// option name, a Score position. A picked span (an amount, an address) comes
// from the Thread's text and is kept sealed with the Thread's Facts instead.

import type {
  LowTrust,
  SignalGate,
  SignalKind,
  SignalOptionsFrom,
  SignalOwner,
  SignalOwnerKind,
  SignalQuestion,
  SignalScope,
} from "@monday/shared";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { threads, workspaces } from "./schema.ts";

/** One Signal per Workspace: its owner, its question as sent, its Question version and scope. */
export const signalDefs = pgTable(
  "signal_defs",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    ownerKind: text("owner_kind").$type<SignalOwnerKind>().notNull(),
    ownerId: text("owner_id"),
    /** Every owner asking this question (the same hash is one Signal). */
    owners: jsonb("owners").$type<SignalOwner[]>().notNull().default([]),
    kind: text("kind").$type<SignalKind>().notNull(),
    question: jsonb("question").$type<SignalQuestion>().notNull(),
    hash: text("hash").notNull(),
    version: integer("version").notNull().default(1),
    scope: jsonb("scope").$type<SignalScope>().notNull(),
    gate: text("gate").$type<SignalGate>(),
    optionsFrom: text("options_from").$type<SignalOptionsFrom>(),
    consumers: jsonb("consumers").$type<string[]>().notNull().default([]),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    /** When the Signal lost its last consumer; its answers go after signals.keep_inactive_days. */
    retiredAt: timestamp("retired_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

/**
 * A Signal backfill (slice 31): one walk per Workspace over
 * signals.backfill.scope, newest first, with the cursor shape of
 * routing_backlogs so a restart resumes. `signal_ids` are the Signals it
 * fills; a second change while it runs widens them.
 */
export const signalBackfills = pgTable("signal_backfills", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull(),
  status: text("status")
    .$type<"confirm" | "running" | "waiting" | "paused" | "done" | "cancelled">()
    .notNull(),
  reason: text("reason").$type<"budget" | "no_judge" | "level">(),
  signalIds: jsonb("signal_ids").$type<string[]>().notNull().default([]),
  scope: text("scope").notNull(),
  since: timestamp("since", { withTimezone: true, mode: "date" }),
  limit: integer("limit"),
  topAt: timestamp("top_at", { withTimezone: true, mode: "date" }),
  topId: text("top_id"),
  cursorAt: timestamp("cursor_at", { withTimezone: true, mode: "date" }),
  cursorId: text("cursor_id"),
  walked: integer("walked").notNull().default(0),
  done: integer("done").notNull().default(0),
  total: integer("total").notNull().default(0),
  asked: integer("asked").notNull().default(0),
  calls: integer("calls").notNull().default(0),
  estimateThreads: integer("estimate_threads"),
  estimateMicros: integer("estimate_micros"),
  lastError: text("last_error"),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
});

/** Every wording a Signal had, so an old answer can be explained. */
export const signalVersions = pgTable(
  "signal_versions",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    signalId: text("signal_id").notNull(),
    version: integer("version").notNull(),
    hash: text("hash").notNull(),
    question: jsonb("question").$type<SignalQuestion>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.signalId, t.version] })],
);

/**
 * The newest answer per Thread and Signal, stamped with the Question version
 * and the Thread version (message count, newest Message id) it was asked for,
 * so the same Thread version is never asked the same Question version twice.
 */
export const signalAnswers = pgTable(
  "signal_answers",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    signalId: text("signal_id").notNull(),
    /** 0 for an answer migrated from before Question versions (section_judgments). */
    version: integer("version").notNull(),
    model: text("model").notNull(),
    judgedAt: timestamp("judged_at", { withTimezone: true, mode: "date" }).notNull(),
    messageCount: integer("message_count").notNull().default(0),
    latestMessageId: text("latest_message_id").notNull().default(""),
    noul: real("noul"),
    choice: text("choice"),
    score: real("score"),
    probabilities: jsonb("probabilities").$type<Record<string, number>>(),
    confidence: real("confidence"),
    lowTrust: text("low_trust").$type<LowTrust>(),
    /** For a migrated section_judgments answer: the statement it was asked with, until its Signal claims it. */
    legacyKey: text("legacy_key"),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.signalId] }),
    index("signal_answers_signal_idx").on(t.workspaceId, t.signalId, t.version),
    index("signal_answers_judged_idx").on(t.workspaceId, t.judgedAt),
  ],
);
