ALTER TABLE "ads_clicks" ADD COLUMN "recording_reason" varchar(40);
--> statement-breakpoint
CREATE INDEX "ads_clicks_interaction_id_idx" ON "ads_clicks" ("interaction_id");
