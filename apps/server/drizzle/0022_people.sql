CREATE TABLE "people" (
	"workspace_id" text NOT NULL,
	"address" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"name_at" timestamp with time zone,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"pending_sent" integer DEFAULT 0 NOT NULL,
	"received_count" integer DEFAULT 0 NOT NULL,
	"last_at" timestamp with time zone,
	"terms" "tsvector" GENERATED ALWAYS AS (array_to_tsvector(array_remove(regexp_split_to_array(lower(name), '[^[:alnum:]]+') || regexp_split_to_array(address, '[^[:alnum:]]+') || ARRAY[address, split_part(address, '@', 1), split_part(address, '@', 2)], ''))) STORED,
	CONSTRAINT "people_workspace_id_address_pk" PRIMARY KEY("workspace_id","address")
);
--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "people_terms_idx" ON "people" USING gin ("terms");--> statement-breakpoint
-- Backfill, once, from every Message the mailbox already holds; from here on
-- the Mailstore keeps the table in step as Messages are written and the
-- drafts module as sends are delivered (src/people/index.ts has the same rules).
WITH "owners" AS (
	SELECT w."id" AS "workspace_id", lower(trim(a."address")) AS "owner"
	FROM "workspaces" w JOIN "accounts" a ON a."id" = w."account_id"
), "m" AS (
	SELECT msg."id", msg."workspace_id", msg."date", msg."to", msg."cc", o."owner",
		lower(trim(coalesce(msg."from" ->> 'email', ''))) AS "sender",
		trim(coalesce(msg."from" ->> 'name', '')) AS "sender_name"
	FROM "messages" msg JOIN "owners" o ON o."workspace_id" = msg."workspace_id"
), "recipients" AS (
	SELECT DISTINCT ON (m."id", lower(trim(coalesce(p ->> 'email', ''))))
		m."workspace_id", lower(trim(coalesce(p ->> 'email', ''))) AS "address",
		trim(coalesce(p ->> 'name', '')) AS "name", m."date", m."sender" = m."owner" AS "mine", m."sender"
	FROM "m" CROSS JOIN LATERAL jsonb_array_elements(
		(CASE WHEN jsonb_typeof(m."to") = 'array' THEN m."to" ELSE '[]'::jsonb END) ||
		(CASE WHEN jsonb_typeof(m."cc") = 'array' THEN m."cc" ELSE '[]'::jsonb END)) AS p
	ORDER BY m."id", lower(trim(coalesce(p ->> 'email', ''))), trim(coalesce(p ->> 'name', '')) = ''
), "entries" AS (
	SELECT "workspace_id", "sender" AS "address", "sender_name" AS "name", "date", 0 AS "sent", 1 AS "received"
	FROM "m" WHERE "sender" <> "owner"
	UNION ALL
	SELECT "workspace_id", "address", "name", "date", CASE WHEN "mine" THEN 1 ELSE 0 END, 0
	FROM "recipients" WHERE "address" <> "sender"
)
INSERT INTO "people" ("workspace_id", "address", "name", "name_at", "sent_count", "received_count", "last_at")
SELECT e."workspace_id", e."address",
	coalesce((array_agg(e."name" ORDER BY e."date" DESC) FILTER (WHERE e."name" <> ''))[1], ''),
	max(e."date") FILTER (WHERE e."name" <> ''),
	sum(e."sent")::int, sum(e."received")::int, max(e."date")
FROM "entries" e JOIN "owners" o ON o."workspace_id" = e."workspace_id"
WHERE e."address" <> '' AND e."address" <> o."owner"
GROUP BY e."workspace_id", e."address";