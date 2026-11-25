import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@crimfig/database/schema';
import { DATABASE_TOKEN } from '../../database/database.module';
import { OpportunityClient } from '../../billing/opportunity-client';
import { DeliveryService } from '../../delivery/delivery.service';
import { ImpressionTokenService } from '../../delivery/impression-token.service';
import { AuctionEngineService } from '../../delivery/auction-engine.service';
import { FraudRulesService } from '../../verification/fraud-rules.service';
import { EvidenceService } from '../../delivery/evidence.service';
import { AdOpportunityWorker } from '../../../../../billing-api/src/modules/ecosystem/ad-opportunity.worker';
import { AdOpportunityService } from '../../../../../billing-api/src/modules/ecosystem/ad-opportunity.service';
import { AdSettlementService } from '../../../../../billing-api/src/modules/ecosystem/ad-settlement.service';
import { CampaignEscrowService } from '../../../../../billing-api/src/modules/ecosystem/campaign-escrow.service';
import {
  type CronExecutionContext,
  type CronJobHandler,
  type CronJobResult,
  CronJobRegistry,
} from '../cron-job-registry';
import { TrafficQualityJob } from './traffic-quality.job';
import { RewardsReconciliationJob } from './rewards-reconciliation.job';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const DEFAULT_CPC_POLICY_VERSION = 'plan0104-signed-cpc-v1';
export const DEFAULT_CPC_START_ISO = '2026-11-01T00:00:00.000Z';

export function cpcAssessmentRequestId(eventId: string, policy = DEFAULT_CPC_POLICY_VERSION): string {
  const digest = createHash('sha256').update(`${policy}:${eventId}`).digest('hex');
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    '4' + digest.slice(13, 16),
    '8' + digest.slice(17, 20),
    digest.slice(20, 32),
  ].join('-');
}

export function cpcServiceActorId(campaignId: string): string {
  const digest = createHash('sha256')
    .update(`plan0114:cpc-service-actor:${campaignId}`)
    .digest('hex');
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    '4' + digest.slice(13, 16),
    '8' + digest.slice(17, 20),
    digest.slice(20, 32),
  ].join('-');
}

function resolveCpcBatchSize(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(String(env.ADS_CPC_BATCH_SIZE ?? '50'), 10);
  if (!Number.isSafeInteger(parsed)) return 50;
  return Math.min(100, Math.max(1, parsed));
}

@Injectable()
export class CpcProcessingJob implements CronJobHandler {
  readonly jobKey = 'ads.cpc.processing';

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly registry: CronJobRegistry,
    private readonly trafficQualityJob: TrafficQualityJob,
    private readonly rewardsReconciliationJob: RewardsReconciliationJob,
  ) {}

  async execute(context: CronExecutionContext): Promise<CronJobResult> {
    await context.assertLeaseOwnership();

    const env = process.env;
    const configuredPolicy = env.ADS_TRAFFIC_ASSESSMENT_POLICY_VERSION || DEFAULT_CPC_POLICY_VERSION;
    if (configuredPolicy !== DEFAULT_CPC_POLICY_VERSION) {
      throw new Error(`Unsupported CPC assessment policy version: ${configuredPolicy}`);
    }
    if (!env.ADS_TRAFFIC_ASSESSMENT_POLICY_VERSION) {
      env.ADS_TRAFFIC_ASSESSMENT_POLICY_VERSION = DEFAULT_CPC_POLICY_VERSION;
    }

    const start =
      env.ADS_CPC_PROCESSOR_START?.trim() ||
      (typeof context.lastCheckpoint?.windowStart === 'string'
        ? context.lastCheckpoint.windowStart
        : DEFAULT_CPC_START_ISO);
    if (!Number.isFinite(Date.parse(start)) || Date.parse(start) > Date.now()) {
      throw new Error('CPC processor start timestamp must be a valid past UTC timestamp');
    }

    const explicitActor = env.ADS_CPC_PROCESSOR_ACTOR?.trim() || '';
    if (explicitActor) {
      if (!UUID_REGEX.test(explicitActor)) {
        throw new Error('ADS_CPC_PROCESSOR_ACTOR must be a valid UUID');
      }
      const actorRow = await this.db.execute(
        sql`SELECT 1 FROM users WHERE id = ${explicitActor}::uuid AND status = 'ACTIVE'`,
      );
      const actorRows = ((actorRow as any).rows ?? actorRow) as Array<unknown>;
      if (!actorRows.length) {
        throw new Error('The configured CPC processor actor must be ACTIVE');
      }
    }

    const rawCampaigns = (env.ADS_CPC_PROCESSOR_CAMPAIGNS ?? '').trim();
    const configuredCampaigns = rawCampaigns
      ? rawCampaigns
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      : [];
    if (
      configuredCampaigns.length > 50 ||
      (configuredCampaigns.length > 0 && !configuredCampaigns.every((id) => UUID_REGEX.test(id)))
    ) {
      throw new Error('ADS_CPC_PROCESSOR_CAMPAIGNS must contain at most 50 valid campaign UUIDs');
    }

    let targetCampaigns = configuredCampaigns;
    if (targetCampaigns.length === 0) {
      const dynamicRows = await this.db.execute(sql`
        SELECT id FROM ads_campaigns
        WHERE pricing_model = 'cpc' AND pricing_version = 2 AND status IN ('active', 'paused')
        ORDER BY updated_at DESC LIMIT 200
      `);
      const rows = ((dynamicRows as any).rows ?? dynamicRows) as Array<{ id: string }>;
      targetCampaigns = rows.map((r) => String(r.id)).filter((id) => UUID_REGEX.test(id));
    }

    const batchSize = resolveCpcBatchSize(env);
    let candidatesEvaluated = 0;
    let eligibleAssessed = 0;
    let quarantinedAssessed = 0;
    let assessmentFailures = 0;
    let recoveryFailures = 0;

    if (targetCampaigns.length > 0) {
      await context.assertLeaseOwnership();
      const scope = sql.join(
        targetCampaigns.map((id) => sql`${id}::uuid`),
        sql`, `,
      );
      const opportunities = new OpportunityClient(new ConfigService());
      const evidence = new EvidenceService(this.db, opportunities);
      const delivery = new DeliveryService(
        this.db,
        new ImpressionTokenService(),
        new AuctionEngineService(),
        new FraudRulesService(),
        opportunities,
        evidence,
      );

      // 1. Link unconfirmed redirect receipts that already have a matching click interaction
      await this.db.execute(sql`
        WITH recoverable AS (
          SELECT receipt.id, e.id AS interaction_id
          FROM ads_clicks receipt
          JOIN ads_interactions e ON e.event_id = receipt.id AND e.serve_id = receipt.serve_id
            AND e.promoter_id = receipt.promoter_id AND e.type = 'click'
          JOIN ads_serves s ON s.id = receipt.serve_id AND s.campaign_id = receipt.campaign_id
          WHERE receipt.recording_reason = 'RECORDING_UNCONFIRMED' AND receipt.interaction_id IS NULL
            AND receipt.campaign_id IN (${scope}) AND receipt.clicked_at >= ${start}::timestamptz
          ORDER BY receipt.clicked_at, receipt.id LIMIT ${batchSize}
        )
        UPDATE ads_clicks receipt SET interaction_id = recoverable.interaction_id, recording_reason = NULL, recovery = NULL
        FROM recoverable WHERE receipt.id = recoverable.id AND receipt.interaction_id IS NULL
      `);

      // 2. Expire stale redirect recovery records
      await this.db.execute(sql`
        WITH expired AS (
          SELECT id FROM ads_clicks WHERE recovery IS NOT NULL AND interaction_id IS NULL
            AND campaign_id IN (${scope}) AND expires_at <= now()
          ORDER BY clicked_at, id LIMIT ${batchSize}
        )
        UPDATE ads_clicks receipt SET recovery = NULL, recording_reason = 'RECOVERY_EXPIRED'
        FROM expired WHERE receipt.id = expired.id AND receipt.interaction_id IS NULL
      `);

      // 3. Recover pending redirect attempts
      const receiptsRes = await this.db.execute<{ id: string }>(sql`
        SELECT id FROM ads_clicks WHERE recovery IS NOT NULL AND interaction_id IS NULL
          AND campaign_id IN (${scope}) AND clicked_at >= ${start}::timestamptz
          AND expires_at > now() ORDER BY clicked_at, id LIMIT 20
      `);
      const receiptRows = ((receiptsRes as any).rows ?? receiptsRes) as Array<{ id: string }>;
      const recoveryDeadline = Math.min(context.deadlineAt.getTime(), Date.now() + 30_000);
      for (const receipt of receiptRows) {
        if (Date.now() >= recoveryDeadline) break;
        await context.assertLeaseOwnership();
        try {
          await delivery.recoverRedirectAttempt(receipt.id);
        } catch {
          recoveryFailures++;
        }
      }

      // 4. Discover pending CPC click candidates requiring final evidence assessment
      await context.assertLeaseOwnership();
      const candidatesRes = await this.db.execute<{
        event_id: string;
        campaign_id: string;
      }>(sql`
        SELECT e.id AS event_id, r.campaign_id AS campaign_id
        FROM ads_opportunity_reservations r
        JOIN ads_serves s ON s.id = r.serve_id AND s.opportunity_reservation_id = r.id
        JOIN ads_interactions e ON e.serve_id = s.id
        WHERE r.campaign_id IN (${scope}) AND r.campaign_id = s.campaign_id
          AND r.state IN ('ISSUED', 'CLAIMED') AND r.settled_at IS NULL AND NOT r.is_simulated
          AND r.pricing_model = 'cpc' AND s.pricing_model = 'cpc' AND s.pricing_version = 2
          AND s.inventory_class = 'paid' AND s.delivery_mode = 'normal'
          AND e.created_at >= ${start}::timestamptz AND e.created_at BETWEEN s.served_at AND r.event_deadline
          AND e.type = 'click' AND e.verification_version = 2 AND e.is_valid
          AND e.assessment_status = 'validated' AND e.financial_eligibility = 'pending'
          AND e.promoter_id = s.promoter_id AND e.website_id = s.website_id AND e.slot_id = s.slot_id
          AND (r.claim_event_id IS NULL OR r.claim_event_id = e.id)
          AND EXISTS (
            SELECT 1 FROM ads_clicks receipt WHERE receipt.serve_id = s.id
              AND receipt.campaign_id = s.campaign_id
              AND (
                receipt.interaction_id = e.id
                OR (receipt.recording_reason = 'RECORDING_UNCONFIRMED' AND receipt.id = e.event_id)
              )
          )
          AND NOT EXISTS (SELECT 1 FROM ads_event_assessments a WHERE a.event_id = e.id)
          AND NOT EXISTS (
            SELECT 1 FROM ads_interactions repeat WHERE repeat.serve_id = s.id
              AND repeat.type = 'click' AND repeat.verification_version = 2
              AND repeat.is_valid AND repeat.id <> e.id
          )
        ORDER BY e.created_at, e.id LIMIT ${batchSize}
      `);
      const candidateRows = ((candidatesRes as any).rows ?? candidatesRes) as Array<{
        event_id: string;
        campaign_id: string;
      }>;
      candidatesEvaluated = candidateRows.length;

      for (const candidate of candidateRows) {
        await context.assertLeaseOwnership();
        try {
          const analysis = await evidence.analyze(candidate.event_id);
          const actorForEvent = explicitActor || cpcServiceActorId(candidate.campaign_id);
          const outcome = analysis.integrity ? 'eligible' : 'quarantined';
          await evidence.assess(candidate.event_id, actorForEvent, {
            requestId: cpcAssessmentRequestId(candidate.event_id, configuredPolicy),
            policyVersion: configuredPolicy,
            outcome,
            reasonCodes: [
              analysis.integrity
                ? 'SIGNED_REDIRECT_CLICK_VERIFIED'
                : 'CLICK_EVIDENCE_INTEGRITY_UNCONFIRMED',
            ],
          });
          if (outcome === 'eligible') eligibleAssessed++;
          else quarantinedAssessed++;
        } catch {
          assessmentFailures++;
        }
      }

      // 5. Reconcile claimed reservations and settle finally eligible clicks via Billing authority
      await context.assertLeaseOwnership();
      const worker = new AdOpportunityWorker(
        this.db,
        new AdOpportunityService(this.db),
        new AdSettlementService(this.db),
        new CampaignEscrowService(this.db),
      );
      await worker.tick({
        campaigns: targetCampaigns,
        start,
        deadline: Math.min(context.deadlineAt.getTime(), Date.now() + 60_000),
      });
    }

    // 6. Execute shared 5-minute cycle tasks (Traffic Quality & Rewards Reconciliation) in sequence
    // with isolated sub-checkpoints and explicit mode resolution (PLAN-0155 G11)
    let trafficQualitySummary: Record<string, unknown> | { skippedDisabled: true } = {
      skippedDisabled: true,
    };
    let trafficQualityCheckpoint: Record<string, unknown> | null =
      (context.lastCheckpoint?.trafficQualityCheckpoint as Record<string, unknown> | undefined) ?? null;
    if (this.registry.isJobEnabled('ads.traffic.quality', env)) {
      await context.assertLeaseOwnership();
      const tqContext: CronExecutionContext = {
        ...context,
        jobKey: 'ads.traffic.quality',
        mode: this.registry.resolveMode('ads.traffic.quality', env),
        lastCheckpoint: trafficQualityCheckpoint,
        saveCheckpoint: async (cp) => {
          await context.assertLeaseOwnership();
          trafficQualityCheckpoint = cp;
        },
      };
      const tqResult = await this.trafficQualityJob.execute(tqContext);
      trafficQualitySummary = tqResult.summary ?? {};
    }

    let rewardsSummary: Record<string, unknown> | { skippedDisabled: true } = {
      skippedDisabled: true,
    };
    let rewardsCheckpoint: Record<string, unknown> | null =
      (context.lastCheckpoint?.rewardsCheckpoint as Record<string, unknown> | undefined) ?? null;
    if (this.registry.isJobEnabled('ads.rewards.reconcile', env)) {
      await context.assertLeaseOwnership();
      const rwContext: CronExecutionContext = {
        ...context,
        jobKey: 'ads.rewards.reconcile',
        mode: this.registry.resolveMode('ads.rewards.reconcile', env),
        lastCheckpoint: rewardsCheckpoint,
        saveCheckpoint: async (cp) => {
          await context.assertLeaseOwnership();
          rewardsCheckpoint = cp;
        },
      };
      const rwResult = await this.rewardsReconciliationJob.execute(
        rwContext,
        {
          lower:
            typeof rewardsCheckpoint?.lastReconciledUntil === 'string'
              ? rewardsCheckpoint.lastReconciledUntil
              : start,
          upper: context.triggerTime.toISOString(),
        },
        {
          persistForwardSettlement:
            context.mode === 'ACTIVE' && this.registry.isForwardRewardsSettlementEnabled(env),
        },
      );
      rewardsSummary = rwResult.summary ?? {};
    }

    if (assessmentFailures > 0 || recoveryFailures > 0) {
      throw new Error(
        `Some CPC assessments or redirect recoveries require retry (assessmentFailures=${assessmentFailures}, recoveryFailures=${recoveryFailures})`,
      );
    }

    const checkpoint = {
      windowStart: start,
      lastProcessedAt: context.triggerTime.toISOString(),
      campaignsEvaluated: targetCampaigns.length,
      candidatesEvaluated,
      eligibleAssessed,
      quarantinedAssessed,
      trafficQualityCheckpoint,
      rewardsCheckpoint,
    };
    await context.saveCheckpoint(checkpoint);

    return {
      processedCount: candidatesEvaluated,
      failedCount: assessmentFailures + recoveryFailures,
      checkpoint,
      summary: {
        status: targetCampaigns.length === 0 ? 'idle' : 'processed',
        campaigns: targetCampaigns.length,
        candidates: candidatesEvaluated,
        eligibleAssessed,
        quarantinedAssessed,
        trafficQuality: trafficQualitySummary,
        rewardsReconciliation: rewardsSummary,
      },
    };
  }
}

