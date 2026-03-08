ALTER TYPE "public"."job_type" ADD VALUE 'social_signal_search';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'brief_generation';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'buzz_generation';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'webinar_speaker_find';--> statement-breakpoint
ALTER TYPE "public"."signal_category" ADD VALUE 'social' BEFORE 'funding';--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"job_id" uuid,
	"service" text NOT NULL,
	"operation" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"input_cost_usd" numeric(10, 6) NOT NULL,
	"output_cost_usd" numeric(10, 6) NOT NULL,
	"total_cost_usd" numeric(10, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buzz_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"time_window_days" integer DEFAULT 30 NOT NULL,
	"icp_ids" jsonb,
	"report" jsonb,
	"signals_analyzed" integer,
	"topics_count" integer,
	"webinar_angles_count" integer,
	"copy_snippets_count" integer,
	"input_hash" text,
	"job_id" uuid,
	"status" text DEFAULT 'generating' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webinar_speakers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"buzz_report_id" uuid NOT NULL,
	"angle_index" integer NOT NULL,
	"angle_title" text NOT NULL,
	"name" text NOT NULL,
	"current_title" text,
	"company" text,
	"bio" text,
	"social_profiles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"primary_platform" text,
	"primary_profile_url" text,
	"relevance_score" numeric(3, 2),
	"reach_score" numeric(3, 2),
	"overall_rank" integer,
	"speaker_reasoning" text,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outreach_message" text,
	"discovery_source" text,
	"source_url" text,
	"job_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "influencers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"handle" text NOT NULL,
	"profile_url" text,
	"category" text,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitor_downtime_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"competitor_id" uuid NOT NULL,
	"competitor_name" text NOT NULL,
	"downtime_started_at" timestamp with time zone NOT NULL,
	"downtime_resolved_at" timestamp with time zone,
	"duration_minutes" integer,
	"status" text DEFAULT 'ongoing' NOT NULL,
	"alert_data" jsonb,
	"dismissed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitored_competitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"uptimerobot_monitor_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "icp_build_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"icp_id" uuid,
	"plan" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"feedback_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"execution_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demo_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint" text NOT NULL,
	"industry" text,
	"icp_text" text,
	"ip_hash" text NOT NULL,
	"user_agent" text,
	"response_time_ms" integer,
	"status_code" integer DEFAULT 200 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "icps" ADD COLUMN "social_keywords" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "list_members" ADD COLUMN "pipeline_stage" "pipeline_stage" DEFAULT 'tam' NOT NULL;--> statement-breakpoint
ALTER TABLE "list_members" ADD COLUMN "engagement_brief" jsonb;--> statement-breakpoint
ALTER TABLE "list_members" ADD COLUMN "brief_generated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "signal_hypotheses" ADD COLUMN "last_searched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_reports" ADD CONSTRAINT "buzz_reports_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_reports" ADD CONSTRAINT "buzz_reports_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webinar_speakers" ADD CONSTRAINT "webinar_speakers_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webinar_speakers" ADD CONSTRAINT "webinar_speakers_buzz_report_id_buzz_reports_id_fk" FOREIGN KEY ("buzz_report_id") REFERENCES "public"."buzz_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webinar_speakers" ADD CONSTRAINT "webinar_speakers_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "influencers" ADD CONSTRAINT "influencers_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_downtime_alerts" ADD CONSTRAINT "competitor_downtime_alerts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_downtime_alerts" ADD CONSTRAINT "competitor_downtime_alerts_competitor_id_monitored_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."monitored_competitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitored_competitors" ADD CONSTRAINT "monitored_competitors_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icp_build_plans" ADD CONSTRAINT "icp_build_plans_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "icp_build_plans" ADD CONSTRAINT "icp_build_plans_icp_id_icps_id_fk" FOREIGN KEY ("icp_id") REFERENCES "public"."icps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_llm_usage_client" ON "llm_usage" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_job" ON "llm_usage" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_service" ON "llm_usage" USING btree ("service");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_created" ON "llm_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_buzz_reports_client" ON "buzz_reports" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "idx_buzz_reports_client_status" ON "buzz_reports" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "idx_webinar_speakers_report" ON "webinar_speakers" USING btree ("buzz_report_id","angle_index");--> statement-breakpoint
CREATE INDEX "idx_webinar_speakers_client" ON "webinar_speakers" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "idx_influencers_client" ON "influencers" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "idx_influencers_client_active" ON "influencers" USING btree ("client_id","is_active");--> statement-breakpoint
CREATE INDEX "idx_competitor_alerts_client" ON "competitor_downtime_alerts" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "idx_competitor_alerts_client_status" ON "competitor_downtime_alerts" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "idx_monitored_competitors_client" ON "monitored_competitors" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "idx_icp_build_plans_client" ON "icp_build_plans" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "idx_icp_build_plans_icp" ON "icp_build_plans" USING btree ("icp_id");--> statement-breakpoint
CREATE INDEX "idx_icp_build_plans_status" ON "icp_build_plans" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_demo_requests_ip_hash" ON "demo_requests" USING btree ("ip_hash");--> statement-breakpoint
CREATE INDEX "idx_demo_requests_created_at" ON "demo_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_demo_requests_endpoint" ON "demo_requests" USING btree ("endpoint","created_at");