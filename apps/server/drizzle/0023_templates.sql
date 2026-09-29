CREATE TABLE "templates" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"share_group_id" text,
	"kind" text NOT NULL,
	"built_in" text,
	"created_by" text DEFAULT 'user' NOT NULL,
	"content_enc" "bytea" NOT NULL,
	"content_key" "bytea" NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "templates_workspace_idx" ON "templates" USING btree ("workspace_id","deleted");--> statement-breakpoint
CREATE INDEX "templates_share_group_idx" ON "templates" USING btree ("share_group_id");