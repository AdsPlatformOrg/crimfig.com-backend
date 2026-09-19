import { Injectable, Inject, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import {
  adsPromoters,
  adsPromoterWebsites,
  adsPromoterApps,
  adsReelsConsents,
} from '@crimfig/database/schema';
import { and, eq, desc } from 'drizzle-orm';
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
    const [existing] = await this.db
      .select()
      .from(adsPromoters)
      .where(eq(adsPromoters.userId, userId))
      .limit(1);

    if (existing) {
      return existing;
    }

    const [created] = await this.db
      .insert(adsPromoters)
      .values({
        userId,
        type,
        displayName: displayName || 'CrimFig Promoter',
      })
      .returning();

    // If individual, initialize Reels consent record
    if (type === 'INDIVIDUAL') {
      await this.db.insert(adsReelsConsents).values({
        promoterId: created.id,
        consentGiven: 0,
      });
    }

    return created;
  }

  /**
   * Register a website for a promoter
   */
  async addWebsite(promoterId: string, params: {
    url: string;
    domain: string;
    verificationMethod: 'dns_txt' | 'html_file_and_meta_tag';
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
   * Register a mobile app for a promoter
   */
  async addMobileApp(promoterId: string, params: {
    appName: string;
    bundleId: string;
    platform: 'ios' | 'android' | 'both';
    storeUrl?: string;
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
}
