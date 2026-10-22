import { Injectable, Inject, NotFoundException, Logger } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { adsPromoterWebsites, adsPromoterApps } from '@crimfig/database/schema';
import { and, eq } from 'drizzle-orm';
import * as dns from 'dns/promises';
import { deadline, fetchWebsiteProof, hasVerificationMeta, websiteTarget } from './website-proof';

@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Verify domain ownership via DNS TXT record or HTML meta tag / file
   */
  async verifyWebsite(promoterId: string, websiteId: string) {
    const [website] = await this.db
      .select()
      .from(adsPromoterWebsites)
      .where(and(eq(adsPromoterWebsites.id, websiteId), eq(adsPromoterWebsites.promoterId, promoterId)))
      .limit(1);

    if (!website) {
      throw new NotFoundException('Website not found');
    }

    const token = website.verificationToken;
    let isVerified = false;
    let errorMessage: string | null = null;

    try {
      const target = websiteTarget(website.domain, website.url);
      if (!token || !/^[a-zA-Z0-9_-]{16,256}$/.test(token)) {
        throw new Error('Invalid verification token; re-register this website');
      }
      if (website.verificationMethod === 'dns_txt') {
        const records = await deadline(dns.resolveTxt(target.hostname), 2000);
        const expected = `crimfig-site-verification=${token}`;
        isVerified = records.some(record => record.join('') === expected);
        if (!isVerified) errorMessage = 'Exact DNS TXT verification record was not found.';
      } else if (website.verificationMethod === 'html_file_and_meta_tag') {
        isVerified = hasVerificationMeta(await fetchWebsiteProof(target), token);
        if (!isVerified) errorMessage = 'Exact crimfig-site-verification meta tag was not found.';
      } else {
        throw new Error('Unsupported website verification method');
      }
    } catch {
      // Do not expose resolver/network internals to dashboard clients.
      errorMessage = 'Website verification failed. Check the HTTPS domain, public DNS and verification record.';
    }

    const [updated] = await this.db
      .update(adsPromoterWebsites)
      .set({
        verificationStatus: isVerified ? 'verified' : 'failed',
        verifiedAt: isVerified ? new Date() : null,
        lastVerificationAttemptAt: new Date(),
        verificationErrorMessage: errorMessage,
        updatedAt: new Date(),
      })
      .where(and(eq(adsPromoterWebsites.id, websiteId), eq(adsPromoterWebsites.promoterId, promoterId)))
      .returning();

    return {
      isVerified,
      status: updated.verificationStatus,
      errorMessage,
      website: updated,
    };
  }

  /**
   * Verify mobile app registration
   */
  async verifyMobileApp(promoterId: string, appId: string) {
    const [app] = await this.db
      .select()
      .from(adsPromoterApps)
      .where(and(eq(adsPromoterApps.id, appId), eq(adsPromoterApps.promoterId, promoterId)))
      .limit(1);

    if (!app) {
      throw new NotFoundException('App not found');
    }

    const [updated] = await this.db
      .update(adsPromoterApps)
      .set({
        verificationStatus: 'verified',
        verifiedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(adsPromoterApps.id, appId))
      .returning();

    return { isVerified: true, status: 'verified', app: updated };
  }
}
