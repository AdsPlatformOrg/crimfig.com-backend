-- Migration: 0034_slot_preset_policy_and_variations.sql
-- PLAN-0067: Nine Approved Image Ad Presets and Responsive Slot Compatibility

ALTER TABLE "adstation_slots"
  ADD COLUMN IF NOT EXISTS "preset_policy" varchar(32) NOT NULL DEFAULT 'auto_any_approved',
  ADD COLUMN IF NOT EXISTS "allowed_preset_ids" text,
  ADD COLUMN IF NOT EXISTS "preset_policy_version" integer NOT NULL DEFAULT 1;

ALTER TABLE "ads_house_creatives"
  ADD COLUMN IF NOT EXISTS "target_preset" varchar(64),
  ADD COLUMN IF NOT EXISTS "rendition_width" integer,
  ADD COLUMN IF NOT EXISTS "rendition_height" integer;

