import { assessPublisherTrafficQuality, type AcquisitionSourceClass, type PublisherTrafficAssessment } from './modules/delivery/traffic-quality-policy';

export interface PublisherTrafficObservationSummary {
  assessedCohorts: number;
  flaggedReportOnly: number;
}

export async function recordPublisherTrafficQualityObservations(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  window: { endAt?: Date },
): Promise<PublisherTrafficObservationSummary> {
  const endAt = window.endAt ?? new Date();
  const startAt = new Date(endAt.getTime() - 60 * 60 * 1000); // 1-hour rolling cohort

  const cohorts = await db.query(
    `SELECT
       i.promoter_id,
       i.website_id,
       count(DISTINCT COALESCE(i.cpc_visitor_key, i.ip_hash, i.id::text))::int AS visitor_count,
       count(DISTINCT i.ip_hash)::int AS distinct_ip_count,
       count(*) FILTER (WHERE i.type = 'click')::int AS click_count,
       count(DISTINCT i.campaign_id) FILTER (WHERE i.type = 'click')::int AS distinct_campaigns_clicked
     FROM ads_interactions i
     WHERE i.created_at >= $1
       AND i.created_at <= $2
       AND i.promoter_id IS NOT NULL
       AND i.website_id IS NOT NULL
     GROUP BY i.promoter_id, i.website_id
     HAVING count(*) FILTER (WHERE i.type = 'click') >= 5`,
    [startAt.toISOString(), endAt.toISOString()],
  );

  let assessedCohorts = 0;
  let flaggedReportOnly = 0;

  for (const row of cohorts.rows ?? []) {
    const assessment: PublisherTrafficAssessment = assessPublisherTrafficQuality(
      {
        promoterId: row.promoter_id,
        websiteId: row.website_id,
        visitorCount: Number(row.visitor_count ?? 0),
        distinctIpCount: Number(row.distinct_ip_count ?? 0),
        clickCount: Number(row.click_count ?? 0),
        baselineCtr: 0.02,
        medianRenderToClickMs: null,
        synchronizedBurstRatio: 0,
        dominantSourceShare: 0,
        dominantSourceClass: 'direct_or_unknown' as AcquisitionSourceClass,
        asnConcentrationRatio: 0,
        continuityRepeatClickCount: 0,
        distinctCampaignsClicked: Number(row.distinct_campaigns_clicked ?? 0),
        advertiserDisputeCount: 0,
      },
      'report_only',
    );

    await db.query(
      `INSERT INTO ads_publisher_traffic_assessments (
         promoter_id, website_id, window_start, window_end,
         visitor_count, distinct_ip_count, click_count, click_to_visit_ratio,
         high_signals, supporting_signals, model_version, enforcement_mode,
         disposition, would_quarantine_if_enforced
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14)`,
      [
        row.promoter_id,
        row.website_id,
        startAt.toISOString(),
        endAt.toISOString(),
        Number(row.visitor_count ?? 0),
        Number(row.distinct_ip_count ?? 0),
        Number(row.click_count ?? 0),
        assessment.clickToVisitRatio,
        JSON.stringify(assessment.highSignals),
        JSON.stringify(assessment.supportingSignals),
        assessment.modelVersion,
        assessment.enforcementMode,
        assessment.disposition,
        assessment.wouldQuarantineIfEnforced,
      ],
    );

    assessedCohorts += 1;
    if (assessment.wouldQuarantineIfEnforced) {
      flaggedReportOnly += 1;
    }
  }

  return { assessedCohorts, flaggedReportOnly };
}

