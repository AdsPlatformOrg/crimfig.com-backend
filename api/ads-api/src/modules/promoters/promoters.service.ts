import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import {
  adsPromoters,
  adsPromoterWebsites,
  adsPromoterApps,
  adsReelsConsents,
  adsInteractions,
  adsSupplyStateHistory,
} from '@crimfig/database/schema';
import { and, eq, desc, sql } from 'drizzle-orm';
import * as crypto from 'crypto';
import { websiteTarget } from '../verification/website-proof';

export function normalizePromoterWebsiteInput(
  rawUrl?: string,
  rawDomain?: string,
): { url: string; domain: string } {
  const candidate = (rawUrl || rawDomain || '').trim();
  if (!candidate) {
    throw new BadRequestException('Website URL or domain is required');
  }
  const withScheme = /^https?:\/\//i.test(candidate)
    ? candidate
    : `https://${candidate}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new BadRequestException(
      'Enter a valid HTTPS website URL (for example https://example.com)',
    );
  }

  if (parsed.protocol !== 'https:') {
    throw new BadRequestException(
      'Promoter websites must use HTTPS (for example https://example.com)',
    );
  }
  if (parsed.username || parsed.password || parsed.port) {
    throw new BadRequestException(
      'Promoter website URL cannot include credentials or a custom port',
    );
  }

  const normalizedDomain = (rawDomain || parsed.hostname)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./i, '');

  const normalizedHost = parsed.hostname.toLowerCase().replace(/^www\./i, '');
  if (normalizedDomain !== normalizedHost) {
    throw new BadRequestException(
      `Domain "${normalizedDomain}" must match the URL hostname "${normalizedHost}"`,
    );
  }

  const canonicalRootUrl = `https://${normalizedDomain}/`;
  try {
    websiteTarget(normalizedDomain, canonicalRootUrl);
  } catch (err: any) {
    throw new BadRequestException(
      err?.message || 'A valid public DNS domain on HTTPS root is required',
    );
  }

  return {
    url: canonicalRootUrl,
    domain: normalizedDomain,
  };
}

@Injectable()
export class PromotersService {
  private readonly logger = new Logger(PromotersService.name);

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Get or create a promoter profile for a user.
   * When an explicit type or displayName is supplied (e.g., registering as WEBSITE),
   * updates the existing profile record cleanly so switching/onboarding works idempotently.
   */
  async getOrCreatePromoter(
    userId: string,
    type: 'WEBSITE' | 'INDIVIDUAL' | 'MOBILE_APP' = 'INDIVIDUAL',
    displayName?: string,
    explicitTypeUpdate = false,
  ) {
    if (!userId) throw new BadRequestException('User ID is required');

    const [userExists] = await this.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (!userExists) {
      throw new NotFoundException(
        `User record not found for ID ${userId}. Ensure session is authenticated.`,
      );
    }

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`set local statement_timeout = '10s'`);

      await tx
        .insert(adsPromoters)
        .values({
          userId,
          type,
          displayName: displayName || 'CrimFig Promoter',
        })
        .onConflictDoNothing({ target: adsPromoters.userId });

      let [promoter] = await tx
        .select()
        .from(adsPromoters)
        .where(eq(adsPromoters.userId, userId))
        .limit(1);
      if (!promoter)
        throw new NotFoundException('Promoter profile unavailable');

      // Update profile type or display name when explicitly registering or onboarding a website/app
      const needsTypeUpdate =
        (explicitTypeUpdate || type === 'WEBSITE' || type === 'MOBILE_APP') &&
        promoter.type !== type;
      const needsNameUpdate =
        Boolean(displayName && displayName.trim()) &&
        promoter.displayName !== displayName!.trim();

      if (needsTypeUpdate || needsNameUpdate) {
        const [updated] = await tx
          .update(adsPromoters)
          .set({
            ...(needsTypeUpdate ? { type } : {}),
            ...(needsNameUpdate ? { displayName: displayName!.trim() } : {}),
            updatedAt: new Date(),
          })
          .where(eq(adsPromoters.id, promoter.id))
          .returning();
        if (updated) promoter = updated;
      }

      if (type === 'INDIVIDUAL') {
        await tx
          .insert(adsReelsConsents)
          .values({
            promoterId: promoter.id,
            consentGiven: 0,
          })
          .onConflictDoNothing({ target: adsReelsConsents.promoterId });
      }
      return promoter;
    });
  }

  /**
   * Register a website for a promoter with canonical domain/HTTPS root validation,
   * cross-owner duplicate protection, and same-owner idempotency.
   */
  async addWebsite(
    promoterId: string,
    params: {
      url: string;
      domain: string;
      verificationMethod: 'dns_txt' | 'html_file_and_meta_tag';
      allowedCategories?: string[];
    },
  ) {
    const normalized = normalizePromoterWebsiteInput(params.url, params.domain);

    const existingForDomain = await this.db
      .select()
      .from(adsPromoterWebsites)
      .where(eq(adsPromoterWebsites.domain, normalized.domain));

    // Prevent another promoter from claiming an already-verified or active domain
    const crossOwnerClaim = existingForDomain.find(
      (site) =>
        site.promoterId !== promoterId &&
        (site.verificationStatus === 'verified' || site.isActive),
    );
    if (crossOwnerClaim) {
      throw new ConflictException(
        `Domain "${normalized.domain}" is already registered by another promoter account.`,
      );
    }

    // Same-owner idempotency: if this promoter already registered the domain, update verification method if still pending/failed
    const sameOwnerSite = existingForDomain.find(
      (site) => site.promoterId === promoterId,
    );
    if (sameOwnerSite) {
      if (sameOwnerSite.verificationStatus !== 'verified') {
        const [updated] = await this.db
          .update(adsPromoterWebsites)
          .set({
            url: normalized.url,
            verificationMethod: params.verificationMethod,
            allowedCategories: params.allowedCategories
              ? JSON.stringify(params.allowedCategories)
              : sameOwnerSite.allowedCategories,
            updatedAt: new Date(),
          })
          .where(eq(adsPromoterWebsites.id, sameOwnerSite.id))
          .returning();
        return updated;
      }
      return sameOwnerSite;
    }

    const verificationToken = `cf_verify_${crypto.randomBytes(16).toString('hex')}`;

    const [website] = await this.db
      .insert(adsPromoterWebsites)
      .values({
        promoterId,
        url: normalized.url,
        domain: normalized.domain,
        verificationToken,
        verificationMethod: params.verificationMethod,
        verificationStatus: 'pending',
        policyStatus: 'unverified',
        policyRevision: 1,
        allowedCategories: params.allowedCategories
          ? JSON.stringify(params.allowedCategories)
          : null,
      })
      .returning();

    return website;
  }

  /**
   * Submit a verified website for policy review (TESTING -> PENDING_APPROVAL)
   */
  async submitWebsiteForReview(promoterId: string, websiteId: string) {
    const [website] = await this.db
      .select()
      .from(adsPromoterWebsites)
      .where(
        and(
          eq(adsPromoterWebsites.id, websiteId),
          eq(adsPromoterWebsites.promoterId, promoterId),
        ),
      )
      .limit(1);

    if (!website) {
      throw new NotFoundException('Website not found');
    }

    if (website.verificationStatus !== 'verified') {
      throw new BadRequestException(
        'Verify domain ownership first before submitting this website for policy approval.',
      );
    }

    if (website.isSuspended || website.policyStatus === 'suspended') {
      throw new BadRequestException(
        'Suspended websites cannot be submitted for policy review without admin reinstatement.',
      );
    }

    const nextPolicyRevision = (website.policyRevision || 1) + 1;
    const [updated] = await this.db
      .update(adsPromoterWebsites)
      .set({
        policyStatus: 'pending_approval',
        policyRevision: nextPolicyRevision,
        updatedAt: new Date(),
      })
      .where(eq(adsPromoterWebsites.id, websiteId))
      .returning();

    await this.db.insert(adsSupplyStateHistory).values({
      entityType: 'website',
      entityId: websiteId,
      dimension: 'policy_status',
      fromState: website.policyStatus || 'testing',
      toState: 'pending_approval',
      actorRole: 'promoter',
      reason: 'Promoter submitted verified website for paid supply approval',
    });

    return updated;
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
  async addMobileApp(
    promoterId: string,
    params: {
      appName: string;
      bundleId: string;
      platform: 'ios' | 'android' | 'both';
      storeUrl?: string;
      allowedCategories?: string[];
    },
  ) {
    const [app] = await this.db
      .insert(adsPromoterApps)
      .values({
        promoterId,
        appName: params.appName,
        bundleId: params.bundleId.trim(),
        platform: params.platform,
        storeUrl: params.storeUrl,
        verificationStatus: 'pending',
        allowedCategories: params.allowedCategories
          ? JSON.stringify(params.allowedCategories)
          : null,
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
    const invalidRatePct =
      total > 0 ? Math.round((invalid / total) * 10000) / 100 : 0;

    return {
      promoterId: promoter.id,
      trustScore: promoter.trustScore ?? 70,
      isSuspended: Boolean(promoter.isSuspended),
      suspensionReason: promoter.suspensionReason,
      totalInteractions: total,
      validInteractions: valid,
      invalidInteractions: invalid,
      invalidRatePct,
      status: promoter.isSuspended
        ? 'suspended'
        : (promoter.trustScore ?? 70) >= 60
          ? 'good'
          : 'warning',
    };
  }
}
