import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { OpportunityClient } from './modules/billing/opportunity-client';
import { EvidenceService } from './modules/delivery/evidence.service';

const stagingEnvironment = '0a13e180-5261-4bc6-af55-60d9c37afbc5';
const uuid = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const policy = 'plan0104-staging-controlled-cpc-v1';

function requestIdentity(kind: string, eventId: string) {
  const hash = createHash('sha256').update('plan0104:'+kind+':'+eventId).digest('hex');
  return [hash.slice(0,8), hash.slice(8,12), '4'+hash.slice(13,16),
    '8'+hash.slice(17,20), hash.slice(20,32)].join('-');
}

export async function runControlledClickSettlement() {
  const campaign = process.env.ADS_CONTROLLED_CPC_CAMPAIGN ?? '';
  const receiptId = process.env.ADS_CONTROLLED_CPC_RECEIPT ?? '';
  const queueEnabled = process.env.ADS_CONTROLLED_CPC_QUEUE === 'true';
  const start = new Date(process.env.ADS_CONTROLLED_CPC_START ?? '');
  const end = new Date(process.env.ADS_CONTROLLED_CPC_END ?? '');
  if (process.env.RAILWAY_ENVIRONMENT_ID !== stagingEnvironment ||
      process.env.RAILWAY_ENVIRONMENT_NAME !== 'staging' || !uuid.test(campaign) ||
      (queueEnabled ? receiptId.length > 0 : !/^clk_[a-z0-9]+_[0-9a-f]+$/.test(receiptId)) ||
      !Number.isFinite(start.getTime()) || start >= new Date() ||
      (queueEnabled && (!Number.isFinite(end.getTime()) || end <= start || end >= new Date() ||
        end.getTime() - start.getTime() > 15000))) {
    throw new Error('Controlled settlement requires an explicit staging campaign and start time');
  }
  const database = new URL(process.env.DATABASE_URL ?? '');
  const billing = new URL(process.env.BILLING_API_URL ?? '');
  const internalKey = process.env.INTERNAL_ECOSYSTEM_KEY;
  if (!database.hostname.endsWith('.railway.internal') ||
      !(billing.hostname.endsWith('.railway.internal') || /^billing-api-staging[.-]/.test(billing.hostname)) ||
      !['https:', 'http:'].includes(billing.protocol) || billing.username || billing.password || !internalKey) {
    throw new Error('Staging database and Billing authority are required');
  }
  const pool = new Pool({connectionString: database.href, max: 1,
    connectionTimeoutMillis: 5000, statement_timeout: 8000});
  try {
    const db = drizzle(pool);
    const config = { get: (name: string) => process.env[name] };
    const evidence = new EvidenceService(db, new OpportunityClient(config as never));
    process.env.ADS_TRAFFIC_ASSESSMENT_POLICY_VERSION = policy;
    const candidates = await db.execute<{id: string; created_at: Date | string; prior_request: string | null}>(sql`
      select i.id, i.created_at, assessment.request_id as prior_request
      from ads_opportunity_reservations r
      join ads_serves s on s.id = r.serve_id and s.opportunity_reservation_id = r.id
      join ads_interactions i on i.id = r.claim_event_id and i.serve_id = s.id
      left join lateral (
        select request_id, outcome, policy_version from ads_event_assessments where event_id = i.id
        order by created_at desc, id desc limit 1
      ) assessment on true
      where r.campaign_id = ${campaign} and s.campaign_id = r.campaign_id
        and r.state = 'CLAIMED' and r.settled_at is null and not r.is_simulated
        and s.inventory_class = 'paid' and s.delivery_mode = 'normal' and s.pricing_version = 2
        and s.pricing_model = 'cpc' and r.pricing_model = s.pricing_model
        and r.reserved_nanos = s.billing_price_nanos and r.reserved_nanos = 100000000
        and s.placement_id is null and i.placement_id is null
        and i.type = 'click' and i.verification_version = 2 and i.is_valid
        and i.assessment_status = 'validated' and i.financial_eligibility = 'pending'
        and i.created_at >= ${start.toISOString()} and i.created_at >= s.served_at
        and i.created_at <= r.event_deadline
        ${queueEnabled ? sql`and i.created_at < ${end.toISOString()}` : sql``}
        and i.promoter_id = s.promoter_id and s.promoter_id = r.promoter_id
        and i.website_id = s.website_id and s.website_id = r.website_id
        and i.slot_id = s.slot_id and s.slot_id = r.slot_id
        and s.creative_id = r.creative_id and s.submission_id = r.submission_id
        and s.content_revision = r.content_revision and s.policy_version = r.policy_version
        and s.request_id = r.opportunity_id
        and exists (select 1 from ads_clicks receipt where receipt.interaction_id = i.id
          and receipt.serve_id = s.id and receipt.campaign_id = r.campaign_id
          ${queueEnabled ? sql`` : sql`and receipt.click_id = ${receiptId}`})
        and (assessment.request_id is null or
          (assessment.outcome = 'eligible' and assessment.policy_version = ${policy}))
        and not exists (select 1 from ads_interactions duplicate
          where duplicate.serve_id = s.id and duplicate.type = 'click'
            and duplicate.is_valid and duplicate.id <> i.id)
        and not exists (select 1 from ads_opportunity_reservations other
          join ads_interactions repeat on repeat.serve_id = other.serve_id
          where other.campaign_id = r.campaign_id and other.visitor_key = r.visitor_key
            and other.serve_id <> s.id and repeat.type = 'click' and repeat.is_valid
            and repeat.created_at between i.created_at - interval '30 seconds' and i.created_at + interval '30 seconds')
      order by i.created_at, i.id
      limit 2
    `);
    if (candidates.rows.length > 1) throw new Error('Controlled window contains multiple eligible clicks');
    const event = candidates.rows[0];
    if (!event) return {status: 'idle'};
    const analysis = await evidence.analyze(event.id);
    if (!analysis.integrity || !analysis.chainLinkIntegrity) throw new Error('Click evidence did not verify');
    const assessmentId = requestIdentity('assessment', event.id);
    if (event.prior_request && event.prior_request !== assessmentId) throw new Error('Assessment identity requires review');
    if (!event.prior_request) {
      await evidence.assess(event.id, requestIdentity('service', campaign), {
        requestId: assessmentId, outcome: 'eligible', policyVersion: policy,
        reasonCodes: ['CONTROLLED_SIGNED_CPC_VERIFIED'],
      });
    }
    const requestId = requestIdentity('settlement', event.id);
    const periodEnd = new Date(new Date(event.created_at).getTime() + 1).toISOString();
    const settlementKey = 'ads-settlement:v3:'+campaign+':'+requestId;
    const response = await fetch(billing.origin+'/api/v1/ecosystem/campaigns/'+campaign+'/settlements', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: {'content-type':'application/json', 'x-internal-key':internalKey},
      body: JSON.stringify({requestId, periodEnd, eventId: event.id}),
    }).then(async response => {
      if (process.env.ADS_CONTROLLED_CPC_DROP_ACK === 'true' && response.ok) {
        await response.body?.cancel();
        throw new Error('Controlled acknowledgement deliberately dropped');
      }
      return response;
    }).catch(async () => {
      const receipt = await db.execute<{id: string}>(sql`
        select b.id from ads_settlement_batches b
        join ads_settlement_claims q on q.batch_id = b.id and q.interaction_id = ${event.id}
        join billing_transactions t on t.idempotency_key = b.idempotency_key
          and t.status = 'completed' and t.type = 'ads_spend' and t.amount_usd_cents = 10
        where b.idempotency_key = ${settlementKey} and b.status = 'completed'
      `);
      if (!receipt.rows[0]) throw new Error('Billing acknowledgement pending reconciliation');
      return Response.json({data: {status: 'completed', billedUsdCents: 10,
        batchId: receipt.rows[0].id, replayed: true}});
    });
    if (!response.ok) throw new Error('Billing did not acknowledge controlled settlement');
    const {data: result} = await response.json() as {data?: {status: string; billedUsdCents: number; batchId: string; replayed: boolean}};
    if (result?.status !== 'completed' || Number(result.billedUsdCents) !== 10) {
      throw new Error('Controlled settlement requires ledger review');
    }
    return {status: 'settled', eventId: event.id, batchId: result.batchId, replayed: result.replayed};
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  runControlledClickSettlement().then(result => console.log(JSON.stringify(result))).catch((error: unknown) => {
    console.error('Controlled click settlement did not complete. Reconcile the staging claim and settlement receipt.');
    const cause = error as { name?: string; code?: string; cause?: { code?: string }; message?: string };
    const safe = /^(Controlled |Staging |Click evidence |Assessment identity |Billing (did not|acknowledgement))/.test(cause.message ?? '')
      ? cause.message : undefined;
    console.error(JSON.stringify({ error: cause.name, code: cause.code ?? cause.cause?.code, detail: safe }));
    process.exitCode = 1;
  });
}
