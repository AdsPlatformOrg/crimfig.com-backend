import { Injectable, Inject, NotFoundException, Logger } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { adsPromoterWebsites, adsPromoterApps } from '@crimfig/database/schema';
import { and, eq } from 'drizzle-orm';
import * as dns from 'dns/promises';

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

    if (website.verificationMethod === 'dns_txt') {
      try {
        const records = await dns.resolveTxt(website.domain);
        const flattened = records.flat();
        const expected = `crimfig-site-verification=${token}`;
        isVerified = flattened.some((rec) => rec.includes(expected) || rec.includes(token));
        if (!isVerified) {
          errorMessage = `DNS TXT record matching '${expected}' was not found on ${website.domain}.`;
        }
      } catch (err: any) {
        errorMessage = `DNS lookup failed for ${website.domain}: ${err.message}`;
      }
    } else {
      // html_file_and_meta_tag
      try {
        const targetUrl = website.url.startsWith('http') ? website.url : `https://${website.domain}`;
        const res = await fetch(targetUrl, {
          headers: { 'User-Agent': 'Crimfig-Verification-Bot/1.0' },
          signal: AbortSignal.timeout(7000),
        });

        if (res.ok) {
          const html = await res.text();
          if (html.includes(token) || html.includes(`content="${token}"`)) {
            isVerified = true;
          } else {
            errorMessage = `Meta tag <meta name="crimfig-site-verification" content="${token}"> was not found on ${targetUrl}.`;
          }
        } else {
          errorMessage = `HTTP request to ${targetUrl} returned status ${res.status}`;
        }
      } catch (err: any) {
        errorMessage = `Failed to fetch ${website.url}: ${err.message}`;
      }
    }

    const [updated] = await this.db
      .update(adsPromoterWebsites)
      .set({
        verificationStatus: isVerified ? 'verified' : 'failed',
        verifiedAt: isVerified ? new Date() : website.verifiedAt,
        lastVerificationAttemptAt: new Date(),
        verificationErrorMessage: errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(adsPromoterWebsites.id, websiteId))
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
