import { BadRequestException, HttpException, HttpStatus, Injectable, Inject, NotFoundException, Logger, ConflictException } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { adsPromoterWebsites, adsPromoterApps,adsSupplyStateHistory } from '@crimfig/database/schema';
import { and, eq, sql } from 'drizzle-orm';
import * as dns from 'dns/promises';
import { deadline, fetchWebsiteProof, hasVerificationMeta, websiteTarget } from './website-proof';
import { resolveTxtDnsProof } from './dns-proof-resolver';
import {proofTokenHash} from './ownership-method-status';

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
  async verifyWebsite(promoterId: string, websiteId: string, method?: unknown) {
    if (method !== undefined && method !== 'dns_txt' && method !== 'html_meta') {
      throw new BadRequestException('Unsupported verification method');
    }
    return this.checkWebsite(promoterId, websiteId, undefined, method);
  }

  async retestWebsite(websiteId: string, method: unknown, actorId: string) {
    if (method !== 'dns_txt' && method !== 'html_meta') throw new BadRequestException('Unsupported verification method');
    const [row] = await this.db.select({ promoterId: adsPromoterWebsites.promoterId }).from(adsPromoterWebsites)
      .where(eq(adsPromoterWebsites.id, websiteId)).limit(1);
    if (!row) throw new NotFoundException('Website not found');
    return this.checkWebsite(row.promoterId, websiteId, { method, actorId });
  }

  private async checkWebsite(promoterId: string, websiteId: string, staff?: { method: 'dns_txt' | 'html_meta'; actorId: string }, ownerMethod?: 'dns_txt' | 'html_meta') {
    const [website] = await this.db
      .select()
      .from(adsPromoterWebsites)
      .where(and(eq(adsPromoterWebsites.id, websiteId), eq(adsPromoterWebsites.promoterId, promoterId)))
      .limit(1);

    if (!website) {
      throw new NotFoundException('Website not found');
    }

    // Rate-limiting safeguard: enforce 10-second cooldown between consecutive verification attempts
    if (website.lastVerificationAttemptAt) {
      const elapsedMs = Date.now() - new Date(website.lastVerificationAttemptAt).getTime();
      if (elapsedMs < 10000) {
        const remainingSec = Math.ceil((10000 - elapsedMs) / 1000);
        throw new HttpException(
          `Verification was attempted recently. Please wait ${remainingSec} second${remainingSec === 1 ? '' : 's'} before retrying.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    const token = website.verificationToken;
    const requestedMethod = staff?.method ?? ownerMethod;
    const method = requestedMethod === 'html_meta' ? 'html_file_and_meta_tag' : requestedMethod ?? website.verificationMethod;
    let isVerified = false;
    let errorMessage: string | null = null;

    try {
      const target = websiteTarget(website.domain, website.url);
      if (!token || !/^[a-zA-Z0-9_-]{16,256}$/.test(token)) {
        throw new Error('Invalid verification token; re-register this website');
      }
      if (method === 'dns_txt') {
        const expected = `crimfig-site-verification=${token}`;
        // First try local resolver
        try {
          const records = await deadline(dns.resolveTxt(target.hostname), 2000);
          isVerified = records.some(record => record.join('') === expected);
        } catch {
          isVerified = false;
        }

        // If not verified locally, query public DoH resolvers (Cloudflare primary, Google fallback) per PLAN-0054
        if (!isVerified) {
          const dohResult = await resolveTxtDnsProof(target.hostname, token);
          isVerified = dohResult.isVerified;
          if (!isVerified) {
            errorMessage = dohResult.errorMessage || 'Exact DNS TXT verification record was not found.';
          }
        }
      } else if (method === 'html_file_and_meta_tag') {
        isVerified = hasVerificationMeta(await fetchWebsiteProof(target), token);
        if (!isVerified) errorMessage = 'Exact crimfig-site-verification meta tag was not found.';
      } else {
        throw new Error('Unsupported website verification method');
      }
    } catch {
      // Do not expose resolver/network internals to dashboard clients.
      errorMessage = 'Website verification failed. Check the HTTPS domain, public DNS and verification record.';
    }

    const updated=await this.db.transaction(async tx=>{
      await tx.execute(sql`set local lock_timeout='5s'`);await tx.execute(sql`set local statement_timeout='8s'`);
      const [current]=await tx.select().from(adsPromoterWebsites).where(and(eq(adsPromoterWebsites.id,websiteId),eq(adsPromoterWebsites.promoterId,promoterId))).for('update').limit(1);
      if(!current||current.domain!==website.domain||current.url!==website.url||current.verificationToken!==token||current.verificationMethod!==website.verificationMethod)throw new ConflictException('Website details changed. Run verification again.');
      if (current.lastVerificationAttemptAt?.getTime() !== website.lastVerificationAttemptAt?.getTime()) {
        throw new ConflictException('Another verification attempt finished. Reload and try again.');
      }
      const preserveProof = Boolean((staff || (ownerMethod && method !== current.verificationMethod)) && !isVerified && current.verificationStatus === 'verified' &&
        current.verificationExpiresAt && current.verificationExpiresAt.getTime() > Date.now());
      // Ownership proof cannot erase a concurrent staff rejection or suspension.
      const nextPolicyStatus=isVerified&&current.policyStatus==='unverified'?'testing':current.policyStatus;
      const now=new Date();
      const [saved]=await tx.update(adsPromoterWebsites).set({
        verificationStatus:isVerified?'verified':preserveProof?'verified':'failed',verifiedAt:isVerified?now:preserveProof?current.verifiedAt:null,
        ...(requestedMethod && isVerified ? { verificationMethod: method } : {}),
        verificationExpiresAt:isVerified?new Date(now.getTime()+30*86400000):preserveProof?current.verificationExpiresAt:null,
        policyStatus:nextPolicyStatus,lastVerificationAttemptAt:now,verificationErrorMessage:errorMessage,
        verificationFailures:isVerified?0:(current.verificationFailures||0)+1,updatedAt:now,
      }).where(eq(adsPromoterWebsites.id,websiteId)).returning();
      await tx.insert(adsSupplyStateHistory).values({entityType:'website',entityId:websiteId,dimension:'ownership_status',fromState:current.verificationStatus,toState:saved.verificationStatus,actorRole:staff?'ads_staff':'owner',actorId:staff?.actorId,reason:staff ? (isVerified ? 'OWNERSHIP_RETEST_CONFIRMED_' : 'OWNERSHIP_RETEST_FAILED_') + staff.method.toUpperCase() : isVerified?'OWNERSHIP_PROOF_CONFIRMED':'OWNERSHIP_PROOF_FAILED'});
      await tx.insert(adsSupplyStateHistory).values({entityType:'website',entityId:websiteId,dimension:`ownership_check_${method==='dns_txt'?'dns_txt':'html_meta'}`,toState:isVerified?'verified':'not_verified',actorRole:staff?'ads_staff':'owner',actorId:staff?.actorId,reason:proofTokenHash(token)});
      return saved;
    });

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
