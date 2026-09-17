-- Routing (ADR 0004, slice 12): Groups with a plaintext sentence and Predicate
-- and the model prompt under the envelope, Examples from corrections, where
-- routing put each Thread with its Confidence, and the Needs a decision queue.
-- Threads learn a headers-only bulk flag for the Section rules. Numbered 0008
-- after 0006_intelligence: 0007 was left free for a slice merging in parallel.
CREATE TABLE "examples" (
	"thread_id" text NOT NULL,
	"group_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"positive" boolean NOT NULL,
	"from" jsonb,
	"subject" text DEFAULT '' NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "examples_thread_id_group_id_pk" PRIMARY KEY("thread_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"parent_id" text,
	"name" text NOT NULL,
	"sentence" text DEFAULT '' NOT NULL,
	"predicate" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prompt_enc" "bytea",
	"prompt_key" "bytea",
	"threshold" real,
	"brief_policy" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routing_decisions" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_routes" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"group_id" text,
	"subgroup_id" text,
	"confidence" real,
	"subgroup_confidence" real,
	"by" text NOT NULL,
	"scores" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"routed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "bulk" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "examples" ADD CONSTRAINT "examples_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "examples" ADD CONSTRAINT "examples_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "examples" ADD CONSTRAINT "examples_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_parent_id_groups_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_routes" ADD CONSTRAINT "thread_routes_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_routes" ADD CONSTRAINT "thread_routes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "examples_group_idx" ON "examples" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "groups_workspace_idx" ON "groups" USING btree ("workspace_id","parent_id");--> statement-breakpoint
CREATE INDEX "routing_decisions_workspace_idx" ON "routing_decisions" USING btree ("workspace_id","at");--> statement-breakpoint
CREATE INDEX "thread_routes_group_idx" ON "thread_routes" USING btree ("workspace_id","group_id");