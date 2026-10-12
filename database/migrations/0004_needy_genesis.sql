ALTER TABLE "billing_transactions" ADD COLUMN "gross_amount_usd_cents" integer;--> statement-breakpoint
ALTER TABLE "billing_transactions" ADD COLUMN "fee_amount_usd_cents" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "billing_transactions" ADD COLUMN "net_amount_usd_cents" integer;--> statement-breakpoint
ALTER TABLE "billing_transactions" ADD COLUMN "balance_before_usd_cents" integer;--> statement-breakpoint
ALTER TABLE "billing_transactions" ADD COLUMN "balance_after_usd_cents" integer;--> statement-breakpoint
ALTER TABLE "billing_transactions" ADD COLUMN "exchange_rate_numeric" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "billing_transactions" ADD COLUMN "ip_address" varchar(45);--> statement-breakpoint
ALTER TABLE "billing_transactions" ADD COLUMN "user_agent" text;