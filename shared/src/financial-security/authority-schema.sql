-- PLAN-0052: apply ONLY to a separately administered authority database.
-- Not included in ordinary Billing migrations. Runtime roles must not own tables or bypass triggers.
BEGIN;
CREATE SCHEMA IF NOT EXISTS financial_authority;
REVOKE ALL ON SCHEMA financial_authority FROM PUBLIC;
-- Written only by the independently administered readiness observer, SELECT-only for the executor.
CREATE TABLE financial_authority.runtime_readiness (
 id text PRIMARY KEY, ready boolean NOT NULL DEFAULT false, policy_version text NOT NULL,
 valid_until timestamptz NOT NULL, observed_at timestamptz NOT NULL DEFAULT clock_timestamp(), evidence_reference text NOT NULL,
 CHECK(valid_until > observed_at AND valid_until <= observed_at + interval '30 seconds')
);
CREATE TABLE financial_authority.workload_nonces (
 key_id text NOT NULL, nonce uuid NOT NULL, observed_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(key_id,nonce)
);
CREATE INDEX ON financial_authority.workload_nonces(key_id,observed_at);
CREATE TABLE financial_authority.intents (
 reference text PRIMARY KEY CHECK(reference ~ '^wd_[a-f0-9]{40}$'),
 digest text NOT NULL UNIQUE CHECK(digest ~ '^[a-f0-9]{64}$'),
 binding jsonb NOT NULL, owner_proof jsonb NOT NULL, reviews jsonb NOT NULL DEFAULT '[]',
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','started','unknown','submitted')),
 provider_receipt text, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE financial_authority.assessments (
 digest text PRIMARY KEY REFERENCES financial_authority.intents(digest),
 assessment jsonb NOT NULL, observed_at timestamptz NOT NULL
);
CREATE TABLE financial_authority.platform_admins (
 actor_id text PRIMARY KEY, person_id text NOT NULL, active boolean NOT NULL DEFAULT false,
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(), valid_until timestamptz NOT NULL,
 CHECK(valid_until > observed_at AND valid_until <= observed_at + interval '30 seconds')
);
CREATE TABLE financial_authority.used_nonces (
 nonce text PRIMARY KEY, reference text NOT NULL REFERENCES financial_authority.intents(reference),
 consumed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE financial_authority.admin_devices (
 key_id text PRIMARY KEY,actor_id text NOT NULL,person_id text NOT NULL,public_key text NOT NULL,active boolean NOT NULL DEFAULT false
);
CREATE TABLE financial_authority.admin_action_receipts (
 request_id uuid PRIMARY KEY,digest text NOT NULL,proofs jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE financial_authority.incident_subjects (
 incident_id text NOT NULL,person_id text NOT NULL,PRIMARY KEY(incident_id,person_id)
);
CREATE TABLE financial_authority.allocations (
 reference text PRIMARY KEY REFERENCES financial_authority.intents(reference),
 owner_id text NOT NULL, destination_id text NOT NULL, environment text NOT NULL CHECK(environment IN ('test','live')),
 amount_usd_cents bigint NOT NULL CHECK(amount_usd_cents > 0),
 outstanding boolean NOT NULL DEFAULT true, allocated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ON financial_authority.allocations(environment, allocated_at);
CREATE TABLE financial_authority.holds (
 scope text PRIMARY KEY, active boolean NOT NULL DEFAULT true, reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE financial_authority.audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, reference text NOT NULL, event text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE financial_authority.incidents (
 id text PRIMARY KEY, source text NOT NULL, event jsonb NOT NULL, severity text NOT NULL CHECK(severity IN ('RED','HIGH')),
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','acknowledged','contained','investigating','resolved','false_positive')),
 acknowledged_by text, acknowledged_at timestamptz, last_escalated_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE financial_authority.alert_deliveries (
 id text PRIMARY KEY, incident_id text NOT NULL REFERENCES financial_authority.incidents(id), recipient text NOT NULL,
 generation integer NOT NULL DEFAULT 0 CHECK(generation BETWEEN 0 AND 12),
 environment text NOT NULL CHECK(environment IN ('test','live')), severity text NOT NULL CHECK(severity IN ('RED','HIGH')),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','attempting','provider_accepted','delivery_confirmed','failed','unknown','test_disabled')),
 submission_due_at timestamptz NOT NULL, acknowledgement_due_at timestamptz NOT NULL,
 lease_token text, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(), provider_id text, failure_reason text,
 UNIQUE(incident_id,recipient,generation)
);
CREATE FUNCTION financial_authority.protect_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.reference IS DISTINCT FROM OLD.reference OR NEW.digest IS DISTINCT FROM OLD.digest
 OR NEW.binding IS DISTINCT FROM OLD.binding OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
 RAISE EXCEPTION 'Withdrawal intent is immutable'; END IF;
 IF OLD.state <> 'pending' AND (NEW.owner_proof IS DISTINCT FROM OLD.owner_proof OR NEW.reviews IS DISTINCT FROM OLD.reviews) THEN
 RAISE EXCEPTION 'Consumed authorization is immutable'; END IF;
 IF OLD.state <> 'pending' AND NEW.state = 'pending' THEN RAISE EXCEPTION 'Execution cannot be reset'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_intent BEFORE UPDATE ON financial_authority.intents FOR EACH ROW EXECUTE FUNCTION financial_authority.protect_intent();
CREATE FUNCTION financial_authority.reject_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Financial evidence is append-only'; END $$;
CREATE TRIGGER append_only_audit BEFORE UPDATE OR DELETE OR TRUNCATE ON financial_authority.audit FOR EACH STATEMENT EXECUTE FUNCTION financial_authority.reject_evidence_mutation();
CREATE TRIGGER append_only_nonces BEFORE UPDATE OR DELETE OR TRUNCATE ON financial_authority.used_nonces FOR EACH STATEMENT EXECUTE FUNCTION financial_authority.reject_evidence_mutation();
REVOKE ALL ON ALL TABLES IN SCHEMA financial_authority FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA financial_authority FROM PUBLIC;
COMMIT;
