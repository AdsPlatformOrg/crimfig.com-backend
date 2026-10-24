import { Injectable, Inject, Logger, BadRequestException, ConflictException } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import {
  growthReferralCodes,
  growthReferrals,
  growthShareLinks,
  growthLinkClicks,
} from '@crimfig/database/schema';
import { eq, sql, and } from 'drizzle-orm';
import { PointsEngineService } from './points-engine.service';

@Injectable()
export class GrowthReferralService {
  private readonly logger = new Logger(GrowthReferralService.name);

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly pointsEngine: PointsEngineService,
  ) {}

  /**
   * Get or automatically generate unique single-level referral code for user.
   */
  async getOrCreateReferralCode(userId: string) {
    const [existing] = await this.db
      .select()
      .from(growthReferralCodes)
      .where(eq(growthReferralCodes.userId, userId))
      .limit(1);

    if (existing) return existing;

    const shortId = userId.replace(/-/g, '').substring(0, 6).toUpperCase();
    const code = `CF-${shortId}`;

    const [created] = await this.db
      .insert(growthReferralCodes)
      .values({
        userId,
        code,
        clicksCount: 0,
        signupsCount: 0,
        qualifiedCount: 0,
      })
      .onConflictDoNothing({ target: growthReferralCodes.userId })
      .returning();

    if (created) return created;

    const [refetched] = await this.db
      .select()
      .from(growthReferralCodes)
      .where(eq(growthReferralCodes.userId, userId))
      .limit(1);
    return refetched;
  }

  /**
   * Create multi-channel tracked share link.
   */
  async createShareLink(userId: string, channel: string, targetPath = '/') {
    const shareCode = `s-${Math.random().toString(36).substring(2, 8)}`;

    const [link] = await this.db
      .insert(growthShareLinks)
      .values({
        userId,
        shareCode,
        channel,
        targetPath,
      })
      .returning();

    return link;
  }

  /**
   * Record referral click and increment counter.
   */
  async recordLinkClick(
    linkType: 'referral' | 'share',
    code: string,
    ipAddress?: string,
    userAgent?: string,
    referer?: string,
  ) {
    await this.db.insert(growthLinkClicks).values({
      linkType,
      code,
      ipAddress: ipAddress ?? null,
      userAgent: userAgent ?? null,
      referer: referer ?? null,
    });

    if (linkType === 'referral') {
      await this.db
        .update(growthReferralCodes)
        .set({ clicksCount: sql`${growthReferralCodes.clicksCount} + 1` })
        .where(eq(growthReferralCodes.code, code));
    } else {
      await this.db
        .update(growthShareLinks)
        .set({ totalClicks: sql`${growthShareLinks.totalClicks} + 1` })
        .where(eq(growthShareLinks.shareCode, code));
    }
  }

  /**
   * Bind referee to referrer upon signup.
   * Single-level only: One referee can only ever have ONE referrer.
   * Prevents self-referral.
   */
  async bindReferral(
    refereeId: string,
    code: string,
    attributionSource = 'link',
    channel?: string,
    deviceFingerprintHash?: string,
    signupIp?: string,
  ) {
    const [referrerCodeRow] = await this.db
      .select()
      .from(growthReferralCodes)
      .where(eq(growthReferralCodes.code, code))
      .limit(1);

    if (!referrerCodeRow) {
      return { success: false, reason: 'Invalid referral code' };
    }

    if (referrerCodeRow.userId === refereeId) {
      return { success: false, reason: 'Self-referral is disallowed' };
    }

    const [existingReferral] = await this.db
      .select()
      .from(growthReferrals)
      .where(eq(growthReferrals.refereeId, refereeId))
      .limit(1);

    if (existingReferral) {
      return { success: false, reason: 'Referee already bound to a referrer' };
    }

    const [referral] = await this.db
      .insert(growthReferrals)
      .values({
        referrerId: referrerCodeRow.userId,
        refereeId,
        referralCode: code,
        status: 'invited',
        attributionSource,
        channel: channel ?? null,
        deviceFingerprintHash: deviceFingerprintHash ?? null,
        signupIp: signupIp ?? null,
      })
      .returning();

    await this.db
      .update(growthReferralCodes)
      .set({ signupsCount: sql`${growthReferralCodes.signupsCount} + 1` })
      .where(eq(growthReferralCodes.id, referrerCodeRow.id));

    return { success: true, referral };
  }

  /**
   * Qualify referral when referee completes verified milestone.
   * Grants 200 points ($2.00) to referrer and 50 points ($0.50) welcome bonus to referee.
   */
  async qualifyReferral(refereeId: string) {
    const [referral] = await this.db
      .select()
      .from(growthReferrals)
      .where(and(eq(growthReferrals.refereeId, refereeId), eq(growthReferrals.status, 'invited')))
      .limit(1);

    if (!referral) return null;

    // Check anti-fraud / duplicate criteria
    if (referral.deviceFingerprintHash && referral.signupIp) {
      // Future hook: cross-check with existing accounts
    }

    // Award Referrer 200 points
    const referrerAward = await this.pointsEngine.awardMilestone(
      referral.referrerId,
      {
        tier: 0,
        key: 'referral_qualified',
        badgeTitle: 'Connector',
        badgeIcon: '🤝',
        pointsAwarded: 200,
        usdEquivalent: 2.0,
      },
      `referral:${referral.id}`,
      `ref-referrer-${referral.id}`,
    );

    // Award Referee 50 points welcome bonus
    const refereeAward = await this.pointsEngine.awardMilestone(
      referral.refereeId,
      {
        tier: 0,
        key: 'referee_welcome',
        badgeTitle: 'Explorer',
        badgeIcon: '🌟',
        pointsAwarded: 50,
        usdEquivalent: 0.5,
      },
      `referral:${referral.id}`,
      `ref-referee-${referral.id}`,
    );

    await this.db
      .update(growthReferrals)
      .set({
        status: 'qualified',
        qualifiedAt: new Date(),
        rewardCreditedAt: new Date(),
      })
      .where(eq(growthReferrals.id, referral.id));

    await this.db
      .update(growthReferralCodes)
      .set({ qualifiedCount: sql`${growthReferralCodes.qualifiedCount} + 1` })
      .where(eq(growthReferralCodes.code, referral.referralCode));

    return { success: true, referrerAward, refereeAward };
  }

  /**
   * Get user referral statistics.
   */
  async getUserReferralStats(userId: string) {
    const code = await this.getOrCreateReferralCode(userId);
    const referrals = await this.db
      .select()
      .from(growthReferrals)
      .where(eq(growthReferrals.referrerId, userId));

    return {
      code: code.code,
      clicksCount: code.clicksCount,
      signupsCount: code.signupsCount,
      qualifiedCount: code.qualifiedCount,
      referralsList: referrals.map((r) => ({
        id: r.id,
        refereeId: r.refereeId,
        status: r.status,
        channel: r.channel,
        createdAt: r.createdAt,
        qualifiedAt: r.qualifiedAt,
      })),
    };
  }
}
