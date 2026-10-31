CREATE TABLE IF NOT EXISTS ads_media_asset_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES ads_media_assets(id) ON DELETE CASCADE,
  provider varchar(32) NOT NULL,
  role varchar(12) NOT NULL DEFAULT 'primary',
  bucket varchar(255) NOT NULL,
  storage_key varchar(500) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'ready',
  bytes bigint NOT NULL DEFAULT 0,
  content_type varchar(100),
  etag varchar(255),
  sha256 varchar(64),
  verified_at timestamptz DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ads_media_asset_locations_asset_provider_uq UNIQUE(asset_id, provider)
);

CREATE INDEX IF NOT EXISTS ads_media_asset_locations_provider_status_idx ON ads_media_asset_locations(provider, status);
CREATE INDEX IF NOT EXISTS ads_media_asset_locations_key_idx ON ads_media_asset_locations(storage_key);

ALTER TABLE ads_media_assets
  ADD COLUMN IF NOT EXISTS primary_provider varchar(32) NOT NULL DEFAULT 'cloudflare_r2',
  ADD COLUMN IF NOT EXISTS replication_status varchar(20) NOT NULL DEFAULT 'ready';
