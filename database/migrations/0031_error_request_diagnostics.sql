ALTER TABLE error_monitor_occurrences ADD COLUMN IF NOT EXISTS diagnostics jsonb;
ALTER TABLE error_monitor_occurrences ADD COLUMN IF NOT EXISTS diagnostics_expires_at timestamptz;
CREATE INDEX IF NOT EXISTS error_monitor_diagnostics_expiry_idx ON error_monitor_occurrences(diagnostics_expires_at) WHERE diagnostics IS NOT NULL;
CREATE INDEX IF NOT EXISTS error_monitor_occurrences_scope_time_idx ON error_monitor_occurrences(environment,service,occurred_at,id);

ALTER TABLE ads_serves ADD COLUMN IF NOT EXISTS house_destination_url text;

ALTER TABLE ads_house_creatives ADD COLUMN IF NOT EXISTS image_asset_id uuid REFERENCES ads_media_assets(id) ON DELETE RESTRICT;
ALTER TABLE ads_house_creatives ADD COLUMN IF NOT EXISTS video_asset_id uuid REFERENCES ads_media_assets(id) ON DELETE RESTRICT;
