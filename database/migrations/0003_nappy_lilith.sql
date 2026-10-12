ALTER TABLE "ads_promoter_settlement_items" ADD COLUMN "platform_share_ratio" numeric(5, 4) DEFAULT '0.7000';--> statement-breakpoint
ALTER TABLE "ads_promoter_settlement_items" ADD COLUMN "publisher_pool_ratio" numeric(5, 4) DEFAULT '0.3000';--> statement-breakpoint
ALTER TABLE "ads_promoter_settlement_items" ADD COLUMN "tax_and_fees_ratio" numeric(5, 4) DEFAULT '0.0750';--> statement-breakpoint
ALTER TABLE "ads_promoter_settlement_items" ADD COLUMN "exchange_rate_snapshot" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "ads_settlement_batches" ADD COLUMN "platform_share_ratio" numeric(5, 4) DEFAULT '0.7000' NOT NULL;--> statement-breakpoint
ALTER TABLE "ads_settlement_batches" ADD COLUMN "publisher_pool_ratio" numeric(5, 4) DEFAULT '0.3000' NOT NULL;--> statement-breakpoint
ALTER TABLE "ads_settlement_batches" ADD COLUMN "tax_and_fees_ratio" numeric(5, 4) DEFAULT '0.0750' NOT NULL;--> statement-breakpoint
ALTER TABLE "ads_settlement_batches" ADD COLUMN "exchange_rate_snapshot" numeric(12, 4);