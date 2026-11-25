import { sql } from 'drizzle-orm';

/** Effective launch cutoff: 23 November 2026, 00:00 Africa/Lagos = 22 November 2026, 23:00:00 UTC (inclusive). */
export const REWARDS_LAUNCH_CUTOFF_UTC = '2026-11-22T23:00:00.000Z';

export interface CampaignEvidence {
  id: string;
  completed: boolean;
  qualifying?: boolean;
  eligible: boolean;
  preCutoffOnly?: boolean;
  clearedSpendCents: number | null;
}
export interface MilestoneEvidence {
  totalCampaigns: number;
  fundingVerified: boolean;
  tenureMonths?: number;
  complianceClean?: boolean;
  underInvestigation?: boolean;
  confirmedFraud?: boolean;
  campaigns: CampaignEvidence[];
}

/**
 * Authoritative single-snapshot milestone evidence reader (PLAN-0149 / PLAN-0154 / PLAN-0155).
 * - Counts eligible cash spend whose authoritative clearance timestamp (i.cleared_at) is on or after
 *   REWARDS_LAUNCH_CUTOFF_UTC (2026-11-22T23:00:00Z), including older campaigns created prior to launch.
 * - Includes verified cleared spend from continuously running ('active' / 'paused') as well as 'completed'
 *   approved cash campaigns, while excluding confirmed invalid events and bonus-credit campaigns.
 * - Computes exact calendar-month tenure and distinguishes unresolved confirmed violations from pending
 *   investigations (which hold only new A4 and Prestige claims per JED's Section 2 decision).
 */
export async function readMilestoneEvidence(db: any, advertiserId: string): Promise<MilestoneEvidence> {
  const result = await db.execute(sql`
    WITH ledger AS (
      SELECT t.*,advertiser_recognition_metadata(t.metadata) AS meta
      FROM billing_transactions t WHERE t.user_id=${advertiserId}::uuid
    ), checked_ledger AS (
      SELECT l.*,CASE
        WHEN status IN ('pending','failed') AND type='wallet_fund' THEN true
        WHEN status <> 'completed' THEN false
        WHEN type='wallet_fund' THEN provider='paystack' AND amount_usd_cents>0
          AND idempotency_key='wallet-fund:v2:'||id::text
          AND meta->>'fundingVersion'='2' AND meta->'fundingCompletion'->>'version'='2'
          AND meta->'fundingCompletion'->>'domain'='live'
          AND meta->'fundingCompletion'->>'reference'=reference
          AND meta->'fundingCompletion'->>'currency'='NGN'
          AND advertiser_recognition_amount(meta->'fundingCompletion'->'amountNgnKobo')=amount_ngn_kobo
          AND amount_ngn_kobo>0
        WHEN type='ads_spend' THEN provider='internal' AND amount_usd_cents>0
          AND meta->>'version'='3' AND meta->>'kind'='funded_ad_spend'
          AND reference='ads-spend-v3-'||(meta->>'batchId')
          AND idempotency_key LIKE 'ads-settlement:v3:%'
          AND EXISTS (SELECT 1 FROM ads_settlement_batches b WHERE b.id::text=meta->>'batchId'
            AND b.idempotency_key=l.idempotency_key AND b.status='completed' AND b.total_debited_usd_cents=l.amount_usd_cents)
        WHEN type IN ('internal_debit','internal_credit') THEN provider='internal'
          AND meta->>'version'='2' AND meta->>'kind'='campaign_escrow'
          AND ((type='internal_debit' AND meta->>'action'='reserve') OR (type='internal_credit' AND meta->>'action'='release'))
          AND idempotency_key='ads-escrow:v2:'||(meta->>'escrowId')||':'||(meta->>'action')||':'||(meta->>'allocatedUsdCents')
          AND balance_before_usd_cents IS NOT NULL AND balance_after_usd_cents IS NOT NULL
          AND balance_after_usd_cents-balance_before_usd_cents
            +advertiser_recognition_amount(meta->'lockedAfterUsdCents')-advertiser_recognition_amount(meta->'lockedBeforeUsdCents')=0
        ELSE false END AS supported
      FROM ledger l
    ), cash_wallet AS (
      SELECT coalesce(bool_and(supported IS TRUE),false)
        AND coalesce(sum(amount_usd_cents) FILTER (WHERE type='wallet_fund' AND status='completed'),0)>0
        AND coalesce(sum(CASE WHEN type='wallet_fund' AND status='completed' THEN amount_usd_cents
          WHEN type='ads_spend' AND status='completed' THEN -amount_usd_cents ELSE 0 END),0)
          =(SELECT balance_usd_cents::numeric+locked_usd_cents FROM billing_wallets WHERE user_id=${advertiserId}::uuid)
        AS verified FROM checked_ledger
    ), campaigns AS (
      SELECT c.*,u.status AS account_status FROM ads_campaigns c JOIN users u ON u.id=c.advertiser_id
      WHERE c.advertiser_id=${advertiserId}::uuid
    ), items AS (
      SELECT i.id,i.campaign_id,i.billed_usd_cents,i.cleared_at,
        i.status='credited' AND i.clearance_status='cleared' AND i.cleared_at IS NOT NULL
        AND i.hold_expires_at IS NOT NULL AND i.cleared_at>=i.hold_expires_at AND i.cleared_at<=now()
        AND i.billed_usd_cents>0 AND r.type='ads_earning' AND r.provider='internal' AND r.status='completed'
        AND r.user_id=p.user_id AND r.amount_usd_cents=i.earned_usd_cents AND r.gross_amount_usd_cents=i.billed_usd_cents
        AND r.idempotency_key='ads-earning:v3:'||i.id::text
        AND m.value->>'version'='3' AND m.value->>'kind'='funded_ad_earning'
        AND m.value->>'itemId'=i.id::text AND m.value->>'campaignId'=i.campaign_id::text
        AND m.value->>'batchId'=i.batch_id::text AND m.value->>'promoterId'=i.promoter_id::text
        AND m.value->>'escrowId'=claim.escrow_id::text AND m.value->>'settlementClaimId'=claim.interaction_id::text
        AND claim.promoter_id=i.promoter_id AND s.promoter_id=i.promoter_id
        AND e.promoter_id=i.promoter_id AND e.serve_id=s.id
        AND escrow.campaign_id=i.campaign_id AND escrow.user_id=c.advertiser_id AND NOT escrow.release_pending
        AND s.campaign_id=i.campaign_id AND s.inventory_class='paid' AND s.delivery_mode='normal'
        AND s.financial_eligibility='eligible' AND s.traffic_risk_status NOT IN ('high_risk','confirmed_fraud')
        AND e.is_valid AND e.verification_version=2 AND e.financial_eligibility='eligible'
        AND e.assessment_status <> 'invalidated'
        AND batch.status='completed' AND spend.supported IS TRUE
        AND spend.meta->>'campaignId'=i.campaign_id::text
        AND (SELECT coalesce(sum(all_items.billed_usd_cents),0) FROM ads_promoter_settlement_items all_items WHERE all_items.batch_id=i.batch_id)=spend.amount_usd_cents
        AND reserve.supported IS TRUE AND reserve.user_id=${advertiserId}::uuid
        AND reserve.meta->>'campaignId'=i.campaign_id::text
        AND advertiser_recognition_amount(reserve.meta->'allocatedUsdCents')=claim.allocated_usd_cents
        AND d.processed AND d.event_type='internal.ad.clearance' AND d.reference='internal.ad.clearance:'||i.id::text
        AND d.raw_payload->>'version'='3' AND d.raw_payload->>'itemId'=i.id::text
        AND advertiser_recognition_amount(d.raw_payload->'amountUsdCents')=i.earned_usd_cents
        AND advertiser_recognition_amount(d.raw_payload->'billedUsdCents')=i.billed_usd_cents
        AND d.raw_payload->>'evidenceId'=m.value->'clearance'->>'evidenceId'
        AND d.raw_payload->>'preparedBy'=m.value->'clearance'->>'preparedBy'
        AND m.value->'clearance'->>'preparedBy' <> m.value->'clearance'->>'reviewedBy'
        AND length(m.value->'clearance'->>'evidenceId')>0
        AND NOT EXISTS (SELECT 1 FROM ads_settlement_claims related
          JOIN ads_interactions prior_event ON prior_event.id=related.interaction_id
          JOIN ads_serves prior_serve ON prior_serve.id=related.serve_id
          WHERE related.escrow_id=claim.escrow_id AND related.allocated_usd_cents=claim.allocated_usd_cents AND related.promoter_id=claim.promoter_id
            AND (NOT prior_event.is_valid OR prior_event.verification_version<>2 OR prior_event.financial_eligibility IN ('invalid','quarantined')
              OR prior_event.assessment_status='invalidated' OR prior_serve.inventory_class<>'paid' OR prior_serve.delivery_mode<>'normal'
              OR prior_serve.financial_eligibility IN ('invalid','quarantined') OR prior_serve.traffic_risk_status IN ('high_risk','confirmed_fraud')))
        AND (SELECT count(*) FROM ads_promoter_settlement_items dup WHERE dup.idempotency_key=i.idempotency_key)=1
        AS verified
      FROM ads_promoter_settlement_items i JOIN campaigns c ON c.id=i.campaign_id
      LEFT JOIN billing_transactions r ON r.id=i.billing_transaction_id
      LEFT JOIN LATERAL (SELECT advertiser_recognition_metadata(r.metadata) AS value) m ON true
      LEFT JOIN ads_promoters p ON p.id=i.promoter_id
      LEFT JOIN ads_settlement_claims claim ON i.idempotency_key='ads-item:v3:'||claim.interaction_id::text
      LEFT JOIN ads_campaign_escrows escrow ON escrow.id=claim.escrow_id
      LEFT JOIN ads_serves s ON s.id=claim.serve_id
      LEFT JOIN ads_interactions e ON e.id=claim.interaction_id
      LEFT JOIN ads_settlement_batches batch ON batch.id=i.batch_id AND claim.batch_id=batch.id
      LEFT JOIN checked_ledger spend ON spend.reference='ads-spend-v3-'||i.batch_id::text
      LEFT JOIN checked_ledger reserve ON reserve.idempotency_key='ads-escrow:v2:'||claim.escrow_id::text||':reserve:'||claim.allocated_usd_cents::text
      LEFT JOIN billing_provider_events d ON d.id::text=m.value->'clearance'->>'draftId'
    ), campaign_evidence AS (
      SELECT c.id,
        c.status='completed' AS completed,
        c.status IN ('active','paused','completed') AS qualifying,
        c.account_status='ACTIVE' AND c.status IN ('active','paused','completed') AND c.moderation_status='approved'
        AND c.is_bonus_delivery=false AND c.current_submission_id=c.approved_submission_id
        AND c.approved_revision=c.content_revision AND c.submission_intent_id IS NULL
        AND EXISTS (SELECT 1 FROM ads_moderation_decisions md WHERE md.target_type='campaign' AND md.target_id=c.id
          AND md.submission_id=c.approved_submission_id AND md.content_revision=c.approved_revision
          AND md.decision='approved' AND md.stage IN ('manager','override') AND md.reviewer_id<>c.advertiser_id)
        AND coalesce((SELECT bool_and(i.verified IS TRUE) FROM items i WHERE i.campaign_id=c.id),false)
        AND NOT EXISTS (SELECT 1 FROM ads_settlement_rebates rb WHERE rb.campaign_id=c.id AND rb.status IN ('completed','pending_admin_signoff'))
        AND (c.status <> 'completed' OR NOT EXISTS (SELECT 1 FROM ads_opportunity_reservations op WHERE op.campaign_id=c.id AND NOT op.is_simulated
          AND op.settled_at IS NULL AND op.state IN ('HELD','ISSUED','CLAIMED')))
        AS eligible,
        coalesce((
          SELECT sum(i.billed_usd_cents)
          FROM items i
          WHERE i.campaign_id=c.id
            AND i.verified IS TRUE
            AND i.cleared_at >= ${REWARDS_LAUNCH_CUTOFF_UTC}::timestamptz
        ),0)::text AS cleared_spend
      FROM campaigns c
    )
    SELECT (SELECT count(*)::text FROM campaigns) AS total,
      coalesce((SELECT verified FROM cash_wallet),false) AS funding_verified,
      coalesce((
        SELECT (EXTRACT(YEAR FROM age(now(), coalesce((to_jsonb(u)->>'created_at')::timestamptz, now())))::int * 12
              + EXTRACT(MONTH FROM age(now(), coalesce((to_jsonb(u)->>'created_at')::timestamptz, now())))::int)
        FROM users u WHERE u.id=${advertiserId}::uuid LIMIT 1
      ), 0) AS tenure_months,
      coalesce((SELECT u.status = 'ACTIVE' FROM users u WHERE u.id=${advertiserId}::uuid LIMIT 1), false)
        AND NOT EXISTS (SELECT 1 FROM campaigns c JOIN ads_settlement_rebates rb ON rb.campaign_id=c.id WHERE rb.status='completed')
        AND NOT EXISTS (SELECT 1 FROM campaigns c WHERE c.status='suspended')
        AS compliance_clean,
      EXISTS (SELECT 1 FROM campaigns c JOIN ads_settlement_rebates rb ON rb.campaign_id=c.id WHERE rb.status='pending_admin_signoff') AS rebate_under_investigation,
      (
        EXISTS (SELECT 1 FROM campaigns c JOIN ads_settlement_rebates rb ON rb.campaign_id=c.id WHERE rb.status='completed')
        OR EXISTS (SELECT 1 FROM campaigns c WHERE c.status='suspended')
      ) AS confirmed_fraud,
      coalesce(jsonb_agg(jsonb_build_object('id',id,'completed',completed,'qualifying',qualifying,'eligible',eligible,'clearedSpend',cleared_spend)),'[]'::jsonb) AS campaigns
    FROM campaign_evidence
  `);
  const row = result.rows[0];

  // Check optional compliance alert/dispute tables via to_regclass first so missing tables in minimal
  // schema test fixtures NEVER raise a SQL error that aborts an enclosing PostgreSQL transaction!
  let alertInvestigation = false;
  let disputeViolation = false;
  const regRes = await db.execute(sql`
    SELECT
      to_regclass('public.platform_admin_silent_alerts') IS NOT NULL AS has_alerts,
      to_regclass('public.ads_disputes') IS NOT NULL AS has_disputes
  `);
  const reg = (regRes.rows ?? regRes)[0] ?? {};
  if (reg.has_alerts === true) {
    const alertRes = await db.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM platform_admin_silent_alerts a
        WHERE a.advertiser_id = ${advertiserId}::uuid
          AND a.category = 'compliance_flag'
          AND a.status = 'open'
      ) AS flag_open
    `);
    alertInvestigation = Boolean((alertRes.rows ?? alertRes)[0]?.flag_open);
  }
  if (reg.has_disputes === true) {
    const dispRes = await db.execute(sql`
      SELECT
        EXISTS (
          SELECT 1 FROM ads_disputes d
          JOIN ads_campaigns c ON c.id = d.campaign_id
          WHERE c.advertiser_id = ${advertiserId}::uuid
            AND d.status IN ('open', 'under_review')
        ) AS disp_open,
        EXISTS (
          SELECT 1 FROM ads_disputes d
          JOIN ads_campaigns c ON c.id = d.campaign_id
          WHERE c.advertiser_id = ${advertiserId}::uuid
            AND d.role = 'promoter'
            AND d.status = 'resolved_upheld'
        ) AS disp_upheld
    `);
    const dr = (dispRes.rows ?? dispRes)[0] ?? {};
    alertInvestigation = alertInvestigation || dr.disp_open === true;
    disputeViolation = dr.disp_upheld === true;
  }

  const confirmedFraud = row.confirmed_fraud === true || disputeViolation;
  const complianceClean = row.compliance_clean === true && !disputeViolation;
  const underInvestigation = row.rebate_under_investigation === true || alertInvestigation;

  return {
    totalCampaigns: Number(row.total),
    fundingVerified: row.funding_verified === true,
    tenureMonths: Number(row.tenure_months ?? 0),
    complianceClean,
    underInvestigation,
    confirmedFraud,
    campaigns: row.campaigns.map((campaign: any) => {
      const cents = Number(campaign.clearedSpend);
      const safe = Number.isSafeInteger(cents) && cents >= 0;
      return {
        id: campaign.id,
        completed: campaign.completed === true,
        qualifying: campaign.qualifying === true,
        eligible: row.funding_verified === true && campaign.eligible === true && safe && cents > 0,
        preCutoffOnly: row.funding_verified === true && campaign.eligible === true && safe && cents === 0,
        clearedSpendCents: safe ? cents : null,
      };
    }),
  };
}
