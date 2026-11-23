CREATE TABLE platform_roles (
 key text PRIMARY KEY, label text NOT NULL, scopes text[] NOT NULL
);
CREATE TABLE platform_role_change_requests (
 id uuid PRIMARY KEY, target_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 role_key text NOT NULL REFERENCES platform_roles(key), scope text NOT NULL CHECK(scope IN ('ads','auth','billing','auth_finance')),
 action text NOT NULL CHECK(action IN ('grant','revoke')), reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
 requested_by uuid NOT NULL REFERENCES users(id), approved_by uuid REFERENCES users(id),
 expected_version integer NOT NULL CHECK(expected_version>=0), grant_expires_at timestamptz,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected')),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
 decided_at timestamptz, CHECK(approved_by IS NULL OR approved_by<>requested_by),
 CHECK((state='pending' AND approved_by IS NULL AND decided_at IS NULL) OR (state IN ('approved','rejected') AND approved_by IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE TABLE platform_user_role_grants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 role_key text NOT NULL REFERENCES platform_roles(key), scope text NOT NULL CHECK(scope IN ('ads','auth','billing','auth_finance')),
 state text NOT NULL CHECK(state IN ('active','revoked')), valid_from timestamptz NOT NULL DEFAULT now(), expires_at timestamptz,
 version integer NOT NULL DEFAULT 1 CHECK(version>0), change_request_id uuid REFERENCES platform_role_change_requests(id),
 source text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,role_key,scope),
 CHECK(expires_at IS NULL OR expires_at>valid_from)
);
CREATE INDEX platform_grants_lookup_idx ON platform_user_role_grants(user_id,scope,state);
CREATE TABLE platform_role_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid REFERENCES platform_role_change_requests(id),
 target_user_id uuid NOT NULL REFERENCES users(id), role_key text NOT NULL REFERENCES platform_roles(key), scope text NOT NULL,
 action text NOT NULL, actor_id uuid REFERENCES users(id), approver_id uuid REFERENCES users(id),
 reason text NOT NULL, before_state jsonb, after_state jsonb NOT NULL, source text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX platform_role_bootstrap_once_idx ON platform_role_audit(target_user_id,role_key,scope,source) WHERE action='bootstrap';
CREATE INDEX platform_role_audit_time_idx ON platform_role_audit(created_at DESC);
CREATE FUNCTION protect_platform_role_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Platform role audit is append-only' USING ERRCODE='55000'; END $$;
CREATE TRIGGER platform_role_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON platform_role_audit
 FOR EACH STATEMENT EXECUTE FUNCTION protect_platform_role_audit();
CREATE FUNCTION protect_platform_role_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Role request history cannot be removed'; END IF;
 IF OLD.state<>'pending' OR NEW.id<>OLD.id OR NEW.target_user_id<>OLD.target_user_id OR NEW.role_key<>OLD.role_key
  OR NEW.scope<>OLD.scope OR NEW.action<>OLD.action OR NEW.reason<>OLD.reason OR NEW.requested_by<>OLD.requested_by
  OR NEW.expected_version<>OLD.expected_version OR NEW.grant_expires_at IS DISTINCT FROM OLD.grant_expires_at
  OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at
 THEN RAISE EXCEPTION 'Role approval proposal is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER platform_role_request_immutable BEFORE UPDATE OR DELETE ON platform_role_change_requests
 FOR EACH ROW EXECUTE FUNCTION protect_platform_role_request();
CREATE TRIGGER platform_role_request_no_truncate BEFORE TRUNCATE ON platform_role_change_requests
 FOR EACH STATEMENT EXECUTE FUNCTION protect_platform_role_audit();
INSERT INTO platform_roles(key,label,scopes) VALUES
 ('super_admin','Platform Admin',ARRAY['ads','auth','billing','auth_finance']),
 ('ads_admin','Ads Administrator',ARRAY['ads']),('ads_reviewer','Ads Reviewer',ARRAY['ads']),
 ('ads_manager','Ads Manager',ARRAY['ads']),('ads_finance','Ads Finance',ARRAY['ads']),
 ('ads_support','Ads Support',ARRAY['ads']),('report_auditor','Report Auditor',ARRAY['ads']),
 ('report_contact_reveal','Report Contact Reviewer',ARRAY['ads']),
 ('auth_admin','Identity Administrator',ARRAY['auth']),('security_admin','Security Administrator',ARRAY['auth']),
 ('compliance_officer','Compliance Officer',ARRAY['auth']),('support_agent','Support Agent',ARRAY['auth']),
 ('billing_admin','Billing Administrator',ARRAY['billing']),('billing_manager','Billing Manager',ARRAY['billing']),
 ('billing_support','Billing Support',ARRAY['billing']),('billing_auditor','Billing Auditor',ARRAY['billing']);
