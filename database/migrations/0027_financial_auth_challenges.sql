-- Additive only. Identity mappings require independent provisioning; no inferred person IDs or backfill approval.
CREATE TABLE auth_financial_identities (
 user_id uuid PRIMARY KEY REFERENCES users(id), person_id text NOT NULL,
 active boolean NOT NULL DEFAULT false, recovery_cleared_at timestamptz NOT NULL
);
CREATE TABLE auth_financial_challenges (
 id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES users(id), proposal jsonb NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5), expires_at timestamptz NOT NULL,
 proof jsonb, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((proof IS NULL) = (consumed_at IS NULL))
);
CREATE INDEX ON auth_financial_challenges(actor_id,created_at);
CREATE TABLE auth_financial_totp_uses (
 device_id uuid NOT NULL REFERENCES mfa_devices(id), step bigint NOT NULL CHECK(step >= 0),
 used_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(device_id,step)
);
CREATE FUNCTION protect_financial_challenge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
 OR NEW.proposal IS DISTINCT FROM OLD.proposal OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
 OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.attempts < OLD.attempts
 OR (OLD.consumed_at IS NOT NULL AND (NEW.proof IS DISTINCT FROM OLD.proof OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at))
 THEN RAISE EXCEPTION 'Financial challenge authorization is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER financial_challenge_immutable BEFORE UPDATE ON auth_financial_challenges FOR EACH ROW EXECUTE FUNCTION protect_financial_challenge();
CREATE FUNCTION hold_financial_identity_after_auth_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
 IF NEW.password_hash IS DISTINCT FROM OLD.password_hash OR NEW.mfa_enabled IS DISTINCT FROM OLD.mfa_enabled
 OR NEW.status IS DISTINCT FROM OLD.status THEN
   UPDATE public.auth_financial_identities SET active=false WHERE user_id=NEW.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER hold_financial_identity AFTER UPDATE OF password_hash,mfa_enabled,status ON users
 FOR EACH ROW EXECUTE FUNCTION hold_financial_identity_after_auth_change();
REVOKE ALL ON FUNCTION hold_financial_identity_after_auth_change() FROM PUBLIC;
-- Release provisioning must deny Billing access to these tables and deny Auth runtime writes to identity mappings.
