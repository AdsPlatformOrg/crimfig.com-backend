-- Preserve the six-decimal FX snapshot already used by billing calculations.
-- Historical snapshots remain nullable because the original applied rate may be unknown.
ALTER TABLE "billing_transactions"
  ALTER COLUMN "exchange_rate_numeric" TYPE numeric(18, 6);
