ALTER TABLE "ads_promoter_settlement_items" ALTER COLUMN "platform_share_ratio" SET DEFAULT '0.3000';--> statement-breakpoint
ALTER TABLE "ads_promoter_settlement_items" ALTER COLUMN "publisher_pool_ratio" SET DEFAULT '0.7000';--> statement-breakpoint
ALTER TABLE "ads_settlement_batches" ALTER COLUMN "platform_share_ratio" SET DEFAULT '0.3000';--> statement-breakpoint
ALTER TABLE "ads_settlement_batches" ALTER COLUMN "publisher_pool_ratio" SET DEFAULT '0.7000';