import { Injectable, Inject, NotFoundException, Logger } from '@nestjs/common';
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
} from '@crimfig/database/schema';
import { eq, sql } from 'drizzle-orm';

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Return client-side embed.js script code
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

    fetch(apiBase + '/api/v1/delivery/ad/' + token + '?domain=' + encodeURIComponent(currentDomain), {
      headers: { 'Accept': 'application/json' }
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (!data || !data.data) return;
      var ad = data.data;

      var card = document.createElement('div');
      card.style.cssText = 'border:1px solid rgba(255,255,255,0.12);background:#0f172a;color:#f8fafc;border-radius:12px;padding:16px;font-family:system-ui,-apple-system,sans-serif;max-width:400px;box-shadow:0 10px 25px rgba(0,0,0,0.3);position:relative;overflow:hidden;box-sizing:border-box;margin:12px 0;';

      var badge = '<div style="font-size:10px;text-transform:uppercase;color:#94a3b8;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;"><span>Promoted</span><span style="font-weight:700;color:#38bdf8;">CrimFig Ads</span></div>';
      var img = ad.imageUrl ? '<img src="' + ad.imageUrl + '" style="width:100%;height:180px;object-fit:cover;border-radius:8px;margin-bottom:12px;display:block;" />' : '';
      var headline = '<h4 style="margin:0 0 6px 0;font-size:16px;font-weight:700;color:#f8fafc;">' + ad.headline + '</h4>';
      var body = ad.bodyText ? '<p style="margin:0 0 14px 0;font-size:13px;color:#cbd5e1;line-height:1.4;">' + ad.bodyText + '</p>' : '';
      var button = '<a href="' + ad.clickUrl + '" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;text-decoration:none;padding:8px 18px;border-radius:8px;font-size:13px;font-weight:600;text-align:center;">' + (ad.ctaText || 'Learn More') + ' &rarr;</a>';

      card.innerHTML = badge + img + headline + body + button;
      container.appendChild(card);
    })
    .catch(function(err) {
      console.warn('CrimFig Ads failed to render:', err);
    });
  });
})();`;
  }

  /**
   * Serve creative asset and track impression + embed ping
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
        costPerImpression: adsCampaigns.costPerImpressionUsdCents,
        costPerClick: adsCampaigns.costPerClickUsdCents,
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

    // If this is a website placement, update embedPingLastAt
    if (placement.websiteId) {
      await this.db
        .update(adsPromoterWebsites)
        .set({ embedPingLastAt: new Date() })
        .where(eq(adsPromoterWebsites.id, placement.websiteId));
    }

    // Record impression interaction
    const [interaction] = await this.db
      .insert(adsInteractions)
      .values({
        placementId: placement.id,
        promoterId: placement.promoterId,
        type: 'impression',
        source: placement.websiteId ? 'embed' : 'share_link',
        actorIp: clientIp,
        userAgent,
        referrer: referrerDomain,
      })
      .returning();

    // Promoter earns 70% of impression cost
    const impressionCost = placement.costPerImpression;
    const promoterEarning = Math.max(1, Math.round(impressionCost * 0.7));

    await this.db.insert(adsPromoterEarnings).values({
      promoterId: placement.promoterId,
      placementId: placement.id,
      interactionId: interaction.id,
      interactionType: 'impression',
      amountUsdCents: promoterEarning,
    });

    // Decrement campaign budget
    await this.db
      .update(adsCampaigns)
      .set({
        remainingBudgetUsdCents: sql`GREATEST(0, ${adsCampaigns.remainingBudgetUsdCents} - ${impressionCost})`,
        updatedAt: new Date(),
      })
      .where(eq(adsCampaigns.id, placement.campaignId));

    const baseUrl = process.env.ADS_PUBLIC_URL || 'https://ads.crimfig.com';
    const clickUrl = `${baseUrl}/api/v1/delivery/go/${token}?pid=${placement.promoterId}`;

    return {
      headline: placement.headline,
      bodyText: placement.bodyText,
      ctaText: placement.ctaText,
      imageUrl: placement.imageUrl,
      clickUrl,
    };
  }

  /**
   * Handle click redirect from share link or embed card
   */
  async handleClick(token: string, clientIp?: string, userAgent?: string, referrer?: string) {
    const [placement] = await this.db
      .select({
        id: adsPlacements.id,
        promoterId: adsPlacements.promoterId,
        campaignId: adsPlacements.campaignId,
        creativeId: adsPlacements.creativeId,
        costPerClick: adsCampaigns.costPerClickUsdCents,
        destinationUrl: adsCreatives.destinationUrl,
      })
      .from(adsPlacements)
      .innerJoin(adsCampaigns, eq(adsPlacements.campaignId, adsCampaigns.id))
      .innerJoin(adsCreatives, eq(adsPlacements.creativeId, adsCreatives.id))
      .where(eq(adsPlacements.placementToken, token))
      .limit(1);

    if (!placement) {
      throw new NotFoundException('Placement not found');
    }

    // Record click interaction
    const [interaction] = await this.db
      .insert(adsInteractions)
      .values({
        placementId: placement.id,
        promoterId: placement.promoterId,
        type: 'click',
        source: 'share_link',
        actorIp: clientIp,
        userAgent,
        referrer,
      })
      .returning();

    // Promoter earns 70% of click cost
    const clickCost = placement.costPerClick;
    const promoterEarning = Math.max(1, Math.round(clickCost * 0.7));

    await this.db.insert(adsPromoterEarnings).values({
      promoterId: placement.promoterId,
      placementId: placement.id,
      interactionId: interaction.id,
      interactionType: 'click',
      amountUsdCents: promoterEarning,
    });

    // Decrement campaign budget
    await this.db
      .update(adsCampaigns)
      .set({
        remainingBudgetUsdCents: sql`GREATEST(0, ${adsCampaigns.remainingBudgetUsdCents} - ${clickCost})`,
        updatedAt: new Date(),
      })
      .where(eq(adsCampaigns.id, placement.campaignId));

    return placement.destinationUrl;
  }
}
