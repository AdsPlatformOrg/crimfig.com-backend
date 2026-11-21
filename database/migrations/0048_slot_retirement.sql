-- Existing configurations, tags and history remain unchanged.
ALTER TABLE adstation_slots ADD COLUMN IF NOT EXISTS retired_at timestamptz;
ALTER TABLE ads_creatives ADD COLUMN IF NOT EXISTS size_policy varchar(16) NOT NULL DEFAULT 'legacy';
ALTER TABLE ads_creatives ADD COLUMN IF NOT EXISTS allowed_preset_ids text;
