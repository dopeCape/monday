CREATE TABLE "mcp_catalog" (
	"id" text PRIMARY KEY NOT NULL,
	"haystack" text NOT NULL,
	"entry" jsonb NOT NULL,
	"remote" boolean NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_catalog_sync" (
	"id" integer PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"cursor" text,
	"complete_at" timestamp with time zone,
	"pass_started_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"count" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE INDEX "mcp_catalog_remote_idx" ON "mcp_catalog" USING btree ("remote");