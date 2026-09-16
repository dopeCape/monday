CREATE TABLE "drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"thread_id" text,
	"kind" text DEFAULT 'new' NOT NULL,
	"in_reply_to_message_id" text,
	"to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bcc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject_enc" "bytea" NOT NULL,
	"subject_key" "bytea" NOT NULL,
	"body_enc" "bytea" NOT NULL,
	"body_key" "bytea" NOT NULL,
	"blob_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider_draft_id" text,
	"mirrored_hash" text,
	"status" text DEFAULT 'open' NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_sends" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"draft_id" text NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"cancelled_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"job_id" text,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voice_profiles" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"excerpts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"built_at" timestamp with time zone,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "content_id" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "inline" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "media_type" text DEFAULT 'application/octet-stream' NOT NULL;--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "complete" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_in_reply_to_message_id_messages_id_fk" FOREIGN KEY ("in_reply_to_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_sends" ADD CONSTRAINT "scheduled_sends_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_sends" ADD CONSTRAINT "scheduled_sends_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_profiles" ADD CONSTRAINT "voice_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drafts_workspace_idx" ON "drafts" USING btree ("workspace_id","deleted","updated_at");--> statement-breakpoint
CREATE INDEX "drafts_thread_idx" ON "drafts" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "scheduled_sends_workspace_idx" ON "scheduled_sends" USING btree ("workspace_id","status","run_at");--> statement-breakpoint
CREATE INDEX "scheduled_sends_draft_idx" ON "scheduled_sends" USING btree ("draft_id");