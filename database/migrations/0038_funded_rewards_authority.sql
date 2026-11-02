-- Reuse rewards_fund and rewards_points_*; no second funded wallet.
ALTER TABLE cfig_ledger ADD COLUMN converted_delta bigint NOT NULL DEFAULT 0;
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='cfig_ledger'::regclass AND contype='c' AND pg_get_constraintdef(oid) NOT ILIKE '%reason%' LOOP EXECUTE format('ALTER TABLE cfig_ledger DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE cfig_ledger DROP CONSTRAINT cfig_ledger_event_kind_uq;
CREATE UNIQUE INDEX cfig_ledger_event_kind_uq ON cfig_ledger(event_id,kind) WHERE kind<>'convert';
ALTER TABLE cfig_ledger ADD CONSTRAINT cfig_ledger_moves CHECK(
 (kind='accrue' AND pending_delta>0 AND available_delta=0 AND invalid_delta=0 AND converted_delta=0) OR
 (kind='clear' AND pending_delta<0 AND available_delta=-pending_delta AND invalid_delta=0 AND converted_delta=0) OR
 (kind='invalidate' AND pending_delta<=0 AND available_delta<=0 AND invalid_delta>0 AND invalid_delta=-(pending_delta+available_delta) AND converted_delta=0) OR
 (kind='convert' AND pending_delta=0 AND available_delta<0 AND invalid_delta=0 AND converted_delta=-available_delta));
CREATE TABLE reward_program_allocations (
 id uuid PRIMARY KEY,request_id uuid NOT NULL UNIQUE,fingerprint text NOT NULL,program text NOT NULL CHECK(program IN('paid_performance','house_conversion')),
 fund_id uuid NOT NULL REFERENCES rewards_fund(id),proof_id uuid NOT NULL UNIQUE REFERENCES billing_provider_events(id),
 backing_source_ref uuid NOT NULL UNIQUE REFERENCES rewards_fund_ledger(id),amount_cents bigint NOT NULL CHECK(amount_cents>0),policy_snapshot jsonb NOT NULL,created_by uuid NOT NULL REFERENCES users(id),
 approved_by uuid REFERENCES users(id),approval_request_id uuid UNIQUE,approved_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(approved_by IS NULL OR approved_by<>created_by),
 CHECK((approved_at IS NULL AND approved_by IS NULL AND approval_request_id IS NULL) OR (approved_at IS NOT NULL AND approved_by IS NOT NULL AND approval_request_id IS NOT NULL))
);
CREATE TABLE reward_program_issues (
 id uuid PRIMARY KEY,request_id uuid NOT NULL UNIQUE,fingerprint text NOT NULL,allocation_id uuid REFERENCES reward_program_allocations(id),
 user_id uuid NOT NULL REFERENCES users(id),kind text NOT NULL CHECK(kind IN('paid_loop','cfig_conversion','legacy_clearance')),
 points integer NOT NULL CHECK(points>0),micro_cfig bigint NOT NULL DEFAULT 0 CHECK(micro_cfig>=0),
 source_ref text NOT NULL UNIQUE,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reward_performance_receipts (
 event_id uuid PRIMARY KEY REFERENCES ads_interactions(id),request_id uuid NOT NULL UNIQUE,fingerprint text NOT NULL,serve_id uuid NOT NULL UNIQUE REFERENCES ads_serves(id),
 promoter_id uuid NOT NULL REFERENCES ads_promoters(id),user_id uuid NOT NULL REFERENCES users(id),model text NOT NULL CHECK(model IN('cpc','cpm')),
 allocation_id uuid NOT NULL REFERENCES reward_program_allocations(id),payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reward_issuance_periods (
 period text NOT NULL,kind text NOT NULL CHECK(kind IN('day','month')),cap_points integer NOT NULL CHECK(cap_points>=0),snapshot jsonb NOT NULL,
 PRIMARY KEY(period,kind)
);
CREATE TABLE reward_recovery_cases (
 id uuid PRIMARY KEY,request_id uuid NOT NULL UNIQUE,fingerprint text NOT NULL,issue_id uuid NOT NULL REFERENCES reward_program_issues(id),
 evidence_id uuid NOT NULL REFERENCES ads_event_assessments(id),actor_id uuid NOT NULL REFERENCES users(id),reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(issue_id,evidence_id)
);
CREATE TRIGGER reward_issues_immutable BEFORE UPDATE OR DELETE ON reward_program_issues FOR EACH ROW EXECUTE FUNCTION reject_cfig_history_mutation();
CREATE TRIGGER reward_receipts_immutable BEFORE UPDATE OR DELETE ON reward_performance_receipts FOR EACH ROW EXECUTE FUNCTION reject_cfig_history_mutation();
CREATE TRIGGER reward_periods_immutable BEFORE UPDATE OR DELETE ON reward_issuance_periods FOR EACH ROW EXECUTE FUNCTION reject_cfig_history_mutation();
CREATE TRIGGER reward_recovery_immutable BEFORE UPDATE OR DELETE ON reward_recovery_cases FOR EACH ROW EXECUTE FUNCTION reject_cfig_history_mutation();
CREATE FUNCTION protect_reward_allocation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Allocation history cannot be deleted'; END IF;
 IF OLD.approved_at IS NOT NULL OR NEW.policy_snapshot IS DISTINCT FROM OLD.policy_snapshot OR NEW.amount_cents<>OLD.amount_cents OR NEW.fund_id<>OLD.fund_id OR NEW.proof_id<>OLD.proof_id OR NEW.backing_source_ref<>OLD.backing_source_ref OR NEW.created_by<>OLD.created_by OR NEW.request_id<>OLD.request_id OR NEW.fingerprint<>OLD.fingerprint OR NEW.program<>OLD.program OR NEW.id<>OLD.id OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'Immutable allocation terms'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER reward_allocation_immutable BEFORE UPDATE OR DELETE ON reward_program_allocations FOR EACH ROW EXECUTE FUNCTION protect_reward_allocation();

-- Source-only attestations: these never create cash, issue points, or change balances.
CREATE TABLE reward_reconciliation_reviews (
 id uuid PRIMARY KEY,request_id uuid NOT NULL UNIQUE,fingerprint text NOT NULL,kind text NOT NULL CHECK(kind IN('backing','clearance')),
 source_id uuid NOT NULL,source_snapshot jsonb NOT NULL,source_hash text NOT NULL,prepared_by uuid NOT NULL REFERENCES users(id),
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 days')
);
CREATE TABLE reward_reconciliation_approvals (
 review_id uuid PRIMARY KEY REFERENCES reward_reconciliation_reviews(id),request_id uuid NOT NULL UNIQUE,
 proof_id uuid NOT NULL UNIQUE REFERENCES billing_provider_events(id),approved_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL
);
CREATE TRIGGER reward_reconciliation_reviews_immutable BEFORE UPDATE OR DELETE ON reward_reconciliation_reviews FOR EACH ROW EXECUTE FUNCTION reject_cfig_history_mutation();
CREATE TRIGGER reward_reconciliation_approvals_immutable BEFORE UPDATE OR DELETE ON reward_reconciliation_approvals FOR EACH ROW EXECUTE FUNCTION reject_cfig_history_mutation();
