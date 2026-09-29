CREATE TABLE "signal_answers" (
	"thread_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"signal_id" text NOT NULL,
	"version" integer NOT NULL,
	"model" text NOT NULL,
	"judged_at" timestamp with time zone NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"latest_message_id" text DEFAULT '' NOT NULL,
	"noul" real,
	"choice" text,
	"score" real,
	"probabilities" jsonb,
	"confidence" real,
	"low_trust" text,
	"legacy_key" text,
	CONSTRAINT "signal_answers_thread_id_signal_id_pk" PRIMARY KEY("thread_id","signal_id")
);
--> statement-breakpoint
CREATE TABLE "signal_defs" (
	"workspace_id" text NOT NULL,
	"id" text NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_id" text,
	"owners" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"kind" text NOT NULL,
	"question" jsonb NOT NULL,
	"hash" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"scope" jsonb NOT NULL,
	"gate" text,
	"options_from" text,
	"consumers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "signal_defs_workspace_id_id_pk" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "signal_versions" (
	"workspace_id" text NOT NULL,
	"signal_id" text NOT NULL,
	"version" integer NOT NULL,
	"hash" text NOT NULL,
	"question" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signal_versions_workspace_id_signal_id_version_pk" PRIMARY KEY("workspace_id","signal_id","version")
);
--> statement-breakpoint
ALTER TABLE "signal_answers" ADD CONSTRAINT "signal_answers_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_answers" ADD CONSTRAINT "signal_answers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_defs" ADD CONSTRAINT "signal_defs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_versions" ADD CONSTRAINT "signal_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signal_answers_signal_idx" ON "signal_answers" USING btree ("workspace_id","signal_id","version");--> statement-breakpoint
CREATE INDEX "signal_answers_judged_idx" ON "signal_answers" USING btree ("workspace_id","judged_at");--> statement-breakpoint
-- The slice 25 arrival Judgments become answers for the shipped Signals at
-- version 1, with the Thread version they were asked for. The review_link and
-- open_attachment chips are not carried over: they are dropped.
INSERT INTO "signal_answers" ("thread_id", "workspace_id", "signal_id", "version", "model", "judged_at", "message_count", "latest_message_id", "noul")
SELECT j."thread_id", j."workspace_id", s."id", 1, j."model", j."judged_at", j."message_count", j."latest_message_id",
  CASE s."id"
    WHEN 'needs_reply' THEN j."needs_reply"
    WHEN 'waiting_on_others' THEN j."waiting_on_others"
    WHEN 'newsletter' THEN j."newsletter"
    ELSE j."automated"
  END
FROM "thread_judgments" j
CROSS JOIN (VALUES ('needs_reply'), ('waiting_on_others'), ('newsletter'), ('automated')) AS s("id");--> statement-breakpoint
INSERT INTO "signal_answers" ("thread_id", "workspace_id", "signal_id", "version", "model", "judged_at", "message_count", "latest_message_id", "score")
SELECT j."thread_id", j."workspace_id", s."id", 1, j."model", j."judged_at", j."message_count", j."latest_message_id",
  CASE s."id" WHEN 'brief_worth' THEN j."brief_worth" ELSE j."urgency" END
FROM "thread_judgments" j
CROSS JOIN (VALUES ('brief_worth'), ('urgency')) AS s("id");--> statement-breakpoint
INSERT INTO "signal_answers" ("thread_id", "workspace_id", "signal_id", "version", "model", "judged_at", "message_count", "latest_message_id", "noul")
SELECT j."thread_id", j."workspace_id", 'chip_' || c."key", 1, j."model", j."judged_at", j."message_count", j."latest_message_id", (c."value")::real
FROM "thread_judgments" j, jsonb_each_text(j."chips") c
WHERE c."key" IN ('reply', 'call', 'pay_or_file', 'snooze');--> statement-breakpoint
-- The slice 26 judged Sections and custom actions become answers for their
-- owned Signals at version 0 with the statement they were asked with; the
-- Server gives them the current version when that statement is still the one
-- asked (intelligence/signals), else they stay stale until read again.
INSERT INTO "signal_answers" ("thread_id", "workspace_id", "signal_id", "version", "model", "judged_at", "noul", "legacy_key")
SELECT sj."thread_id", sj."workspace_id",
  CASE WHEN sj."rule_id" IN (
    SELECT a."value"->>'id' FROM "settings" st,
      jsonb_array_elements(CASE WHEN jsonb_typeof(st."value") = 'array' THEN st."value" ELSE '[]'::jsonb END) a("value")
    WHERE st."key" = 'actions.custom' AND st."scope" = 'global'
  ) THEN 'action:' ELSE 'section:' END || sj."rule_id",
  0, sj."model", sj."judged_at", sj."probability", sj."statement"
FROM "section_judgments" sj
ON CONFLICT DO NOTHING;--> statement-breakpoint
DROP TABLE "section_judgments" CASCADE;--> statement-breakpoint
DROP TABLE "thread_judgments" CASCADE;