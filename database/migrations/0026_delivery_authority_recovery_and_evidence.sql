ALTER TABLE ads_opportunity_reservations
 ADD COLUMN binding_fingerprint varchar(64),ADD COLUMN escrow_allocated_usd_cents bigint,
 ADD COLUMN submission_id uuid,ADD COLUMN content_revision integer,ADD COLUMN creative_id uuid,
 ADD COLUMN promoter_id uuid,ADD COLUMN website_id uuid,ADD COLUMN slot_id uuid,ADD COLUMN placement_id uuid,
 ADD COLUMN policy_version varchar(64),ADD COLUMN policy_snapshot jsonb,ADD COLUMN visitor_key varchar(64),
 ADD COLUMN event_deadline timestamptz,ADD COLUMN ingest_deadline timestamptz,ADD COLUMN claim_event_id uuid,ADD COLUMN settled_at timestamptz;
-- Historical rows have no authoritative receipt. Never silently promote simulations.
UPDATE ads_opportunity_reservations SET is_simulated=true WHERE binding_fingerprint IS NULL;
CREATE INDEX ads_opportunity_generation_idx ON ads_opportunity_reservations(escrow_id,escrow_allocated_usd_cents,state,settled_at);
--> statement-breakpoint
ALTER TABLE ads_serves ADD COLUMN opportunity_reservation_id uuid,ADD COLUMN submission_id uuid,
 ADD COLUMN content_revision bigint,ADD COLUMN content_snapshot jsonb;
CREATE UNIQUE INDEX ads_serve_reservation_uq ON ads_serves(opportunity_reservation_id) WHERE opportunity_reservation_id IS NOT NULL;
ALTER TABLE ads_interactions ALTER COLUMN placement_id DROP NOT NULL;
ALTER TABLE ads_promoter_settlement_items ALTER COLUMN placement_id DROP NOT NULL;
--> statement-breakpoint
CREATE TABLE ads_event_assessments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_id uuid NOT NULL,campaign_id uuid,
 request_id uuid NOT NULL UNIQUE,actor_id uuid NOT NULL,policy_version varchar(64) NOT NULL,outcome varchar(24) NOT NULL,
 reason_codes jsonb NOT NULL,features jsonb NOT NULL,supersedes_id uuid,record_hash varchar(64) NOT NULL,key_id varchar(40) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),CHECK(outcome IN ('eligible','quarantined','invalid'))
);
CREATE INDEX ads_assessment_event_idx ON ads_event_assessments(event_id,created_at);
CREATE TABLE ads_evidence_records (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_id uuid NOT NULL UNIQUE,sequence bigserial NOT NULL,
 partition varchar(80) NOT NULL,payload jsonb NOT NULL,previous_hash varchar(64),record_hash varchar(64) NOT NULL,
 key_id varchar(40) NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ads_evidence_partition_idx ON ads_evidence_records(partition,sequence);
CREATE FUNCTION reject_ad_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Ad evidence is append-only'; END $$;
CREATE TRIGGER ad_evidence_append_only BEFORE UPDATE OR DELETE ON ads_evidence_records FOR EACH ROW EXECUTE FUNCTION reject_ad_evidence_mutation();
CREATE TRIGGER ad_assessment_append_only BEFORE UPDATE OR DELETE ON ads_event_assessments FOR EACH ROW EXECUTE FUNCTION reject_ad_evidence_mutation();
--> statement-breakpoint
ALTER TABLE ads_campaign_submissions ADD COLUMN snapshot_hash varchar(64),ADD COLUMN purged_at timestamptz;
ALTER TABLE ads_campaign_mutations ADD COLUMN purged_at timestamptz;
ALTER TABLE ads_campaign_changes ADD COLUMN purged_at timestamptz;
CREATE TABLE ads_retention_holds(campaign_id uuid PRIMARY KEY REFERENCES ads_campaigns(id) ON DELETE RESTRICT,active boolean NOT NULL DEFAULT true,
 actor_id uuid NOT NULL,request_id uuid NOT NULL,reason text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
--> statement-breakpoint
CREATE TABLE error_monitor_source_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),service varchar(64) NOT NULL,environment varchar(32) NOT NULL,payload jsonb NOT NULL,
 status varchar(24) NOT NULL DEFAULT 'pending',attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_id uuid,lease_expires_at timestamptz,last_error_code varchar(64),created_at timestamptz NOT NULL DEFAULT now(),delivered_at timestamptz
);
CREATE INDEX error_source_outbox_due_idx ON error_monitor_source_outbox(service,status,next_attempt_at);
CREATE TABLE error_monitor_ingest_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),source_event_id uuid NOT NULL,service varchar(64) NOT NULL,environment varchar(32) NOT NULL,
 fingerprint varchar(64) NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX error_ingest_receipt_uq ON error_monitor_ingest_receipts(environment,service,source_event_id);

ALTER TABLE ads_serves ALTER COLUMN campaign_id DROP NOT NULL,ALTER COLUMN creative_id DROP NOT NULL,ALTER COLUMN slot_handle TYPE varchar(64);
ALTER TABLE ads_serves ADD CONSTRAINT ads_new_serve_inventory_contract CHECK ((inventory_class IN ('house','shadow') AND campaign_id IS NULL AND creative_id IS NULL AND billing_price_nanos=0 AND financial_eligibility='invalid') OR (inventory_class NOT IN ('house','shadow') AND campaign_id IS NOT NULL AND creative_id IS NOT NULL)) NOT VALID;

CREATE UNIQUE INDEX ads_interaction_client_event_uq ON ads_interactions(event_id) WHERE event_id IS NOT NULL;

ALTER TABLE ads_campaign_escrows ADD COLUMN release_pending boolean NOT NULL DEFAULT false;

--> statement-breakpoint
CREATE TABLE error_monitor_source_actions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),source_id uuid NOT NULL REFERENCES error_monitor_source_outbox(id),actor_id uuid NOT NULL,
 request_id uuid NOT NULL UNIQUE,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TRIGGER error_source_action_append_only BEFORE UPDATE OR DELETE ON error_monitor_source_actions FOR EACH ROW EXECUTE FUNCTION reject_ad_evidence_mutation();
CREATE TRIGGER ad_serve_append_only BEFORE UPDATE OR DELETE ON ads_serves FOR EACH ROW EXECUTE FUNCTION reject_ad_evidence_mutation();

--> statement-breakpoint
ALTER TABLE ads_promoter_websites ADD COLUMN verification_expires_at timestamptz;
-- Preserve the actual historical proof clock; never grant a new ownership period merely by migrating.
UPDATE ads_promoter_websites SET verification_expires_at=verified_at+interval '30 days' WHERE verification_status='verified' AND verified_at IS NOT NULL;

--> statement-breakpoint
CREATE FUNCTION protect_ad_observation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Ad observations cannot be deleted'; END IF;
 IF (to_jsonb(NEW)-'is_valid') IS DISTINCT FROM (to_jsonb(OLD)-'is_valid') THEN RAISE EXCEPTION 'Original ad observations are immutable'; END IF;
 RETURN NEW;
END $$;
-- Existing formal funded-rejection authority may update its legacy is_valid projection only.
CREATE TRIGGER ad_observation_immutable BEFORE UPDATE OR DELETE ON ads_interactions FOR EACH ROW EXECUTE FUNCTION protect_ad_observation();
