CREATE TYPE "public"."user_status" AS ENUM('ACTIVE', 'SUSPENDED', 'PENDING_VERIFICATION', 'DELETED');--> statement-breakpoint
CREATE TYPE "public"."org_status" AS ENUM('ACTIVE', 'SUSPENDED', 'PENDING', 'DELETED');--> statement-breakpoint
CREATE TYPE "public"."org_role" AS ENUM('OWNER', 'ADMIN', 'MEMBER');--> statement-breakpoint
CREATE TYPE "public"."member_status" AS ENUM('ACTIVE', 'INVITED', 'SUSPENDED', 'LEFT');--> statement-breakpoint
CREATE TYPE "public"."mfa_type" AS ENUM('TOTP', 'PASSKEY', 'SMS', 'EMAIL_OTP', 'BACKUP_CODE');--> statement-breakpoint
CREATE TYPE "public"."exchange_rate_source" AS ENUM('frankfurter', 'exchangerate_api', 'stale_fallback');--> statement-breakpoint
CREATE TYPE "public"."card_provider" AS ENUM('paystack', 'stripe');--> statement-breakpoint
CREATE TYPE "public"."billing_transaction_status" AS ENUM('pending', 'completed', 'failed', 'reversed', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."billing_transaction_type" AS ENUM('wallet_fund', 'wallet_withdraw', 'subscription_charge', 'subscription_renewal', 'one_time_payment', 'ads_spend', 'ads_earning', 'rewards_credit', 'internal_debit', 'internal_credit', 'reversal');--> statement-breakpoint
CREATE TYPE "public"."subscription_plan" AS ENUM('monthly', 'annual');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('active', 'past_due', 'cancelled', 'expired', 'trialing');--> statement-breakpoint
CREATE TYPE "public"."provider_event_provider" AS ENUM('paystack', 'stripe');--> statement-breakpoint
CREATE TYPE "public"."withdrawal_status" AS ENUM('pending', 'processing', 'completed', 'failed', 'reversed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."ads_format" AS ENUM('banner', 'card', 'video', 'interstitial');--> statement-breakpoint
CREATE TYPE "public"."ads_campaign_status" AS ENUM('draft', 'active', 'paused', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."ads_creative_status" AS ENUM('active', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."ads_app_platform" AS ENUM('ios', 'android', 'both');--> statement-breakpoint
CREATE TYPE "public"."ads_placement_status" AS ENUM('active', 'paused', 'completed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."ads_promoter_type" AS ENUM('WEBSITE', 'INDIVIDUAL', 'MOBILE_APP');--> statement-breakpoint
CREATE TYPE "public"."ads_verification_method" AS ENUM('dns_txt', 'html_file_and_meta_tag');--> statement-breakpoint
CREATE TYPE "public"."ads_verification_status" AS ENUM('pending', 'verified', 'failed', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."ads_interaction_type" AS ENUM('impression', 'click', 'share', 'reels_view', 'embed_ping', 'conversion');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"phone" varchar(30),
	"password_hash" text,
	"status" "user_status" DEFAULT 'PENDING_VERIFICATION' NOT NULL,
	"is_email_verified" boolean DEFAULT false NOT NULL,
	"is_phone_verified" boolean DEFAULT false NOT NULL,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"preferred_locale" varchar(10) DEFAULT 'en' NOT NULL,
	"last_login_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "individual_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"full_name" varchar(255),
	"display_name" varchar(100),
	"avatar_url" text,
	"bio" text,
	"timezone" varchar(64) DEFAULT 'Africa/Lagos',
	"country" varchar(2) DEFAULT 'NG',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "individual_profiles_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"description" text,
	"logo_url" text,
	"website" varchar(255),
	"country" varchar(2) DEFAULT 'NG',
	"status" "org_status" DEFAULT 'PENDING' NOT NULL,
	"owner_quorum_count" integer DEFAULT 2 NOT NULL,
	"inactivity_days_trigger" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "org_role" DEFAULT 'MEMBER' NOT NULL,
	"status" "member_status" DEFAULT 'INVITED' NOT NULL,
	"invited_by_user_id" uuid,
	"joined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" varchar(100) NOT NULL,
	"client_secret_hash" text,
	"name" varchar(100) NOT NULL,
	"subdomain" varchar(100) NOT NULL,
	"description" text,
	"logo_url" text,
	"current_terms_version" varchar(20) DEFAULT '1.0.0' NOT NULL,
	"terms_url" text,
	"privacy_url" text,
	"is_first_party" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apps_client_id_unique" UNIQUE("client_id"),
	CONSTRAINT "apps_subdomain_unique" UNIQUE("subdomain")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_app_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid,
	"app_id" uuid NOT NULL,
	"terms_version_accepted" varchar(20) NOT NULL,
	"agreed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" varchar(45),
	"user_agent" text,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mfa_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "mfa_type" NOT NULL,
	"nickname" varchar(100),
	"secret_or_public_key" text NOT NULL,
	"credential_id" text,
	"counter" varchar(20) DEFAULT '0',
	"is_verified" boolean DEFAULT false NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "mfa_devices_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"client_id" varchar(100) NOT NULL,
	"client_secret_hash" text,
	"redirect_uris" text NOT NULL,
	"allowed_scopes" text DEFAULT 'openid profile email' NOT NULL,
	"owner_user_id" uuid,
	"is_first_party" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"logo_url" text,
	"website_url" text,
	"privacy_policy_url" text,
	"terms_of_service_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_clients_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"family_id" uuid NOT NULL,
	"device_fingerprint" varchar(255),
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"organization_id" uuid,
	"action" varchar(100) NOT NULL,
	"resource_type" varchar(100),
	"resource_id" varchar(255),
	"metadata" jsonb,
	"ip_address" varchar(45),
	"user_agent" text,
	"request_id" varchar(100),
	"success" varchar(10) DEFAULT 'true' NOT NULL,
	"error_code" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_exchange_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usd_to_ngn" numeric(18, 6) NOT NULL,
	"source" "exchange_rate_source" NOT NULL,
	"raw_main_response" jsonb,
	"raw_fallback_response" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"balance_usd_cents" integer DEFAULT 0 NOT NULL,
	"locked_usd_cents" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_wallets_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_saved_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "card_provider" NOT NULL,
	"provider_token" text NOT NULL,
	"signature" varchar(255),
	"card_brand" varchar(30),
	"last4" varchar(4) NOT NULL,
	"exp_month" varchar(2) NOT NULL,
	"exp_year" varchar(4) NOT NULL,
	"bank" varchar(100),
	"card_type" varchar(30),
	"billing_email" varchar(255),
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "billing_transaction_type" NOT NULL,
	"status" "billing_transaction_status" DEFAULT 'pending' NOT NULL,
	"amount_usd_cents" integer NOT NULL,
	"amount_ngn_kobo" integer,
	"exchange_rate_id" uuid,
	"reference" text,
	"idempotency_key" text,
	"provider" text,
	"metadata" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_transactions_reference_unique" UNIQUE("reference"),
	CONSTRAINT "billing_transactions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"app_slug" varchar(50) NOT NULL,
	"plan" "subscription_plan" DEFAULT 'monthly' NOT NULL,
	"status" "subscription_status" DEFAULT 'active' NOT NULL,
	"price_usd_cents" integer NOT NULL,
	"provider" varchar(20) DEFAULT 'paystack' NOT NULL,
	"saved_card_id" uuid,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"next_billing_date" timestamp with time zone NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"cancelled_at" timestamp with time zone,
	"last_payment_reference" text,
	"last_payment_date" timestamp with time zone,
	"failed_renewal_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_provider_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "provider_event_provider" NOT NULL,
	"reference" text NOT NULL,
	"event_type" text NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"processed_at" timestamp with time zone,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_provider_events_ref_unique" UNIQUE("provider","reference")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"bank_name" varchar(100) NOT NULL,
	"bank_code" varchar(10) NOT NULL,
	"account_number" varchar(20) NOT NULL,
	"account_name" varchar(255) NOT NULL,
	"recipient_code" varchar(50),
	"is_default" boolean DEFAULT false NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_withdrawal_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_usd_cents" integer NOT NULL,
	"amount_ngn_kobo" integer NOT NULL,
	"exchange_rate_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"status" "withdrawal_status" DEFAULT 'pending' NOT NULL,
	"paystack_transfer_code" text,
	"paystack_transfer_reference" text,
	"transaction_id" uuid,
	"failure_reason" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_withdrawal_requests_paystack_transfer_reference_unique" UNIQUE("paystack_transfer_reference")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"advertiser_id" uuid NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"budget_usd_cents" integer NOT NULL,
	"remaining_budget_usd_cents" integer NOT NULL,
	"cost_per_impression_usd_cents" integer DEFAULT 1 NOT NULL,
	"cost_per_click_usd_cents" integer DEFAULT 10 NOT NULL,
	"format" "ads_format" DEFAULT 'card' NOT NULL,
	"status" "ads_campaign_status" DEFAULT 'draft' NOT NULL,
	"targeting" text,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"accepting_promoters" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads_creatives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"headline" varchar(100) NOT NULL,
	"body_text" text,
	"cta_text" varchar(50) DEFAULT 'Learn More' NOT NULL,
	"image_url" text,
	"video_url" text,
	"destination_url" text NOT NULL,
	"status" "ads_creative_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads_placements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"creative_id" uuid NOT NULL,
	"promoter_id" uuid NOT NULL,
	"website_id" uuid,
	"app_id" uuid,
	"status" "ads_placement_status" DEFAULT 'active' NOT NULL,
	"placement_token" varchar(64) NOT NULL,
	"link_signature" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ads_placements_placement_token_unique" UNIQUE("placement_token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads_promoter_apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"promoter_id" uuid NOT NULL,
	"app_name" varchar(100) NOT NULL,
	"bundle_id" varchar(255) NOT NULL,
	"platform" "ads_app_platform" NOT NULL,
	"store_url" text,
	"verification_status" "ads_verification_status" DEFAULT 'pending' NOT NULL,
	"verified_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads_promoter_websites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"promoter_id" uuid NOT NULL,
	"url" text NOT NULL,
	"domain" varchar(255) NOT NULL,
	"verification_token" varchar(100) NOT NULL,
	"verification_method" "ads_verification_method" NOT NULL,
	"verification_status" "ads_verification_status" DEFAULT 'pending' NOT NULL,
	"verified_at" timestamp with time zone,
	"last_verification_attempt_at" timestamp with time zone,
	"verification_error_message" text,
	"embed_ping_last_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads_promoters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "ads_promoter_type" NOT NULL,
	"display_name" varchar(100),
	"bio" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ads_promoters_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads_interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"placement_id" uuid NOT NULL,
	"promoter_id" uuid NOT NULL,
	"type" "ads_interaction_type" NOT NULL,
	"source" varchar(30),
	"actor_ip" varchar(45),
	"user_agent" text,
	"referrer" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads_promoter_earnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"promoter_id" uuid NOT NULL,
	"placement_id" uuid NOT NULL,
	"interaction_id" uuid NOT NULL,
	"interaction_type" "ads_interaction_type" NOT NULL,
	"amount_usd_cents" integer NOT NULL,
	"billing_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads_reels_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"promoter_id" uuid NOT NULL,
	"consent_given" integer DEFAULT 0 NOT NULL,
	"consent_given_at" timestamp with time zone,
	"consent_revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ads_reels_consents_promoter_id_unique" UNIQUE("promoter_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "individual_profiles" ADD CONSTRAINT "individual_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_app_consents" ADD CONSTRAINT "user_app_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_app_consents" ADD CONSTRAINT "user_app_consents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_app_consents" ADD CONSTRAINT "user_app_consents_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mfa_devices" ADD CONSTRAINT "mfa_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_wallets" ADD CONSTRAINT "billing_wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_saved_cards" ADD CONSTRAINT "billing_saved_cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_transactions" ADD CONSTRAINT "billing_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_transactions" ADD CONSTRAINT "billing_transactions_exchange_rate_id_billing_exchange_rates_id_fk" FOREIGN KEY ("exchange_rate_id") REFERENCES "public"."billing_exchange_rates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_saved_card_id_billing_saved_cards_id_fk" FOREIGN KEY ("saved_card_id") REFERENCES "public"."billing_saved_cards"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_bank_accounts" ADD CONSTRAINT "billing_bank_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_withdrawal_requests" ADD CONSTRAINT "billing_withdrawal_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_withdrawal_requests" ADD CONSTRAINT "billing_withdrawal_requests_exchange_rate_id_billing_exchange_rates_id_fk" FOREIGN KEY ("exchange_rate_id") REFERENCES "public"."billing_exchange_rates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_withdrawal_requests" ADD CONSTRAINT "billing_withdrawal_requests_bank_account_id_billing_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."billing_bank_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_withdrawal_requests" ADD CONSTRAINT "billing_withdrawal_requests_transaction_id_billing_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."billing_transactions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_campaigns" ADD CONSTRAINT "ads_campaigns_advertiser_id_users_id_fk" FOREIGN KEY ("advertiser_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_creatives" ADD CONSTRAINT "ads_creatives_campaign_id_ads_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ads_campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_placements" ADD CONSTRAINT "ads_placements_campaign_id_ads_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ads_campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_placements" ADD CONSTRAINT "ads_placements_creative_id_ads_creatives_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."ads_creatives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_placements" ADD CONSTRAINT "ads_placements_promoter_id_ads_promoters_id_fk" FOREIGN KEY ("promoter_id") REFERENCES "public"."ads_promoters"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_placements" ADD CONSTRAINT "ads_placements_website_id_ads_promoter_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."ads_promoter_websites"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_placements" ADD CONSTRAINT "ads_placements_app_id_ads_promoter_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."ads_promoter_apps"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_promoter_apps" ADD CONSTRAINT "ads_promoter_apps_promoter_id_ads_promoters_id_fk" FOREIGN KEY ("promoter_id") REFERENCES "public"."ads_promoters"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_promoter_websites" ADD CONSTRAINT "ads_promoter_websites_promoter_id_ads_promoters_id_fk" FOREIGN KEY ("promoter_id") REFERENCES "public"."ads_promoters"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_promoters" ADD CONSTRAINT "ads_promoters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_interactions" ADD CONSTRAINT "ads_interactions_placement_id_ads_placements_id_fk" FOREIGN KEY ("placement_id") REFERENCES "public"."ads_placements"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_interactions" ADD CONSTRAINT "ads_interactions_promoter_id_ads_promoters_id_fk" FOREIGN KEY ("promoter_id") REFERENCES "public"."ads_promoters"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_promoter_earnings" ADD CONSTRAINT "ads_promoter_earnings_promoter_id_ads_promoters_id_fk" FOREIGN KEY ("promoter_id") REFERENCES "public"."ads_promoters"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_promoter_earnings" ADD CONSTRAINT "ads_promoter_earnings_placement_id_ads_placements_id_fk" FOREIGN KEY ("placement_id") REFERENCES "public"."ads_placements"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_promoter_earnings" ADD CONSTRAINT "ads_promoter_earnings_interaction_id_ads_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."ads_interactions"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_reels_consents" ADD CONSTRAINT "ads_reels_consents_promoter_id_ads_promoters_id_fk" FOREIGN KEY ("promoter_id") REFERENCES "public"."ads_promoters"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_exchange_rates_fetched_at_idx" ON "billing_exchange_rates" USING btree ("fetched_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_wallets_user_id_idx" ON "billing_wallets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_saved_cards_user_id_idx" ON "billing_saved_cards" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_saved_cards_signature_idx" ON "billing_saved_cards" USING btree ("user_id","signature");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_transactions_user_id_idx" ON "billing_transactions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_transactions_type_idx" ON "billing_transactions" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_transactions_status_idx" ON "billing_transactions" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_transactions_created_at_idx" ON "billing_transactions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_transactions_reference_idx" ON "billing_transactions" USING btree ("reference");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_subscriptions_user_id_idx" ON "billing_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_subscriptions_app_slug_idx" ON "billing_subscriptions" USING btree ("app_slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_subscriptions_next_billing_idx" ON "billing_subscriptions" USING btree ("next_billing_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_subscriptions_status_idx" ON "billing_subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_provider_events_processed_idx" ON "billing_provider_events" USING btree ("processed");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_provider_events_event_type_idx" ON "billing_provider_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_bank_accounts_user_id_idx" ON "billing_bank_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_withdrawals_user_id_idx" ON "billing_withdrawal_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_withdrawals_status_idx" ON "billing_withdrawal_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_campaigns_advertiser_id_idx" ON "ads_campaigns" USING btree ("advertiser_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_campaigns_status_idx" ON "ads_campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_creatives_campaign_id_idx" ON "ads_creatives" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_creatives_status_idx" ON "ads_creatives" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_placements_campaign_id_idx" ON "ads_placements" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_placements_promoter_id_idx" ON "ads_placements" USING btree ("promoter_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_placements_token_idx" ON "ads_placements" USING btree ("placement_token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_placements_status_idx" ON "ads_placements" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_promoter_apps_promoter_id_idx" ON "ads_promoter_apps" USING btree ("promoter_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_promoter_websites_promoter_id_idx" ON "ads_promoter_websites" USING btree ("promoter_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_promoter_websites_domain_idx" ON "ads_promoter_websites" USING btree ("domain");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_promoter_websites_status_idx" ON "ads_promoter_websites" USING btree ("verification_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_promoters_user_id_idx" ON "ads_promoters" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_promoters_type_idx" ON "ads_promoters" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_interactions_placement_id_idx" ON "ads_interactions" USING btree ("placement_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_interactions_promoter_id_idx" ON "ads_interactions" USING btree ("promoter_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_interactions_type_idx" ON "ads_interactions" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_interactions_created_at_idx" ON "ads_interactions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_promoter_earnings_promoter_id_idx" ON "ads_promoter_earnings" USING btree ("promoter_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_promoter_earnings_created_at_idx" ON "ads_promoter_earnings" USING btree ("created_at");