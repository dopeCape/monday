-- Judgments (ADR 0012, slice 25): the arrival request's answers per Thread,
-- probabilities only, stamped with the Thread version they were asked for.

CREATE TABLE "thread_judgments" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"needs_reply" real NOT NULL,
	"waiting_on_others" real NOT NULL,
	"newsletter" real NOT NULL,
	"automated" real NOT NULL,
	"brief_worth" real NOT NULL,
	"urgency" real NOT NULL,
	"chips" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"model" text NOT NULL,
	"judged_at" timestamp with time zone NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"latest_message_id" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "thread_judgments" ADD CONSTRAINT "thread_judgments_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_judgments" ADD CONSTRAINT "thread_judgments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thread_judgments_workspace_idx" ON "thread_judgments" USING btree ("workspace_id","judged_at");