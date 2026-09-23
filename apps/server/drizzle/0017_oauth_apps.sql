CREATE TABLE "oauth_apps" (
	"provider" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"secret_enc" "bytea",
	"tenant" text,
	"account_type" text,
	"project_id" text,
	"pubsub_topic" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
