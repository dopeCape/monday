CREATE TABLE "thread_meetings" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"message_id" text NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"reading_enc" "bytea" NOT NULL,
	"reading_key" "bytea" NOT NULL,
	"judged_by" text NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"chip" jsonb,
	"judged_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "thread_meetings" ADD CONSTRAINT "thread_meetings_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_meetings" ADD CONSTRAINT "thread_meetings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thread_meetings_workspace_idx" ON "thread_meetings" USING btree ("workspace_id","judged_at");