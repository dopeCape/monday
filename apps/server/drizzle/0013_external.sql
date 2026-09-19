-- External MCP (docs/spec/external-mcp.md, slice 19): credentials of the
-- external MCP server (keys and OAuth tokens, hashed), the dynamically
-- registered OAuth clients, authorization codes with their PKCE challenge,
-- refresh tokens, and the credential name on the Activity log as actor.

CREATE TABLE "external_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"scope" text NOT NULL,
	"workspace_ids" jsonb,
	"secret_hash" text NOT NULL,
	"prefix" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"client_id" text,
	CONSTRAINT "external_credentials_secret_hash_unique" UNIQUE("secret_hash")
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"pairing_code" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"scope" text NOT NULL,
	"workspace_ids" jsonb,
	"state" text,
	"code_challenge" text NOT NULL,
	"resource" text,
	"code_hash" text,
	"approved_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"credential_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "actor_name" text;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_credential_id_external_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."external_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_credentials_client_idx" ON "external_credentials" USING btree ("client_id");