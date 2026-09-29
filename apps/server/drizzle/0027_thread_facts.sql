CREATE TABLE "thread_facts" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"latest_message_id" text DEFAULT '' NOT NULL,
	"facts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deadline_at" timestamp with time zone,
	"content_enc" "bytea",
	"content_key" "bytea",
	"computed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "thread_facts" ADD CONSTRAINT "thread_facts_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_facts" ADD CONSTRAINT "thread_facts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thread_facts_deadline_idx" ON "thread_facts" USING btree ("workspace_id","deadline_at");