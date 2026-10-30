import { CampaignWorkflow, campaignCapabilities, assertEditableCampaign, currentApproval, controlRequired, fingerprint, type MutationControl } from './campaign-workflow';
import { imageSpecsView } from "../uploads/prepared-image";
import { createHash } from "crypto";
import {
  allDay,
  inherited,
  legacySchedule,
  resolvedSchedule,
  validateSchedule,
} from "./daily-schedule";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@crimfig/database/schema";
import {
  adsCampaigns,
  adsCampaignSubmissions,
  adsCampaignEscrows,
  adsCreatives,
  adsCreativeStacks,
  adsMediaAssets,
  crimfigGeoTargets,
} from "@crimfig/database/schema";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { DATABASE_TOKEN } from "../database/database.module";
import { AdsEscrowService } from "../billing/ads-escrow.service";
import {
  LocationsService,
  ResolvedTarget,
} from "../locations/locations.service";
import { LocationScope } from "../locations/location.types";

const AD_TYPES = ["text", "image", "video"] as const;
const AD_FORMATS = ["banner", "card", "video", "interstitial"] as const;
const DEVICE_CATEGORIES = [
  "desktop",
  "mobile",
  "android",
  "ios",
  "tablet",
] as const;
const ALLOWED_VIDEO_PLACEMENTS = [
  "in_content_mid",
  "in_content_end",
  "listing_interstitial",
];

type AdType = (typeof AD_TYPES)[number];
type AdFormat = (typeof AD_FORMATS)[number];

export interface GeoSelectionInput {
  geoMode?: "global" | "targeted";
  locations?: string[];
}

export interface StackSettingsInput {
  name?: string;
  geoMode?: "inherit" | "global" | "targeted";
  locations?: string[];
  targetDevices?: string[] | null;
  targetHours?: number[] | null;
  schedule?: unknown;
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
  mediaFormat?: "image" | "gif" | "video";
  mediaAssetId?: string;
}

function videoAuthoringEnabled(): boolean {
  return (
    (process.env.CREATIVE_VIDEO_AUTHORING_ENABLED || "false").toLowerCase() ===
    "true"
  );
}

function parseJsonArray<T>(
  value: string | null | undefined,
  fallback: T[],
): T[] {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}

function cleanString(
  value: string | undefined,
  field: string,
  max: number,
  required = false,
): string {
  const text = (value || "").trim();
  if (required && !text) throw new BadRequestException(`${field} is required.`);
  if (text.length > max)
    throw new BadRequestException(
      `${field} must be ${max} characters or fewer.`,
    );
  return text;
}

function assertHttpUrl(value: string): string {
  const text = cleanString(value, "Destination URL", 2048, true);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new BadRequestException(
      "Enter a valid destination URL including https://.",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new BadRequestException(
      "Destination URL must be an http(s) address without embedded credentials.",
    );
  }
  return url.toString();
}

function cleanDevices(value: string[] | null | undefined): string[] | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value) && value.length === 0) return null;
  if (!Array.isArray(value))
    throw new BadRequestException("Choose at least one device category.");
  const unique = [...new Set(value)];
  if (unique.some((device) => !DEVICE_CATEGORIES.includes(device as any))) {
    throw new BadRequestException("Unsupported device category.");
  }
  return unique;
}

function cleanHours(value: number[] | null | undefined): number[] | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value) && value.length === 0) return null;
  if (!Array.isArray(value))
    throw new BadRequestException("Choose at least one daypart hour.");
  const unique = [...new Set(value)];
  if (unique.some((hour) => !Number.isInteger(hour) || hour < 0 || hour > 23)) {
    throw new BadRequestException(
      "Daypart hours must be integers from 0 to 23.",
    );
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
      geoTargetingEnabled: process.env.GEO_TARGETING_ENABLED === "true",
      videoAuthoringEnabled: enabled,
      allowedVideoPlacements: enabled ? ALLOWED_VIDEO_PLACEMENTS : [],
      scheduleVersion: 1,
      imagePreparationEnabled: true,
      supportedAdTypes: enabled ? [...AD_TYPES] : ["text", "image"],
    };
  }

  // ── Ownership and editability ───────────────────────────────────────────────

  private async campaignForUpdate(
    tx: any,
    campaignId: string,
    advertiserId: string,
  ) {
    const [campaign] = await tx
      .select()
      .from(adsCampaigns)
      .where(
        and(
          eq(adsCampaigns.id, campaignId),
          eq(adsCampaigns.advertiserId, advertiserId),
        ),
      )
      .for("update")
      .limit(1);
    if (!campaign)
      throw new NotFoundException("Campaign not found or unauthorized.");
    return campaign;
  }

  private get workflow() { return new CampaignWorkflow(this.db); }
  private assertEditable(campaign: typeof adsCampaigns.$inferSelect) { assertEditableCampaign(campaign); }

  private async resolveGeo(
    geoMode: "global" | "targeted" | "inherit",
    locations: string[] | undefined,
    fallbackMode: "global" | "targeted" = "global",
  ): Promise<{
    mode: "global" | "targeted" | "inherit";
    targets: ResolvedTarget[];
  }> {
    if (geoMode === "inherit") {
      if (locations && locations.length > 0)
        throw new BadRequestException(
          "Inherited targeting cannot carry its own locations.",
        );
      return { mode: "inherit", targets: [] };
    }
    const mode = geoMode || fallbackMode;
    if (mode === "global") {
      if (locations && locations.length > 0)
        throw new BadRequestException(
          "Global targeting cannot include locations.",
        );
      return { mode: "global", targets: [] };
    }
    if (process.env.GEO_TARGETING_ENABLED !== "true")
      throw new BadRequestException(
        "Location targeting is not available yet. Select Global targeting.",
      );
    if (!locations || locations.length === 0)
      throw new BadRequestException(
        "Choose at least one location, or select Global.",
      );
    return {
      mode: "targeted",
      targets: await this.locations.resolveTargetsByIds(locations),
    };
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
    pricingModel?: "cpm" | "cpc";
    format?: AdFormat;
    targetCountries?: string[];
    targetStates?: string[];
    targetDevices?: string[];
    targetHours?: number[];
    schedule?: unknown;
    requestId?: string;
    frequencyCapPerDay?: number;
    geoMode?: "global" | "targeted";
    locations?: string[];
    startsAt?: Date;
    endsAt?: Date;
  }) {
    const title = cleanString(params.title, "Campaign title", 255, true);
    if (params.budgetUsd < 5)
      throw new BadRequestException("Minimum campaign budget is $5.00 USD.");
    if (!Number.isFinite(params.budgetUsd) || params.budgetUsd > 100_000_000) {
      throw new BadRequestException("Campaign budget is out of range.");
    }
    const cpmBid = params.costPerImpressionCents ?? 50;
    const cpcBid = params.costPerClickCents ?? 10;
    if (!Number.isSafeInteger(cpmBid) || cpmBid < 50 || cpmBid > 2147483647) {
      throw new BadRequestException(
        "Minimum CPM bid is 50 integer USD cents ($0.50 per 1,000 viewable impressions).",
      );
    }
    if (!Number.isSafeInteger(cpcBid) || cpcBid < 10 || cpcBid > 2147483647) {
      throw new BadRequestException(
        "Minimum CPC bid is 10 integer USD cents ($0.10 per click).",
      );
    }
    const budgetCents = Math.round(params.budgetUsd * 100);
    const dailyBudgetCents = params.dailyBudgetUsd
      ? Math.round(params.dailyBudgetUsd * 100)
      : null;
    if (
      dailyBudgetCents !== null &&
      (dailyBudgetCents < 100 || dailyBudgetCents > budgetCents)
    ) {
      throw new BadRequestException(
        "Daily budget cannot exceed the total budget and must be at least $1.00.",
      );
    }
    const hourlyPacingCents = dailyBudgetCents
      ? Math.ceil(dailyBudgetCents / 24)
      : null;
    const devices = cleanDevices(params.targetDevices);
    if (params.schedule !== undefined && params.targetHours !== undefined)
      throw new BadRequestException("Send schedule or targetHours, not both.");
    const hours = cleanHours(params.targetHours);
    let schedule;
    try {
      schedule =
        params.schedule === undefined
          ? legacySchedule(hours)
          : validateSchedule(params.schedule);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ ...params, requestId: undefined, schedule }))
      .digest("hex");
    if (params.requestId) {
      const existing = await this.findCreationRequest(
        params.advertiserId,
        params.requestId,
      );
      if (existing) {
        if (existing.creationFingerprint !== fingerprint)
          throw new ConflictException(
            "This request ID belongs to different campaign details.",
          );
        return existing;
      }
    }

    const legacyCountryLocations = (params.targetCountries || [])
      .filter((code) => /^[A-Za-z]{2}$/.test(code))
      .map((code) => `country:${code.toUpperCase()}`);
    const geoLocations = params.locations?.length
      ? params.locations
      : legacyCountryLocations;
    const geo = await this.resolveGeo(
      params.geoMode || (geoLocations.length ? "targeted" : "global"),
      geoLocations,
    );

    const created = await this.db.transaction(async (tx) => {
      if (params.requestId) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${params.advertiserId + params.requestId}))`,
        );
        const [existing] = await tx
          .select()
          .from(adsCampaigns)
          .where(
            and(
              eq(adsCampaigns.advertiserId, params.advertiserId),
              eq(adsCampaigns.creationRequestId, params.requestId),
            ),
          )
          .limit(1);
        if (existing) {
          if (existing.creationFingerprint !== fingerprint)
            throw new ConflictException("Request details changed.");
          const [stack] = await tx
            .select()
            .from(adsCreativeStacks)
            .where(eq(adsCreativeStacks.campaignId, existing.id))
            .orderBy(asc(adsCreativeStacks.position))
            .limit(1);
          return { campaign: existing, stack, reused: true };
        }
      }
      const [campaign] = await tx
        .insert(adsCampaigns)
        .values({
          advertiserId: params.advertiserId,
          creationRequestId: params.requestId,
          creationFingerprint: fingerprint,
          schedule,
          title,
          description: params.description?.trim() || null,
          category: params.category?.trim() || null,
          channels: params.channels
            ? JSON.stringify([...new Set(params.channels)])
            : null,
          budgetUsdCents: budgetCents,
          dailyBudgetUsdCents: dailyBudgetCents,
          hourlyPacingUsdCents: hourlyPacingCents,
          remainingBudgetUsdCents: budgetCents,
          pricingVersion: 2,
          pricingModel: params.pricingModel || "cpm",
          costPerImpressionUsdCents: cpmBid,
          costPerClickUsdCents: cpcBid,
          format: params.format || "card",
          status: "draft",
          moderationStatus: "draft",
          targetCountries:
            geo.mode === "targeted"
              ? JSON.stringify([
                  ...new Set(geo.targets.flatMap((t) => t.resolvedCountries)),
                ])
              : null,
          targetStates:
            geo.mode === "targeted"
              ? JSON.stringify([
                  ...new Set(
                    geo.targets.flatMap((t) => t.resolvedSubdivisions),
                  ),
                ])
              : null,
          targetDevices: devices ? JSON.stringify(devices) : null,
          targetHours: hours ? JSON.stringify(hours) : null,
          frequencyCapPerDay: params.frequencyCapPerDay ?? 5,
          geoMode: geo.mode === "targeted" ? "targeted" : "global",
          startsAt: params.startsAt || new Date(),
          endsAt: params.endsAt,
        })
        .returning();

      const [stack] = await tx
        .insert(adsCreativeStacks)
        .values({
          campaignId: campaign.id,
          name: "Ad Stack #1",
          position: 1,
          schedule: inherited(),
        })
        .returning();

      if (geo.mode === "targeted") {
        await this.locations.replaceTargets(
          tx,
          "campaign",
          campaign.id,
          geo.targets,
        );
      }
      return { campaign, stack };
    });

    if ((created as any).reused) return { ...created.campaign, defaultStackId: created.stack?.id };
    // A server draft never reserves money. Funding starts only after complete submission validation.
    return { ...created.campaign, defaultStackId: created.stack.id };
  }

  // ── Stacks ──────────────────────────────────────────────────────────────────

  async findCreationRequest(advertiserId: string, requestId: string) {
    const [campaign] = await this.db
      .select()
      .from(adsCampaigns)
      .where(
        and(
          eq(adsCampaigns.advertiserId, advertiserId),
          eq(adsCampaigns.creationRequestId, requestId),
        ),
      )
      .limit(1);
    if (!campaign) return null;
    const [stack] = await this.db
      .select()
      .from(adsCreativeStacks)
      .where(eq(adsCreativeStacks.campaignId, campaign.id))
      .orderBy(asc(adsCreativeStacks.position))
      .limit(1);
    return { ...campaign, defaultStackId: stack?.id };
  }

  async createStack(campaignId: string, advertiserId: string, name?: string, control?: MutationControl) {
    return this.workflow.mutate(campaignId, advertiserId, "create_stack", control, { name }, async (tx) => {
      const campaign = await this.campaignForUpdate(
        tx,
        campaignId,
        advertiserId,
      );
      this.assertEditable(campaign);
      const [row] = await tx
        .select({
          max: sql<number>`coalesce(max(${adsCreativeStacks.position}), 0)`,
        })
        .from(adsCreativeStacks)
        .where(eq(adsCreativeStacks.campaignId, campaignId));
      const position = Number(row?.max || 0) + 1;
      const [stack] = await tx
        .insert(adsCreativeStacks)
        .values({
          campaignId,
          schedule: inherited(),
          name: cleanString(
            name || `Ad Stack #${position}`,
            "Stack name",
            100,
            true,
          ),
          position,
        })
        .returning();
      return stack;
    });
  }

  async updateStack(
    campaignId: string,
    stackId: string,
    advertiserId: string,
    input: StackSettingsInput,
    control?: MutationControl,
  ) {
    return this.workflow.mutate(campaignId, advertiserId, "update_stack", control, { stackId, ...input }, async (tx) => {
      const campaign = await this.campaignForUpdate(
        tx,
        campaignId,
        advertiserId,
      );
      this.assertEditable(campaign);
      const [stack] = await tx
        .select()
        .from(adsCreativeStacks)
        .where(
          and(
            eq(adsCreativeStacks.id, stackId),
            eq(adsCreativeStacks.archived, false),
            eq(adsCreativeStacks.campaignId, campaignId),
          ),
        )
        .limit(1);
      if (!stack) throw new NotFoundException("Ad stack not found.");

      const update: Partial<typeof adsCreativeStacks.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (input.name !== undefined)
        update.name = cleanString(input.name, "Stack name", 100, true);
      if (input.targetDevices !== undefined) {
        const devices = cleanDevices(input.targetDevices);
        update.targetDevices = devices ? JSON.stringify(devices) : null;
      }
      if (input.schedule !== undefined && input.targetHours !== undefined)
        throw new BadRequestException(
          "Send schedule or targetHours, not both.",
        );
      if (input.schedule !== undefined) {
        try {
          update.schedule = validateSchedule(input.schedule, true);
        } catch (e) {
          throw new BadRequestException((e as Error).message);
        }
      }
      if (input.targetHours !== undefined) {
        if (stack.schedule !== null && stack.schedule !== undefined)
          throw new ConflictException(
            "Use schedule to edit a minute schedule; legacy hours cannot erase it.",
          );
        const hours = cleanHours(input.targetHours);
        update.targetHours = hours ? JSON.stringify(hours) : null;
      }
      if (input.geoMode !== undefined) {
        const geo = await this.resolveGeo(
          input.geoMode,
          input.locations,
          "global",
        );
        update.geoMode = geo.mode;
        await this.locations.replaceTargets(tx, "stack", stack.id, geo.targets);
      } else if (input.locations !== undefined) {
        throw new BadRequestException(
          "Choose inherit, global, or targeted before changing stack locations.",
        );
      }
      const [updated] = await tx
        .update(adsCreativeStacks)
        .set(update)
        .where(eq(adsCreativeStacks.id, stack.id))
        .returning();
      return updated;
    });
  }

  async deleteStack(campaignId: string, stackId: string, advertiserId: string, control?: MutationControl) {
    return this.workflow.mutate(campaignId, advertiserId, "delete_stack", control, { stackId }, async (tx) => {
      const campaign = await this.campaignForUpdate(
        tx,
        campaignId,
        advertiserId,
      );
      this.assertEditable(campaign);
      const stacks = await tx
        .select()
        .from(adsCreativeStacks)
        .where(and(eq(adsCreativeStacks.campaignId, campaignId), eq(adsCreativeStacks.archived, false)))
        .orderBy(asc(adsCreativeStacks.position));
      if (stacks.length <= 1)
        throw new BadRequestException("The last ad stack cannot be removed.");
      const stack = stacks.find((s: typeof adsCreativeStacks.$inferSelect) => s.id === stackId);
      if (!stack) throw new NotFoundException("Ad stack not found.");
      if (stack.position === 1)
        throw new BadRequestException(
          "The default ad stack cannot be removed.",
        );
      await tx.update(adsCreatives).set({ status: 'archived' }).where(eq(adsCreatives.adStackId, stack.id));
      await tx
        .delete(crimfigGeoTargets)
        .where(
          and(
            eq(crimfigGeoTargets.ownerType, "stack"),
            eq(crimfigGeoTargets.ownerId, stack.id),
          ),
        );
      await tx
        .update(adsCreativeStacks).set({ archived: true })
        .where(eq(adsCreativeStacks.id, stack.id));
      return { deleted: true };
    });
  }

  // ── Creatives ───────────────────────────────────────────────────────────────

  private async validateCreative(
    tx: any,
    advertiserId: string,
    input: CreativeInput,
    partial = false,
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
    mediaFormat: "image" | "gif" | "video";
    width?: number | null;
    height?: number | null;
  }> {
    const destinationUrl = partial && !input.destinationUrl?.trim() ? "" : assertHttpUrl(input.destinationUrl);
    const adFormat = (input.adFormat || "card") as AdFormat;
    if (!AD_FORMATS.includes(adFormat))
      throw new BadRequestException("Unsupported display format.");

    let adType = input.adType;
    if (!adType) {
      adType = input.videoUrl ? "video" : input.imageUrl ? "image" : "text";
    }
    if (!AD_TYPES.includes(adType))
      throw new BadRequestException("Unsupported ad type.");
    if (adType === "video" && !videoAuthoringEnabled()) {
      throw new BadRequestException("Video authoring is not available yet.");
    }

    // Image/video artwork may contain the entire advertising message. Text ads are
    // the only type that must carry a discrete headline.
    const headline = input.headline?.trim()
      ? cleanString(input.headline, "Headline", 100)
      : null;
    if (!partial && adType === "text" && !headline) {
      throw new BadRequestException("A headline is required for text ads.");
    }
    const bodyText = input.bodyText?.trim()
      ? cleanString(input.bodyText, "Body text", 2000)
      : null;
    const configuredCta = input.ctaText?.trim()
      ? cleanString(input.ctaText, "Call to action", 50)
      : null;
    const ctaText =
      adType === "text" ? configuredCta || "Learn More" : configuredCta;

    let asset: typeof adsMediaAssets.$inferSelect | undefined;
    if (input.mediaAssetId) {
      [asset] = await tx
        .select()
        .from(adsMediaAssets)
        .where(
          and(
            eq(adsMediaAssets.id, input.mediaAssetId),
            eq(adsMediaAssets.ownerId, advertiserId),
            eq(adsMediaAssets.status, "ready"),
          ),
        )
        .limit(1);
      if (!asset)
        throw new BadRequestException(
          "The selected media asset is not owned by this advertiser or is not ready.",
        );
    } else {
      const candidate =
        adType === "video"
          ? input.videoUrl
          : adType === "image"
            ? input.imageUrl
            : undefined;
      if (candidate) {
        [asset] = await tx
          .select()
          .from(adsMediaAssets)
          .where(
            and(
              eq(adsMediaAssets.cdnUrl, candidate),
              eq(adsMediaAssets.ownerId, advertiserId),
              eq(adsMediaAssets.status, "ready"),
            ),
          )
          .limit(1);
      }
    }

    if (adType === "text") {
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
        mediaFormat: "image",
      };
    }
    if (!asset && partial && !input.mediaAssetId && !input.imageUrl && !input.videoUrl) return {
      adType, headline, bodyText, ctaText, destinationUrl, adFormat, imageUrl: null, videoUrl: null, posterUrl: null, mediaAssetId: null, mediaFormat: 'image',
    };
    if (!asset) throw new BadRequestException(`A validated ${adType} asset is required.`);
    if (adType === "image" && asset.bytes > 200000)
      throw new BadRequestException(
        "Prepare this image to a delivered size of at most 200 KB.",
      );
    if (
      adType === "image" &&
      asset.preparation &&
      (asset.preparation as any).layout !== adFormat
    )
      throw new BadRequestException(
        "Prepared image layout does not match this creative.",
      );
    if (adType === "image" && !asset.mimeType.startsWith("image/")) {
      throw new BadRequestException("The selected asset is not an image.");
    }
    if (adType === "video" && !asset.mimeType.startsWith("video/")) {
      throw new BadRequestException(
        "The selected asset is not a supported video.",
      );
    }
    return {
      adType,
      headline,
      bodyText,
      ctaText,
      destinationUrl,
      adFormat,
      imageUrl: adType === "image" ? asset.cdnUrl : null,
      videoUrl: adType === "video" ? asset.cdnUrl : null,
      posterUrl: asset.thumbnailUrl || null,
      mediaAssetId: asset.id,
      width: asset.width,
      height: asset.height,
      mediaFormat:
        asset.mimeType === "image/gif"
          ? "gif"
          : adType === "video"
            ? "video"
            : "image",
    };
  }

  async addCreative(
    campaignId: string,
    advertiserId: string,
    input: CreativeInput,
    control?: MutationControl,
  ) {
    return this.workflow.mutate(campaignId, advertiserId, "add_creative", control, input, async (tx) => {
      const campaign = await this.campaignForUpdate(
        tx,
        campaignId,
        advertiserId,
      );
      this.assertEditable(campaign);
      const [stack] = input.adStackId
        ? await tx
            .select()
            .from(adsCreativeStacks)
            .where(
              and(
                eq(adsCreativeStacks.id, input.adStackId),
                eq(adsCreativeStacks.archived, false),
                eq(adsCreativeStacks.campaignId, campaignId),
              ),
            )
            .limit(1)
        : await tx
            .select()
            .from(adsCreativeStacks)
            .where(and(eq(adsCreativeStacks.campaignId, campaignId), eq(adsCreativeStacks.archived, false)))
            .orderBy(asc(adsCreativeStacks.position))
            .limit(1);
      if (!stack)
        throw new BadRequestException(
          "Choose a valid ad stack for this campaign.",
        );
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
          reviewStatus: "pending",
          status: "active",
        })
        .returning();
      return creative;
    });
  }

  async replaceCreative(
    creativeId: string,
    advertiserId: string,
    input: Partial<CreativeInput>,
    control?: MutationControl,
  ) {
    const [parent] = await this.db.select({ campaignId: adsCreatives.campaignId }).from(adsCreatives)
      .innerJoin(adsCampaigns, eq(adsCreatives.campaignId, adsCampaigns.id))
      .where(and(eq(adsCreatives.id, creativeId), eq(adsCampaigns.advertiserId, advertiserId))).limit(1);
    if (!parent) throw new NotFoundException('Creative not found.');
    return this.workflow.mutate(parent.campaignId, advertiserId, "replace_creative", control, { creativeId, ...input }, async (tx) => {
      const [existing] = await tx
        .select({ creative: adsCreatives, campaign: adsCampaigns })
        .from(adsCreatives)
        .innerJoin(adsCampaigns, eq(adsCreatives.campaignId, adsCampaigns.id))
        .where(
          and(
            eq(adsCreatives.id, creativeId),
            eq(adsCampaigns.advertiserId, advertiserId),
          ),
        )
        .limit(1);
      if (!existing)
        throw new NotFoundException(
          "Creative asset not found or unauthorized.",
        );
      const campaign = await this.campaignForUpdate(
        tx,
        existing.campaign.id,
        advertiserId,
      );
      this.assertEditable(campaign);

      const merged: CreativeInput = {
        adStackId: input.adStackId || existing.creative.adStackId,
        adType: (input.adType || existing.creative.adType) as AdType,
        headline: input.headline ?? existing.creative.headline,
        bodyText: input.bodyText ?? existing.creative.bodyText ?? undefined,
        ctaText: input.ctaText ?? existing.creative.ctaText,
        destinationUrl:
          input.destinationUrl ?? existing.creative.destinationUrl,
        imageUrl:
          input.imageUrl !== undefined
            ? input.imageUrl
            : (existing.creative.imageUrl ?? undefined),
        videoUrl:
          input.videoUrl !== undefined
            ? input.videoUrl
            : (existing.creative.videoUrl ?? undefined),
        adFormat: (input.adFormat || existing.creative.adFormat) as AdFormat,
        mediaAssetId: input.mediaAssetId,
      };
      if (
        merged.adType === "text" &&
        !input.mediaAssetId &&
        input.imageUrl === undefined &&
        input.videoUrl === undefined
      ) {
        merged.imageUrl = undefined;
        merged.videoUrl = undefined;
      }
      const [targetStack] = await tx.select().from(adsCreativeStacks).where(and(eq(adsCreativeStacks.id, merged.adStackId!), eq(adsCreativeStacks.campaignId, campaign.id), eq(adsCreativeStacks.archived, false))).limit(1);
      if (!targetStack || existing.creative.status === 'archived') throw new BadRequestException('Choose a current stack in this campaign.');
      merged.mediaAssetId = input.mediaAssetId === undefined ? existing.creative.mediaAssetId : input.mediaAssetId;
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
          reviewStatus: "pending",
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

  async beginEdit(id: string, owner: string, control: MutationControl & { submissionId?: string }) {
    return this.workflow.mutate(id, owner, 'begin_edit', control, { submissionId: control.submissionId }, async (tx,c) => {
      if (['suspended','trash','cancelled','completed'].includes(c.status) || c.submissionIntentId) throw new ConflictException('This campaign cannot begin editing now.');
      if (c.currentSubmissionId && c.currentSubmissionId !== control.submissionId) throw new ConflictException('The submission changed. Reload before editing.');
      if (c.currentSubmissionId) await tx.update(adsCampaignSubmissions).set({ state:'superseded', updatedAt:new Date() }).where(eq(adsCampaignSubmissions.id,c.currentSubmissionId));
      const [updated] = await tx.update(adsCampaigns).set({ status:'draft', moderationStatus:'draft', currentSubmissionId:null,
        approvedSubmissionId:null, approvedRevision:null, primaryReviewerId:null, managerReviewerId:null, primaryReviewedAt:null, managerReviewedAt:null, updatedAt:new Date() }).where(eq(adsCampaigns.id,id)).returning();
      await tx.update(adsCreatives).set({ reviewStatus:'pending', rejectionReason:null, reviewedAt:null }).where(eq(adsCreatives.campaignId,id));
      return updated;
    }, true);
  }

  async deleteCreative(id: string, creativeId: string, owner: string, control: MutationControl) {
    return this.workflow.mutate(id,owner,'delete_creative',control,{creativeId},async(tx) => {
      const [creative] = await tx.update(adsCreatives).set({ status:'archived',updatedAt:new Date() })
        .where(and(eq(adsCreatives.id,creativeId),eq(adsCreatives.campaignId,id))).returning();
      if (!creative) throw new NotFoundException('Creative not found.');
      return { deleted:true, creativeId };
    });
  }

  /** Atomic full editor save. IDs supplied by clients are references, never ownership claims. */
  async saveCampaign(id: string, owner: string, input: any) {
    return this.workflow.mutate(id,owner,'save_campaign',input,input,async(tx,c) => {
      const patch: any = {};
      const allowed = ['expectedRevision','requestId','title','description','category','channels','budgetUsd','dailyBudgetUsd','costPerImpressionCents','costPerClickCents','pricingModel','format','targetDevices','schedule','frequencyCapPerDay','geoMode','locations','stacks'];
      if (Object.keys(input).some(k => !allowed.includes(k))) throw new BadRequestException('Unsupported campaign field.');
      for (const [field,max] of [['title',255],['description',5000],['category',80]] as const) if (input[field] !== undefined) patch[field] = cleanString(input[field],field,max,field==='title') || null;
      if (input.channels !== undefined) {
        if (!Array.isArray(input.channels) || input.channels.length>3 || input.channels.some((v: any)=>!['websites','individuals','mobile_apps'].includes(v))) throw new BadRequestException('Unsupported channel.');
        patch.channels=JSON.stringify([...new Set(input.channels)]);
      }
      if (input.budgetUsd !== undefined) {
        if (!Number.isFinite(input.budgetUsd) || input.budgetUsd<5 || input.budgetUsd>21474836.47) throw new BadRequestException('Invalid campaign budget.');
        const cents=Math.round(input.budgetUsd*100);
        if (cents!==c.budgetUsdCents) {
          const [escrow]=await tx.select().from(adsCampaignEscrows).where(eq(adsCampaignEscrows.campaignId,id)).limit(1);
          if (escrow || c.budgetUsdCents!==c.remainingBudgetUsdCents) throw new ConflictException('A funded budget cannot be resized here. Keep the current budget or create another campaign.');
          patch.budgetUsdCents=cents; patch.remainingBudgetUsdCents=cents;
        }
      }
      const budget=patch.budgetUsdCents??c.budgetUsdCents;
      if (input.dailyBudgetUsd !== undefined) {
        if (input.dailyBudgetUsd===null) { patch.dailyBudgetUsdCents=null; patch.hourlyPacingUsdCents=null; }
        else {
          const cents=Math.round(input.dailyBudgetUsd*100);
          if (!Number.isFinite(input.dailyBudgetUsd) || cents<100 || cents>budget) throw new BadRequestException('Daily budget must be between $1 and the total budget.');
          patch.dailyBudgetUsdCents=cents;patch.hourlyPacingUsdCents=Math.ceil(cents/24);
        }
      } else if (c.dailyBudgetUsdCents>budget) throw new BadRequestException('Daily budget exceeds the new total.');
      for(const [field,column,min] of [['costPerImpressionCents','costPerImpressionUsdCents',50],['costPerClickCents','costPerClickUsdCents',10]] as const) if(input[field]!==undefined) {
        if(!Number.isSafeInteger(input[field]) || input[field]<min || input[field]>2147483647) throw new BadRequestException('The bid is below its floor or out of range.');
        patch[column]=input[field];patch.pricingVersion=2;
      }
      if(input.pricingModel!==undefined) { if(!['cpm','cpc'].includes(input.pricingModel)) throw new BadRequestException('Unsupported pricing model.');patch.pricingModel=input.pricingModel; }
      if(input.format!==undefined) { if(!AD_FORMATS.includes(input.format)) throw new BadRequestException('Unsupported format.');patch.format=input.format; }
      if(input.targetDevices!==undefined) { const devices=cleanDevices(input.targetDevices);patch.targetDevices=devices?JSON.stringify(devices):null; }
      if(input.schedule!==undefined) { try { patch.schedule=validateSchedule(input.schedule); } catch(e) { throw new BadRequestException((e as Error).message); } }
      if(input.frequencyCapPerDay!==undefined) { if(!Number.isInteger(input.frequencyCapPerDay)||input.frequencyCapPerDay<1||input.frequencyCapPerDay>100) throw new BadRequestException('Invalid daily frequency cap.');patch.frequencyCapPerDay=input.frequencyCapPerDay; }
      if(input.geoMode!==undefined) {
        const geo=await this.resolveGeo(input.geoMode,input.locations);patch.geoMode=geo.mode;
        await this.locations.replaceTargets(tx,'campaign',id,geo.targets);
      } else if(input.locations!==undefined) throw new BadRequestException('Choose a geographic mode.');
      if(Object.keys(patch).length) await tx.update(adsCampaigns).set({...patch,updatedAt:new Date()}).where(eq(adsCampaigns.id,id));
      if(input.stacks!==undefined) {
        if(!Array.isArray(input.stacks)||input.stacks.length<1||input.stacks.length>30) throw new BadRequestException('Save between one and 30 stacks.');
        const oldStacks=await tx.select().from(adsCreativeStacks).where(eq(adsCreativeStacks.campaignId,id)).orderBy(asc(adsCreativeStacks.position));
        const oldAds=await tx.select().from(adsCreatives).where(eq(adsCreatives.campaignId,id));
        const keptStacks=new Set<string>(),keptAds=new Set<string>();let nextPosition=Math.max(0,...oldStacks.map((s:any)=>s.position))+1;
        for(const stack of input.stacks) {
          if(!stack || typeof stack!=='object' || Object.keys(stack).some(k=>!['id','name','geoMode','locations','targetDevices','schedule','ads'].includes(k))) throw new BadRequestException('Invalid stack fields.');
          if(stack.id && (!oldStacks.some((s:any)=>s.id===stack.id&&!s.archived)||keptStacks.has(stack.id))) throw new BadRequestException('Choose a current stack in this campaign.');
          const geo=await this.resolveGeo(stack.geoMode||'inherit',stack.locations);
          const values={name:cleanString(stack.name,'Stack name',100,true),geoMode:geo.mode,targetDevices:cleanDevices(stack.targetDevices)?JSON.stringify(cleanDevices(stack.targetDevices)):null,schedule:validateSchedule(stack.schedule??inherited(),true)};
          const [row]=stack.id ? await tx.update(adsCreativeStacks).set({...values,updatedAt:new Date()}).where(eq(adsCreativeStacks.id,stack.id)).returning():await tx.insert(adsCreativeStacks).values({...values,campaignId:id,position:nextPosition++}).returning();
          keptStacks.add(row.id);await this.locations.replaceTargets(tx,'stack',row.id,geo.targets);
          if(!Array.isArray(stack.ads)||stack.ads.length>100) throw new BadRequestException('Invalid ads.');
          for(const ad of stack.ads) {
            if(!ad||typeof ad!=='object'||Object.keys(ad).some(k=>!['id','adType','headline','bodyText','ctaText','destinationUrl','adFormat','mediaAssetId'].includes(k))) throw new BadRequestException('Invalid ad fields.');
            if(ad.id&&(!oldAds.some((a:any)=>a.id===ad.id&&a.status!=='archived')||keptAds.has(ad.id))) throw new BadRequestException('Choose a current creative in this campaign.');
            const valid=await this.validateCreative(tx,owner,ad,true);
            const values={...valid,campaignId:id,adStackId:row.id,status:'active' as const};
            const [saved]=ad.id?await tx.update(adsCreatives).set({...values,updatedAt:new Date()}).where(eq(adsCreatives.id,ad.id)).returning():await tx.insert(adsCreatives).values(values).returning();keptAds.add(saved.id);
          }
        }
        const originalDefault=oldStacks.find((s:any)=>s.position===1&&!s.archived);
        if(originalDefault && !keptStacks.has(originalDefault.id)) throw new BadRequestException('Keep the default stack; its ads can be changed.');
        for(const ad of oldAds) if(!keptAds.has(ad.id)&&ad.status!=='archived') await tx.update(adsCreatives).set({status:'archived',updatedAt:new Date()}).where(eq(adsCreatives.id,ad.id));
        for(const stack of oldStacks) if(!keptStacks.has(stack.id)&&!stack.archived) await tx.update(adsCreativeStacks).set({archived:true,updatedAt:new Date()}).where(eq(adsCreativeStacks.id,stack.id));
      }
      const [updated]=await tx.select().from(adsCampaigns).where(eq(adsCampaigns.id,id)).limit(1);return updated;
    });
  }

  async submitForReview(campaignId: string, advertiserId: string, control?: MutationControl) {
    controlRequired(control);
    const hash=fingerprint({action:'submit',...control});
    const intent=await this.db.transaction(async(tx)=>{
      const campaign=await this.workflow.lock(tx,campaignId,advertiserId);
      const [existing]=await tx.select().from(adsCampaignSubmissions).where(and(eq(adsCampaignSubmissions.campaignId,campaignId),eq(adsCampaignSubmissions.actorId,advertiserId),eq(adsCampaignSubmissions.requestId,control.requestId))).limit(1);
      if(existing) {
        if(existing.fingerprint!==hash || existing.state==='superseded') throw new ConflictException('This submission request changed or was superseded.');
        if(existing.state==='submitted') return existing;
        if(campaign.contentRevision!==existing.contentRevision || (campaign.submissionIntentId && campaign.submissionIntentId!==existing.id)) throw new ConflictException('This submission no longer matches the campaign.');
        await tx.update(adsCampaigns).set({submissionIntentId:existing.id}).where(eq(adsCampaigns.id,campaignId));
        return existing;
      }
      if(campaign.contentRevision!==control.expectedRevision) throw new ConflictException('This campaign changed. Reload before submitting.');
      this.assertEditable(campaign);
      if(campaign.geoMode==='targeted' && process.env.GEO_TARGETING_ENABLED!=='true') throw new BadRequestException('Select Global targeting before submitting.');
      const stacks = await tx
        .select()
        .from(adsCreativeStacks)
        .where(and(eq(adsCreativeStacks.campaignId, campaignId), eq(adsCreativeStacks.archived, false)))
        .orderBy(asc(adsCreativeStacks.position));
      for (const stack of stacks) {
        try {
          resolvedSchedule(
            campaign.schedule,
            stack.schedule,
            campaign.targetHours,
            stack.targetHours,
          );
        } catch (e) {
          throw new BadRequestException((e as Error).message);
        }
      }
      if (stacks.length === 0)
        throw new BadRequestException(
          "Add at least one ad stack before submitting.",
        );
      const creatives = await tx
        .select()
        .from(adsCreatives)
        .where(and(eq(adsCreatives.campaignId, campaignId), sql`${adsCreatives.status} <> 'archived'`));
      if (creatives.some(c => !stacks.some(s => s.id === c.adStackId))) throw new BadRequestException('An ad points to an unavailable stack.');
      for (const creative of creatives) await this.validateCreative(tx, advertiserId, { ...creative, adType:creative.adType, adFormat:creative.adFormat, mediaAssetId:creative.mediaAssetId??undefined, imageUrl:creative.imageUrl??undefined,videoUrl:creative.videoUrl??undefined });
      for (const stack of stacks) {
        const stackCreatives = creatives.filter(
          (c) => c.adStackId === stack.id,
        );
        if (stackCreatives.length === 0)
          throw new BadRequestException(
            `${stack.name} needs at least one complete ad.`,
          );
        for (const creative of stackCreatives) {
          if (
            (creative.adType === "text" && !creative.headline?.trim()) ||
            !creative.destinationUrl?.trim()
          ) {
            throw new BadRequestException(
              `${stack.name} has an ad with missing headline or destination.`,
            );
          }
          if (creative.adType === "image" && !creative.imageUrl) {
            throw new BadRequestException(
              `${stack.name} has an image ad without an image asset.`,
            );
          }
          if (creative.adType === "video" && !creative.videoUrl) {
            throw new BadRequestException(
              `${stack.name} has a video ad without a video asset.`,
            );
          }
          if (creative.mediaAssetId) {
            const [asset] = await tx
              .select({ id: adsMediaAssets.id })
              .from(adsMediaAssets)
              .where(
                and(
                  eq(adsMediaAssets.id, creative.mediaAssetId),
                  eq(adsMediaAssets.ownerId, advertiserId),
                  eq(adsMediaAssets.status, "ready"),
                ),
              )
              .limit(1);
            if (!asset)
              throw new BadRequestException(
                `${stack.name} has an ad whose media asset is unavailable.`,
              );
          }
        }
        if (stack.geoMode === "targeted") {
          if (process.env.GEO_TARGETING_ENABLED !== "true")
            throw new BadRequestException(
              "Location targeting is not available yet. Change stack geography to Global or inherit the campaign.",
            );
          const targets = await tx
            .select({ id: crimfigGeoTargets.id })
            .from(crimfigGeoTargets)
            .where(
              and(
                eq(crimfigGeoTargets.ownerType, "stack"),
                eq(crimfigGeoTargets.ownerId, stack.id),
              ),
            )
            .limit(1);
          if (targets.length === 0)
            throw new BadRequestException(
              `${stack.name} has targeted geography but no locations.`,
            );
        }
      }
      if (campaign.geoMode === "targeted") {
        const targets = await tx
          .select({ id: crimfigGeoTargets.id })
          .from(crimfigGeoTargets)
          .where(
            and(
              eq(crimfigGeoTargets.ownerType, "campaign"),
              eq(crimfigGeoTargets.ownerId, campaign.id),
            ),
          )
          .limit(1);
        if (targets.length === 0)
          throw new BadRequestException(
            "Choose at least one campaign location, or select Global.",
          );
      }

      const before=await this.workflow.snapshot(tx,campaign);
      const [submission]=await tx.insert(adsCampaignSubmissions).values({campaignId,actorId:advertiserId,requestId:control.requestId,contentRevision:campaign.contentRevision,fingerprint:hash,snapshot:before,state:'funding_pending'}).returning();
      await tx.update(adsCampaigns).set({submissionIntentId:submission.id}).where(eq(adsCampaigns.id,campaignId));
      await this.workflow.audit(tx,before,{...before,campaign:{...before.campaign,submissionIntentId:submission.id}},advertiserId,'submission_prepared',control.requestId,['submissionIntentId']);
      return submission;
    });
    if(intent.state==='submitted') {
      const [c]=await this.db.select().from(adsCampaigns).where(and(eq(adsCampaigns.id,campaignId),eq(adsCampaigns.advertiserId,advertiserId))).limit(1);
      if(c.currentSubmissionId!==intent.id) throw new ConflictException('This review was superseded.');return c;
    }
    let receipt:any;
    try {
      // Billing validates its durable receipt even when the same campaign was funded before.
      const snapshot=intent.snapshot as any;
      receipt=await this.escrowService.lockCampaignBudget({campaignId,userId:advertiserId,amountUsdCents:snapshot.campaign.budgetUsdCents,campaignTitle:snapshot.campaign.title});
      if(!receipt?.transactionId || !receipt?.operationId || receipt?.escrow?.status!=='active') throw new ServiceUnavailableException('Funding needs reconciliation.');
    } catch(error) {
      const confirmed=error instanceof ConflictException || error instanceof BadRequestException;
      await this.db.transaction(async(tx)=>{
        const c=await this.workflow.lock(tx,campaignId,advertiserId);
        const [record]=await tx.select().from(adsCampaignSubmissions).where(eq(adsCampaignSubmissions.id,intent.id)).limit(1);
        if(record?.state==='submitted') return;
        await tx.update(adsCampaignSubmissions).set({state:confirmed?'funding_rejected':'funding_unknown',updatedAt:new Date()}).where(eq(adsCampaignSubmissions.id,intent.id));
        if(confirmed && c.submissionIntentId===intent.id) await tx.update(adsCampaigns).set({submissionIntentId:null}).where(eq(adsCampaigns.id,campaignId));
      });
      throw error;
    }
    return this.db.transaction(async(tx)=>{
      const c=await this.workflow.lock(tx,campaignId,advertiserId);
      const [submission]=await tx.select().from(adsCampaignSubmissions).where(eq(adsCampaignSubmissions.id,intent.id)).limit(1);
      if(submission.state==='submitted' && c.currentSubmissionId===intent.id) return c;
      if(c.contentRevision!==intent.contentRevision || c.submissionIntentId!==intent.id || ['suspended','trash','completed','cancelled'].includes(c.status)) throw new ConflictException('Funding is retained for reconciliation; this revision cannot enter review.');
      const before=await this.workflow.snapshot(tx,c), now=new Date();
      const [updated]=await tx.update(adsCampaigns).set({status:'paused',moderationStatus:'pending_primary_review',currentSubmissionId:intent.id,submissionIntentId:null,submittedAt:now,approvedSubmissionId:null,approvedRevision:null,primaryReviewerId:null,managerReviewerId:null,primaryReviewedAt:null,managerReviewedAt:null,updatedAt:now}).where(eq(adsCampaigns.id,campaignId)).returning();
      await tx.update(adsCreatives).set({reviewStatus:'pending',rejectionReason:null,reviewedAt:null}).where(and(eq(adsCreatives.campaignId,campaignId),sql`${adsCreatives.status} <> 'archived'`));
      await tx.update(adsCampaignSubmissions).set({state:'submitted',submittedAt:now,updatedAt:now,fundingReference:{transactionId:receipt.transactionId,operationId:receipt.operationId,escrowId:receipt.escrow.id}}).where(eq(adsCampaignSubmissions.id,intent.id));
      await this.workflow.audit(tx,before,await this.workflow.snapshot(tx,updated),advertiserId,'submit_review',control.requestId,['currentSubmissionId','moderationStatus']);
      return updated;
    });
  }

  async mutationResult(campaignId:string,owner:string,requestId:string) {
    await this.getCampaignDetails(campaignId,owner);
    const [mutation]=await this.db.select().from(schema.adsCampaignMutations).where(and(eq(schema.adsCampaignMutations.campaignId,campaignId),eq(schema.adsCampaignMutations.actorId,owner),eq(schema.adsCampaignMutations.requestId,requestId))).limit(1);
    const [submission]=await this.db.select({id:adsCampaignSubmissions.id,state:adsCampaignSubmissions.state,contentRevision:adsCampaignSubmissions.contentRevision}).from(adsCampaignSubmissions).where(and(eq(adsCampaignSubmissions.campaignId,campaignId),eq(adsCampaignSubmissions.actorId,owner),eq(adsCampaignSubmissions.requestId,requestId))).limit(1);
    return { mutation:mutation?.result??null, submission:submission??null };
  }

  // ── Reads ───────────────────────────────────────────────────────────────────

  async getAdvertiserCampaigns(advertiserId: string, status?: string) {
    const conditions = [eq(adsCampaigns.advertiserId, advertiserId)];
    if (status && status !== "all")
      conditions.push(eq(adsCampaigns.status, status as any));
    const campaigns = await this.db
      .select()
      .from(adsCampaigns)
      .where(and(...conditions))
      .orderBy(desc(adsCampaigns.createdAt));
    return campaigns.map((c) => ({
      capabilities: campaignCapabilities(c),
      ...c,
      budgetUsd: c.budgetUsdCents / 100,
      dailyBudgetUsd: c.dailyBudgetUsdCents
        ? c.dailyBudgetUsdCents / 100
        : null,
      remainingBudgetUsd: c.remainingBudgetUsdCents / 100,
      spentUsd: (c.budgetUsdCents - c.remainingBudgetUsdCents) / 100,
    }));
  }

  async getCampaignDetails(campaignId: string, advertiserId: string) {
    if (!advertiserId) throw new NotFoundException("Campaign not found.");
    const [campaign] = await this.db
      .select()
      .from(adsCampaigns)
      .where(
        and(
          eq(adsCampaigns.id, campaignId),
          eq(adsCampaigns.advertiserId, advertiserId),
        ),
      )
      .limit(1);
    if (!campaign) throw new NotFoundException("Campaign not found.");

    const [stacks, creatives, targets] = await Promise.all([
      this.db
        .select()
        .from(adsCreativeStacks)
        .where(and(eq(adsCreativeStacks.campaignId, campaignId), eq(adsCreativeStacks.archived, false)))
        .orderBy(asc(adsCreativeStacks.position)),
      this.db
        .select()
        .from(adsCreatives)
        .where(and(eq(adsCreatives.campaignId, campaignId), sql`${adsCreatives.status} <> 'archived'`))
        .orderBy(asc(adsCreatives.createdAt)),
      this.db
        .select()
        .from(crimfigGeoTargets)
        .where(
          and(
            eq(crimfigGeoTargets.ownerType, "campaign"),
            eq(crimfigGeoTargets.ownerId, campaignId),
          ),
        ),
    ]);
    const mediaIds = [
      ...new Set(
        creatives.map((c) => c.mediaAssetId).filter((id): id is string => !!id),
      ),
    ];
    const media = mediaIds.length
      ? await this.db
          .select()
          .from(adsMediaAssets)
          .where(
            and(
              eq(adsMediaAssets.ownerId, advertiserId),
              inArray(adsMediaAssets.id, mediaIds),
            ),
          )
      : [];
    const mediaById = new Map(media.map((asset) => [asset.id, asset]));
    const creativeViews = creatives.map((creative) => ({
      ...creative,
      imageSpecs:
        creative.mediaAssetId && mediaById.has(creative.mediaAssetId)
          ? imageSpecsView(mediaById.get(creative.mediaAssetId))
          : null,
    }));
    const stackTargets = stacks.length
      ? await this.db
          .select()
          .from(crimfigGeoTargets)
          .where(
            and(
              eq(crimfigGeoTargets.ownerType, "stack"),
              inArray(
                crimfigGeoTargets.ownerId,
                stacks.map((s) => s.id),
              ),
            ),
          )
      : [];
    const allTargets = [...targets, ...stackTargets];
    const places = await this.locations.getPlacesByIds([
      ...new Set(allTargets.map((t) => t.placeId)),
    ]);
    const placeById = new Map(places.map((p) => [p.id, p]));

    const mapLocations = (ownerTargets: typeof allTargets) =>
      ownerTargets.map((target) => ({
        id: target.placeId,
        scope: target.scope as Exclude<LocationScope, "global">,
        name: placeById.get(target.placeId)?.name || target.placeId,
        resolvedCountries: parseJsonArray(target.resolvedCountries, []),
        resolvedSubdivisions: parseJsonArray(target.resolvedSubdivisions, []),
        resolvedCities: parseJsonArray(target.resolvedCities, []),
      }));

    const campaignDevices = parseJsonArray<string>(campaign.targetDevices, []);
    const campaignHours = parseJsonArray<number>(campaign.targetHours, []);
    const stackViews = stacks.map((stack) => {
      const ownTargets = stackTargets.filter((t) => t.ownerId === stack.id);
      const inherited = stack.geoMode === "inherit";
      return {
        ...stack,
        creatives: creativeViews.filter((c) => c.adStackId === stack.id),
        settings: {
          geoMode: stack.geoMode,
          locations: mapLocations(ownTargets),
          targetDevices: parseJsonArray<string>(stack.targetDevices, []),
          targetHours: parseJsonArray<number>(stack.targetHours, []),
          schedule: stack.schedule ?? legacySchedule(stack.targetHours, true),
        },
        effectiveSettings: {
          geoMode: inherited ? campaign.geoMode : stack.geoMode,
          locations: inherited
            ? mapLocations(targets)
            : mapLocations(ownTargets),
          targetDevices: stack.targetDevices
            ? parseJsonArray<string>(stack.targetDevices, [])
            : campaignDevices,
          targetHours: stack.targetHours
            ? parseJsonArray<number>(stack.targetHours, [])
            : campaignHours,
          schedule: resolvedSchedule(
            campaign.schedule,
            stack.schedule,
            campaign.targetHours,
            stack.targetHours,
          ),
          frequencyCapPerDay: campaign.frequencyCapPerDay,
          budgetUsdCents: campaign.budgetUsdCents,
          costPerImpressionUsdCents: campaign.costPerImpressionUsdCents,
          costPerClickUsdCents: campaign.costPerClickUsdCents,
          pricingModel: campaign.pricingModel,
        },
      };
    });

    const [submission] = campaign.currentSubmissionId
      ? await this.db
          .select({ requestId: adsCampaignSubmissions.requestId, state: adsCampaignSubmissions.state })
          .from(adsCampaignSubmissions)
          .where(eq(adsCampaignSubmissions.id, campaign.currentSubmissionId))
          .limit(1)
      : campaign.submissionIntentId
        ? await this.db
            .select({ requestId: adsCampaignSubmissions.requestId, state: adsCampaignSubmissions.state })
            .from(adsCampaignSubmissions)
            .where(eq(adsCampaignSubmissions.id, campaign.submissionIntentId))
            .limit(1)
        : [];

    return {
      ...campaign,
      capabilities: campaignCapabilities(campaign),
      submissionRequestId: submission?.requestId ?? null,
      submissionState: submission?.state ?? null,
      budgetUsd: campaign.budgetUsdCents / 100,
      dailyBudgetUsd: campaign.dailyBudgetUsdCents
        ? campaign.dailyBudgetUsdCents / 100
        : null,
      remainingBudgetUsd: campaign.remainingBudgetUsdCents / 100,
      spentUsd:
        (campaign.budgetUsdCents - campaign.remainingBudgetUsdCents) / 100,
      geoLocations: mapLocations(targets),
      targetDevices: campaignDevices,
      targetHours: campaignHours,
      schedule: campaign.schedule ?? legacySchedule(campaign.targetHours),
      adStacks: stackViews,
      creatives: creativeViews,
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
      .where(eq(adsCampaigns.status, "active"))
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
    status:
      | "active"
      | "paused"
      | "under_review"
      | "draft"
      | "rejected"
      | "suspended"
      | "trash",
  ) {
    const [campaign] = await this.db
      .select()
      .from(adsCampaigns)
      .where(
        and(
          eq(adsCampaigns.id, campaignId),
          eq(adsCampaigns.advertiserId, advertiserId),
        ),
      )
      .limit(1);
    if (!campaign) throw new NotFoundException("Campaign not found.");
    if (!["active", "paused", "trash"].includes(status)) {
      throw new BadRequestException(
        "Use the review workflow for moderation states.",
      );
    }
    if (campaign.status === "suspended")
      throw new BadRequestException(
        "A suspended campaign requires staff review.",
      );
    if (status === "active" && !currentApproval(campaign)) {
      throw new BadRequestException(
        "Campaign must have completed moderation before activation.",
      );
    }
    return this.escrowService.changeCampaignStatus(
      campaignId,
      advertiserId,
      status as "active" | "paused" | "trash",
    );
  }
}
