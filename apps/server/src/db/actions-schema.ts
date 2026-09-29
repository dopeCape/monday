// Recommended actions (docs/spec/actions.md; slices 34 and 35): a Thread's
// Recommended actions as the Server worked them out for one Thread version,
// and what the user did with the chips shown. Kept in their own file,
// re-exported by schema.ts, so the schema's other slices merge without
// touching these.
//
// The actions carry arguments drawn from the Thread's text (a recipient, a
// time, a subject), so they are sealed like a Brief; which kinds a Thread
// holds is in the clear for the feed.

import type { OutcomeArgs, RecommendationOutcome, RecommendedActionKind } from "@monday/shared";
import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { threads, workspaces } from "./schema.ts";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
  toDriver: (value) => value,
  fromDriver: (value) => new Uint8Array(value),
});

/** One row per Thread: its Recommended actions for the Thread version they were worked out for. */
export const threadRecommendations = pgTable(
  "thread_recommendations",
  {
    threadId: text("thread_id")
      .primaryKey()
      .references(() => threads.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    messageCount: integer("message_count").notNull().default(0),
    latestMessageId: text("latest_message_id").notNull().default(""),
    /** Which actions it holds, in rank order: the feed's headers. */
    kinds: jsonb("kinds").$type<RecommendedActionKind[]>().notNull().default([]),
    /** JSON ThreadRecommendations["actions"] and the sender's domain, under one envelope. */
    contentEnc: bytea("content_enc").notNull(),
    contentKey: bytea("content_key").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [index("thread_recommendations_workspace_idx").on(t.workspaceId, t.computedAt)],
);

/**
 * Every chip shown, and what became of it (docs/spec/actions.md, "Learning
 * from what the user does"): used, dismissed ("Not this"), ignored (the
 * Thread was dealt with some other way) or other_used (the same action with
 * other arguments). The arguments kept are header-level only (a recipient's
 * address, a time, a Workflow id), like the sender's address beside them.
 */
export const recommendationEvents = pgTable(
  "recommendation_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    action: text("action").$type<RecommendedActionKind>().notNull(),
    fit: real("fit").notNull().default(0),
    args: jsonb("args").$type<OutcomeArgs>().notNull().default({}),
    /** The newest sender's address, for sender history ("forwarded 9 threads from billing@"). */
    sender: text("sender"),
    messageCount: integer("message_count").notNull().default(0),
    shownAt: timestamp("shown_at", { withTimezone: true, mode: "date" }).notNull(),
    outcome: text("outcome").$type<RecommendationOutcome>(),
    outcomeAt: timestamp("outcome_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    index("recommendation_events_thread_idx").on(t.threadId, t.action),
    index("recommendation_events_action_idx").on(t.workspaceId, t.action, t.outcomeAt),
    index("recommendation_events_sender_idx").on(t.workspaceId, t.sender),
  ],
);
