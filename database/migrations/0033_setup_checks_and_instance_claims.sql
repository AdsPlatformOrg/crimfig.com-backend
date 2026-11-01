ALTER TABLE ads_interactions ADD COLUMN IF NOT EXISTS page_view_id uuid;
ALTER TABLE ads_interactions ADD COLUMN IF NOT EXISTS slot_instance_id uuid;
ALTER TABLE ads_interactions ADD COLUMN IF NOT EXISTS opportunity_id uuid;
ALTER TABLE ads_interactions ADD COLUMN IF NOT EXISTS sdk_init_id uuid;
ALTER TABLE ads_interactions ADD COLUMN IF NOT EXISTS instance_index integer;
ALTER TABLE ads_interactions ADD COLUMN IF NOT EXISTS instances_detected integer;
CREATE INDEX IF NOT EXISTS ads_interactions_slot_instance_idx ON ads_interactions(slot_instance_id) WHERE slot_instance_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ads_setup_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  website_id uuid NOT NULL REFERENCES ads_promoter_websites(id) ON DELETE CASCADE,
  promoter_id uuid NOT NULL REFERENCES ads_promoters(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  challenge_hash varchar(64) NOT NULL,
  page_path varchar(256),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  sdk_executed_at timestamptz,
  sdk_version varchar(32),
  sdk_runtime_id uuid,
  sdk_page_view_id uuid,
  sdk_host varchar(255),
  CONSTRAINT ads_setup_checks_request_uq UNIQUE (promoter_id, request_id),
  CONSTRAINT ads_setup_checks_challenge_uq UNIQUE (challenge_hash)
);
CREATE INDEX IF NOT EXISTS ads_setup_checks_website_idx ON ads_setup_checks(website_id, created_at DESC);
