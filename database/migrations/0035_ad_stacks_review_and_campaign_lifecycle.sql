-- Migration: 0035_ad_stacks_review_and_campaign_lifecycle.sql
-- PLAN-0068: Independent Campaign Lifecycle, Dual Reviewer Approvals for Stacks and Creatives

-- 1. Extend enums
ALTER TYPE "ads_asset_review_status" ADD VALUE IF NOT EXISTS 'pending_manager_approval';
ALTER TYPE "ads_moderation_target_type" ADD VALUE IF NOT EXISTS 'stack';

-- 2. Dual review tracking for ads_creative_stacks
ALTER TABLE "ads_creative_stacks"
  ADD COLUMN IF NOT EXISTS "review_status" varchar(32) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS "primary_reviewer_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "primary_reviewed_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "manager_reviewer_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "manager_reviewed_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "rejection_reason" text;

-- 2. Dual review tracking for ads_creatives
ALTER TABLE "ads_creatives"
  ADD COLUMN IF NOT EXISTS "primary_reviewer_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "primary_reviewed_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "manager_reviewer_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "manager_reviewed_at" timestamp with time zone;

-- 3. Audit trail note separation in ads_moderation_decisions
ALTER TABLE "ads_moderation_decisions"
  ADD COLUMN IF NOT EXISTS "advertiser_note" text,
  ADD COLUMN IF NOT EXISTS "internal_note" text;

