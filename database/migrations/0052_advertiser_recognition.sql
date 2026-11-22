CREATE FUNCTION advertiser_recognition_metadata(value text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN RETURN value::jsonb; EXCEPTION WHEN invalid_text_representation THEN RETURN NULL; END $$;
CREATE FUNCTION advertiser_recognition_amount(value jsonb) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN jsonb_typeof(value)='number' AND value::text ~ '^[0-9]+$' THEN value::text::numeric ELSE NULL END
$$;
CREATE INDEX IF NOT EXISTS ads_settlement_items_evidence_idx ON ads_promoter_settlement_items(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE advertiser_recognition_awards (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 advertiser_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 milestone_id text NOT NULL,
 qualifying_scope text NOT NULL DEFAULT 'lifetime',
 policy_version text NOT NULL,
 state text NOT NULL CHECK(state IN ('qualified','under_review','revoked')),
 first_qualified_at timestamptz NOT NULL DEFAULT now(),
 evaluated_at timestamptz NOT NULL DEFAULT now(),
 evidence jsonb NOT NULL,
 UNIQUE(advertiser_id,milestone_id,qualifying_scope)
);
CREATE TABLE advertiser_recognition_evaluations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 award_id uuid NOT NULL REFERENCES advertiser_recognition_awards(id) ON DELETE RESTRICT,
 previous_state text,
 state text NOT NULL,
 policy_version text NOT NULL,
 evidence jsonb NOT NULL,
 evaluated_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION protect_advertiser_recognition_evaluation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Recognition history is append-only' USING ERRCODE='55000'; END $$;
CREATE TRIGGER advertiser_recognition_history_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON advertiser_recognition_evaluations
 FOR EACH STATEMENT EXECUTE FUNCTION protect_advertiser_recognition_evaluation();
