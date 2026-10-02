-- A Message only in the Provider's Drafts never becomes a Thread Message (ADR 0010):
-- the engine keeps its header facts here for the import pass, and a Draft keeps the
-- id of the Provider Message that holds its mirror, so a copy coming back is matched.
-- Messages synced before this are moved out at boot (SyncEngine.repairDraftMessages).
CREATE TABLE "provider_drafts" (
	"workspace_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"provider_thread_id" text,
	"thread_id" text,
	"in_reply_to_message_id" text,
	"rfc_message_id" text,
	"references" text[] DEFAULT '{}'::text[] NOT NULL,
	"to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mailbox_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"draft_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_drafts_workspace_id_provider_id_pk" PRIMARY KEY("workspace_id","provider_id")
);
--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "provider_message_id" text;--> statement-breakpoint
ALTER TABLE "provider_drafts" ADD CONSTRAINT "provider_drafts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_drafts" ADD CONSTRAINT "provider_drafts_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_drafts" ADD CONSTRAINT "provider_drafts_in_reply_to_message_id_messages_id_fk" FOREIGN KEY ("in_reply_to_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_drafts" ADD CONSTRAINT "provider_drafts_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_drafts_draft_idx" ON "provider_drafts" USING btree ("workspace_id","draft_id");