ALTER TABLE "calendars" ADD COLUMN "access" text;--> statement-breakpoint
ALTER TABLE "calendars" ADD COLUMN "shared_by" jsonb;