-- Briefs (slice 13): the Thread version a Brief was computed for, so a
-- Message arriving after it marks the Brief stale. Chained after
-- 0006_intelligence; 0007 and 0008 belong to parallel slices and the chain
-- is re-linked at merge.
ALTER TABLE "briefs" ADD COLUMN "message_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "briefs" ADD COLUMN "latest_message_id" text DEFAULT '' NOT NULL;