-- Agent host (ADR 0002, slice 14): Sessions and their transcript events, and
-- the Activity log grown from a summary line into the tool ledger: tier,
-- input, preview, decision, status, result and what Undo replays, keyed by
-- (session, call id) so a re-executed LangGraph node never runs a call twice.
-- The LangGraph checkpoint tables are not here: the checkpointer creates them
-- under the `langgraph` schema at boot (entry/checkpointer.ts, PostgresSaver.setup).
-- Chained after 0009_briefs.
CREATE TABLE "session_events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"event" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"runtime" jsonb NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"developer_mode" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "call_id" text;--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "tier" text;--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "input" jsonb;--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "preview" jsonb;--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "decision" text;--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "status" text DEFAULT 'done' NOT NULL;--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "result" jsonb;--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "undo" jsonb;--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "undone_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_events_session_idx" ON "session_events" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "sessions_workspace_idx" ON "sessions" USING btree ("workspace_id","last_activity");--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_session_call" UNIQUE("session_id","call_id");