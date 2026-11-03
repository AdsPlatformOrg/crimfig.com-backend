import { readinessReport, websiteReadiness, installationReadiness } from '../delivery/readiness-report';
import { slotDeliveryDiagnostics } from '../delivery/paid-delivery-policy';
import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import {
  adstationSlots,
  adstationDirectCampaigns,
  adsPromoterWebsites,
  adsServes,
  adsInteractions,
  adsAuctionDecisions,
  adsSupplyStateHistory,
} from '@crimfig/database/schema';
import { and, eq, desc, gte, sql } from 'drizzle-orm';
import * as crypto from 'crypto';
import {
  normalizeSlotPresetPolicy,
  CURRENT_IMAGE_PRESETS_POLICY_VERSION,
} from '../uploads/image-ad-presets';

export interface CreateAdstationSlotDto {
  websiteId: string;
  name: string;
  slotType: 'consideration' | 'direct' | 'network' | 'hybrid';
  format?: string;
  slotDeliveryPreference?: string;
  width?: number;
  height?: number;
  responsive?: boolean;
  allowedAdTypes?: string[];
  allowedPresetIds?: string[];
}

export interface UpdateAdstationSlotDto {
  name?: string;
  format?: string;
  slotDeliveryPreference?: string;
  lifecycleStatus?: 'testing' | 'active' | 'paused' | 'disabled';
  width?: number;
  height?: number;
  responsive?: boolean;
  allowedAdTypes?: string[];
  allowedPresetIds?: string[];
}

export interface CreateDirectCampaignDto {
  websiteId: string;
  slotId?: string;
  clientName: string;
  campaignTitle: string;
  destinationUrl: string;
  headline?: string;
  imageUrl?: string;
  videoUrl?: string;
  targetImpressions?: number;
  endsAt?: Date;
}

@Injectable()
export class AdstationService {
  private readonly logger = new Logger(AdstationService.name);

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * List slots for a promoter website
   */
  async getSlots(promoterId: string, websiteId: string) {
    return this.db
      .select()
      .from(adstationSlots)
      .where(
        and(
          eq(adstationSlots.promoterId, promoterId),
          eq(adstationSlots.websiteId, websiteId),
        ),
      )
      .orderBy(desc(adstationSlots.createdAt));
  }

  /**
   * Create a canonical ad slot in AdStation.
   * Requires a verified promoter website owned by this promoter.
   */
  async createSlot(promoterId: string, dto: CreateAdstationSlotDto) {
    const [website] = await this.db
      .select()
      .from(adsPromoterWebsites)
      .where(
        and(
          eq(adsPromoterWebsites.id, dto.websiteId),
          eq(adsPromoterWebsites.promoterId, promoterId),
        ),
      )
      .limit(1);

    if (!website) {
      throw new NotFoundException('Promoter website not found or unauthorized');
    }

    if (website.verificationStatus !== 'verified') {
      throw new BadRequestException(
        'Verify domain ownership first before creating ad slots for this website.',
      );
    }

    if (website.isSuspended || website.policyStatus === 'suspended') {
      throw new ForbiddenException(
        'Cannot create ad slots on a suspended website.',
      );
    }

    const isConsideration = dto.slotType === 'consideration';
    const tagSuffix = crypto.randomBytes(8).toString('hex');
    const slotTagId = `cf-slot-${dto.slotType}-${tagSuffix}`;
    const initialLifecycle =
      website.policyStatus === 'approved' ? 'testing' : 'testing';

    const normalizedPolicy = normalizeSlotPresetPolicy(dto.allowedPresetIds);

    const [slot] = await this.db
      .insert(adstationSlots)
      .values({
        promoterId,
        websiteId: dto.websiteId,
        name: dto.name.trim(),
        slotType: dto.slotType,
        format: dto.format || 'banner',
        isConsiderationSlot: isConsideration,
        isConsiderationVerified: false,
        slotDeliveryPreference: dto.slotDeliveryPreference,
        slotTagId,
        lifecycleStatus: initialLifecycle,
        width: dto.width ?? null,
        height: dto.height ?? null,
        responsive: dto.responsive ?? true,
        allowedAdTypes: dto.allowedAdTypes
          ? JSON.stringify(dto.allowedAdTypes)
          : null,
        presetPolicy: normalizedPolicy.policy,
        allowedPresetIds:
          dto.allowedPresetIds && dto.allowedPresetIds.length > 0
            ? JSON.stringify(normalizedPolicy.allowedPresetIds)
            : null,
        presetPolicyVersion: CURRENT_IMAGE_PRESETS_POLICY_VERSION,
        installationStatus: 'unchecked',
        policyRevision: 1,
        isActive: true,
      })
      .returning();

    if (isConsideration) {
      await this.db
        .update(adsPromoterWebsites)
        .set({
          considerationSlotActive: true,
          updatedAt: new Date(),
        })
        .where(eq(adsPromoterWebsites.id, dto.websiteId));
    }

    await this.db.insert(adsSupplyStateHistory).values({
      entityType: 'slot',
      entityId: slot.id,
      dimension: 'lifecycle_status',
      fromState: 'draft',
      toState: slot.lifecycleStatus,
      actorRole: 'promoter',
      reason: `Created ${dto.slotType} slot ${slot.slotTagId}`,
    });

    return slot;
  }

  /**
   * Update an existing canonical AdStation slot (pause/resume/configure).
   * Enforces that owners cannot clear an admin-imposed 'suspended' state.
   */
  async updateSlot(
    promoterId: string,
    slotId: string,
    dto: UpdateAdstationSlotDto,
  ) {
    const [slot] = await this.db
      .select()
      .from(adstationSlots)
      .where(
        and(
          eq(adstationSlots.id, slotId),
          eq(adstationSlots.promoterId, promoterId),
        ),
      )
      .limit(1);

    if (!slot) {
      throw new NotFoundException('AdStation slot not found or unauthorized');
    }

    if (slot.lifecycleStatus === 'suspended') {
      throw new ForbiddenException(
        'This ad slot is suspended by compliance moderation and cannot be modified or resumed without admin reinstatement.',
      );
    }

    let nextLifecycle = slot.lifecycleStatus;
    let nextIsActive = slot.isActive;
    if (dto.lifecycleStatus) {
      if (
        !['testing', 'active', 'paused', 'disabled'].includes(
          dto.lifecycleStatus,
        )
      ) {
        throw new BadRequestException('Invalid slot lifecycle status');
      }
      if (
        dto.lifecycleStatus === 'active' &&
        slot.installationStatus !== 'verified' &&
        !slot.isConsiderationVerified
      ) {
        // Keep in testing until installation check passes
        nextLifecycle = 'testing';
      } else {
        nextLifecycle = dto.lifecycleStatus;
      }
      nextIsActive =
        nextLifecycle !== 'paused' && nextLifecycle !== 'disabled';
    }

    let presetUpdates = {};
    if (dto.allowedPresetIds !== undefined) {
      const normalized = normalizeSlotPresetPolicy(dto.allowedPresetIds);
      presetUpdates = {
        presetPolicy: normalized.policy,
        allowedPresetIds:
          dto.allowedPresetIds && dto.allowedPresetIds.length > 0
            ? JSON.stringify(normalized.allowedPresetIds)
            : null,
        presetPolicyVersion: CURRENT_IMAGE_PRESETS_POLICY_VERSION,
      };
    }

    const [updated] = await this.db
      .update(adstationSlots)
      .set({
        ...(dto.name ? { name: dto.name.trim() } : {}),
        ...(dto.format ? { format: dto.format } : {}),
        ...(dto.slotDeliveryPreference !== undefined
          ? { slotDeliveryPreference: dto.slotDeliveryPreference }
          : {}),
        ...(dto.width !== undefined ? { width: dto.width } : {}),
        ...(dto.height !== undefined ? { height: dto.height } : {}),
        ...(dto.responsive !== undefined ? { responsive: dto.responsive } : {}),
        ...(dto.allowedAdTypes
          ? { allowedAdTypes: JSON.stringify(dto.allowedAdTypes) }
          : {}),
        ...presetUpdates,
        lifecycleStatus: nextLifecycle,
        isActive: nextIsActive,
        policyRevision: (slot.policyRevision || 1) + 1,
        updatedAt: new Date(),
      })
      .where(eq(adstationSlots.id, slotId))
      .returning();

    if (nextLifecycle !== slot.lifecycleStatus) {
      await this.db.insert(adsSupplyStateHistory).values({
        entityType: 'slot',
        entityId: slot.id,
        dimension: 'lifecycle_status',
        fromState: slot.lifecycleStatus,
        toState: nextLifecycle,
        actorRole: 'promoter',
        reason: `Promoter updated slot lifecycle to ${nextLifecycle}`,
      });
    }

    return updated;
  }

  /**
   * Generate environment-safe HTML & Next.js/React embed snippet for a persisted slot.
   */
  async getSlotEmbedInstructions(promoterId: string, slotId: string) {
    const [slot] = await this.db
      .select()
      .from(adstationSlots)
      .where(
        and(
          eq(adstationSlots.id, slotId),
          eq(adstationSlots.promoterId, promoterId),
        ),
      )
      .limit(1);

    if (!slot) {
      throw new NotFoundException('AdStation slot not found or unauthorized');
    }

    const [website] = await this.db
      .select()
      .from(adsPromoterWebsites)
      .where(eq(adsPromoterWebsites.id, slot.websiteId))
      .limit(1);

    if(!website)throw new NotFoundException('Website not found');
    if(website.promoterId!==promoterId)throw new ForbiddenException('Website ownership changed');

    const adsPublicUrl = (
      process.env.ADS_PUBLIC_URL ||
      process.env.NEXT_PUBLIC_ADS_API_URL ||
      'https://api.ads.crimfig.com'
    ).replace(/\/$/, '');

    const slotSnippet = [
      `<!-- CrimFig Ad Slot: ${slot.name} (${slot.slotTagId}) -->`,
      `<!-- If you have a visitor consent choice, supply it before loading the SDK. The default is unknown. -->`,
      `<ins class="crimfig-pub-slot"`,
      `     style="display:block;min-height:0;"`,
      `     data-cf-height="${slot.height || 90}"`,
      `     data-cf-consent="unknown"`,
      `     data-cf-api-base="${adsPublicUrl}"`,
      `     data-ad-slot="${slot.slotTagId}"`,
      `     data-ad-format="${slot.format || 'banner'}"`,
      `     data-full-width-responsive="${slot.responsive ? 'true' : 'false'}"></ins>`,
    ].join('\n');
    const sdkSnippet = `<script async crossorigin="anonymous" src="${adsPublicUrl}/api/v1/delivery/embed.js"></script>`;
    const htmlSnippet = [slotSnippet, "<!-- Load this SDK only once per page, not once per slot. -->", sdkSnippet].join("\n");
    const consentInstructions = "If your site collects a measurement consent choice, pass it before the SDK requests an ad. Only after genuine visitor consent, set data-cf-consent to granted on each slot; unknown or denied does not disqualify paid delivery. Load one SDK for all slots. Changing consent after initialization does not retry that slot: save the decision and reload, or defer SDK initialization until consent is resolved. Consent does not replace website approval or guarantee paid fill.";

    const nextJsSnippet = [
      `// Next.js / React Component Usage (${website?.domain || 'your-domain.com'})`,
      `// measurementConsent must come from your visitor consent manager before mounting.`,
      `<CrimFigAdSlot`,
      `  slotTagId="${slot.slotTagId}"`,
      `  publisherKey="${website?.id || slot.websiteId}"`,
      `  apiBaseUrl="${adsPublicUrl}"`,
      `  measurementConsent="unknown"`,
      `/>`,
    ].join('\n');

    const evaluatedAt = new Date();
    const readiness = readinessReport('slot', slot.id, evaluatedAt);
    websiteReadiness(readiness, website, evaluatedAt, false);
    installationReadiness(readiness, slot, evaluatedAt);
    return {
      slotId: slot.id,
      slotTagId: slot.slotTagId,
      websiteId: slot.websiteId,
      domain: website?.domain || null,
      lifecycleStatus: slot.lifecycleStatus,
      installationStatus: slot.installationStatus,
      deliveryReadiness:slotDeliveryDiagnostics(slot,website),
      readiness: readiness.result(),
      adsPublicUrl,
      htmlSnippet,
      sdkSnippet,
      slotSnippet,
      consentInstructions,
      nextJsSnippet,
    };
  }

  /**
   * Evidence-driven installation check for a canonical slot (`POST /api/v1/adstation/slots/:id/check-installation`).
   * Inspects recent serves and render/impression receipts from the registered website domain.
   */
  async checkSlotInstallation(promoterId: string, slotId: string) {
    return this.db.transaction(async tx => {
    await tx.execute(sql`set local lock_timeout='5s'`);
    await tx.execute(sql`set local statement_timeout='8s'`);
    const [slot] = await tx
      .select()
      .from(adstationSlots)
      .where(
        and(
          eq(adstationSlots.id, slotId),
          eq(adstationSlots.promoterId, promoterId),
        ),
      )
      .for('update').limit(1);

    if (!slot) {
      throw new NotFoundException('AdStation slot not found or unauthorized');
    }

    const [website] = await tx
      .select()
      .from(adsPromoterWebsites)
      .where(eq(adsPromoterWebsites.id, slot.websiteId))
      .for('share').limit(1);

    if (!website) {
      throw new NotFoundException('Website not found');
    }

    if (website.promoterId !== promoterId) throw new ForbiddenException('Website ownership changed');
    if (website.verificationStatus !== 'verified' || !website.verificationExpiresAt || website.verificationExpiresAt <= new Date()) {
      throw new BadRequestException('Reverify domain ownership before certifying installation.');
    }
    if (website.isSuspended || website.policyStatus === 'suspended') throw new ForbiddenException('Website is suspended');

    const [serveStats] = await tx
      .select({
        serveCount: sql<number>`count(*)::int`,
        lastServedAt: sql<Date | null>`max(${adsServes.servedAt})`,
      })
      .from(adsServes)
      .where(and(eq(adsServes.slotHandle, slot.slotTagId), gte(adsServes.servedAt, new Date(Date.now() - 24 * 60 * 60 * 1000))));

    const [interactionStats] = await tx
      .select({
        renderCount: sql<number>`count(*) filter (where ${adsInteractions.type} = 'render')::int`,
        impressionCount: sql<number>`count(*) filter (where ${adsInteractions.type} in ('impression', 'viewable_impression'))::int`,
      })
      .from(adsInteractions)
      .where(and(eq(adsInteractions.slotId, slot.id), gte(adsInteractions.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000))));

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
        : `No ad requests received yet for slot tag "${slot.slotTagId}" on https://${website.domain}. Install the snippet and load the page once, then re-run this check.`;

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
   * Slot diagnostics summary (`GET /api/v1/adstation/slots/:id/diagnostics`).
   * Surfaces safe promoter-facing telemetry without exposing private fraud rules or thresholds.
   */
  async getSlotDiagnostics(promoterId: string, slotId: string) {
    const [slot] = await this.db
      .select()
      .from(adstationSlots)
      .where(
        and(
          eq(adstationSlots.id, slotId),
          eq(adstationSlots.promoterId, promoterId),
        ),
      )
      .limit(1);

    if (!slot) {
      throw new NotFoundException('AdStation slot not found or unauthorized');
    }

    const [website] = await this.db
      .select()
      .from(adsPromoterWebsites)
      .where(eq(adsPromoterWebsites.id, slot.websiteId))
      .limit(1);

    const [serveMetrics] = await this.db
      .select({
        totalServes: sql<number>`count(*)::int`,
        houseServes: sql<number>`count(*) filter (where ${adsServes.inventoryClass} in ('house', 'shadow'))::int`,
        paidServes: sql<number>`count(*) filter (where ${adsServes.inventoryClass} in ('paid', 'simulated_paid'))::int`,
        lastServedAt: sql<Date | null>`max(${adsServes.servedAt})`,
      })
      .from(adsServes)
      .where(eq(adsServes.slotHandle, slot.slotTagId));

    const [eventMetrics] = await this.db
      .select({
        renders: sql<number>`count(*) filter (where ${adsInteractions.type} = 'render')::int`,
        impressions: sql<number>`count(*) filter (where ${adsInteractions.type} = 'impression')::int`,
        viewableImpressions: sql<number>`count(*) filter (where ${adsInteractions.type} = 'viewable_impression' and ${adsInteractions.isValid} = true)::int`,
        clicks: sql<number>`count(*) filter (where ${adsInteractions.type} = 'click' and ${adsInteractions.isValid} = true)::int`,
        filteredInvalid: sql<number>`count(*) filter (where ${adsInteractions.isValid} = false)::int`,
      })
      .from(adsInteractions)
      .where(eq(adsInteractions.slotId, slot.id));

    return {
      slotId: slot.id,
      slotTagId: slot.slotTagId,
      name: slot.name,
      slotType: slot.slotType,
      format: slot.format,
      lifecycleStatus: slot.lifecycleStatus,
      installationStatus: slot.installationStatus,
      installationCheckedAt: slot.installationCheckedAt,
      installationDiagnostic: slot.installationDiagnostic,
      website: website
        ? {
            id: website.id,
            domain: website.domain,
            verificationStatus: website.verificationStatus,
            policyStatus: website.policyStatus,
            isSuspended: website.isSuspended,
          }
        : null,
      telemetry: {
        totalServes: serveMetrics?.totalServes || 0,
        houseOrDefaultServes: serveMetrics?.houseServes || 0,
        paidServes: serveMetrics?.paidServes || 0,
        lastServedAt: serveMetrics?.lastServedAt || null,
        renders: eventMetrics?.renders || 0,
        impressions: eventMetrics?.impressions || 0,
        viewableImpressions: eventMetrics?.viewableImpressions || 0,
        clicks: eventMetrics?.clicks || 0,
        filteredInvalidEvents: eventMetrics?.filteredInvalid || 0,
      },
    };
  }

  /**
   * Verify Consideration Slot (PLAN-0018 Section 2.1)
   */
  async verifyConsiderationSlot(
    promoterId: string,
    websiteId: string,
    slotId: string,
  ) {
    const [slot] = await this.db
      .select()
      .from(adstationSlots)
      .where(
        and(
          eq(adstationSlots.id, slotId),
          eq(adstationSlots.websiteId, websiteId),
          eq(adstationSlots.promoterId, promoterId),
        ),
      )
      .limit(1);

    if (!slot) {
      throw new NotFoundException('AdStation slot not found');
    }

    if (!slot.isConsiderationSlot && slot.slotType !== 'consideration') {
      throw new BadRequestException(
        'Slot is not designated as a consideration slot',
      );
    }

    const result = await this.checkSlotInstallation(promoterId, slotId);
    if (!result.isInstalled) throw new BadRequestException('A recent real render receipt is required before verifying this placement.');

    return {
      status: 'verified',
      slot: result.slot,
    };
  }

  /**
   * Update Account Delivery Preference (PLAN-0018 Section 2.2)
   */
  async updateDeliveryPreference(
    promoterId: string,
    websiteId: string,
    preference: 'high' | 'medium' | 'low',
  ) {
    const [updated] = await this.db
      .update(adsPromoterWebsites)
      .set({
        deliveryPreference: preference,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(adsPromoterWebsites.id, websiteId),
          eq(adsPromoterWebsites.promoterId, promoterId),
        ),
      )
      .returning();

    if (!updated) {
      throw new NotFoundException('Website not found');
    }

    return {
      status: 'success',
      deliveryPreference: updated.deliveryPreference,
    };
  }

  /**
   * List Direct Campaigns (100% revenue to site owner; 0% CF commission)
   */
  async getDirectCampaigns(promoterId: string, websiteId?: string) {
    if (websiteId) {
      return this.db
        .select()
        .from(adstationDirectCampaigns)
        .where(
          and(
            eq(adstationDirectCampaigns.promoterId, promoterId),
            eq(adstationDirectCampaigns.websiteId, websiteId),
          ),
        )
        .orderBy(desc(adstationDirectCampaigns.createdAt));
    }

    return this.db
      .select()
      .from(adstationDirectCampaigns)
      .where(eq(adstationDirectCampaigns.promoterId, promoterId))
      .orderBy(desc(adstationDirectCampaigns.createdAt));
  }

  /**
   * Create Direct Campaign
   * Enforces: CANNOT bind direct campaign to a Consideration Slot! (PLAN-0018 Section 2.1)
   */
  async createDirectCampaign(promoterId: string, dto: CreateDirectCampaignDto) {
    const [website] = await this.db
      .select()
      .from(adsPromoterWebsites)
      .where(
        and(
          eq(adsPromoterWebsites.id, dto.websiteId),
          eq(adsPromoterWebsites.promoterId, promoterId),
        ),
      )
      .limit(1);

    if (!website) {
      throw new NotFoundException('Promoter website not found or unauthorized');
    }

    if (dto.slotId) {
      const [slot] = await this.db
        .select()
        .from(adstationSlots)
        .where(
          and(
            eq(adstationSlots.id, dto.slotId),
            eq(adstationSlots.promoterId, promoterId),
            eq(adstationSlots.websiteId, dto.websiteId),
          ),
        )
        .limit(1);

      if (!slot) {
        throw new NotFoundException('AdStation slot not found or unauthorized');
      }

      if (slot.isConsiderationSlot || slot.slotType === 'consideration') {
        throw new BadRequestException(
          'Direct deals cannot be assigned to a Consideration Slot. Consideration slots serve exclusively CrimFig network ads.',
        );
      }
    }

    const [campaign] = await this.db
      .insert(adstationDirectCampaigns)
      .values({
        promoterId,
        websiteId: dto.websiteId,
        slotId: dto.slotId || null,
        clientName: dto.clientName,
        campaignTitle: dto.campaignTitle,
        destinationUrl: dto.destinationUrl,
        headline: dto.headline || null,
        imageUrl: dto.imageUrl || null,
        videoUrl: dto.videoUrl || null,
        targetImpressions: dto.targetImpressions || 0,
        status: 'active',
        endsAt: dto.endsAt || null,
      })
      .returning();

    return campaign;
  }

  /**
   * Record Direct Deal Ad Event with Idempotency Deduplication (PLAN-0018 Phase 3)
   */
  async recordDirectEvent(dto: {
    promoterId?: string;
    directCampaignId: string;
    websiteId: string;
    slotId?: string;
    eventType: 'impression' | 'viewable_impression' | 'click' | 'hover';
    idempotencyKey: string;
    isViewable?: boolean;
    viewDurationMs?: number;
    ipHash?: string;
    userAgent?: string;
  }) {
    if (dto.promoterId) {
      const [campaign] = await this.db
        .select()
        .from(adstationDirectCampaigns)
        .where(
          and(
            eq(adstationDirectCampaigns.id, dto.directCampaignId),
            eq(adstationDirectCampaigns.promoterId, dto.promoterId),
            eq(adstationDirectCampaigns.websiteId, dto.websiteId),
          ),
        )
        .limit(1);

      if (!campaign) {
        throw new NotFoundException('Direct campaign not found or unauthorized');
      }
    }

    const existing = await this.db
      .select({ id: schema.adstationAdEvents.id })
      .from(schema.adstationAdEvents)
      .where(eq(schema.adstationAdEvents.idempotencyKey, dto.idempotencyKey))
      .limit(1);

    if (existing.length > 0) {
      return { status: 'duplicate_ignored', eventId: existing[0].id };
    }

    const [event] = await this.db
      .insert(schema.adstationAdEvents)
      .values({
        directCampaignId: dto.directCampaignId,
        websiteId: dto.websiteId,
        slotId: dto.slotId || null,
        eventType: dto.eventType,
        idempotencyKey: dto.idempotencyKey,
        isViewable: dto.isViewable ?? false,
        viewDurationMs: dto.viewDurationMs ?? 0,
        ipHash: dto.ipHash || null,
        userAgent: dto.userAgent || null,
      })
      .returning();

    if (
      dto.eventType === 'impression' ||
      dto.eventType === 'viewable_impression'
    ) {
      const [camp] = await this.db
        .select({ delivered: adstationDirectCampaigns.deliveredImpressions })
        .from(adstationDirectCampaigns)
        .where(eq(adstationDirectCampaigns.id, dto.directCampaignId))
        .limit(1);

      if (camp) {
        await this.db
          .update(adstationDirectCampaigns)
          .set({
            deliveredImpressions: (camp.delivered || 0) + 1,
            updatedAt: new Date(),
          })
          .where(eq(adstationDirectCampaigns.id, dto.directCampaignId));
      }
    } else if (dto.eventType === 'click') {
      const [camp] = await this.db
        .select({ clicks: adstationDirectCampaigns.deliveredClicks })
        .from(adstationDirectCampaigns)
        .where(eq(adstationDirectCampaigns.id, dto.directCampaignId))
        .limit(1);

      if (camp) {
        await this.db
          .update(adstationDirectCampaigns)
          .set({
            deliveredClicks: (camp.clicks || 0) + 1,
            updatedAt: new Date(),
          })
          .where(eq(adstationDirectCampaigns.id, dto.directCampaignId));
      }
    }

    return { status: 'recorded', eventId: event.id };
  }

  /**
   * Consideration Slot 48-Hour Grace State Machine (PLAN-0018 Phase 6)
   */
  async checkConsiderationSlotHealth(websiteId: string, promoterId?: string) {
    const [website] = await this.db
      .select()
      .from(adsPromoterWebsites)
      .where(
        promoterId
          ? and(
              eq(adsPromoterWebsites.id, websiteId),
              eq(adsPromoterWebsites.promoterId, promoterId),
            )
          : eq(adsPromoterWebsites.id, websiteId),
      )
      .limit(1);

    if (!website) {
      throw new NotFoundException('Website not found');
    }

    const considerationSlots = await this.db
      .select()
      .from(adstationSlots)
      .where(
        and(
          eq(adstationSlots.websiteId, websiteId),
          eq(adstationSlots.isConsiderationSlot, true),
          eq(adstationSlots.isActive, true),
        ),
      );

    const hasHealthyConsideration = considerationSlots.some(
      (s) => s.isConsiderationVerified,
    );

    if (hasHealthyConsideration) {
      if (website.considerationSlotActive === false) {
        await this.db
          .update(adsPromoterWebsites)
          .set({
            considerationSlotActive: true,
            suspensionReason: null,
            updatedAt: new Date(),
          })
          .where(eq(adsPromoterWebsites.id, websiteId));
      }
      return {
        status: 'healthy',
        considerationVerified: true,
        graceActive: false,
      };
    }

    const referenceTime =
      website.considerationSlotVerifiedAt ||
      website.lastVerificationAttemptAt ||
      website.createdAt;
    const gracePeriodMs = 48 * 60 * 60 * 1000;
    const elapsedMs = Date.now() - new Date(referenceTime).getTime();
    const graceRemainingHours = Math.max(
      0,
      Math.round((gracePeriodMs - elapsedMs) / (60 * 60 * 1000)),
    );

    if (elapsedMs > gracePeriodMs) {
      await this.db
        .update(adsPromoterWebsites)
        .set({
          considerationSlotActive: false,
          isSuspended: true,
          policyStatus: 'suspended',
          suspensionReason:
            'Consideration slot requirement unfulfilled past 48-hour grace window.',
          updatedAt: new Date(),
        })
        .where(eq(adsPromoterWebsites.id, websiteId));

      return {
        status: 'suspended',
        considerationVerified: false,
        graceActive: false,
        graceRemainingHours: 0,
        reason:
          'Consideration slot requirement unfulfilled past 48-hour grace window.',
      };
    }

    return {
      status: 'pending_review_grace',
      considerationVerified: false,
      graceActive: true,
      graceRemainingHours,
      reason: `Consideration slot unverified. Please configure tag within ${graceRemainingHours} hours to avoid suspension.`,
    };
  }

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
  async listAuctionDecisions(limit = 50, slotTagId?: string, requestId?: string) {
    const safeLimit = Math.min(Math.max(1, Number(limit) || 50), 200);
    const conditions: any[] = [];
    if (slotTagId) conditions.push(eq(adsAuctionDecisions.slotTagId, slotTagId));
    if (requestId) conditions.push(eq(adsAuctionDecisions.requestId, requestId));

    const rows = await this.db
      .select()
      .from(adsAuctionDecisions)
      .where(conditions.length === 1 ? conditions[0] : conditions.length > 1 ? and(...conditions) : undefined)
      .orderBy(desc(adsAuctionDecisions.createdAt))
      .limit(safeLimit);

    // Drizzle schema uses BigInt for billingPriceNanos which crashes JSON.stringify if returned raw
    return rows.map((row) => ({
      ...row,
      billingPriceNanos:
        typeof row.billingPriceNanos === 'bigint'
          ? row.billingPriceNanos.toString()
          : row.billingPriceNanos,
    }));
  }

  async getAuctionDecision(requestId: string) {
    const [row] = await this.db
      .select()
      .from(adsAuctionDecisions)
      .where(eq(adsAuctionDecisions.requestId, requestId))
      .limit(1);
    if (!row) return null;
    return {
      ...row,
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
}
