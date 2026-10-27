import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import {
  adsCampaigns,
  adsCreatives,
  adsCreativeStacks,
  adsMediaAssets,
  crimfigGeoTargets,
} from '@crimfig/database/schema';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../database/database.module';
import { AdsEscrowService } from '../billing/ads-escrow.service';
import { LocationsService, ResolvedTarget } from '../locations/locations.service';
import { LocationScope } from '../locations/location.types';

const AD_TYPES = ['text', 'image', 'video'] as const;
const AD_FORMATS = ['banner', 'card', 'video', 'interstitial'] as const;
const DEVICE_CATEGORIES = ['desktop', 'mobile', 'android', 'ios', 'tablet'] as const;
const ALLOWED_VIDEO_PLACEMENTS = ['in_content_mid', 'in_content_end', 'listing_interstitial'];

type AdType = (typeof AD_TYPES)[number];
type AdFormat = (typeof AD_FORMATS)[number];

export interface GeoSelectionInput {
  geoMode?: 'global' | 'targeted';
  locations?: string[];
}

export interface StackSettingsInput {
  name?: string;
  geoMode?: 'inherit' | 'global' | 'targeted';
  locations?: string[];
  targetDevices?: string[] | null;
  targetHours?: number[] | null;
}

export interface CreativeInput {
  adStackId?: string;
  adType?: AdType;
  headline?: string | null;
  bodyText?: string | null;
  ctaText?: string | null;
  destinationUrl: string;
  imageUrl?: string;
  videoUrl?: string;
  adFormat?: AdFormat;
  mediaFormat?: 'image' | 'gif' | 'video';
  mediaAssetId?: string;
}

function videoAuthoringEnabled(): boolean {
  return (process.env.CREATIVE_VIDEO_AUTHORING_ENABLED || 'false').toLowerCase() === 'true';
}

function parseJsonArray<T>(value: string | null | undefined, fallback: T[]): T[] {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}

function cleanString(value: string | undefined, field: string, max: number, required = false): string {
  const text = (value || '').trim();
  if (required && !text) throw new BadRequestException(`${field} is required.`);
  if (text.length > max) throw new BadRequestException(`${field} must be ${max} characters or fewer.`);
  return text;
}

function assertHttpUrl(value: string): string {
  const text = cleanString(value, 'Destination URL', 2048, true);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new BadRequestException('Enter a valid destination URL including https://.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new BadRequestException('Destination URL must be an http(s) address without embedded credentials.');
  }
  return url.toString();
}

function cleanDevices(value: string[] | null | undefined): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) throw new BadRequestException('Choose at least one device category.');
  const unique = [...new Set(value)];
  if (unique.some((device) => !DEVICE_CATEGORIES.includes(device as any))) {
    throw new BadRequestException('Unsupported device category.');
  }
  return unique;
}

function cleanHours(value: number[] | null | undefined): number[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) throw new BadRequestException('Choose at least one daypart hour.');
  const unique = [...new Set(value)];
  if (unique.some((hour) => !Number.isInteger(hour) || hour < 0 || hour > 23)) {
    throw new BadRequestException('Daypart hours must be integers from 0 to 23.');
  }
  return unique.sort((a, b) => a - b);
}

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly escrowService: AdsEscrowService,
    private readonly locations: LocationsService,
  ) {}

  creationCapabilities() {
    const enabled = videoAuthoringEnabled();
    return {
      videoAuthoringEnabled: enabled,
      allowedVideoPlacements: enabled ? ALLOWED_VIDEO_PLACEMENTS : [],
      supportedAdTypes: enabled ? [...AD_TYPES] : ['text', 'image'],
    };
  }

  // ── Ownership and editability ───────────────────────────────────────────────

  private async campaignForUpdate(tx: any, campaignId: string, advertiserId: string) {
    const [campaign] = await tx
      .select()
      .from(adsCampaigns)
      .where(and(eq(adsCampaigns.id, campaignId), eq(adsCampaigns.advertiserId, advertiserId)))
      .for('update')
      .limit(1);
    if (!campaign) throw new NotFoundException('Campaign not found or unauthorized.');
    return campaign;
  }

  private assertEditable(campaign: typeof adsCampaigns.$inferSelect) {
    if (campaign.status === 'trash' || campaign.status === 'cancelled' || campaign.status === 'completed') {
      throw new BadRequestException('This campaign can no longer be edited.');
    }
    if (campaign.moderationStatus !== 'draft' && campaign.moderationStatus !== 'rejected') {
      throw new BadRequestException('This campaign is in review or approved; creative changes are closed.');
    }
  }

  private async resolveGeo(
    geoMode: 'global' | 'targeted' | 'inherit',
    locations: string[] | undefined,
    fallbackMode: 'global' | 'targeted' = 'global',
  ): Promise<{ mode: 'global' | 'targeted' | 'inherit'; targets: ResolvedTarget[] }> {
    if (geoMode === 'inherit') {
      if (locations && locations.length > 0) throw new BadRequestException('Inherited targeting cannot carry its own locations.');
      return { mode: 'inherit', targets: [] };
    }
    const mode = geoMode || fallbackMode;
    if (mode === 'global') {
      if (locations && locations.length > 0) throw new BadRequestException('Global targeting cannot include locations.');
      return { mode: 'global', targets: [] };
    }
    if (!locations || locations.length === 0) throw new BadRequestException('Choose at least one location, or select Global.');
    return { mode: 'targeted', targets: await this.locations.resolveTargetsByIds(locations) };
  }

  // ── Campaign creation ───────────────────────────────────────────────────────

  async createCampaign(params: {
    advertiserId: string;
    title: string;
    description?: string;
    category?: string;
    channels?: string[];
    budgetUsd: number;
    dailyBudgetUsd?: number;
    costPerImpressionCents?: number;
    costPerClickCents?: number;
    pricingModel?: 'cpm' | 'cpc';
    format?: AdFormat;
    targetCountries?: string[];
    targetStates?: string[];
    targetDevices?: string[];
    targetHours?: number[];
    frequencyCapPerDay?: number;
    geoMode?: 'global' | 'targeted';
    locations?: string[];
    startsAt?: Date;
    endsAt?: Date;
  }) {
    const title = cleanString(params.title, 'Campaign title', 255, true);
    if (params.budgetUsd < 5) throw new BadRequestException('Minimum campaign budget is $5.00 USD.');
    if (!Number.isFinite(params.budgetUsd) || params.budgetUsd > 100_000_000) {
      throw new BadRequestException('Campaign budget is out of range.');
    }
    const cpmBid = params.costPerImpressionCents ?? 50;
    const cpcBid = params.costPerClickCents ?? 10;
    if (!Number.isSafeInteger(cpmBid) || cpmBid < 50 || cpmBid > 2147483647) {
      throw new BadRequestException('Minimum CPM bid is 50 integer USD cents ($0.50 per 1,000 viewable impressions).');
    }
    if (!Number.isSafeInteger(cpcBid) || cpcBid < 10 || cpcBid > 2147483647) {
      throw new BadRequestException('Minimum CPC bid is 10 integer USD cents ($0.10 per click).');
    }
    const budgetCents = Math.round(params.budgetUsd * 100);
    const dailyBudgetCents = params.dailyBudgetUsd ? Math.round(params.dailyBudgetUsd * 100) : null;
    if (dailyBudgetCents !== null && (dailyBudgetCents < 100 || dailyBudgetCents > budgetCents)) {
      throw new BadRequestException('Daily budget cannot exceed the total budget and must be at least $1.00.');
    }
    const hourlyPacingCents = dailyBudgetCents ? Math.ceil(dailyBudgetCents / 24) : null;
    const devices = cleanDevices(params.targetDevices);
    const hours = cleanHours(params.targetHours);
    const legacyCountryLocations = (params.targetCountries || [])
      .filter((code) => /^[A-Za-z]{2}$/.test(code))
      .map((code) => `country:${code.toUpperCase()}`);
    const geoLocations = params.locations?.length ? params.locations : legacyCountryLocations;
    const geo = await this.resolveGeo(
      params.geoMode || (geoLocations.length ? 'targeted' : 'global'),
      geoLocations,
    );

    const created = await this.db.transaction(async (tx) => {
      const [campaign] = await tx
        .insert(adsCampaigns)
        .values({
          advertiserId: params.advertiserId,
          title,
          description: params.description?.trim() || null,
          category: params.category?.trim() || null,
          channels: params.channels ? JSON.stringify([...new Set(params.channels)]) : null,
          budgetUsdCents: budgetCents,
          dailyBudgetUsdCents: dailyBudgetCents,
          hourlyPacingUsdCents: hourlyPacingCents,
          remainingBudgetUsdCents: budgetCents,
          pricingVersion: 2,
          pricingModel: params.pricingModel || 'cpm',
          costPerImpressionUsdCents: cpmBid,
          costPerClickUsdCents: cpcBid,
          format: params.format || 'card',
          status: 'draft',
          moderationStatus: 'draft',
          targetCountries: geo.mode === 'targeted' ? JSON.stringify([...new Set(geo.targets.flatMap((t) => t.resolvedCountries))]) : null,
          targetStates: geo.mode === 'targeted' ? JSON.stringify([...new Set(geo.targets.flatMap((t) => t.resolvedSubdivisions))]) : null,
          targetDevices: devices ? JSON.stringify(devices) : null,
          targetHours: hours ? JSON.stringify(hours) : null,
          frequencyCapPerDay: params.frequencyCapPerDay ?? 5,
          geoMode: geo.mode === 'targeted' ? 'targeted' : 'global',
          startsAt: params.startsAt || new Date(),
          endsAt: params.endsAt,
        })
        .returning();

      const [stack] = await tx
        .insert(adsCreativeStacks)
        .values({ campaignId: campaign.id, name: 'Ad Stack #1', position: 1 })
        .returning();

      if (geo.mode === 'targeted') {
        await this.locations.replaceTargets(tx, 'campaign', campaign.id, geo.targets);
      }
      return { campaign, stack };
    });

    try {
      await this.escrowService.lockCampaignBudget({
        campaignId: created.campaign.id,
        userId: params.advertiserId,
        amountUsdCents: budgetCents,
        campaignTitle: title,
      });
    } catch (err: any) {
      this.logger.warn(`Campaign ${created.campaign.id} created; escrow lock deferred: ${err.message}`);
    }

    return { ...created.campaign, defaultStackId: created.stack.id };
  }

  // ── Stacks ──────────────────────────────────────────────────────────────────

  async createStack(campaignId: string, advertiserId: string, name?: string) {
    return this.db.transaction(async (tx) => {
      const campaign = await this.campaignForUpdate(tx, campaignId, advertiserId);
      this.assertEditable(campaign);
      const [row] = await tx
        .select({ max: sql<number>`coalesce(max(${adsCreativeStacks.position}), 0)` })
        .from(adsCreativeStacks)
        .where(eq(adsCreativeStacks.campaignId, campaignId));
      const position = Number(row?.max || 0) + 1;
      const [stack] = await tx
        .insert(adsCreativeStacks)
        .values({
          campaignId,
          name: cleanString(name || `Ad Stack #${position}`, 'Stack name', 100, true),
          position,
        })
        .returning();
      return stack;
    });
  }

  async updateStack(campaignId: string, stackId: string, advertiserId: string, input: StackSettingsInput) {
    return this.db.transaction(async (tx) => {
      const campaign = await this.campaignForUpdate(tx, campaignId, advertiserId);
      this.assertEditable(campaign);
      const [stack] = await tx
        .select()
        .from(adsCreativeStacks)
        .where(and(eq(adsCreativeStacks.id, stackId), eq(adsCreativeStacks.campaignId, campaignId)))
        .limit(1);
      if (!stack) throw new NotFoundException('Ad stack not found.');

      const update: Partial<typeof adsCreativeStacks.$inferInsert> = { updatedAt: new Date() };
      if (input.name !== undefined) update.name = cleanString(input.name, 'Stack name', 100, true);
      if (input.targetDevices !== undefined) {
        const devices = cleanDevices(input.targetDevices);
        update.targetDevices = devices ? JSON.stringify(devices) : null;
      }
      if (input.targetHours !== undefined) {
        const hours = cleanHours(input.targetHours);
        update.targetHours = hours ? JSON.stringify(hours) : null;
      }
      if (input.geoMode !== undefined) {
        const geo = await this.resolveGeo(input.geoMode, input.locations, 'global');
        update.geoMode = geo.mode;
        await this.locations.replaceTargets(tx, 'stack', stack.id, geo.targets);
      } else if (input.locations !== undefined) {
        throw new BadRequestException('Choose inherit, global, or targeted before changing stack locations.');
      }
      const [updated] = await tx.update(adsCreativeStacks).set(update).where(eq(adsCreativeStacks.id, stack.id)).returning();
      return updated;
    });
  }

  async deleteStack(campaignId: string, stackId: string, advertiserId: string) {
    return this.db.transaction(async (tx) => {
      const campaign = await this.campaignForUpdate(tx, campaignId, advertiserId);
      this.assertEditable(campaign);
      const stacks = await tx
        .select()
        .from(adsCreativeStacks)
        .where(eq(adsCreativeStacks.campaignId, campaignId))
        .orderBy(asc(adsCreativeStacks.position));
      if (stacks.length <= 1) throw new BadRequestException('The last ad stack cannot be removed.');
      const stack = stacks.find((s) => s.id === stackId);
      if (!stack) throw new NotFoundException('Ad stack not found.');
      if (stack.position === 1) throw new BadRequestException('The default ad stack cannot be removed.');
      await tx.delete(adsCreatives).where(eq(adsCreatives.adStackId, stack.id));
      await tx.delete(crimfigGeoTargets).where(and(eq(crimfigGeoTargets.ownerType, 'stack'), eq(crimfigGeoTargets.ownerId, stack.id)));
      await tx.delete(adsCreativeStacks).where(eq(adsCreativeStacks.id, stack.id));
      return { deleted: true };
    });
  }

  // ── Creatives ───────────────────────────────────────────────────────────────

  private async validateCreative(
    tx: any,
    advertiserId: string,
    input: CreativeInput,
  ): Promise<{
    adType: AdType;
    headline: string | null;
    bodyText: string | null;
    ctaText: string | null;
    destinationUrl: string;
    adFormat: AdFormat;
    imageUrl: string | null;
    videoUrl: string | null;
    posterUrl: string | null;
    mediaAssetId: string | null;
    mediaFormat: 'image' | 'gif' | 'video';
  }> {
    const destinationUrl = assertHttpUrl(input.destinationUrl);
    const adFormat = (input.adFormat || 'card') as AdFormat;
    if (!AD_FORMATS.includes(adFormat)) throw new BadRequestException('Unsupported display format.');

    let adType = input.adType;
    if (!adType) {
      adType = input.videoUrl ? 'video' : input.imageUrl ? 'image' : 'text';
    }
    if (!AD_TYPES.includes(adType)) throw new BadRequestException('Unsupported ad type.');
    if (adType === 'video' && !videoAuthoringEnabled()) {
      throw new BadRequestException('Video authoring is not available yet.');
    }

    // Image/video artwork may contain the entire advertising message. Text ads are
    // the only type that must carry a discrete headline.
    const headline = input.headline?.trim() ? cleanString(input.headline, 'Headline', 100) : null;
    if (adType === 'text' && !headline) {
      throw new BadRequestException('A headline is required for text ads.');
    }
    const bodyText = input.bodyText?.trim() ? cleanString(input.bodyText, 'Body text', 2000) : null;
    const configuredCta = input.ctaText?.trim() ? cleanString(input.ctaText, 'Call to action', 50) : null;
    const ctaText = adType === 'text' ? configuredCta || 'Learn More' : configuredCta;

    let asset: typeof adsMediaAssets.$inferSelect | undefined;
    if (input.mediaAssetId) {
      [asset] = await tx
        .select()
        .from(adsMediaAssets)
        .where(and(eq(adsMediaAssets.id, input.mediaAssetId), eq(adsMediaAssets.ownerId, advertiserId), eq(adsMediaAssets.status, 'ready')))
        .limit(1);
      if (!asset) throw new BadRequestException('The selected media asset is not owned by this advertiser or is not ready.');
    } else {
      const candidate = adType === 'video' ? input.videoUrl : adType === 'image' ? input.imageUrl : undefined;
      if (candidate) {
        [asset] = await tx
          .select()
          .from(adsMediaAssets)
          .where(and(eq(adsMediaAssets.cdnUrl, candidate), eq(adsMediaAssets.ownerId, advertiserId), eq(adsMediaAssets.status, 'ready')))
          .limit(1);
      }
    }

    if (adType === 'text') {
      return {
        adType,
        headline,
        bodyText,
        ctaText,
        destinationUrl,
        adFormat,
        imageUrl: null,
        videoUrl: null,
        posterUrl: null,
        mediaAssetId: null,
        mediaFormat: 'image',
      };
    }
    if (!asset) throw new BadRequestException(`A validated ${adType} asset is required.`);
    if (adType === 'image' && !asset.mimeType.startsWith('image/')) {
      throw new BadRequestException('The selected asset is not an image.');
    }
    if (adType === 'video' && !asset.mimeType.startsWith('video/')) {
      throw new BadRequestException('The selected asset is not a supported video.');
    }
    return {
      adType,
      headline,
      bodyText,
      ctaText,
      destinationUrl,
      adFormat,
      imageUrl: adType === 'image' ? asset.cdnUrl : null,
      videoUrl: adType === 'video' ? asset.cdnUrl : null,
      posterUrl: asset.thumbnailUrl || null,
      mediaAssetId: asset.id,
      mediaFormat: asset.mimeType === 'image/gif' ? 'gif' : adType === 'video' ? 'video' : 'image',
    };
  }

  async addCreative(campaignId: string, advertiserId: string, input: CreativeInput) {
    return this.db.transaction(async (tx) => {
      const campaign = await this.campaignForUpdate(tx, campaignId, advertiserId);
      this.assertEditable(campaign);
      const [stack] = input.adStackId
        ? await tx
            .select()
            .from(adsCreativeStacks)
            .where(and(eq(adsCreativeStacks.id, input.adStackId), eq(adsCreativeStacks.campaignId, campaignId)))
            .limit(1)
        : await tx
            .select()
            .from(adsCreativeStacks)
            .where(eq(adsCreativeStacks.campaignId, campaignId))
            .orderBy(asc(adsCreativeStacks.position))
            .limit(1);
      if (!stack) throw new BadRequestException('Choose a valid ad stack for this campaign.');
      const validated = await this.validateCreative(tx, advertiserId, input);
      const [creative] = await tx
        .insert(adsCreatives)
        .values({
          campaignId,
          adStackId: stack.id,
          adType: validated.adType,
          headline: validated.headline,
          bodyText: validated.bodyText,
          ctaText: validated.ctaText,
          destinationUrl: validated.destinationUrl,
          imageUrl: validated.imageUrl,
          videoUrl: validated.videoUrl,
          posterUrl: validated.posterUrl,
          mediaAssetId: validated.mediaAssetId,
          adFormat: validated.adFormat,
          mediaFormat: validated.mediaFormat,
          reviewStatus: 'pending',
          status: 'active',
        })
        .returning();
      return creative;
    });
  }

  async replaceCreative(creativeId: string, advertiserId: string, input: Partial<CreativeInput>) {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ creative: adsCreatives, campaign: adsCampaigns })
        .from(adsCreatives)
        .innerJoin(adsCampaigns, eq(adsCreatives.campaignId, adsCampaigns.id))
        .where(and(eq(adsCreatives.id, creativeId), eq(adsCampaigns.advertiserId, advertiserId)))
        .limit(1);
      if (!existing) throw new NotFoundException('Creative asset not found or unauthorized.');
      const campaign = await this.campaignForUpdate(tx, existing.campaign.id, advertiserId);
      this.assertEditable(campaign);

      const merged: CreativeInput = {
        adStackId: input.adStackId || existing.creative.adStackId,
        adType: (input.adType || existing.creative.adType) as AdType,
        headline: input.headline ?? existing.creative.headline,
        bodyText: input.bodyText ?? existing.creative.bodyText ?? undefined,
        ctaText: input.ctaText ?? existing.creative.ctaText,
        destinationUrl: input.destinationUrl ?? existing.creative.destinationUrl,
        imageUrl: input.imageUrl !== undefined ? input.imageUrl : existing.creative.imageUrl ?? undefined,
        videoUrl: input.videoUrl !== undefined ? input.videoUrl : existing.creative.videoUrl ?? undefined,
        adFormat: (input.adFormat || existing.creative.adFormat) as AdFormat,
        mediaAssetId: input.mediaAssetId,
      };
      if (merged.adType === 'text' && !input.mediaAssetId && input.imageUrl === undefined && input.videoUrl === undefined) {
        merged.imageUrl = undefined;
        merged.videoUrl = undefined;
      }
      const validated = await this.validateCreative(tx, advertiserId, merged);
      const [updated] = await tx
        .update(adsCreatives)
        .set({
          adStackId: merged.adStackId,
          adType: validated.adType,
          headline: validated.headline,
          bodyText: validated.bodyText,
          ctaText: validated.ctaText,
          destinationUrl: validated.destinationUrl,
          imageUrl: validated.imageUrl,
          videoUrl: validated.videoUrl,
          posterUrl: validated.posterUrl,
          mediaAssetId: validated.mediaAssetId,
          adFormat: validated.adFormat,
          mediaFormat: validated.mediaFormat,
          reviewStatus: 'pending',
          rejectionReason: null,
          reviewedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(adsCreatives.id, creativeId))
        .returning();
      return updated;
    });
  }

  // ── Review submission ───────────────────────────────────────────────────────

  async submitForReview(campaignId: string, advertiserId: string) {
    const [preflight] = await this.db
      .select()
      .from(adsCampaigns)
      .where(and(eq(adsCampaigns.id, campaignId), eq(adsCampaigns.advertiserId, advertiserId)))
      .limit(1);
    if (!preflight) throw new NotFoundException('Campaign not found or unauthorized.');
    if (preflight.moderationStatus !== 'draft' && preflight.moderationStatus !== 'rejected') {
      throw new BadRequestException('This campaign has already been submitted or approved.');
    }

    const escrow = await this.escrowService.getCampaignEscrow(campaignId, advertiserId);
    if (!escrow || escrow.status !== 'active') {
      await this.escrowService.lockCampaignBudget({
        campaignId,
        userId: advertiserId,
        amountUsdCents: preflight.budgetUsdCents,
        campaignTitle: preflight.title,
      });
    }

    return this.db.transaction(async (tx) => {
      const campaign = await this.campaignForUpdate(tx, campaignId, advertiserId);
      if (campaign.moderationStatus !== 'draft' && campaign.moderationStatus !== 'rejected') {
        throw new ConflictException('This campaign was already submitted by another request.');
      }
      const stacks = await tx
        .select()
        .from(adsCreativeStacks)
        .where(eq(adsCreativeStacks.campaignId, campaignId))
        .orderBy(asc(adsCreativeStacks.position));
      if (stacks.length === 0) throw new BadRequestException('Add at least one ad stack before submitting.');
      const creatives = await tx.select().from(adsCreatives).where(eq(adsCreatives.campaignId, campaignId));
      for (const stack of stacks) {
        const stackCreatives = creatives.filter((c) => c.adStackId === stack.id);
        if (stackCreatives.length === 0) throw new BadRequestException(`${stack.name} needs at least one complete ad.`);
        for (const creative of stackCreatives) {
          if (!creative.headline?.trim() || !creative.destinationUrl?.trim()) {
            throw new BadRequestException(`${stack.name} has an ad with missing headline or destination.`);
          }
          if (creative.adType === 'image' && !creative.imageUrl) {
            throw new BadRequestException(`${stack.name} has an image ad without an image asset.`);
          }
          if (creative.adType === 'video' && !creative.videoUrl) {
            throw new BadRequestException(`${stack.name} has a video ad without a video asset.`);
          }
          if (creative.mediaAssetId) {
            const [asset] = await tx
              .select({ id: adsMediaAssets.id })
              .from(adsMediaAssets)
              .where(and(eq(adsMediaAssets.id, creative.mediaAssetId), eq(adsMediaAssets.ownerId, advertiserId), eq(adsMediaAssets.status, 'ready')))
              .limit(1);
            if (!asset) throw new BadRequestException(`${stack.name} has an ad whose media asset is unavailable.`);
          }
        }
        if (stack.geoMode === 'targeted') {
          const targets = await tx
            .select({ id: crimfigGeoTargets.id })
            .from(crimfigGeoTargets)
            .where(and(eq(crimfigGeoTargets.ownerType, 'stack'), eq(crimfigGeoTargets.ownerId, stack.id)))
            .limit(1);
          if (targets.length === 0) throw new BadRequestException(`${stack.name} has targeted geography but no locations.`);
        }
      }
      if (campaign.geoMode === 'targeted') {
        const targets = await tx
          .select({ id: crimfigGeoTargets.id })
          .from(crimfigGeoTargets)
          .where(and(eq(crimfigGeoTargets.ownerType, 'campaign'), eq(crimfigGeoTargets.ownerId, campaign.id)))
          .limit(1);
        if (targets.length === 0) throw new BadRequestException('Choose at least one campaign location, or select Global.');
      }
      const [updated] = await tx
        .update(adsCampaigns)
        .set({ status: 'paused', moderationStatus: 'pending_primary_review', updatedAt: new Date() })
        .where(eq(adsCampaigns.id, campaignId))
        .returning();
      return updated;
    });
  }

  // ── Reads ───────────────────────────────────────────────────────────────────

  async getAdvertiserCampaigns(advertiserId: string, status?: string) {
    const conditions = [eq(adsCampaigns.advertiserId, advertiserId)];
    if (status && status !== 'all') conditions.push(eq(adsCampaigns.status, status as any));
    const campaigns = await this.db
      .select()
      .from(adsCampaigns)
      .where(and(...conditions))
      .orderBy(desc(adsCampaigns.createdAt));
    return campaigns.map((c) => ({
      ...c,
      budgetUsd: c.budgetUsdCents / 100,
      dailyBudgetUsd: c.dailyBudgetUsdCents ? c.dailyBudgetUsdCents / 100 : null,
      remainingBudgetUsd: c.remainingBudgetUsdCents / 100,
      spentUsd: (c.budgetUsdCents - c.remainingBudgetUsdCents) / 100,
    }));
  }

  async getCampaignDetails(campaignId: string, advertiserId: string) {
    if (!advertiserId) throw new NotFoundException('Campaign not found.');
    const [campaign] = await this.db
      .select()
      .from(adsCampaigns)
      .where(and(eq(adsCampaigns.id, campaignId), eq(adsCampaigns.advertiserId, advertiserId)))
      .limit(1);
    if (!campaign) throw new NotFoundException('Campaign not found.');

    const [stacks, creatives, targets] = await Promise.all([
      this.db.select().from(adsCreativeStacks).where(eq(adsCreativeStacks.campaignId, campaignId)).orderBy(asc(adsCreativeStacks.position)),
      this.db.select().from(adsCreatives).where(eq(adsCreatives.campaignId, campaignId)).orderBy(asc(adsCreatives.createdAt)),
      this.db.select().from(crimfigGeoTargets).where(
        and(
          eq(crimfigGeoTargets.ownerType, 'campaign'),
          eq(crimfigGeoTargets.ownerId, campaignId),
        ),
      ),
    ]);
    const stackTargets = stacks.length
      ? await this.db.select().from(crimfigGeoTargets).where(
          and(eq(crimfigGeoTargets.ownerType, 'stack'), inArray(crimfigGeoTargets.ownerId, stacks.map((s) => s.id))),
        )
      : [];
    const allTargets = [...targets, ...stackTargets];
    const places = await this.locations.getPlacesByIds([...new Set(allTargets.map((t) => t.placeId))]);
    const placeById = new Map(places.map((p) => [p.id, p]));

    const mapLocations = (ownerTargets: typeof allTargets) =>
      ownerTargets.map((target) => ({
        id: target.placeId,
        scope: target.scope as Exclude<LocationScope, 'global'>,
        name: placeById.get(target.placeId)?.name || target.placeId,
        resolvedCountries: parseJsonArray(target.resolvedCountries, []),
        resolvedSubdivisions: parseJsonArray(target.resolvedSubdivisions, []),
        resolvedCities: parseJsonArray(target.resolvedCities, []),
      }));

    const campaignDevices = parseJsonArray<string>(campaign.targetDevices, []);
    const campaignHours = parseJsonArray<number>(campaign.targetHours, []);
    const stackViews = stacks.map((stack) => {
      const ownTargets = stackTargets.filter((t) => t.ownerId === stack.id);
      const inherited = stack.geoMode === 'inherit';
      return {
        ...stack,
        creatives: creatives.filter((c) => c.adStackId === stack.id),
        settings: {
          geoMode: stack.geoMode,
          locations: mapLocations(ownTargets),
          targetDevices: parseJsonArray<string>(stack.targetDevices, []),
          targetHours: parseJsonArray<number>(stack.targetHours, []),
        },
        effectiveSettings: {
          geoMode: inherited ? campaign.geoMode : stack.geoMode,
          locations: inherited ? mapLocations(targets) : mapLocations(ownTargets),
          targetDevices: stack.targetDevices ? parseJsonArray<string>(stack.targetDevices, []) : campaignDevices,
          targetHours: stack.targetHours ? parseJsonArray<number>(stack.targetHours, []) : campaignHours,
          frequencyCapPerDay: campaign.frequencyCapPerDay,
          budgetUsdCents: campaign.budgetUsdCents,
          costPerImpressionUsdCents: campaign.costPerImpressionUsdCents,
          costPerClickUsdCents: campaign.costPerClickUsdCents,
          pricingModel: campaign.pricingModel,
        },
      };
    });

    return {
      ...campaign,
      budgetUsd: campaign.budgetUsdCents / 100,
      dailyBudgetUsd: campaign.dailyBudgetUsdCents ? campaign.dailyBudgetUsdCents / 100 : null,
      remainingBudgetUsd: campaign.remainingBudgetUsdCents / 100,
      spentUsd: (campaign.budgetUsdCents - campaign.remainingBudgetUsdCents) / 100,
      geoLocations: mapLocations(targets),
      targetDevices: campaignDevices,
      targetHours: campaignHours,
      adStacks: stackViews,
      creatives,
    };
  }

  async getPublicCatalog(category?: string) {
    const activeCampaigns = await this.db
      .select({
        id: adsCampaigns.id,
        title: adsCampaigns.title,
        description: adsCampaigns.description,
        category: adsCampaigns.category,
        format: adsCampaigns.format,
        createdAt: adsCampaigns.createdAt,
      })
      .from(adsCampaigns)
      .where(eq(adsCampaigns.status, 'active'))
      .orderBy(desc(adsCampaigns.createdAt));
    return activeCampaigns
      .filter((c) => !category || c.category === category)
      .map((c) => ({
        id: c.id,
        title: c.title,
        description: c.description,
        category: c.category,
        format: c.format,
        createdAt: c.createdAt,
        eligibleForPlacement: true,
      }));
  }

  async updateStatus(
    campaignId: string,
    advertiserId: string,
    status: 'active' | 'paused' | 'under_review' | 'draft' | 'rejected' | 'suspended' | 'trash',
  ) {
    const [campaign] = await this.db
      .select()
      .from(adsCampaigns)
      .where(and(eq(adsCampaigns.id, campaignId), eq(adsCampaigns.advertiserId, advertiserId)))
      .limit(1);
    if (!campaign) throw new NotFoundException('Campaign not found.');
    if (!['active', 'paused', 'trash'].includes(status)) {
      throw new BadRequestException('Use the review workflow for moderation states.');
    }
    if (campaign.status === 'suspended') throw new BadRequestException('A suspended campaign requires staff review.');
    if (status === 'active' && campaign.moderationStatus !== 'approved') {
      throw new BadRequestException('Campaign must have completed moderation before activation.');
    }
    return this.escrowService.changeCampaignStatus(campaignId, advertiserId, status as 'active' | 'paused' | 'trash');
  }
}
