-- Calendar (slice 18, research 6): the calendars a Workspace's Provider lists
-- or its Local calendar, Events with their title, description and location
-- under the envelope and everything else in the clear, and Invites parsed
-- from the text/calendar parts of Messages. Chained after 0011_workflows.
CREATE TABLE "calendars" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source" text NOT NULL,
	"provider_id" text NOT NULL,
	"name" text NOT NULL,
	"primary" boolean DEFAULT false NOT NULL,
	"writable" boolean DEFAULT true NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"color" text,
	"sync_token" text,
	"subscription" jsonb,
	"last_sync" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendars_workspace_provider" UNIQUE("workspace_id","provider_id")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"calendar_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"uid" text,
	"content_enc" "bytea" NOT NULL,
	"content_key" "bytea" NOT NULL,
	"title_search" text DEFAULT '' NOT NULL,
	"start" timestamp with time zone NOT NULL,
	"end" timestamp with time zone NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"time_zone" text,
	"organizer" jsonb,
	"attendees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"link" text,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"recurrence" text,
	"recurring_event_id" text,
	"response" text,
	"created_by_agent" boolean DEFAULT false NOT NULL,
	"etag" text,
	"sequence" integer DEFAULT 0 NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"stale" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_calendar_provider" UNIQUE("calendar_id","provider_id")
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"message_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"event_id" text,
	"method" text NOT NULL,
	"uid" text NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"title_enc" "bytea" NOT NULL,
	"title_key" "bytea" NOT NULL,
	"ical_enc" "bytea" NOT NULL,
	"ical_key" "bytea" NOT NULL,
	"start" timestamp with time zone NOT NULL,
	"end" timestamp with time zone NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"organizer" jsonb,
	"attendees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"response" text DEFAULT 'needs-action' NOT NULL,
	"by_mail" boolean DEFAULT false NOT NULL,
	"sender_mismatch" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"writes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_message" UNIQUE("message_id")
);
--> statement-breakpoint
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_window_idx" ON "events" USING btree ("workspace_id","start","end");--> statement-breakpoint
CREATE INDEX "events_uid_idx" ON "events" USING btree ("workspace_id","uid");--> statement-breakpoint
CREATE INDEX "invites_thread_idx" ON "invites" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "invites_uid_idx" ON "invites" USING btree ("workspace_id","uid");