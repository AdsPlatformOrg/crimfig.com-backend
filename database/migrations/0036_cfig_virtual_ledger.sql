-- PLAN-0070: virtual promotional units only. No wallet/fund balances changed.
CREATE TABLE cfig_policies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL UNIQUE,
 fingerprint text NOT NULL, terms jsonb NOT NULL, created_by uuid NOT NULL REFERENCES users(id),
 approved_by uuid REFERENCES users(id), approval_request_id uuid UNIQUE, approval_reason text, created_at timestamptz NOT NULL DEFAULT now(), approved_at timestamptz,
 CHECK (approved_by IS NULL OR approved_by <> created_by),
 CHECK ((approved_at IS NULL AND approved_by IS NULL AND approval_request_id IS NULL AND approval_reason IS NULL) OR (approved_at IS NOT NULL AND approved_by IS NOT NULL AND approval_request_id IS NOT NULL AND length(approval_reason) BETWEEN 3 AND 500))
);
CREATE UNIQUE INDEX cfig_policy_version_uq ON cfig_policies ((terms->>'version'));
CREATE TABLE cfig_ledger (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL UNIQUE, fingerprint text NOT NULL,
 event_id uuid NOT NULL REFERENCES ads_interactions(id), promoter_id uuid NOT NULL REFERENCES ads_promoters(id),
 policy_id uuid NOT NULL REFERENCES cfig_policies(id), kind text NOT NULL CHECK(kind IN ('accrue','clear','invalidate')),
 pending_delta bigint NOT NULL, available_delta bigint NOT NULL, invalid_delta bigint NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id), reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
 created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT cfig_ledger_event_kind_uq UNIQUE(event_id,kind),
 CHECK ((kind='accrue' AND pending_delta>0 AND available_delta=0 AND invalid_delta=0)
 OR (kind='clear' AND pending_delta<0 AND available_delta=-pending_delta AND invalid_delta=0)
 OR (kind='invalidate' AND pending_delta<=0 AND available_delta<=0 AND invalid_delta>0 AND invalid_delta=-(pending_delta+available_delta)))
);
CREATE INDEX cfig_ledger_promoter_created ON cfig_ledger(promoter_id,created_at);
CREATE INDEX cfig_ledger_event_created ON cfig_ledger(event_id,created_at);
-- Appending compensating entries is the only supported mutation.
CREATE FUNCTION reject_cfig_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'cfig ledger is append-only'; END; $$;
CREATE TRIGGER cfig_ledger_immutable BEFORE UPDATE OR DELETE ON cfig_ledger
FOR EACH ROW EXECUTE FUNCTION reject_cfig_history_mutation();
-- Approved policy terms/identity cannot be repriced or removed.
CREATE FUNCTION protect_cfig_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'cfig policy history cannot be deleted'; END IF;
 IF OLD.approved_at IS NOT NULL OR NEW.terms IS DISTINCT FROM OLD.terms OR NEW.created_by<>OLD.created_by
 OR NEW.request_id<>OLD.request_id OR NEW.fingerprint<>OLD.fingerprint OR NEW.created_at<>OLD.created_at OR NEW.id<>OLD.id
 THEN RAISE EXCEPTION 'cfig policy is immutable except initial independent approval'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER cfig_policy_immutable BEFORE UPDATE OR DELETE ON cfig_policies
FOR EACH ROW EXECUTE FUNCTION protect_cfig_policy();
