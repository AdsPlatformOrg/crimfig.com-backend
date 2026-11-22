-- Apply before the report access module. No contact values are stored in this ledger.
CREATE TABLE report_access_audit (
 position bigint PRIMARY KEY,
 actor_id uuid,
 actor_roles jsonb NOT NULL,
 action text NOT NULL,
 outcome text NOT NULL CHECK (outcome IN ('allowed','denied','failed')),
 scope jsonb NOT NULL,
 correlation_id uuid NOT NULL,
 reason_code text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 previous_hash text,
 entry_hash text NOT NULL
);
CREATE INDEX report_access_audit_actor_time_idx ON report_access_audit(actor_id,created_at DESC);
CREATE INDEX report_access_audit_time_idx ON report_access_audit(created_at DESC);
CREATE FUNCTION append_report_access_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous report_access_audit%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('report-access-audit-chain-v1',0));
 SELECT * INTO previous FROM report_access_audit ORDER BY position DESC LIMIT 1;
 NEW.position := coalesce(previous.position,0)+1;
 NEW.previous_hash := previous.entry_hash;
 NEW.created_at := clock_timestamp();
 NEW.entry_hash := encode(sha256(convert_to(jsonb_build_array(
  NEW.position,NEW.actor_id,NEW.actor_roles,NEW.action,NEW.outcome,NEW.scope,
  NEW.correlation_id,NEW.reason_code,to_char(NEW.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),NEW.previous_hash)::text,'UTF8')),'hex');
 RETURN NEW;
END $$;
CREATE TRIGGER report_access_append BEFORE INSERT ON report_access_audit FOR EACH ROW EXECUTE FUNCTION append_report_access_audit();
CREATE FUNCTION protect_report_access_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Report access audit is append-only' USING ERRCODE='55000'; END $$;
CREATE TRIGGER report_access_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON report_access_audit FOR EACH STATEMENT EXECUTE FUNCTION protect_report_access_audit();
REVOKE UPDATE,DELETE,TRUNCATE ON report_access_audit FROM PUBLIC;
CREATE TABLE report_access_alerts (
 actor_key text NOT NULL,
 kind text NOT NULL,
 hour_start timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(actor_key,kind,hour_start)
);
