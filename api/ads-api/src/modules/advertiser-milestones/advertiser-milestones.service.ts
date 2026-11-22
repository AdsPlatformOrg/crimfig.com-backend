import { Injectable, Inject, UnauthorizedException } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { desc, eq, sql } from 'drizzle-orm';
import { readMilestoneEvidence } from './milestone-evidence';
import { recognitionDecisions, recognitionPolicyVersion } from './milestone-policy';

@Injectable()
export class AdvertiserMilestonesService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>) {}

  private validateIdentity(advertiserId: string) {
    if (typeof advertiserId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(advertiserId)) {
      throw new UnauthorizedException('Authenticated advertiser required');
    }
  }

  async getAdvertiserAchievements(advertiserId: string) {
    this.validateIdentity(advertiserId);
    return this.db.transaction(async tx => {
      await tx.execute(sql`set local statement_timeout = '8s'`);
      const evidence = await readMilestoneEvidence(tx, advertiserId);
      const achievements = await tx.select({
        id: schema.advertiserAchievements.id, tier: schema.advertiserAchievements.tier,
        badgeTitle: schema.advertiserAchievements.badgeTitle,
        bonusCreditCents: schema.advertiserAchievements.bonusCreditCents,
        bonusCreditRemainingCents: schema.advertiserAchievements.bonusCreditRemainingCents,
        creditExpiresAt: schema.advertiserAchievements.creditExpiresAt,
        isClawedBack: schema.advertiserAchievements.isClawedBack, achievedAt: schema.advertiserAchievements.achievedAt,
      }).from(schema.advertiserAchievements)
        .where(eq(schema.advertiserAchievements.advertiserId, advertiserId))
        .orderBy(desc(schema.advertiserAchievements.achievedAt));
      const awards = await tx.execute<{ id: string; milestone_id: string; state: string; first_qualified_at: Date }>(sql`
        SELECT id,milestone_id,state,first_qualified_at FROM advertiser_recognition_awards
        WHERE advertiser_id=${advertiserId}::uuid AND qualifying_scope='lifetime' ORDER BY first_qualified_at,id`);
      const decisions = recognitionDecisions(evidence);
      const eligible = evidence.campaigns.filter(campaign => campaign.eligible);
      const pending = evidence.campaigns.filter(campaign => campaign.completed && !campaign.eligible).length;
      const spend = eligible.reduce((total, campaign) => total + campaign.clearedSpendCents!, 0);
      return {
        policyVersion: recognitionPolicyVersion, evaluatedAt: new Date().toISOString(),
        monetaryProgram: { status: 'unavailable', reason: 'Bonus ad credit requires approved funding and claim terms.' },
        progress: {
          totalCampaigns: evidence.totalCampaigns, completedCampaignsAwaitingVerification: pending,
          verifiedCompletedCampaigns: evidence.fundingVerified || !evidence.totalCampaigns ? eligible.length : null,
          eligibleClearedSpendCents: (evidence.fundingVerified || !evidence.totalCampaigns) && Number.isSafeInteger(spend) ? spend : null,
          evidenceStatus: !evidence.totalCampaigns ? 'no_activity' : !evidence.fundingVerified || pending ? 'pending_verification' : 'verified',
          explanation: !evidence.totalCampaigns ? 'Complete an approved campaign to begin your milestone progress.'
            : !evidence.fundingVerified ? 'Funding history needs verification before campaign spend can qualify.'
            : pending ? 'Some completed campaigns are awaiting clearance or eligibility review.'
            : 'Progress reflects verified cash funding, completed campaigns and cleared advertising activity.',
        },
        definitions: decisions.map(({ qualified, ...definition }) => ({
          ...definition,
          state: qualified ? awards.rows.some(award => award.milestone_id === definition.tier && award.state === 'qualified') ? 'EARNED' : 'QUALIFIED'
            : !evidence.totalCampaigns ? 'LOCKED' : !evidence.fundingVerified || pending ? 'PENDING_CLEARANCE' : 'IN_PROGRESS',
        })),
        badges: awards.rows.map(award => ({
          id: award.id, tier: award.milestone_id, achievedAt: award.first_qualified_at,
          state: decisions.find(decision => decision.tier === award.milestone_id)?.qualified ? award.state
            : !evidence.fundingVerified || pending ? 'under_review' : 'revoked',
        })),
        achievements: achievements.map(achievement => ({ ...achievement, status: 'RECONCILIATION_REQUIRED' })),
        claimableRewards: [], totalBonusCreditRemainingCents: null, totalBonusCreditRemainingUsd: null,
      };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }

  /** Recognition writes are separate from the historical bonus ledger and money. */
  async evaluateCategoryAMilestones(advertiserId: string) {
    this.validateIdentity(advertiserId);
    const newlyAwarded = await this.db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`set local statement_timeout = '8s'`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'advertiser-recognition:' + advertiserId},0))`);
      const evidence = await readMilestoneEvidence(tx, advertiserId);
      const decisions = recognitionDecisions(evidence);
      const proof = JSON.stringify({ fundingVerified: evidence.fundingVerified,
        campaigns: evidence.campaigns.filter(campaign => campaign.eligible).sort((left, right) => left.id.localeCompare(right.id)) });
      const awarded: { id: string; tier: string }[] = [];
      for (const decision of decisions) {
        const prior = await tx.execute<{ id: string; state: string }>(sql`
          SELECT id,state FROM advertiser_recognition_awards WHERE advertiser_id=${advertiserId}::uuid
            AND milestone_id=${decision.tier} AND qualifying_scope='lifetime' FOR UPDATE`);
        if (!prior.rows.length && !decision.qualified) continue;
        const state = decision.qualified ? 'qualified' : !evidence.fundingVerified || evidence.campaigns.some(campaign => campaign.completed && !campaign.eligible)
          ? 'under_review' : 'revoked';
        if (!prior.rows.length) {
          const created = await tx.execute<{ id: string }>(sql`INSERT INTO advertiser_recognition_awards(advertiser_id,milestone_id,qualifying_scope,policy_version,state,evidence)
            VALUES (${advertiserId}::uuid,${decision.tier},'lifetime',${recognitionPolicyVersion},${state},${proof}::jsonb) RETURNING id`);
          const id = created.rows[0].id;
          await tx.execute(sql`INSERT INTO advertiser_recognition_evaluations(award_id,state,policy_version,evidence)
            VALUES (${id}::uuid,${state},${recognitionPolicyVersion},${proof}::jsonb)`);
          awarded.push({ id, tier: decision.tier });
        } else {
          await tx.execute(sql`WITH changed AS (
            UPDATE advertiser_recognition_awards SET state=${state},policy_version=${recognitionPolicyVersion},evidence=${proof}::jsonb,evaluated_at=now()
            WHERE id=${prior.rows[0].id}::uuid AND (state<>${state} OR evidence IS DISTINCT FROM ${proof}::jsonb OR policy_version<>${recognitionPolicyVersion}) RETURNING id
          ) INSERT INTO advertiser_recognition_evaluations(award_id,previous_state,state,policy_version,evidence)
            SELECT id,${prior.rows[0].state},${state},${recognitionPolicyVersion},${proof}::jsonb FROM changed`);
        }
      }
      return awarded;
    });
    return { status: 'evaluated', newlyAwarded, ...await this.getAdvertiserAchievements(advertiserId) };
  }

  async reconcile(after: string | null, persist: boolean, assertLease: () => Promise<void>) {
    const result = await this.db.execute<{ advertiser_id: string }>(sql`SELECT advertiser_id FROM (
      SELECT advertiser_id FROM ads_campaigns UNION SELECT advertiser_id FROM advertiser_recognition_awards
    ) owners WHERE ${after ? sql`advertiser_id>${after}::uuid` : sql`true`} ORDER BY advertiser_id LIMIT 100`);
    for (const row of result.rows) {
      await assertLease();
      if (persist) await this.evaluateCategoryAMilestones(row.advertiser_id);
      else await this.getAdvertiserAchievements(row.advertiser_id);
    }
    return { processed: result.rows.length, cursor: result.rows.length === 100 ? result.rows[result.rows.length - 1].advertiser_id : null };
  }
}
