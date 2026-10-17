import { Injectable, Inject, NotFoundException, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import {
  adsPlacements,
  adsCampaigns,
  adsCreatives,
  adsInteractions,
  adsPromoterEarnings,
  adsPromoterWebsites,
  adsEmbedRunAudits,
  adsServes,
} from '@crimfig/database/schema';
import { eq, sql, and } from 'drizzle-orm';
import { ImpressionTokenService } from './impression-token.service';
import { AuctionEngineService } from './auction-engine.service';
import { FraudRulesService } from '../verification/fraud-rules.service';

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly tokenService: ImpressionTokenService,
    private readonly auctionEngine: AuctionEngineService,
    private readonly fraudRules: FraudRulesService,
  ) {}

  /**
   * Return client-side embed.js script code
   */
  /**
   * Return client-side embed.js script code
   * Generates DOM elements safely using textContent to prevent stored XSS,
   * styled strictly with canonical CrimFig design tokens.
   */
  getEmbedScript(): string {
    return `(function() {
  var scripts = document.querySelectorAll('script[data-placement]');
  scripts.forEach(function(script) {
    var token = script.getAttribute('data-placement');
    if (!token) return;
    var container = document.getElementById('cf-ad-' + token);
    if (!container) return;

    var apiBase = script.src.replace('/api/v1/delivery/embed.js', '');
    var currentDomain = window.location.hostname;

    fetch(apiBase + '/api/v1/delivery/ad/' + encodeURIComponent(token) + '?domain=' + encodeURIComponent(currentDomain), {
      headers: { 'Accept': 'application/json' }
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (!data || !data.data) return;
      var ad = data.data;

      var card = document.createElement('div');
      card.style.cssText = 'border:1px solid rgba(255,255,255,0.08);background:#171B2A;color:#FFFFFF;border-radius:12px;padding:16px;font-family:\"Poppins\",Arial,Helvetica,sans-serif;max-width:400px;box-shadow:0 10px 25px rgba(0,0,0,0.3);position:relative;overflow:hidden;box-sizing:border-box;margin:12px 0;';

      var badge = document.createElement('div');
      badge.style.cssText = 'font-size:10px;text-transform:uppercase;color:#94a3b8;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;letter-spacing:0.05em;';
      var badgeLeft = document.createElement('span');
      badgeLeft.textContent = 'Promoted';
      var badgeRight = document.createElement('span');
      badgeRight.textContent = 'CrimFig Ads';
      badgeRight.style.cssText = 'font-weight:700;color:#D4143A;';
      badge.appendChild(badgeLeft);
      badge.appendChild(badgeRight);
      card.appendChild(badge);

      if (ad.imageUrl && /^https?:\\/\\//i.test(ad.imageUrl)) {
        var img = document.createElement('img');
        img.src = ad.imageUrl;
        img.alt = ad.headline || 'Advertisement';
        img.style.cssText = 'width:100%;height:180px;object-fit:cover;border-radius:8px;margin-bottom:12px;display:block;';
        card.appendChild(img);
      }

      var headline = document.createElement('h4');
      headline.style.cssText = 'margin:0 0 6px 0;font-size:16px;font-weight:700;color:#FFFFFF;line-height:1.3;';
      headline.textContent = ad.headline || '';
      card.appendChild(headline);

      if (ad.bodyText) {
        var body = document.createElement('p');
        body.style.cssText = 'margin:0 0 14px 0;font-size:13px;color:#F5F6F8;line-height:1.4;opacity:0.85;';
        body.textContent = ad.bodyText;
        card.appendChild(body);
      }

      if (ad.clickUrl && /^https?:\\/\\//i.test(ad.clickUrl)) {
        var button = document.createElement('a');
        button.href = ad.clickUrl;
        button.target = '_blank';
        button.rel = 'noopener noreferrer';
        button.style.cssText = 'display:inline-block;background:linear-gradient(135deg,#D4143A,#A80F32);color:#FFFFFF;text-decoration:none;padding:8px 18px;border-radius:8px;font-size:13px;font-weight:600;text-align:center;transition:opacity 0.2s;box-shadow:0 4px 12px rgba(212,20,58,0.25);';
        button.textContent = (ad.ctaText || 'Learn More') + ' \u2192';
        card.appendChild(button);
      }

      container.appendChild(card);
    })
    .catch(function(err) {
      console.warn('CrimFig Ads failed to render:', err);
    });
  });
})();`;
  }

  /**
   * Serve creative asset and log audit ping.
   * Single Money Authority Directive: Does NOT debit escrow or credit promoter earnings here.
   * Interaction telemetry is recorded cleanly for the 30-min settlement cron.
   */
  async getAdForPlacement(token: string, clientIp?: string, userAgent?: string, referrerDomain?: string) {
    const [placement] = await this.db
      .select({
        id: adsPlacements.id,
        promoterId: adsPlacements.promoterId,
        campaignId: adsPlacements.campaignId,
        creativeId: adsPlacements.creativeId,
        websiteId: adsPlacements.websiteId,
        status: adsPlacements.status,
        campaignStatus: adsCampaigns.status,
        remainingBudget: adsCampaigns.remainingBudgetUsdCents,
        headline: adsCreatives.headline,
        bodyText: adsCreatives.bodyText,
        ctaText: adsCreatives.ctaText,
        imageUrl: adsCreatives.imageUrl,
        destinationUrl: adsCreatives.destinationUrl,
      })
      .from(adsPlacements)
      .innerJoin(adsCampaigns, eq(adsPlacements.campaignId, adsCampaigns.id))
      .innerJoin(adsCreatives, eq(adsPlacements.creativeId, adsCreatives.id))
      .where(eq(adsPlacements.placementToken, token))
      .limit(1);

    if (!placement || placement.status !== 'active' || placement.campaignStatus !== 'active' || placement.remainingBudget <= 0) {
      throw new NotFoundException('Ad placement unavailable or budget exhausted');
    }

    // Update website embed ping heartbeat timestamp
    if (placement.websiteId) {
      await this.db
        .update(adsPromoterWebsites)
        .set({ embedPingLastAt: new Date() })
        .where(eq(adsPromoterWebsites.id, placement.websiteId));
    }

    // Dynamic Auction Evaluation
    // Gather candidate active creatives across eligible campaigns
    const activeCandidates = await this.db
      .select({
        campaignId: adsCampaigns.id,
        creativeId: adsCreatives.id,
        headline: adsCreatives.headline,
        bodyText: adsCreatives.bodyText,
        ctaText: adsCreatives.ctaText,
        imageUrl: adsCreatives.imageUrl,
        destinationUrl: adsCreatives.destinationUrl,
        pricingModel: adsCampaigns.pricingModel,
        costPerImpressionUsdCents: adsCampaigns.costPerImpressionUsdCents,
        costPerClickUsdCents: adsCampaigns.costPerClickUsdCents,
        remainingBudgetUsdCents: adsCampaigns.remainingBudgetUsdCents,
        hourlyPacingUsdCents: adsCampaigns.hourlyPacingUsdCents,
        targetCountries: adsCampaigns.targetCountries,
        targetStates: adsCampaigns.targetStates,
        targetDevices: adsCampaigns.targetDevices,
        targetHours: adsCampaigns.targetHours,
        format: adsCreatives.adFormat,
      })
      .from(adsCampaigns)
      .innerJoin(adsCreatives, eq(adsCampaigns.id, adsCreatives.campaignId))
      .where(
        and(
          eq(adsCampaigns.status, 'active'),
          eq(adsCampaigns.moderationStatus, 'approved'),
          eq(adsCreatives.status, 'active'),
          sql`${adsCampaigns.remainingBudgetUsdCents} > 0`,
        ),
      )
      .limit(20);

    const formattedCandidates = activeCandidates.map((c) => ({
      ...c,
      pricingModel: (c.pricingModel || 'cpm') as 'cpm' | 'cpc',
      targetCountries: c.targetCountries ? JSON.parse(c.targetCountries) : null,
      targetStates: c.targetStates ? JSON.parse(c.targetStates) : null,
      targetDevices: c.targetDevices ? JSON.parse(c.targetDevices) : null,
      targetHours: c.targetHours ? JSON.parse(c.targetHours) : null,
    }));

    const auctionResult = this.auctionEngine.resolveAuction(formattedCandidates, {
      slotHandle: 'cf_slot_auto',
      clientIp,
    });

    // Select the auction winner or fallback to the placement-bound creative
    const winningCreative = auctionResult ? auctionResult.winner : placement;
    const clearingPriceMicros = auctionResult ? auctionResult.clearingPriceMicros : 0;
    const finalCampaignId = auctionResult ? auctionResult.winner.campaignId : placement.campaignId;
    const finalCreativeId = auctionResult ? auctionResult.winner.creativeId : placement.creativeId;

    const ipHash = this.tokenService.hashIp(clientIp);

    // Record immutable ads_serves record for the auction allocation
    const [serve] = await this.db
      .insert(adsServes)
      .values({
        placementId: placement.id,
        campaignId: finalCampaignId,
        creativeId: finalCreativeId,
        promoterId: placement.promoterId,
        slotHandle: 'cf_slot_auto',
        clearingPriceMicros,
        pricingModel: auctionResult ? auctionResult.winner.pricingModel : 'cpm',
        ipHash,
        userAgentHash: userAgent ? this.tokenService.hashIp(userAgent) : null,
      })
      .returning();

    // Generate cryptographic signed impression token binding this serve
    const impToken = this.tokenService.generateToken({
      servedId: serve.id,
      placementId: placement.id,
      campaignId: finalCampaignId,
      creativeId: finalCreativeId,
      promoterId: placement.promoterId,
      ipHash,
    });

    // Record interaction telemetry (money settlement runs in 30-min cron via PLAN-0002)
    await this.db
      .insert(adsInteractions)
      .values({
        placementId: placement.id,
        promoterId: placement.promoterId,
        serveId: serve.id,
        type: 'impression',
        source: placement.websiteId ? 'embed' : 'share_link',
        actorIp: clientIp,
        userAgent,
        referrer: referrerDomain,
        isValid: true,
      });

    const baseUrl = process.env.ADS_PUBLIC_URL || 'https://ads.crimfig.com';
    const clickUrl = `${baseUrl}/api/v1/delivery/go/${impToken}?pid=${placement.promoterId}`;

    return {
      headline: winningCreative.headline,
      bodyText: winningCreative.bodyText,
      ctaText: winningCreative.ctaText,
      imageUrl: winningCreative.imageUrl,
      impToken,
      clickUrl,
    };
  }

  /**
   * Handle click redirect from share link or embed card.
   * Verifies cryptographic impToken signature (or falls back to legacy token),
   * validates campaign active state and budget, and logs click telemetry.
   */
  async handleClick(token: string, clientIp?: string, userAgent?: string, referrer?: string) {
    let placementId: string | undefined;
    let serveId: string | undefined;
    let campaignId: string | undefined;
    let creativeId: string | undefined;
    let promoterId: string | undefined;
    let destinationUrl: string | undefined;

    // 1. Try to decode as cryptographically signed impression token
    const tokenPayload = this.tokenService.verifyToken(token, clientIp);
    if (tokenPayload) {
      serveId = tokenPayload.servedId;
      placementId = tokenPayload.placementId;
      campaignId = tokenPayload.campaignId;
      creativeId = tokenPayload.creativeId;
      promoterId = tokenPayload.promoterId;

      const [creative] = await this.db
        .select({ destinationUrl: adsCreatives.destinationUrl })
        .from(adsCreatives)
        .where(eq(adsCreatives.id, creativeId))
        .limit(1);

      if (creative) {
        destinationUrl = creative.destinationUrl;
      }
    } else {
      // 2. Fallback to legacy placementToken lookup
      const [placement] = await this.db
        .select({
          id: adsPlacements.id,
          promoterId: adsPlacements.promoterId,
          campaignId: adsPlacements.campaignId,
          creativeId: adsPlacements.creativeId,
          campaignStatus: adsCampaigns.status,
          remainingBudget: adsCampaigns.remainingBudgetUsdCents,
          destinationUrl: adsCreatives.destinationUrl,
        })
        .from(adsPlacements)
        .innerJoin(adsCampaigns, eq(adsPlacements.campaignId, adsCampaigns.id))
        .innerJoin(adsCreatives, eq(adsPlacements.creativeId, adsCreatives.id))
        .where(eq(adsPlacements.placementToken, token))
        .limit(1);

      if (placement) {
        placementId = placement.id;
        campaignId = placement.campaignId;
        creativeId = placement.creativeId;
        promoterId = placement.promoterId;
        destinationUrl = placement.destinationUrl;
      }
    }

    if (!placementId || !campaignId || !destinationUrl) {
      throw new NotFoundException('Placement or click token invalid or expired');
    }

    // Verify campaign is active with budget
    const [campaign] = await this.db
      .select({ status: adsCampaigns.status, remainingBudget: adsCampaigns.remainingBudgetUsdCents })
      .from(adsCampaigns)
      .where(eq(adsCampaigns.id, campaignId))
      .limit(1);

    if (!campaign || campaign.status !== 'active' || campaign.remainingBudget <= 0) {
      throw new NotFoundException('Campaign inactive or budget exhausted');
    }

    // Run anti-fraud rules evaluation on click
    const validation = this.fraudRules.validateClick({
      placementId,
      clientIp,
      userAgent,
      referrer,
      tokenTimestampMs: tokenPayload ? tokenPayload.timestamp : undefined,
    });

    // Record click interaction telemetry with validation status for batch settlement
    const [interaction] = await this.db
      .insert(adsInteractions)
      .values({
        placementId,
        promoterId: promoterId || placementId,
        serveId,
        type: 'click',
        source: 'share_link',
        actorIp: clientIp,
        userAgent,
        referrer,
        isValid: validation.isValid,
        invalidReason: validation.reasonCode || null,
      })
      .returning();

    // Generate signed unique clickId (cf_click) and persist in ads_clicks (30-day validity)
    const clickId = `clk_${Date.now().toString(36)}_${crypto.randomBytes(8).toString('hex')}`;
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    try {
      await this.db.insert(schema.adsClicks).values({
        clickId,
        serveId,
        interactionId: interaction.id,
        campaignId,
        promoterId: promoterId || null,
        actorIp: clientIp || null,
        userAgent: userAgent || null,
        expiresAt,
      });
    } catch (clickErr: any) {
      this.logger.warn(`Failed to insert ads_clicks entry: ${clickErr.message}`);
    }

    // Append cf_click to destination URL for conversion attribution
    const separator = destinationUrl.includes('?') ? '&' : '?';
    return `${destinationUrl}${separator}cf_click=${clickId}`;
  }

  /**
   * Ultra-fast non-blocking execution audit logging for embed runs
   */
  async logAuditPing(params: {
    placementToken?: string;
    domain?: string;
    bundleId?: string;
    clientIp?: string;
    userAgent?: string;
    referrer?: string;
  }) {
    let placementId: string | undefined;
    let promoterId: string | undefined;
    let websiteId: string | undefined;
    let appId: string | undefined;

    if (params.placementToken) {
      const [placement] = await this.db
        .select({
          id: adsPlacements.id,
          promoterId: adsPlacements.promoterId,
          websiteId: adsPlacements.websiteId,
          appId: adsPlacements.appId,
        })
        .from(adsPlacements)
        .where(eq(adsPlacements.placementToken, params.placementToken))
        .limit(1);

      if (placement) {
        placementId = placement.id;
        promoterId = placement.promoterId;
        websiteId = placement.websiteId || undefined;
        appId = placement.appId || undefined;
      }
    }

    await this.db.insert(adsEmbedRunAudits).values({
      placementId,
      promoterId,
      websiteId,
      appId,
      domain: params.domain ? params.domain.toLowerCase().trim() : null,
      bundleId: params.bundleId ? params.bundleId.trim() : null,
      ipAddress: params.clientIp,
      userAgent: params.userAgent,
      referrer: params.referrer,
      runTimestamp: new Date(),
      isProcessed: false,
    });
  }

  /**
   * Fast-path tracking for user engagement and verified viewability events
   */
  async logInteraction(params: {
    placementToken?: string;
    impToken?: string;
    type: 'hover' | 'touch' | 'impression' | 'viewable_impression' | 'click' | 'reels_view' | 'video_q25' | 'video_q50' | 'video_q75' | 'video_complete';
    source?: string;
    clientIp?: string;
    userAgent?: string;
    referrer?: string;
    visibleRatio?: number;
    durationSeconds?: number;
  }) {
    let placementId: string | undefined;
    let promoterId: string | undefined;
    let serveId: string | undefined;

    // 1. If signed impToken is provided, decode cryptographic payload
    if (params.impToken) {
      const payload = this.tokenService.verifyToken(params.impToken, params.clientIp);
      if (payload) {
        placementId = payload.placementId;
        promoterId = payload.promoterId;
        serveId = payload.servedId;
      }
    }

    // 2. Fallback to placementToken lookup if not resolved from impToken
    if (!placementId && params.placementToken) {
      const [placement] = await this.db
        .select({
          id: adsPlacements.id,
          promoterId: adsPlacements.promoterId,
        })
        .from(adsPlacements)
        .where(eq(adsPlacements.placementToken, params.placementToken))
        .limit(1);

      if (placement) {
        placementId = placement.id;
        promoterId = placement.promoterId;
      }
    }

    if (!placementId) {
      return;
    }

    // Run anti-fraud check for impression and viewability events
    let isValid = true;
    let invalidReason: string | null = null;

    if (params.type === 'impression' || params.type === 'viewable_impression') {
      const validation = this.fraudRules.validateImpression({
        placementId,
        clientIp: params.clientIp,
        userAgent: params.userAgent,
        referrer: params.referrer,
      });
      isValid = validation.isValid;
      invalidReason = validation.reasonCode || null;
    }

    await this.db.insert(adsInteractions).values({
      placementId,
      promoterId: promoterId || placementId,
      serveId,
      type: params.type,
      source: params.source || 'embed',
      actorIp: params.clientIp,
      userAgent: params.userAgent,
      referrer: params.referrer,
      isValid,
      invalidReason,
    });
  }
}
