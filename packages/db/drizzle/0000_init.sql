CREATE TYPE "public"."review_status" AS ENUM('running', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"repo" text NOT NULL,
	"pull_number" integer NOT NULL,
	"rule_id" text NOT NULL,
	"path" text NOT NULL,
	"line" integer NOT NULL,
	"severity" text NOT NULL,
	"fingerprint" text NOT NULL,
	"message" text NOT NULL,
	"is_new" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo" text NOT NULL,
	"pull_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"delivery_id" text,
	"status" "review_status" DEFAULT 'running' NOT NULL,
	"files_checked" integer,
	"findings" integer,
	"already_reported" integer,
	"posted" integer,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "findings_review_id_index" ON "findings" USING btree ("review_id");--> statement-breakpoint
CREATE INDEX "findings_repo_rule_id_index" ON "findings" USING btree ("repo","rule_id");--> statement-breakpoint
CREATE INDEX "findings_repo_pull_number_fingerprint_index" ON "findings" USING btree ("repo","pull_number","fingerprint");--> statement-breakpoint
CREATE INDEX "reviews_repo_pull_number_index" ON "reviews" USING btree ("repo","pull_number");--> statement-breakpoint
CREATE INDEX "reviews_started_at_index" ON "reviews" USING btree ("started_at");