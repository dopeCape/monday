CREATE TABLE "recommendation_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"action" text NOT NULL,
	"fit" real DEFAULT 0 NOT NULL,
	"args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sender" text,
	"message_count" integer DEFAULT 0 NOT NULL,
	"shown_at" timestamp with time zone NOT NULL,
	"outcome" text,
	"outcome_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "recommendation_events" ADD CONSTRAINT "recommendation_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_events" ADD CONSTRAINT "recommendation_events_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recommendation_events_thread_idx" ON "recommendation_events" USING btree ("thread_id","action");--> statement-breakpoint
CREATE INDEX "recommendation_events_action_idx" ON "recommendation_events" USING btree ("workspace_id","action","outcome_at");--> statement-breakpoint
CREATE INDEX "recommendation_events_sender_idx" ON "recommendation_events" USING btree ("workspace_id","sender");