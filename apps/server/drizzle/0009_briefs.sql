-- Briefs (slice 13): the Thread version a Brief was computed for, so a
-- Message arriving after it marks the Brief stale. Chained after 0008_routing.
ALTER TABLE "briefs" ADD COLUMN "message_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "briefs" ADD COLUMN "latest_message_id" text DEFAULT '' NOT NULL;