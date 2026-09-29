// Recommended actions (docs/spec/actions.md; slices 34 and 35): a Thread's
// Recommended actions as the Server worked them out for one Thread version,
// and what the user did with the chips shown. Kept in their own file,
// re-exported by schema.ts, so the schema's other slices merge without
// touching these.
//
// The actions carry arguments drawn from the Thread's text (a recipient, a
// time, a subject), so they are sealed like a Brief; which kinds a Thread
// holds is in the clear for the feed.

import type { RecommendedActionKind } from "@monday/shared";
import { customType, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
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
