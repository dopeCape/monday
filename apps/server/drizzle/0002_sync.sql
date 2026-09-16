CREATE TABLE "account_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"key" "bytea" NOT NULL,
	"data_enc" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_credentials_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
CREATE TABLE "sync_messages" (
	"workspace_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"message_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"thread_key" text NOT NULL,
	"rfc_message_id" text,
	"references" text[] DEFAULT '{}'::text[] NOT NULL,
	"subject_key" text DEFAULT '' NOT NULL,
	"participants" text[] DEFAULT '{}'::text[] NOT NULL,
	"mailbox_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"seen" boolean DEFAULT false NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"body_state" text DEFAULT 'pending' NOT NULL,
	"stale" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_messages_workspace_id_provider_id_pk" PRIMARY KEY("workspace_id","provider_id")
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"tier" text,
	"mailbox_states" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pending" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_full_sync" timestamp with time zone,
	"last_reconcile" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "labels" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "account_credentials" ADD CONSTRAINT "account_credentials_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_credentials" ADD CONSTRAINT "account_credentials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_messages" ADD CONSTRAINT "sync_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_messages" ADD CONSTRAINT "sync_messages_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_messages" ADD CONSTRAINT "sync_messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_messages_message_idx" ON "sync_messages" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "sync_messages_thread_idx" ON "sync_messages" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "sync_messages_rfc_idx" ON "sync_messages" USING btree ("workspace_id","rfc_message_id");--> statement-breakpoint
CREATE INDEX "sync_messages_references_idx" ON "sync_messages" USING gin ("references");--> statement-breakpoint
CREATE INDEX "sync_messages_subject_idx" ON "sync_messages" USING btree ("workspace_id","subject_key","date");--> statement-breakpoint
CREATE INDEX "sync_messages_body_idx" ON "sync_messages" USING btree ("workspace_id","body_state","date");