import { readinessReport, websiteReadiness } from '../delivery/readiness-report';
import { paidDeliveryDiagnostics } from '../delivery/paid-delivery-policy';
import { Injectable, Inject, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { adstationSlots, adsPromoterWebsites, adsServes, adsInteractions, adsAuctionDecisions, adsSupplyStateHistory } from '@crimfig/database/schema';
import { and, eq, desc, gte, sql, or, ilike } from 'drizzle-orm';


@Injectable()
export class AdsOperationsService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>) {}

  /**
   * Super Admin Enforcement: Suspend or Reinstate Website Direct Deals & Policy Status
   */
  async updateWebsiteAdstationStatus(
    websiteId: string,
    isSuspended: boolean,
    reason?: string,
    reviewerId?: string,
  ) {
    const [existing] = await this.db
      .select()
      .from(adsPromoterWebsites)
      .where(eq(adsPromoterWebsites.id, websiteId))
      .limit(1);

    if (!existing) {
      throw new NotFoundException('Website not found');
    }

    const nextPolicyStatus = isSuspended
      ? 'suspended'
      : existing.verificationStatus === 'verified'
        ? 'approved'
        : 'unverified';

    const [updated] = await this.db
      .update(adsPromoterWebsites)
      .set({
        isSuspended,
        policyStatus: nextPolicyStatus,
        policyRevision: (existing.policyRevision || 1) + 1,
        suspensionReason: isSuspended
          ? reason || 'Super Admin moderation action'
          : null,
        reviewNote: reason || null,
        reviewedBy: reviewerId || null,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(adsPromoterWebsites.id, websiteId))
      .returning();

    await this.db.insert(adsSupplyStateHistory).values({
      entityType: 'website',
      entityId: websiteId,
      dimension: 'policy_status',
      fromState: existing.policyStatus,
      toState: nextPolicyStatus,
      actorId: reviewerId || null,
      actorRole: 'ads_admin',
      reason: reason || (isSuspended ? 'Suspended website' : 'Reinstated/approved website'),
    });

    return {
      status: isSuspended ? 'suspended' : 'active',
      websiteId: updated.id,
      domain: updated.domain,
      policyStatus: updated.policyStatus,
      isSuspended: updated.isSuspended,
      suspensionReason: updated.suspensionReason,
    };
  }

  /**
   * Admin / Compliance: Review promoter website policy status ('approved' | 'rejected' | 'testing' | 'suspended')
   */
  async reviewWebsitePolicy(
    websiteId: string,
    decision: 'approved' | 'rejected' | 'testing' | 'suspended',
    reason?: string,
    reviewerId?: string,
  ) {
    if (!['approved', 'rejected', 'testing', 'suspended'].includes(decision)) throw new BadRequestException('Unsupported website policy decision.');
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 1000)) throw new BadRequestException('Review reason must be at most 1000 characters.');
    return this.db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout='5s'`);
      await tx.execute(sql`set local statement_timeout='8s'`);
      const [existing] = await tx
        .select()
        .from(adsPromoterWebsites)
        .where(eq(adsPromoterWebsites.id, websiteId))
        .for('update')
        .limit(1);

      if (!existing) {
        throw new NotFoundException('Website not found');
      }

      if (decision === 'approved' && (existing.verificationStatus !== 'verified' || !existing.verificationExpiresAt || existing.verificationExpiresAt <= new Date())) {
        throw new BadRequestException(
          'Cannot approve a website for paid ad serving without current, unexpired domain ownership verification.',
        );
      }

      const isSuspended = decision === 'suspended';
      const [updated] = await tx
        .update(adsPromoterWebsites)
        .set({
          policyStatus: decision,
          isSuspended,
          policyRevision: (existing.policyRevision || 1) + 1,
          reviewNote: reason || null,
          suspensionReason: isSuspended ? reason || 'Policy suspension' : null,
          reviewedBy: reviewerId || null,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(adsPromoterWebsites.id, websiteId))
        .returning();

      await tx.insert(adsSupplyStateHistory).values({
        entityType: 'website',
        entityId: websiteId,
        dimension: 'policy_status',
        fromState: existing.policyStatus,
        toState: decision,
        actorId: reviewerId || null,
        actorRole: 'ads_admin',
        reason: reason || `Website policy set to ${decision}`,
      });
      return updated;
    });
  }

  /**
   * Admin / Compliance: Inspect recent auction decisions (`GET /api/v1/adstation/admin/auction-decisions`)
   */
  async listAuctionDecisions(options: {
    limit?: number;
    page?: number;
    pageSize?: number;
    slotTagId?: string;
    requestId?: string;
    search?: string;
    inventoryClass?: string;
  } = {}) {
    const page = Math.max(1, Number(options.page) || 1);
    const pageSize = Math.min(Math.max(1, Number(options.pageSize || options.limit) || 100), 200);
    const offset = (page - 1) * pageSize;

    const conditions: any[] = [];
    if (options.slotTagId) conditions.push(eq(adsAuctionDecisions.slotTagId, options.slotTagId));
    if (options.requestId) conditions.push(eq(adsAuctionDecisions.requestId, options.requestId));
    if (options.inventoryClass && options.inventoryClass !== 'all') {
      conditions.push(eq(adsAuctionDecisions.inventoryClass, options.inventoryClass as any));
    }
    if (options.search && options.search.trim()) {
      const q = `%${options.search.trim()}%`;
      conditions.push(
        or(
          ilike(adsAuctionDecisions.slotTagId, q),
          sql`${adsAuctionDecisions.requestId}::text ILIKE ${q}`,
          ilike(adsAuctionDecisions.inventoryClass, q),
        ),
      );
    }

    const whereClause = conditions.length === 1 ? conditions[0] : conditions.length > 1 ? and(...conditions) : undefined;

    const [countResult] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(adsAuctionDecisions)
      .where(whereClause);

    const total = countResult?.count || 0;

    const rows = await this.db
      .select()
      .from(adsAuctionDecisions)
      .where(whereClause)
      .orderBy(desc(adsAuctionDecisions.createdAt), desc(adsAuctionDecisions.id))
      .limit(pageSize)
      .offset(offset);

    // Drizzle schema uses BigInt for billingPriceNanos which crashes JSON.stringify if returned raw
    const items = rows.map((row) => ({
      ...row,
      billingPriceNanos:
        typeof row.billingPriceNanos === 'bigint'
          ? row.billingPriceNanos.toString()
          : row.billingPriceNanos,
    }));

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async getAuctionDecision(requestId: string) {
    const [row] = await this.db
      .select()
      .from(adsAuctionDecisions)
      .where(eq(adsAuctionDecisions.requestId, requestId))
      .limit(1);
    if (!row) return null;

    // Fetch correlated site and slot if available
    let website: any = null;
    let slot: any = null;
    if (row.websiteId) {
      const [w] = await this.db
        .select({ id: adsPromoterWebsites.id, domain: adsPromoterWebsites.domain, policyStatus: adsPromoterWebsites.policyStatus, verificationStatus: adsPromoterWebsites.verificationStatus })
        .from(adsPromoterWebsites)
        .where(eq(adsPromoterWebsites.id, row.websiteId))
        .limit(1);
      website = w || null;
    }
    if (row.slotId) {
      const [s] = await this.db
        .select({ id: adstationSlots.id, name: adstationSlots.name, format: adstationSlots.format, lifecycleStatus: adstationSlots.lifecycleStatus, installationStatus: adstationSlots.installationStatus })
        .from(adstationSlots)
        .where(eq(adstationSlots.id, row.slotId))
        .limit(1);
      slot = s || null;
    }

    const platformDiagnostics = paidDeliveryDiagnostics();

    return {
      ...row,
      website,
      slot,
      platformDiagnostics,
      billingPriceNanos:
        typeof row.billingPriceNanos === 'bigint'
          ? row.billingPriceNanos.toString()
          : row.billingPriceNanos,
    };
  }

  /**
   * Admin / Compliance: List promoter websites with search, status filters, and pagination
   */
  async adminListWebsites(
    page = 1,
    pageSize = 25,
    search?: string,
    policyStatus?: string,
    verificationStatus?: string,
  ) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new BadRequestException('Invalid pagination parameters.');
    }
    const cleanSearch = search?.trim();
    return this.db.transaction(async (tx: any) => {
      await tx.execute(sql`SET LOCAL statement_timeout='8s'`);

      const conditions: any[] = [];
      if (cleanSearch) {
        conditions.push(
          sql`(${adsPromoterWebsites.domain} ILIKE ${'%' + cleanSearch + '%'} OR ${adsPromoterWebsites.url} ILIKE ${'%' + cleanSearch + '%'} OR ${schema.users.email} ILIKE ${'%' + cleanSearch + '%'} OR ${adsPromoterWebsites.id}::text ILIKE ${'%' + cleanSearch + '%'})`
        );
      }
      if (policyStatus && policyStatus !== 'all') {
        conditions.push(eq(adsPromoterWebsites.policyStatus, policyStatus as any));
      }
      if (verificationStatus && verificationStatus !== 'all') {
        conditions.push(eq(adsPromoterWebsites.verificationStatus, verificationStatus as any));
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const rows = await tx
        .select({
          id: adsPromoterWebsites.id,
          domain: adsPromoterWebsites.domain,
          url: adsPromoterWebsites.url,
          promoterId: adsPromoterWebsites.promoterId,
          promoterEmail: schema.users.email,
          verificationStatus: adsPromoterWebsites.verificationStatus,
          verificationMethod: adsPromoterWebsites.verificationMethod,
          verifiedAt: adsPromoterWebsites.verifiedAt,
          verificationExpiresAt: adsPromoterWebsites.verificationExpiresAt,
          policyStatus: adsPromoterWebsites.policyStatus,
          policyRevision: adsPromoterWebsites.policyRevision,
          reviewNote: adsPromoterWebsites.reviewNote,
          reviewedAt: adsPromoterWebsites.reviewedAt,
          isActive: adsPromoterWebsites.isActive,
          isSuspended: adsPromoterWebsites.isSuspended,
          createdAt: adsPromoterWebsites.createdAt,
          updatedAt: adsPromoterWebsites.updatedAt,
        })
        .from(adsPromoterWebsites)
        .leftJoin(schema.adsPromoters, eq(adsPromoterWebsites.promoterId, schema.adsPromoters.id))
        .leftJoin(schema.users, eq(schema.adsPromoters.userId, schema.users.id))
        .where(whereClause)
        .orderBy(desc(adsPromoterWebsites.createdAt), desc(adsPromoterWebsites.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      const [totalRow] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(adsPromoterWebsites)
        .leftJoin(schema.adsPromoters, eq(adsPromoterWebsites.promoterId, schema.adsPromoters.id))
        .leftJoin(schema.users, eq(schema.adsPromoters.userId, schema.users.id))
        .where(whereClause);

      // Get slot counts for returned websites
      const siteIds = rows.map((r: any) => r.id);
      const slotCounts = siteIds.length > 0
        ? await tx
            .select({
              websiteId: adstationSlots.websiteId,
              totalSlots: sql<number>`count(*)::int`,
              activeSlots: sql<number>`count(*) filter (where ${adstationSlots.isActive} = true)::int`,
            })
            .from(adstationSlots)
            .where(sql`${adstationSlots.websiteId} IN ${siteIds}`)
            .groupBy(adstationSlots.websiteId)
        : [];

      const slotMap = new Map<string, { total: number; active: number }>();
      for (const sc of slotCounts) {
        slotMap.set(sc.websiteId, { total: sc.totalSlots || 0, active: sc.activeSlots || 0 });
      }

      const now = Date.now();
      const items = rows.map((site: any) => {
        const sc = slotMap.get(site.id) || { total: 0, active: 0 };
        const expiry = site.verificationExpiresAt ? new Date(site.verificationExpiresAt).getTime() : 0;
        const ownershipVerified = site.verificationStatus === 'verified' && expiry > now;

        let paidEligibility: 'eligible' | 'pending_approval' | 'unverified' | 'blocked' = 'eligible';
        if (site.isSuspended || !site.isActive) {
          paidEligibility = 'blocked';
        } else if (!ownershipVerified) {
          paidEligibility = 'unverified';
        } else if (site.policyStatus === 'pending_approval' || site.policyStatus === 'testing') {
          paidEligibility = 'pending_approval';
        } else if (site.policyStatus !== 'approved') {
          paidEligibility = 'blocked';
        }

        return {
          ...site,
          slotCount: sc.total,
          activeSlotCount: sc.active,
          paidEligibility,
        };
      });

      return {
        items,
        page,
        pageSize,
        total: totalRow?.count ?? 0,
      };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }

  /**
   * Admin / Compliance: Get full inspection details for a single promoter website
   */
  async adminGetWebsite(websiteId: string) {
    return this.db.transaction(async (tx: any) => {
      await tx.execute(sql`SET LOCAL statement_timeout='8s'`);

      const [site] = await tx
        .select({
          id: adsPromoterWebsites.id,
          domain: adsPromoterWebsites.domain,
          url: adsPromoterWebsites.url,
          promoterId: adsPromoterWebsites.promoterId,
          promoterEmail: schema.users.email,
          verificationToken: adsPromoterWebsites.verificationToken,
          verificationStatus: adsPromoterWebsites.verificationStatus,
          verificationMethod: adsPromoterWebsites.verificationMethod,
          verifiedAt: adsPromoterWebsites.verifiedAt,
          verificationExpiresAt: adsPromoterWebsites.verificationExpiresAt,
          lastVerificationAttemptAt: adsPromoterWebsites.lastVerificationAttemptAt,
          verificationErrorMessage: adsPromoterWebsites.verificationErrorMessage,
          deliveryPreference: adsPromoterWebsites.deliveryPreference,
          considerationSlotActive: adsPromoterWebsites.considerationSlotActive,
          considerationSlotVerifiedAt: adsPromoterWebsites.considerationSlotVerifiedAt,
          policyStatus: adsPromoterWebsites.policyStatus,
          policyRevision: adsPromoterWebsites.policyRevision,
          reviewNote: adsPromoterWebsites.reviewNote,
          reviewedBy: adsPromoterWebsites.reviewedBy,
          reviewedAt: adsPromoterWebsites.reviewedAt,
          trustScore: adsPromoterWebsites.trustScore,
          isActive: adsPromoterWebsites.isActive,
          isSuspended: adsPromoterWebsites.isSuspended,
          suspensionReason: adsPromoterWebsites.suspensionReason,
          createdAt: adsPromoterWebsites.createdAt,
          updatedAt: adsPromoterWebsites.updatedAt,
        })
        .from(adsPromoterWebsites)
        .leftJoin(schema.adsPromoters, eq(adsPromoterWebsites.promoterId, schema.adsPromoters.id))
        .leftJoin(schema.users, eq(schema.adsPromoters.userId, schema.users.id))
        .where(eq(adsPromoterWebsites.id, websiteId))
        .limit(1);

      if (!site) throw new NotFoundException('Website not found.');

      // Fetch associated slots
      const slots = await tx
        .select()
        .from(adstationSlots)
        .where(eq(adstationSlots.websiteId, websiteId))
        .orderBy(desc(adstationSlots.createdAt));

      // Fetch audit history
      const history = await tx
        .select()
        .from(adsSupplyStateHistory)
        .where(and(eq(adsSupplyStateHistory.entityType, 'website'), eq(adsSupplyStateHistory.entityId, websiteId)))
        .orderBy(desc(adsSupplyStateHistory.createdAt))
        .limit(50);

      // Evaluate delivery readiness report
      const now = new Date();
      const report = readinessReport('website', websiteId, now);
      websiteReadiness(report, site, now, true);

      return {
        website: site,
        slots,
        history,
        readiness: report.result(),
      };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }

  /**
   * Admin / Staff: Trigger slot installation evidence check on behalf of promoter (`POST /api/v1/adstation/admin/slots/:id/check-installation`)
   */
  async adminCheckSlotInstallation(slotId: string) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout='5s'`);
      await tx.execute(sql`set local statement_timeout='8s'`);

      const [slot] = await tx
        .select()
        .from(adstationSlots)
        .where(eq(adstationSlots.id, slotId))
        .for('update')
        .limit(1);

      if (!slot) {
        throw new NotFoundException('AdStation slot not found');
      }

      const [website] = await tx
        .select()
        .from(adsPromoterWebsites)
        .where(eq(adsPromoterWebsites.id, slot.websiteId))
        .for('share')
        .limit(1);

      if (!website) {
        throw new NotFoundException('Parent website not found');
      }

      if (website.verificationStatus !== 'verified' || !website.verificationExpiresAt || website.verificationExpiresAt <= new Date()) {
        throw new BadRequestException('Parent website domain ownership is not verified or has expired.');
      }
      if (website.isSuspended || website.policyStatus === 'suspended') {
        throw new ForbiddenException('Parent website is suspended');
      }

      const [serveStats] = await tx
        .select({
          serveCount: sql<number>`count(*)::int`,
          lastServedAt: sql<Date | null>`max(${adsServes.servedAt})`,
        })
        .from(adsServes)
        .where(
          and(
            eq(adsServes.slotHandle, slot.slotTagId),
            gte(adsServes.servedAt, new Date(Date.now() - 24 * 60 * 60 * 1000)),
          ),
        );

      const [interactionStats] = await tx
        .select({
          renderCount: sql<number>`count(*) filter (where ${adsInteractions.type} = 'render')::int`,
          impressionCount: sql<number>`count(*) filter (where ${adsInteractions.type} in ('impression', 'viewable_impression'))::int`,
        })
        .from(adsInteractions)
        .where(
          and(
            eq(adsInteractions.slotId, slot.id),
            gte(adsInteractions.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000)),
          ),
        );

      const totalServes = serveStats?.serveCount || 0;
      const totalRenders =
        (interactionStats?.renderCount || 0) +
        (interactionStats?.impressionCount || 0);
      const isInstalled = totalServes > 0 && totalRenders > 0;

      const nextInstallationStatus = isInstalled ? 'verified' : 'missing';
      const nextLifecycleStatus =
        slot.lifecycleStatus === 'suspended' ||
        slot.lifecycleStatus === 'paused' ||
        slot.lifecycleStatus === 'disabled'
          ? slot.lifecycleStatus
          : isInstalled
            ? website.policyStatus === 'approved'
              ? 'active'
              : 'testing'
            : 'testing';

      const diagnostic = isInstalled
        ? `Verified embed activity on ${website.domain}: ${totalServes} ad serve(s), ${totalRenders} render/impression beacon(s).`
        : totalServes > 0
          ? `Ad requests detected on ${website.domain}, but no render receipt has been received. Check delivery errors and load the publisher page again.`
          : `No ad requests received yet for slot tag "${slot.slotTagId}" on https://${website.domain}. Ensure the slot snippet is embedded and traffic is loading the page.`;

      const [updatedSlot] = await tx
        .update(adstationSlots)
        .set({
          installationStatus: nextInstallationStatus,
          installationCheckedAt: new Date(),
          installationDiagnostic: diagnostic,
          lifecycleStatus: nextLifecycleStatus,
          isConsiderationVerified: slot.isConsiderationSlot ? isInstalled : slot.isConsiderationVerified,
          considerationLastCheckedAt: slot.isConsiderationSlot
            ? new Date()
            : slot.considerationLastCheckedAt,
          updatedAt: new Date(),
        })
        .where(eq(adstationSlots.id, slot.id))
        .returning();

      if (slot.isConsiderationSlot && isInstalled) {
        await tx
          .update(adsPromoterWebsites)
          .set({
            considerationSlotActive: true,
            considerationSlotVerifiedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(adsPromoterWebsites.id, website.id));
      }

      return {
        isInstalled,
        installationStatus: updatedSlot.installationStatus,
        lifecycleStatus: updatedSlot.lifecycleStatus,
        serveCount: totalServes,
        renderBeaconCount: totalRenders,
        lastServedAt: serveStats?.lastServedAt || null,
        diagnostic,
        slot: updatedSlot,
      };
    });
  }


  /**
   * Admin: Transition slot lifecycle (e.g. testing -> active) with prerequisite validation and audit trail.
   */
  async adminUpdateSlotLifecycle(
    slotId: string,
    targetLifecycle: 'active' | 'testing' | 'paused' | 'suspended',
    reason: string,
    reviewerId?: string,
  ) {
    if (!['active', 'testing', 'paused', 'suspended'].includes(targetLifecycle)) {
      throw new BadRequestException('Invalid target lifecycle status');
    }
    if (!reason || reason.trim().length < 5) {
      throw new BadRequestException('A reason of at least 5 characters is required for lifecycle transitions.');
    }

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout='5s'`);
      await tx.execute(sql`set local statement_timeout='8s'`);

      const [slot] = await tx
        .select()
        .from(adstationSlots)
        .where(eq(adstationSlots.id, slotId))
        .for('update')
        .limit(1);

      if (!slot) {
        throw new NotFoundException('AdStation slot not found');
      }

      if (slot.lifecycleStatus === targetLifecycle) {
        return { message: `Slot is already in ${targetLifecycle} lifecycle`, slot };
      }

      const [website] = await tx
        .select()
        .from(adsPromoterWebsites)
        .where(eq(adsPromoterWebsites.id, slot.websiteId))
        .for('share')
        .limit(1);

      if (!website) {
        throw new NotFoundException('Parent website not found');
      }

      // If activating, validate all supply prerequisites
      if (targetLifecycle === 'active') {
        if (website.verificationStatus !== 'verified' || !website.verificationExpiresAt || website.verificationExpiresAt <= new Date()) {
          throw new BadRequestException('Cannot activate slot: Parent website domain ownership verification is absent or expired.');
        }
        if (website.policyStatus !== 'approved') {
          throw new BadRequestException(`Cannot activate slot: Parent website suitability policy is "${website.policyStatus}". Must be "approved".`);
        }
        if (website.isSuspended) {
          throw new ForbiddenException('Cannot activate slot: Parent website is suspended.');
        }
        if (slot.installationStatus !== 'verified') {
          throw new BadRequestException(`Cannot activate slot: Slot installation status is "${slot.installationStatus}". Verified embed telemetry is required.`);
        }
      }

      const previousLifecycle = slot.lifecycleStatus;
      const [updatedSlot] = await tx
        .update(adstationSlots)
        .set({
          lifecycleStatus: targetLifecycle,
          isActive: targetLifecycle === 'active' || targetLifecycle === 'testing',
          updatedAt: new Date(),
        })
        .where(eq(adstationSlots.id, slotId))
        .returning();

      // Record immutable audit history
      await tx.insert(adsSupplyStateHistory).values({
        entityType: 'slot',
        entityId: slotId,
        dimension: 'lifecycle_status',
        fromState: previousLifecycle,
        toState: targetLifecycle,
        actorId: reviewerId || null,
        actorRole: 'ads_admin',
        reason: reason.trim(),
      });

      return {
        message: `Slot lifecycle transitioned from ${previousLifecycle} to ${targetLifecycle}.`,
        previousLifecycle,
        currentLifecycle: targetLifecycle,
        slot: updatedSlot,
      };
    });
  }
}
