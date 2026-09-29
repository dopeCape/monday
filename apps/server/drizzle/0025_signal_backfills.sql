CREATE TABLE "signal_backfills" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"signal_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scope" text NOT NULL,
	"since" timestamp with time zone,
	"limit" integer,
	"top_at" timestamp with time zone,
	"top_id" text,
	"cursor_at" timestamp with time zone,
	"cursor_id" text,
	"walked" integer DEFAULT 0 NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"asked" integer DEFAULT 0 NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"estimate_threads" integer,
	"estimate_micros" integer,
	"last_error" text,
	"started_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "signal_backfills" ADD CONSTRAINT "signal_backfills_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;