-- PLAN-0070 deterministic virtual allocation. No funded point or wallet writes.
CREATE TABLE cfig_event_reviews (
 id uuid PRIMARY KEY, event_id uuid NOT NULL REFERENCES ads_interactions(id), request_id uuid NOT NULL UNIQUE,
 fingerprint text NOT NULL, outcome text NOT NULL CHECK(outcome IN ('eligible','invalid')),
 actor_id uuid NOT NULL REFERENCES users(id), reason text NOT NULL, payload jsonb NOT NULL,
 key_id text NOT NULL, record_hash text NOT NULL, created_at timestamptz NOT NULL
);
CREATE INDEX cfig_reviews_event_time ON cfig_event_reviews(event_id,created_at,id);
CREATE TABLE cfig_period_budgets (
 month text PRIMARY KEY CHECK(month ~ '^\d{4}-\d{2}$'), policy_id uuid NOT NULL REFERENCES cfig_policies(id),
 snapshot jsonb NOT NULL, snapshot_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cfig_finalizations (
 day date PRIMARY KEY, request_id uuid NOT NULL UNIQUE, fingerprint text NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id), reason text NOT NULL, snapshot jsonb NOT NULL, snapshot_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cfig_allocations (
 event_id uuid PRIMARY KEY REFERENCES ads_interactions(id), day date NOT NULL REFERENCES cfig_finalizations(day),
 serve_id uuid NOT NULL REFERENCES ads_serves(id), promoter_id uuid NOT NULL REFERENCES ads_promoters(id),
 policy_id uuid REFERENCES cfig_policies(id), metric text NOT NULL, outcome text NOT NULL,
 entitled bigint NOT NULL CHECK(entitled>=0), allocated bigint NOT NULL CHECK(allocated>=0 AND allocated<=entitled),
 badge_eligible boolean NOT NULL, source_key text NOT NULL UNIQUE, review_id uuid REFERENCES cfig_event_reviews(id),
 source_snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cfig_allocations_month_promoter ON cfig_allocations(day,promoter_id);
CREATE TRIGGER cfig_reviews_immutable BEFORE UPDATE OR DELETE ON cfig_event_reviews FOR EACH ROW EXECUTE FUNCTION reject_cfig_history_mutation();
CREATE TRIGGER cfig_budgets_immutable BEFORE UPDATE OR DELETE ON cfig_period_budgets FOR EACH ROW EXECUTE FUNCTION reject_cfig_history_mutation();
CREATE TRIGGER cfig_finalizations_immutable BEFORE UPDATE OR DELETE ON cfig_finalizations FOR EACH ROW EXECUTE FUNCTION reject_cfig_history_mutation();
CREATE TRIGGER cfig_allocations_immutable BEFORE UPDATE OR DELETE ON cfig_allocations FOR EACH ROW EXECUTE FUNCTION reject_cfig_history_mutation();
