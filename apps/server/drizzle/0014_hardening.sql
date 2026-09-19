-- Hardening (the security follow-ups on the record): the sealed rows for
-- Workflow integration secrets, the envelope columns for Session transcripts
-- and the Voice profile (old rows keep their plaintext columns and are sealed
-- by the boot sweep once the Server is unlocked), and the indexes the request
-- paths over messages, threads and workflow_runs need.

CREATE TABLE "integration_secrets" (
	"integration" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"key" "bytea" NOT NULL,
	"data_enc" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_events" ALTER COLUMN "event" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "session_events" ADD COLUMN "event_enc" "bytea";--> statement-breakpoint
ALTER TABLE "session_events" ADD COLUMN "event_key" "bytea";--> statement-breakpoint
ALTER TABLE "voice_profiles" ADD COLUMN "profile_enc" "bytea";--> statement-breakpoint
ALTER TABLE "voice_profiles" ADD COLUMN "profile_key" "bytea";--> statement-breakpoint
ALTER TABLE "integration_secrets" ADD CONSTRAINT "integration_secrets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_workspace_date_idx" ON "messages" USING btree ("workspace_id","date","id");--> statement-breakpoint
CREATE INDEX "threads_subgroup_idx" ON "threads" USING btree ("workspace_id","subgroup_id");--> statement-breakpoint
CREATE INDEX "threads_snoozed_idx" ON "threads" USING btree ("workspace_id","snoozed_until");--> statement-breakpoint
CREATE INDEX "workflow_runs_workspace_started_idx" ON "workflow_runs" USING btree ("workspace_id","started_at");