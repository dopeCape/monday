-- Search (ADR 0011, research 5): the headers-only index on the Server. The
-- generated tsvector carries the subject prefix at weight A and every
-- participant name and address at weight B; pg_trgm on the participants text
-- lets a substring of an address match. Bodies stay under the envelope and are
-- never indexed here. Numbered 0005 to leave 0004 for a slice in flight.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce(subject_search, '')), 'A') || setweight(to_tsvector('simple', jsonb_path_query_array(participants, '$[*].name')::text || ' ' || jsonb_path_query_array(participants, '$[*].email')::text), 'B')) STORED;--> statement-breakpoint
CREATE INDEX "threads_search_idx" ON "threads" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "threads_participants_trgm_idx" ON "threads" USING gin ((jsonb_path_query_array(participants, '$[*].name')::text || ' ' || jsonb_path_query_array(participants, '$[*].email')::text) gin_trgm_ops);
