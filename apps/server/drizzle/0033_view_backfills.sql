-- A pinned View reads its own scope (docs/spec/views.md, "Reading a pinned View"):
-- one resumable walk per View, headers only.
CREATE TABLE "view_backfills" (
	"view_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"version" integer NOT NULL,
	"signal_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cursor_at" timestamp with time zone,
	"cursor_id" text,
	"done" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"asked" integer DEFAULT 0 NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"started_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "view_backfills" ADD CONSTRAINT "view_backfills_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "view_backfills_workspace_idx" ON "view_backfills" USING btree ("workspace_id");