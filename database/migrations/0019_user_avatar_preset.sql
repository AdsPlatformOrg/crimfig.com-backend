-- PLAN-0037: curated anime avatar preset selection.
-- Preset metadata and files live with the Auth web app; the database stores only the
-- selected preset ID and a version used to bust cached avatar URLs.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_preset_id" varchar(50);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_version" integer NOT NULL DEFAULT 1;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_updated_at" timestamp with time zone;
