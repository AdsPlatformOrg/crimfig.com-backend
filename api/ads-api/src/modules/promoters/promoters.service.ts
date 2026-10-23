import { Injectable, Inject, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import {
  adsPromoters,
  adsPromoterWebsites,
  adsPromoterApps,
  adsReelsConsents,
  adsInteractions,
} from '@crimfig/database/schema';
import { and, eq, desc, sql } from 'drizzle-orm';
import * as crypto from 'crypto';

@Injectable()
export class PromotersService {
  private readonly logger = new Logger(PromotersService.name);

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Get or create a promoter profile for a user
   */
  async getOrCreatePromoter(userId: string, type: 'WEBSITE' | 'INDIVIDUAL' | 'MOBILE_APP' = 'INDIVIDUAL', displayName?: string) {
    return this.db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`set local statement_timeout = '10s'`);
      // The unique user key arbitrates concurrent first-load requests. A separate
      // SELECT gets a fresh READ COMMITTED snapshot after the winning insert.
      await tx.insert(adsPromoters).values({
        userId, type, displayName: displayName || 'CrimFig Promoter',
      }).onConflictDoNothing({ target: adsPromoters.userId });
      const [promoter] = await tx.select().from(adsPromoters)
        .where(eq(adsPromoters.userId, userId)).limit(1);
      if (!promoter) throw new NotFoundException('Promoter profile unavailable');

      // A website/app request may have created the shared profile first. Ensure
      // Reels has a consent record, without overwriting any existing decision.
      if (type === 'INDIVIDUAL') {
        await tx.insert(adsReelsConsents).values({
          promoterId: promoter.id, consentGiven: 0,
        }).onConflictDoNothing({ target: adsReelsConsents.promoterId });
      }
      return promoter;
    });
  }

  /**
   * Register a website for a promoter
   */
  async addWebsite(promoterId: string, params: {
    url: string;
    domain: string;
    verificationMethod: 'dns_txt' | 'html_file_and_meta_tag';
    allowedCategories?: string[];
  }) {
    const verificationToken = `cf_verify_${crypto.randomBytes(16).toString('hex')}`;

    const [website] = await this.db
      .insert(adsPromoterWebsites)
      .values({
        promoterId,
        url: params.url,
        domain: params.domain.toLowerCase().trim(),
        verificationToken,
        verificationMethod: params.verificationMethod,
        verificationStatus: 'pending',
        allowedCategories: params.allowedCategories ? JSON.stringify(params.allowedCategories) : null,
      })
      .returning();

    return website;
  }

  /**
   * List websites for promoter
   */
  async getWebsites(promoterId: string) {
    return this.db
      .select()
      .from(adsPromoterWebsites)
      .where(eq(adsPromoterWebsites.promoterId, promoterId))
      .orderBy(desc(adsPromoterWebsites.createdAt));
  }

  /**
   * Update category filters for promoter profile
   */
  async updateCategories(promoterId: string, allowedCategories: string[]) {
    const [updated] = await this.db
      .update(adsPromoters)
      .set({
        allowedCategories: JSON.stringify(allowedCategories),
        updatedAt: new Date(),
      })
      .where(eq(adsPromoters.id, promoterId))
      .returning();

    return updated;
  }

  /**
   * Register a mobile app for a promoter
   */
  async addMobileApp(promoterId: string, params: {
    appName: string;
    bundleId: string;
    platform: 'ios' | 'android' | 'both';
    storeUrl?: string;
    allowedCategories?: string[];
  }) {
    const [app] = await this.db
      .insert(adsPromoterApps)
      .values({
        promoterId,
        appName: params.appName,
        bundleId: params.bundleId.trim(),
        platform: params.platform,
        storeUrl: params.storeUrl,
        verificationStatus: 'pending',
        allowedCategories: params.allowedCategories ? JSON.stringify(params.allowedCategories) : null,
      })
      .returning();

    return app;
  }

  /**
   * List registered mobile apps for promoter
   */
  async getMobileApps(promoterId: string) {
    return this.db
      .select()
      .from(adsPromoterApps)
      .where(eq(adsPromoterApps.promoterId, promoterId))
      .orderBy(desc(adsPromoterApps.createdAt));
  }

  /**
   * Get Reels consent for promoter
   */
  async getReelsConsent(promoterId: string) {
    const [consent] = await this.db
      .select()
      .from(adsReelsConsents)
      .where(eq(adsReelsConsents.promoterId, promoterId))
      .limit(1);

    return consent || { promoterId, consentGiven: 0 };
  }

  /**
   * Update Reels consent
   */
  async setReelsConsent(promoterId: string, consent: boolean) {
    const [existing] = await this.db
      .select()
      .from(adsReelsConsents)
      .where(eq(adsReelsConsents.promoterId, promoterId))
      .limit(1);

    if (existing) {
      const [updated] = await this.db
        .update(adsReelsConsents)
        .set({
          consentGiven: consent ? 1 : 0,
          consentGivenAt: consent ? new Date() : existing.consentGivenAt,
          consentRevokedAt: consent ? null : new Date(),
          updatedAt: new Date(),
        })
        .where(eq(adsReelsConsents.id, existing.id))
        .returning();

      return updated;
    }

    const [created] = await this.db
      .insert(adsReelsConsents)
      .values({
        promoterId,
        consentGiven: consent ? 1 : 0,
        consentGivenAt: consent ? new Date() : null,
      })
      .returning();

    return created;
  }

  /**
   * Get promoter quality metrics and trust score
   */
  async getQualityMetrics(promoterId: string) {
    const [promoter] = await this.db
      .select({
        id: adsPromoters.id,
        trustScore: adsPromoters.trustScore,
        isSuspended: adsPromoters.isSuspended,
        suspensionReason: adsPromoters.suspensionReason,
        updatedAt: adsPromoters.updatedAt,
      })
      .from(adsPromoters)
      .where(eq(adsPromoters.id, promoterId))
      .limit(1);

    if (!promoter) {
      throw new NotFoundException('Promoter not found');
    }

    // Aggregate total vs invalid interactions
    const [stats] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        valid: sql<number>`count(*) filter (where ${adsInteractions.isValid} = true)::int`,
        invalid: sql<number>`count(*) filter (where ${adsInteractions.isValid} = false)::int`,
      })
      .from(adsInteractions)
      .where(eq(adsInteractions.promoterId, promoterId));

    const total = stats?.total || 0;
    const invalid = stats?.invalid || 0;
    const valid = stats?.valid || 0;
    const invalidRatePct = total > 0 ? Math.round((invalid / total) * 10000) / 100 : 0;

    return {
      promoterId: promoter.id,
      trustScore: promoter.trustScore ?? 70,
      isSuspended: Boolean(promoter.isSuspended),
      suspensionReason: promoter.suspensionReason,
      totalInteractions: total,
      validInteractions: valid,
      invalidInteractions: invalid,
      invalidRatePct,
      status: promoter.isSuspended ? 'suspended' : (promoter.trustScore ?? 70) >= 60 ? 'good' : 'warning',
    };
  }
}

