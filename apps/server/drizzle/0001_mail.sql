CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"address" text NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"credentials_ref" text,
	"sync_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"capabilities" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"size" integer NOT NULL,
	"media_type" text NOT NULL,
	"blob_id" text,
	"text_enc" "bytea",
	"text_key" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blob_chunks" (
	"blob_id" text NOT NULL,
	"index" integer NOT NULL,
	"data" "bytea" NOT NULL,
	CONSTRAINT "blob_chunks_blob_id_index_pk" PRIMARY KEY("blob_id","index")
);
--> statement-breakpoint
CREATE TABLE "blobs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"size" integer NOT NULL,
	"chunk_size" integer NOT NULL,
	"chunk_count" integer NOT NULL,
	"key" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "labels_workspace_provider" UNIQUE("workspace_id","provider_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"from" jsonb NOT NULL,
	"to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body_enc" "bytea" NOT NULL,
	"body_key" "bytea" NOT NULL,
	"snippet_enc" "bytea" NOT NULL,
	"snippet_key" "bytea" NOT NULL,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_workspace_provider" UNIQUE("workspace_id","provider_message_id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "tags_workspace_name" UNIQUE("workspace_id","name")
);
--> statement-breakpoint
CREATE TABLE "thread_labels" (
	"thread_id" text NOT NULL,
	"label_id" text NOT NULL,
	CONSTRAINT "thread_labels_thread_id_label_id_pk" PRIMARY KEY("thread_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "thread_tags" (
	"thread_id" text NOT NULL,
	"tag_id" text NOT NULL,
	CONSTRAINT "thread_tags_thread_id_tag_id_pk" PRIMARY KEY("thread_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider_thread_id" text NOT NULL,
	"subject_enc" "bytea" NOT NULL,
	"subject_key" "bytea" NOT NULL,
	"subject_search" text DEFAULT '' NOT NULL,
	"participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_activity" timestamp with time zone NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"unread" boolean DEFAULT false NOT NULL,
	"starred" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"snoozed_until" timestamp with time zone,
	"section" text,
	"group_id" text,
	"subgroup_id" text,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "threads_workspace_provider" UNIQUE("workspace_id","provider_thread_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_keys" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"wrapped_key" "bytea" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blob_chunks" ADD CONSTRAINT "blob_chunks_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_labels" ADD CONSTRAINT "thread_labels_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_labels" ADD CONSTRAINT "thread_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_tags" ADD CONSTRAINT "thread_tags_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_tags" ADD CONSTRAINT "thread_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_keys" ADD CONSTRAINT "workspace_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_message_idx" ON "attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("thread_id","date");--> statement-breakpoint
CREATE INDEX "threads_list_idx" ON "threads" USING btree ("workspace_id","archived","last_activity","id");--> statement-breakpoint
CREATE INDEX "threads_section_idx" ON "threads" USING btree ("workspace_id","section");--> statement-breakpoint
CREATE INDEX "threads_group_idx" ON "threads" USING btree ("workspace_id","group_id");