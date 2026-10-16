CREATE TYPE "public"."approval_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."asset_type" AS ENUM('BACKGROUND', 'FINAL');--> statement-breakpoint
CREATE TYPE "public"."batch_status" AS ENUM('CREATED', 'GENERATING', 'PARTIALLY_READY', 'READY_FOR_REVIEW', 'APPROVED', 'SCHEDULED', 'PARTIALLY_PUBLISHED', 'COMPLETED', 'CANCELLED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."board_assignment_mode" AS ENUM('AUTO', 'MANUAL', 'UNIQUE');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('CONNECTED', 'EXPIRED', 'REVOKED', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."draft_status" AS ENUM('CREATED', 'GENERATING', 'READY_FOR_REVIEW', 'NEEDS_EDIT', 'APPROVED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED', 'PUBLISH_UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."publish_job_status" AS ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."schedule_status" AS ENUM('SCHEDULED', 'PAUSED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED', 'PUBLISH_UNKNOWN');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"draft_id" uuid,
	"batch_id" uuid,
	"action" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "image_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"public_url" text NOT NULL,
	"asset_type" "asset_type" NOT NULL,
	"image_style" text,
	"generation_prompt" text,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"mime_type" text NOT NULL,
	"version" integer NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "image_assets_object_key_unique" UNIQUE("object_key")
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"nonce_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_states_nonce_hash_unique" UNIQUE("nonce_hash")
);
--> statement-breakpoint
CREATE TABLE "pin_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" serial NOT NULL,
	"user_id" uuid NOT NULL,
	"original_topic" text NOT NULL,
	"requested_count" integer NOT NULL,
	"generated_count" integer DEFAULT 0 NOT NULL,
	"board_assignment_mode" "board_assignment_mode" DEFAULT 'AUTO' NOT NULL,
	"status" "batch_status" DEFAULT 'CREATED' NOT NULL,
	"schedule_plan" jsonb,
	"ready_notified_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pin_batches_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "pin_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"topic" text NOT NULL,
	"emotion" text,
	"quote" text,
	"title" text,
	"description" text,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"alt_text" text,
	"link" text,
	"image_style" text,
	"typography" text,
	"background_prompt" text,
	"selected_board_id" uuid,
	"board_reason" text,
	"selected_image_id" uuid,
	"background_image_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"status" "draft_status" DEFAULT 'CREATED' NOT NULL,
	"approval_status" "approval_status" DEFAULT 'PENDING' NOT NULL,
	"approved_version" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pin_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"board_id" uuid NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"timezone" text NOT NULL,
	"interval_minutes" integer NOT NULL,
	"approved_version" integer NOT NULL,
	"status" "schedule_status" DEFAULT 'SCHEDULED' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pinterest_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"pinterest_user_id" text,
	"username" text,
	"encrypted_access_token" text NOT NULL,
	"encrypted_refresh_token" text,
	"token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scopes" text,
	"connection_status" "connection_status" DEFAULT 'CONNECTED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pinterest_accounts_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "pinterest_boards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pinterest_account_id" uuid NOT NULL,
	"external_board_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"privacy" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publish_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "publish_job_status" DEFAULT 'QUEUED' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"attempt_started_at" timestamp with time zone,
	"reconcile_attempts" integer DEFAULT 0 NOT NULL,
	"pinterest_pin_id" text,
	"pinterest_pin_url" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publish_jobs_schedule_id_unique" UNIQUE("schedule_id"),
	CONSTRAINT "publish_jobs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"default_language" text DEFAULT 'English' NOT NULL,
	"tone" text DEFAULT 'emotional' NOT NULL,
	"quote_length" text DEFAULT 'medium' NOT NULL,
	"default_image_style" text DEFAULT 'auto' NOT NULL,
	"typography_preset" text DEFAULT 'elegant_serif' NOT NULL,
	"image_quality" integer DEFAULT 88 NOT NULL,
	"default_batch_size" integer DEFAULT 5 NOT NULL,
	"default_interval_minutes" integer DEFAULT 60 NOT NULL,
	"default_board_assignment_mode" "board_assignment_mode" DEFAULT 'AUTO' NOT NULL,
	"preferred_board_id" uuid,
	"watermark_enabled" boolean DEFAULT false NOT NULL,
	"watermark_text" text,
	"default_link" text,
	"notifications_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_settings_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_user_id" text NOT NULL,
	"telegram_chat_id" text,
	"telegram_username" text,
	"is_authorized" boolean DEFAULT false NOT NULL,
	"timezone" text DEFAULT 'Asia/Dhaka' NOT NULL,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pending_action" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_telegram_user_id_unique" UNIQUE("telegram_user_id")
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_assets" ADD CONSTRAINT "image_assets_draft_id_pin_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."pin_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pin_batches" ADD CONSTRAINT "pin_batches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pin_drafts" ADD CONSTRAINT "pin_drafts_batch_id_pin_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."pin_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pin_drafts" ADD CONSTRAINT "pin_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pin_drafts" ADD CONSTRAINT "pin_drafts_selected_board_id_pinterest_boards_id_fk" FOREIGN KEY ("selected_board_id") REFERENCES "public"."pinterest_boards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pin_schedules" ADD CONSTRAINT "pin_schedules_draft_id_pin_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."pin_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pin_schedules" ADD CONSTRAINT "pin_schedules_batch_id_pin_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."pin_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pin_schedules" ADD CONSTRAINT "pin_schedules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pin_schedules" ADD CONSTRAINT "pin_schedules_board_id_pinterest_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."pinterest_boards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinterest_accounts" ADD CONSTRAINT "pinterest_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinterest_boards" ADD CONSTRAINT "pinterest_boards_pinterest_account_id_pinterest_accounts_id_fk" FOREIGN KEY ("pinterest_account_id") REFERENCES "public"."pinterest_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_draft_id_pin_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."pin_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_schedule_id_pin_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."pin_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_user_idx" ON "audit_logs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "assets_draft_idx" ON "image_assets" USING btree ("draft_id");--> statement-breakpoint
CREATE INDEX "batches_user_idx" ON "pin_batches" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "drafts_batch_position_uq" ON "pin_drafts" USING btree ("batch_id","position");--> statement-breakpoint
CREATE INDEX "drafts_user_idx" ON "pin_drafts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "schedules_status_time_idx" ON "pin_schedules" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "schedules_one_active_per_draft_uq" ON "pin_schedules" USING btree ("draft_id") WHERE status in ('SCHEDULED','PAUSED','PUBLISHING','PUBLISH_UNKNOWN');--> statement-breakpoint
CREATE UNIQUE INDEX "boards_account_external_uq" ON "pinterest_boards" USING btree ("pinterest_account_id","external_board_id");--> statement-breakpoint
CREATE UNIQUE INDEX "publish_jobs_one_success_per_draft_uq" ON "publish_jobs" USING btree ("draft_id") WHERE status = 'SUCCEEDED';