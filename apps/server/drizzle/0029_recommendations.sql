CREATE TABLE "thread_recommendations" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"latest_message_id" text DEFAULT '' NOT NULL,
	"kinds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content_enc" "bytea" NOT NULL,
	"content_key" "bytea" NOT NULL,
	"computed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "thread_recommendations" ADD CONSTRAINT "thread_recommendations_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_recommendations" ADD CONSTRAINT "thread_recommendations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thread_recommendations_workspace_idx" ON "thread_recommendations" USING btree ("workspace_id","computed_at");