-- Additive migration. Historical approvals are intentionally NOT revision-certified.
ALTER TABLE ads_campaigns ADD COLUMN content_revision integer NOT NULL DEFAULT 1 CHECK (content_revision > 0),
 ADD COLUMN current_submission_id uuid, ADD COLUMN approved_submission_id uuid,
 ADD COLUMN approved_revision integer, ADD COLUMN submission_intent_id uuid, ADD COLUMN submitted_at timestamptz;
--> statement-breakpoint
CREATE TABLE ads_campaign_submissions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid NOT NULL REFERENCES ads_campaigns(id) ON DELETE RESTRICT,
 actor_id uuid NOT NULL, request_id uuid NOT NULL, content_revision integer NOT NULL,
 fingerprint varchar(64) NOT NULL, snapshot jsonb NOT NULL, state varchar(30) NOT NULL,
 funding_reference jsonb, created_at timestamptz NOT NULL DEFAULT now(), submitted_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ads_submission_request_uq ON ads_campaign_submissions(campaign_id,actor_id,request_id);
CREATE INDEX ads_submission_state_idx ON ads_campaign_submissions(state);
--> statement-breakpoint
CREATE TABLE ads_campaign_mutations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid NOT NULL REFERENCES ads_campaigns(id) ON DELETE RESTRICT,
 actor_id uuid NOT NULL, request_id uuid NOT NULL, action varchar(80) NOT NULL, fingerprint varchar(64) NOT NULL,
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ads_mutation_request_uq ON ads_campaign_mutations(campaign_id,actor_id,request_id);
--> statement-breakpoint
CREATE TABLE ads_campaign_changes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid NOT NULL REFERENCES ads_campaigns(id) ON DELETE RESTRICT,
 actor_id uuid NOT NULL, request_id uuid NOT NULL, action varchar(80) NOT NULL,
 prior_revision integer NOT NULL, content_revision integer NOT NULL, previous_submission_id uuid, submission_id uuid,
 before_hash varchar(64) NOT NULL, after_hash varchar(64) NOT NULL, changed_fields jsonb NOT NULL, entity_ids jsonb NOT NULL,
 before_snapshot jsonb NOT NULL, after_snapshot jsonb NOT NULL,
 policy_version varchar(40) NOT NULL DEFAULT 'campaign-audit-v1', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ads_campaign_changes_idx ON ads_campaign_changes(campaign_id,created_at);
--> statement-breakpoint
ALTER TABLE ads_moderation_decisions ADD COLUMN submission_id uuid, ADD COLUMN content_revision bigint,
 ADD COLUMN stage varchar(30), ADD COLUMN request_id uuid;
-- Keep old decisions as history; never backfill their authorization from timestamps.
ALTER TABLE ads_creative_stacks ADD COLUMN archived boolean NOT NULL DEFAULT false;
-- Old active campaigns fail the revision serving/activation gate until freshly submitted/reviewed.
