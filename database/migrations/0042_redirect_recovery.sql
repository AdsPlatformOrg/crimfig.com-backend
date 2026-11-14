ALTER TABLE ads_clicks ADD COLUMN IF NOT EXISTS recovery jsonb;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ads_clicks_pending_recovery_idx ON ads_clicks (campaign_id, clicked_at, id)
  WHERE recovery IS NOT NULL AND interaction_id IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ads_interactions_click_audit_idx ON ads_interactions (created_at, id)
  WHERE type = 'click';
