-- A View whose scope is a full search (docs/spec/views.md, "Scope by a search"):
-- its members as ids only, and the walk that finds them beside the one that reads them.
CREATE TABLE "view_members" (
	"view_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"message_count" integer NOT NULL,
	"matched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "view_members_view_id_thread_id_pk" PRIMARY KEY("view_id","thread_id")
);
--> statement-breakpoint
ALTER TABLE "view_backfills" ADD COLUMN "members_key" text;--> statement-breakpoint
ALTER TABLE "view_backfills" ADD COLUMN "members_done" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "view_backfills" ADD COLUMN "found" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "view_backfills" ADD COLUMN "asks_held" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "view_members" ADD CONSTRAINT "view_members_view_id_views_id_fk" FOREIGN KEY ("view_id") REFERENCES "public"."views"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_members" ADD CONSTRAINT "view_members_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_members" ADD CONSTRAINT "view_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "view_members_thread_idx" ON "view_members" USING btree ("thread_id");