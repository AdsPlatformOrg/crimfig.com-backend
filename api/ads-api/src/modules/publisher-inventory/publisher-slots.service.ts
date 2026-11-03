import { readinessReport, websiteReadiness, installationReadiness } from '../delivery/readiness-report';
import { slotDeliveryDiagnostics } from '../delivery/paid-delivery-policy';
import { Injectable, Inject, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { adstationSlots, adsPromoterWebsites, adsServes, adsInteractions, adsSupplyStateHistory } from '@crimfig/database/schema';
import { and, eq, desc, gte, sql, or } from 'drizzle-orm';
import * as crypto from 'crypto';
import { normalizeSlotPresetPolicy, CURRENT_IMAGE_PRESETS_POLICY_VERSION } from '../uploads/image-ad-presets';

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

@Injectable()
export class PublisherSlotsService {
  constructor(@Inject(DATABASE_TOKEN) protected readonly db: NodePgDatabase<typeof schema>) {}

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

}
