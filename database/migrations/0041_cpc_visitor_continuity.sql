ALTER TABLE ads_serves ADD COLUMN IF NOT EXISTS cpc_visitor_key varchar(64);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ads_serves_cpc_visitor_idx
  ON ads_serves (campaign_id, cpc_visitor_key)
  WHERE cpc_visitor_key IS NOT NULL AND pricing_model = 'cpc';
