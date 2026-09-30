-- A View's scope by sender (docs/spec/views.md): the test pool and the View's
-- Threads are the newest in scope across the whole mailbox, found through these.
CREATE INDEX "messages_from_email_idx" ON "messages" USING btree ("workspace_id",lower("from"->>'email'));--> statement-breakpoint
CREATE INDEX "messages_from_domain_idx" ON "messages" USING btree ("workspace_id",split_part(lower("from"->>'email'), '@', 2));