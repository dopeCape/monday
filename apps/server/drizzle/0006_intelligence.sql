-- Intelligence (ADR 0007, slice 11): the Hosted runtime's shared provider keys
-- under the envelope, the Meter with one row per model call, and Briefs with
-- bullets and actions each in their own envelope. Meter only: no budgets, no
-- stops. Prices live in Settings, not here.
CREATE TABLE "briefs" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"bullets_enc" "bytea" NOT NULL,
	"bullets_key" "bytea" NOT NULL,
	"actions_enc" "bytea" NOT NULL,
	"actions_key" "bytea" NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"stale" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meter" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"task" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_keys" (
	"provider" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"key" "bytea" NOT NULL,
	"data_enc" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter" ADD CONSTRAINT "meter_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_keys" ADD CONSTRAINT "provider_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meter_workspace_at_idx" ON "meter" USING btree ("workspace_id","created_at");