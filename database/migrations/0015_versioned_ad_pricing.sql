-- Historical campaigns/serves remain version 1. No monetary reinterpretation or backfill.
ALTER TABLE "ads_campaigns" ADD COLUMN "pricing_version" smallint DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "ads_serves" ADD COLUMN "pricing_version" smallint DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "ads_serves" ADD COLUMN "billing_price_nanos" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "ads_serves" ADD CONSTRAINT "ads_serves_billing_price_nonnegative" CHECK ("billing_price_nanos" >= 0);
