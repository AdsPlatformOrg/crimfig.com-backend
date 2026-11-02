-- PLAN-0074: advisory coordination only; never consulted by decision authorization.
CREATE TABLE ads_moderation_claims (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 campaign_id uuid NOT NULL REFERENCES ads_campaigns(id) ON DELETE RESTRICT,
 target_type varchar(16) NOT NULL CHECK (target_type IN ('creative','stack','campaign')),
 target_id uuid NOT NULL,
 submission_id uuid NOT NULL REFERENCES ads_campaign_submissions(id) ON DELETE RESTRICT,
 content_revision integer NOT NULL CHECK (content_revision > 0),
 stage varchar(16) NOT NULL CHECK (stage IN ('reviewer','manager')),
 claimant_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 claimed_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 released_at timestamptz,
 CHECK (expires_at > claimed_at AND expires_at <= claimed_at + interval '60 minutes'),
 CONSTRAINT ads_moderation_claim_identity_uq UNIQUE(target_type,target_id,submission_id,content_revision,stage)
);
CREATE INDEX ads_moderation_claims_campaign_idx ON ads_moderation_claims(campaign_id);
--> statement-breakpoint
CREATE TABLE ads_moderation_claim_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 campaign_id uuid NOT NULL REFERENCES ads_campaigns(id) ON DELETE RESTRICT,
 claim_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL,
 action varchar(32) NOT NULL,
 reason text,
 before_claim jsonb,
 after_claim jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT ads_moderation_claim_event_request_uq UNIQUE(campaign_id,actor_id,request_id)
);
CREATE INDEX ads_moderation_claim_events_campaign_idx ON ads_moderation_claim_events(campaign_id,created_at);
--> statement-breakpoint
CREATE FUNCTION reject_moderation_claim_event_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Moderation claim events are append-only'; END; $$;
CREATE TRIGGER ads_moderation_claim_events_immutable BEFORE UPDATE OR DELETE ON ads_moderation_claim_events
FOR EACH ROW EXECUTE FUNCTION reject_moderation_claim_event_change();
