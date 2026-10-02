ALTER TABLE "devices" ADD COLUMN "kind" text DEFAULT 'computer' NOT NULL;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD COLUMN "invite" boolean DEFAULT false NOT NULL;