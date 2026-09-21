CREATE TABLE "section_judgments" (
	"workspace_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"rule_id" text NOT NULL,
	"statement" text NOT NULL,
	"probability" real NOT NULL,
	"model" text NOT NULL,
	"judged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "section_judgments_thread_id_rule_id_pk" PRIMARY KEY("thread_id","rule_id")
);
--> statement-breakpoint
ALTER TABLE "section_judgments" ADD CONSTRAINT "section_judgments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section_judgments" ADD CONSTRAINT "section_judgments_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "section_judgments_rule_idx" ON "section_judgments" USING btree ("workspace_id","rule_id");