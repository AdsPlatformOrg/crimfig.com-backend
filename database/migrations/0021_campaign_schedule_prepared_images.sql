-- Additive: old hours retained unchanged for rollback and null schedules read compatibly.
ALTER TABLE ads_campaigns ADD COLUMN IF NOT EXISTS schedule jsonb;
ALTER TABLE ads_creative_stacks ADD COLUMN IF NOT EXISTS schedule jsonb;
ALTER TABLE ads_campaigns ADD COLUMN IF NOT EXISTS creation_request_id uuid;
ALTER TABLE ads_campaigns ADD COLUMN IF NOT EXISTS creation_fingerprint varchar(64);
CREATE UNIQUE INDEX IF NOT EXISTS ads_campaign_creation_request_uq ON ads_campaigns(advertiser_id,creation_request_id) WHERE creation_request_id IS NOT NULL;
ALTER TABLE ads_media_assets ADD COLUMN IF NOT EXISTS preparation jsonb;
ALTER TABLE ads_placements ADD COLUMN IF NOT EXISTS image_max_bytes integer NOT NULL DEFAULT 150000;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='ads_image_cap') THEN ALTER TABLE ads_placements ADD CONSTRAINT ads_image_cap CHECK(image_max_bytes BETWEEN 1000 AND 200000); END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='ads_campaign_schedule_shape') THEN ALTER TABLE ads_campaigns ADD CONSTRAINT ads_campaign_schedule_shape CHECK(schedule IS NULL OR (jsonb_typeof(schedule)='object' AND schedule->>'version'='1' AND schedule->>'mode' IN ('custom','round_the_clock') AND schedule->>'timezone'='Africa/Lagos' AND jsonb_typeof(schedule->'ranges')='array')); END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='ads_stack_schedule_shape') THEN ALTER TABLE ads_creative_stacks ADD CONSTRAINT ads_stack_schedule_shape CHECK(schedule IS NULL OR (jsonb_typeof(schedule)='object' AND schedule->>'version'='1' AND schedule->>'mode' IN ('inherit','custom','round_the_clock'))); END IF;
END $$;
