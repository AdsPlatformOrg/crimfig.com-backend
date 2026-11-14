CREATE TABLE IF NOT EXISTS reward_points_correction_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  model text NOT NULL CHECK (model IN ('cpc', 'cpm')),
  rate_version text NOT NULL,
  eligible_events bigint NOT NULL CHECK (eligible_events >= 0),
  issued_points bigint NOT NULL CHECK (issued_points >= 0),
  entitled_points bigint NOT NULL CHECK (entitled_points >= 0),
  unsupported_points bigint NOT NULL CHECK (unsupported_points >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS reward_points_correction_cohort_idx
  ON reward_points_correction_observations (user_id, model, rate_version, created_at DESC, id DESC);
--> statement-breakpoint
CREATE TRIGGER reward_points_correction_append_only
  BEFORE UPDATE OR DELETE ON reward_points_correction_observations
  FOR EACH ROW EXECUTE FUNCTION reject_cfig_history_mutation();
--> statement-breakpoint
DROP INDEX IF EXISTS cfig_ledger_event_kind_uq;
--> statement-breakpoint
CREATE UNIQUE INDEX cfig_ledger_event_kind_uq
  ON cfig_ledger (event_id, kind)
  WHERE kind IN ('accrue', 'clear');
--> statement-breakpoint
ALTER TABLE cfig_ledger DROP CONSTRAINT IF EXISTS cfig_ledger_moves;
--> statement-breakpoint
ALTER TABLE cfig_ledger ADD CONSTRAINT cfig_ledger_moves CHECK (
  (kind = 'accrue' AND pending_delta > 0 AND available_delta = 0 AND invalid_delta = 0 AND converted_delta = 0) OR
  (kind = 'clear' AND pending_delta < 0 AND available_delta = -pending_delta AND invalid_delta = 0 AND converted_delta = 0) OR
  (kind = 'invalidate' AND pending_delta <= 0 AND available_delta <= 0 AND invalid_delta > 0 AND invalid_delta = -(pending_delta + available_delta) AND converted_delta = 0) OR
  (kind = 'convert' AND pending_delta = 0 AND available_delta < 0 AND invalid_delta = 0 AND converted_delta = -available_delta) OR
  (kind = 'restore' AND converted_delta = 0 AND (
    (pending_delta >= 0 AND available_delta >= 0 AND (pending_delta + available_delta) > 0 AND invalid_delta <= 0 AND (invalid_delta = 0 OR invalid_delta = -(pending_delta + available_delta))) OR
    (pending_delta <= 0 AND available_delta <= 0 AND (pending_delta + available_delta) < 0 AND invalid_delta = 0)
  ))
);
