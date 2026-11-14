import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

import { Pool } from 'pg';
import * as schema from '@crimfig/database/schema';
import { OpportunityClient } from './modules/billing/opportunity-client';
import { DeliveryService } from './modules/delivery/delivery.service';
import { ImpressionTokenService } from './modules/delivery/impression-token.service';
import { AuctionEngineService } from './modules/delivery/auction-engine.service';
import { FraudRulesService } from './modules/verification/fraud-rules.service';
import { EvidenceService } from './modules/delivery/evidence.service';
import { AdOpportunityWorker } from '../../billing-api/src/modules/ecosystem/ad-opportunity.worker';
import { AdOpportunityService } from '../../billing-api/src/modules/ecosystem/ad-opportunity.service';
import { AdSettlementService } from '../../billing-api/src/modules/ecosystem/ad-settlement.service';
import { CampaignEscrowService } from '../../billing-api/src/modules/ecosystem/campaign-escrow.service';
import { applyEventCashRebates, restoreOverturnedEventCash } from './event-cash-rebate-reconciliation';
import { houseCfigCorrectionPreview, reconcileHouseCfigCorrections } from './house-cfig-correction-preview';
import { reconcilePaidPointsCorrections, recordPaidPointsCorrectionObservations } from './paid-points-correction-preview';
import { runClickAuditWindows } from './scheduled-click-audits';

const stagingId = '0a13e180-5261-4bc6-af55-60d9c37afbc5';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const policy = 'plan0104-signed-cpc-v1';

function assessmentId(eventId: string) {
  const digest = createHash('sha256').update(policy + ':' + eventId).digest('hex');
  return [digest.slice(0, 8), digest.slice(8, 12), '4' + digest.slice(13, 16),
    '8' + digest.slice(17, 20), digest.slice(20, 32)].join('-');
}

export async function processScheduledClicks() {
  const start = process.env.ADS_CPC_PROCESSOR_START ?? '';
  const actor = process.env.ADS_CPC_PROCESSOR_ACTOR ?? '';
  const campaigns = (process.env.ADS_CPC_PROCESSOR_CAMPAIGNS ?? '').split(',').map(id => id.trim());
  const database = new URL(process.env.DATABASE_URL ?? '');
  if (process.env.RAILWAY_ENVIRONMENT_ID !== stagingId ||
      process.env.RAILWAY_ENVIRONMENT_NAME !== 'staging' ||
      process.env.ADS_OPPORTUNITY_WORKER_ENABLED === 'true' ||
      !database.hostname.endsWith('.railway.internal') || !uuid.test(actor) ||
      campaigns.length > 50 || !campaigns.every(id => uuid.test(id)) ||
      !Number.isFinite(Date.parse(start)) || Date.parse(start) > Date.now() ||
      process.env.ADS_TRAFFIC_ASSESSMENT_POLICY_VERSION !== policy) {
    throw new Error('A controlled staging scope and the CPC assessment policy are required');
  }
  const pool = new Pool({ connectionString: database.href, max: 2, connectionTimeoutMillis: 5000,
    statement_timeout: 8000, lock_timeout: 5000 });
  let connection;
  try {
    connection = await pool.connect();
    const lock = await connection.query("select pg_try_advisory_lock(hashtext('ads:scheduled-clicks:v1')) as acquired");
    if (!lock.rows[0].acquired) return { status: 'busy' };
    const db = drizzle(pool, { schema });
    const actorRow = await db.execute(sql`select 1 from users where id = ${actor} and status = 'ACTIVE'`);
    if (!actorRow.rows.length) throw new Error('The CPC processor actor must be active');
    const scope = sql.join(campaigns.map(id => sql`${id}::uuid`), sql`, `);
    const opportunities = new OpportunityClient(new ConfigService());
    const evidence = new EvidenceService(db, opportunities);
    const delivery = new DeliveryService(db, new ImpressionTokenService(), new AuctionEngineService(),
      new FraudRulesService(), opportunities, evidence);
    await runClickAuditWindows(db, start);
    await db.execute(sql`
      with recoverable as (
        select receipt.id, e.id as interaction_id
        from ads_clicks receipt
        join ads_interactions e on e.event_id = receipt.id and e.serve_id = receipt.serve_id
          and e.promoter_id = receipt.promoter_id and e.type = 'click'
        join ads_serves s on s.id = receipt.serve_id and s.campaign_id = receipt.campaign_id
        where receipt.recording_reason = 'RECORDING_UNCONFIRMED' and receipt.interaction_id is null
          and receipt.campaign_id in (${scope}) and receipt.clicked_at >= ${start}::timestamptz
        order by receipt.clicked_at, receipt.id limit 50
      )
      update ads_clicks receipt set interaction_id = recoverable.interaction_id, recording_reason = null, recovery = null
      from recoverable where receipt.id = recoverable.id and receipt.interaction_id is null
    `);
    await db.execute(sql`
      with expired as (
        select id from ads_clicks where recovery is not null and interaction_id is null
          and campaign_id in (${scope}) and expires_at <= now()
        order by clicked_at, id limit 50
      )
      update ads_clicks receipt set recovery = null, recording_reason = 'RECOVERY_EXPIRED'
      from expired where receipt.id = expired.id and receipt.interaction_id is null
    `);
    const receipts = await db.execute<{ id: string }>(sql`
      select id from ads_clicks where recovery is not null and interaction_id is null
        and campaign_id in (${scope}) and clicked_at >= ${start}::timestamptz
        and expires_at > now() order by clicked_at, id limit 20
    `);
    const recoveryDeadline = Date.now() + 30_000;
    let recoveryFailures = 0;
    for (const receipt of receipts.rows) {
      if (Date.now() >= recoveryDeadline) break;
      try { await delivery.recoverRedirectAttempt(receipt.id); }
      catch { recoveryFailures++; }
    }
    const candidates = await db.execute<{ event_id: string }>(sql`
      select e.id as event_id from ads_opportunity_reservations r
      join ads_serves s on s.id = r.serve_id and s.opportunity_reservation_id = r.id
      join ads_interactions e on e.serve_id = s.id
      where r.campaign_id in (${scope}) and r.campaign_id = s.campaign_id
        and r.state in ('ISSUED', 'CLAIMED') and r.settled_at is null and not r.is_simulated
        and r.pricing_model = 'cpc' and s.pricing_model = 'cpc' and s.pricing_version = 2
        and s.inventory_class = 'paid' and s.delivery_mode = 'normal'
        and e.created_at >= ${start}::timestamptz and e.created_at between s.served_at and r.event_deadline
        and e.type = 'click' and e.verification_version = 2 and e.is_valid
        and e.assessment_status = 'validated' and e.financial_eligibility = 'pending'
        and e.promoter_id = s.promoter_id and e.website_id = s.website_id and e.slot_id = s.slot_id
        and (r.claim_event_id is null or r.claim_event_id = e.id)
        and exists (select 1 from ads_clicks receipt where receipt.serve_id = s.id
          and receipt.campaign_id = s.campaign_id and (receipt.interaction_id = e.id
          or (receipt.recording_reason = 'RECORDING_UNCONFIRMED' and receipt.id = e.event_id)))
        and not exists (select 1 from ads_event_assessments a where a.event_id = e.id)
        and not exists (select 1 from ads_interactions repeat where repeat.serve_id = s.id
          and repeat.type = 'click' and repeat.verification_version = 2 and repeat.is_valid and repeat.id <> e.id)
      order by e.created_at, e.id limit 50
    `);
    let assessmentFailures = 0;
    const deadline = Date.now() + 120_000;
    for (const candidate of candidates.rows) {
      if (Date.now() >= deadline) break;
      try {
        const analysis = await evidence.analyze(candidate.event_id);
        await evidence.assess(candidate.event_id, actor, {
          requestId: assessmentId(candidate.event_id), policyVersion: policy,
          outcome: analysis.integrity ? 'eligible' : 'quarantined',
          reasonCodes: [analysis.integrity ? 'SIGNED_REDIRECT_CLICK_VERIFIED' : 'CLICK_EVIDENCE_INTEGRITY_UNCONFIRMED'],
        });
      } catch {
        assessmentFailures++;
      }
    }
    const worker = new AdOpportunityWorker(db, new AdOpportunityService(db),
      new AdSettlementService(db), new CampaignEscrowService(db));
    await worker.tick({ campaigns, start, deadline: deadline + 60_000 });
    if (assessmentFailures || recoveryFailures) throw new Error('Some CPC assessments require retry');
    const window = { lower: start, upper: new Date().toISOString() };
    const cashRebates = await applyEventCashRebates(db, window);
    const cashRestores = await restoreOverturnedEventCash(db, window);
    const pointsReconciliation = await reconcilePaidPointsCorrections(db, window);
    const houseReconciliation = await reconcileHouseCfigCorrections(db, window);
    const points = await recordPaidPointsCorrectionObservations(db, window);
    const house = await houseCfigCorrectionPreview(db, window);
    return {
      status: 'processed',
      candidates: candidates.rows.length,
      cashRebates,
      cashRestores,
      pointsReconciliation,
      houseReconciliation,
      houseAwardsWithUnsupportedBalance: house.filter(award =>
        award.pendingMicroCfig !== '0' || award.availableMicroCfig !== '0' || award.convertedMicroCfig !== '0').length,
      pointsCohortsWithUnsupportedAwards: points.filter(cohort => cohort.unsupportedPoints !== '0').length,
    };
  } finally {
    connection?.release(true);
    await pool.end();
  }
}

if (require.main === module) {
  processScheduledClicks().then(result => console.log(JSON.stringify(result))).catch(() => {
    console.error('The staging CPC processor did not complete.');
    process.exitCode = 1;
  });
}
