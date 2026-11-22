ALTER TABLE ads_campaigns ADD COLUMN report_pseudonym varchar(40);
--> statement-breakpoint
CREATE UNIQUE INDEX ads_campaigns_report_pseudonym_uq ON ads_campaigns (report_pseudonym);
--> statement-breakpoint
CREATE FUNCTION assign_campaign_report_pseudonym() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  candidate text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.report_pseudonym IS NOT NULL THEN
    NEW.report_pseudonym := OLD.report_pseudonym;
    RETURN NEW;
  END IF;

  FOR attempt IN 1..8 LOOP
    candidate := 'ad-' || replace(gen_random_uuid()::text, '-', '');
    PERFORM pg_advisory_xact_lock(hashtextextended(candidate, 0));
    IF NOT EXISTS (SELECT 1 FROM ads_campaigns WHERE report_pseudonym = candidate) THEN
      NEW.report_pseudonym := candidate;
      RETURN NEW;
    END IF;
  END LOOP;
  RAISE EXCEPTION 'Could not allocate a campaign report pseudonym';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER assign_campaign_report_pseudonym
BEFORE INSERT OR UPDATE OF report_pseudonym ON ads_campaigns
FOR EACH ROW EXECUTE FUNCTION assign_campaign_report_pseudonym();
--> statement-breakpoint
CREATE FUNCTION backfill_campaign_report_pseudonyms() RETURNS integer LANGUAGE sql AS $$
  WITH batch AS (
    SELECT id FROM ads_campaigns
    WHERE report_pseudonym IS NULL
    ORDER BY id
    LIMIT 500
    FOR UPDATE SKIP LOCKED
  ), updated AS (
    UPDATE ads_campaigns AS campaign
    SET report_pseudonym = NULL
    FROM batch
    WHERE campaign.id = batch.id
    RETURNING campaign.id
  )
  SELECT count(*)::integer FROM updated;
$$;
