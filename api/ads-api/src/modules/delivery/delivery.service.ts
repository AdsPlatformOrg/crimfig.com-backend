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
  adsMediaAssets,
  adsCreativeStacks,
  crimfigGeoTargets,
} from '@crimfig/database/schema';
import { eq, sql, and, or, inArray } from 'drizzle-orm';
import { ImpressionTokenService, ImpressionTokenPayload } from './impression-token.service';
import { AuctionEngineService } from './auction-engine.service';
import { FraudRulesService } from '../verification/fraud-rules.service';

const SLOT_HANDLE_BY_ID: Record<string, string> = {
  cf_slot_0001: 'banner_top',
  cf_slot_0002: 'banner_bottom',
  cf_slot_0003: 'in_content_mid',
  cf_slot_0004: 'in_content_end',
  cf_slot_0005: 'sidebar_sticky',
  cf_slot_0006: 'listing_interstitial',
  cf_slot_0007: 'popup_exit_intent',
  cf_slot_0008: 'app_interstitial',
  cf_slot_0009: 'app_rewarded',
  cf_slot_0010: 'reels_preroll',
};

const VIDEO_PLACEMENTS = new Set(['in_content_mid', 'in_content_end', 'listing_interstitial']);

function videoDeliveryEnabled(): boolean {
  return (process.env.CREATIVE_VIDEO_AUTHORING_ENABLED || 'false').toLowerCase() === 'true';
}

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

  private publicBaseUrl(): string {
    return (process.env.ADS_PUBLIC_URL || 'https://ads.crimfig.com').replace(/\/+$/, '');
  }

  /** Media is served by the Ads API itself; reject unrelated or relative external paths. */
  private absoluteMediaUrl(value: string | null | undefined): string | null {
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith('/api/v1/uploads/media/')) return `${this.publicBaseUrl()}${value}`;
    return null;
  }

  private requestedPlacementHandle(token: string, isSlotCatalog: boolean): string {
    if (isSlotCatalog) return SLOT_HANDLE_BY_ID[token] || 'unknown';
    // Legacy placements render the card surface; keep video limited to the
    // same allowlist rather than treating an unknown embed as video-capable.
    return 'in_content_mid';
  }

  private allowedAdTypes(handle: string): Array<'text' | 'image' | 'video'> {
    if (videoDeliveryEnabled() && VIDEO_PLACEMENTS.has(handle)) return ['text', 'image', 'video'];
    return ['text', 'image'];
  }

  /** A valid signature is necessary but never sufficient: bind every identity to its stored serve. */
  private async boundServe(payload: ImpressionTokenPayload): Promise<boolean> {
    const [serve] = await this.db.select().from(adsServes).where(eq(adsServes.id, payload.servedId)).limit(1);
    return !!serve && serve.placementId === payload.placementId && serve.campaignId === payload.campaignId &&
      serve.creativeId === payload.creativeId && serve.promoterId === payload.promoterId &&
      serve.ipHash === payload.ipHash && serve.servedAt.getTime() <= payload.timestamp &&
      payload.timestamp - serve.servedAt.getTime() <= 60_000;
  }

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
  function initSlots() {
    var apiBase = 'https://ads.crimfig.com';
    var currentScript = document.currentScript;
    if (currentScript && currentScript.src) {
      apiBase = currentScript.src.replace(/\\/api\\/v1\\/delivery\\/(embed|pub-loader)\\.js.*/, '');
    }
    var currentDomain = window.location.hostname;

    // 1. Modern ins.crimfig-pub-slot elements
    var pubSlots = document.querySelectorAll('ins.crimfig-pub-slot:not([data-cf-loaded="true"])');
    pubSlots.forEach(function(slot) {
      var token = slot.getAttribute('data-cf-placement');
      var mode = slot.getAttribute('data-cf-mode') || 'publisher_network';
      var fill = slot.getAttribute('data-cf-network-fill') || 'false';
      if (!token) return;
      slot.setAttribute('data-cf-loaded', 'true');

      var query = '?domain=' + encodeURIComponent(currentDomain) + '&mode=' + encodeURIComponent(mode) + '&fill=' + encodeURIComponent(fill);
      fetch(apiBase + '/api/v1/delivery/ad/' + encodeURIComponent(token) + query, {
        headers: { 'Accept': 'application/json' }
      })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (!data || !data.data) return;
        renderAdCard(slot, data.data, mode, apiBase);
      })
      .catch(function(err) {
        console.warn('CrimFig Ads failed to render:', err);
      });
    });

    // 2. Legacy script[data-placement] elements
    var legacyScripts = document.querySelectorAll('script[data-placement]:not([data-cf-processed="true"])');
    legacyScripts.forEach(function(script) {
      var token = script.getAttribute('data-placement');
      if (!token) return;
      script.setAttribute('data-cf-processed', 'true');
      var container = document.getElementById('cf-ad-' + token);
      if (!container) return;

      var scriptApiBase = script.src.replace(/\\/api\\/v1\\/delivery\\/embed\\.js.*/, '') || apiBase;
      fetch(scriptApiBase + '/api/v1/delivery/ad/' + encodeURIComponent(token) + '?domain=' + encodeURIComponent(currentDomain), {
        headers: { 'Accept': 'application/json' }
      })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (!data || !data.data) return;
        renderAdCard(container, data.data, 'publisher_network', scriptApiBase);
      })
      .catch(function(err) {
        console.warn('CrimFig Ads failed to render legacy slot:', err);
      });
    });
  }

  function resolvedMedia(value) {
    if (!value) return '';
    if (/^https?:\\/\\//i.test(value)) return value;
    if (value.charAt(0) === '/' && value.indexOf('/api/v1/uploads/media/') === 0) return apiBase + value;
    return '';
  }

  function trackViewability(container, ad, minSeconds) {
    if (!ad.impToken || !('IntersectionObserver' in window)) return;
    var sent = false, timer = null, startedAt = null;
    var observer = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
          if (timer || sent) return;
          startedAt = Date.now();
          timer = setTimeout(function() {
            timer = null;
            if (sent) return;
            sent = true;
            fetch(apiBase + '/api/v1/delivery/viewability', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                impToken: ad.impToken,
                visibleRatio: Math.min(1, entry.intersectionRatio),
                durationSeconds: Math.max(minSeconds, (Date.now() - startedAt) / 1000),
                format: ad.format || undefined
              })
            }).catch(function() {});
          }, minSeconds * 1000);
        } else if (timer) {
          clearTimeout(timer);
          timer = null;
          startedAt = null;
        }
      });
    }, { threshold: [0.5] });
    observer.observe(container);
  }

  function renderAdCard(container, ad, mode, apiBase) {
    var card = document.createElement('div');
    card.style.cssText = "border:1px solid rgba(255,255,255,0.08);background:#171B2A;color:#FFFFFF;border-radius:12px;padding:16px;font-family:'Poppins',Arial,Helvetica,sans-serif;max-width:100%;box-shadow:0 10px 25px rgba(0,0,0,0.3);position:relative;overflow:hidden;box-sizing:border-box;margin:12px 0;";

    var badge = document.createElement('div');
    badge.style.cssText = 'font-size:10px;text-transform:uppercase;color:#94a3b8;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;letter-spacing:0.05em;';
    var badgeLeft = document.createElement('span');
    badgeLeft.textContent = mode === 'owned_site_direct' ? 'Direct Partner' : 'Promoted';
    var badgeRight = document.createElement('span');
    badgeRight.textContent = 'CrimFig Ads';
    badgeRight.style.cssText = 'font-weight:700;color:#D4143A;';
    badge.appendChild(badgeLeft);
    badge.appendChild(badgeRight);
    card.appendChild(badge);

    var videoSource = ad.adType === 'video' ? resolvedMedia(ad.videoUrl) : '';
    if (videoSource) {
      var videoWrap = document.createElement('div');
      videoWrap.style.cssText = 'position:relative;margin-bottom:12px;';
      var video = document.createElement('video');
      video.src = videoSource;
      if (ad.posterUrl) video.poster = resolvedMedia(ad.posterUrl);
      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.setAttribute('playsinline', '');
      video.setAttribute('muted', '');
      video.setAttribute('disablePictureInPicture', '');
      video.setAttribute('disableRemotePlayback', '');
      video.setAttribute('aria-label', ad.headline || 'Advertisement video');
      video.style.cssText = 'width:100%;height:180px;object-fit:cover;border-radius:8px;display:block;background:#0b1020;';
      videoWrap.appendChild(video);

      var overlay = document.createElement('a');
      overlay.href = ad.clickUrl;
      overlay.target = '_blank';
      overlay.rel = 'noopener noreferrer';
      overlay.setAttribute('aria-label', ad.headline || 'Open advertisement');
      overlay.style.cssText = 'position:absolute;inset:0;z-index:2;';
      videoWrap.appendChild(overlay);

      var play = document.createElement('button');
      play.type = 'button';
      play.textContent = 'Play muted';
      play.setAttribute('aria-label', 'Play advertisement muted');
      play.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:3;background:rgba(212,20,58,.94);color:#fff;border:0;border-radius:999px;padding:10px 16px;font:600 12px Poppins,Arial,sans-serif;cursor:pointer;';
      var started = false;
      var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      play.addEventListener('click', function(event) {
        event.preventDefault();
        event.stopPropagation();
        started = true;
        play.style.display = 'none';
        video.play().catch(function() { play.style.display = 'block'; });
      });
      video.addEventListener('error', function() {
        video.style.display = 'none';
        play.style.display = 'none';
      });
      if (!reduced) play.style.display = 'none';
      videoWrap.appendChild(play);

      if ('IntersectionObserver' in window) {
        new IntersectionObserver(function(entries) {
          entries.forEach(function(entry) {
            if (entry.intersectionRatio >= 0.5) {
              if (!reduced && !started) {
                started = true;
                play.style.display = 'none';
                video.play().catch(function() { started = false; play.style.display = 'block'; });
              }
            } else {
              video.pause();
            }
          });
        }, { threshold: [0, 0.5] }).observe(videoWrap);
      } else if (!reduced) {
        started = true;
        play.style.display = 'none';
        video.play().catch(function() { started = false; play.style.display = 'block'; });
      }
      card.appendChild(videoWrap);
    } else if (ad.imageUrl && resolvedMedia(ad.imageUrl)) {
      var img = document.createElement('img');
      img.src = resolvedMedia(ad.imageUrl);
      img.alt = ad.headline || 'Advertisement';
      img.style.cssText = 'width:100%;height:180px;object-fit:cover;border-radius:8px;margin-bottom:12px;display:block;';
      if (ad.clickUrl && /^https?:\\/\\//i.test(ad.clickUrl)) {
        var imgLink = document.createElement('a');
        imgLink.href = ad.clickUrl;
        imgLink.target = '_blank';
        imgLink.rel = 'noopener noreferrer';
        imgLink.setAttribute('aria-label', ad.headline || 'Open advertisement');
        imgLink.appendChild(img);
        card.appendChild(imgLink);
      } else {
        card.appendChild(img);
      }
    }

    if (ad.headline) {
      var headline = document.createElement('h4');
      headline.style.cssText = 'margin:0 0 6px 0;font-size:16px;font-weight:700;color:#FFFFFF;line-height:1.3;';
      headline.textContent = ad.headline;
      card.appendChild(headline);
    }

    if (ad.bodyText) {
      var body = document.createElement('p');
      body.style.cssText = 'margin:0 0 14px 0;font-size:13px;color:#F5F6F8;line-height:1.4;opacity:0.85;';
      body.textContent = ad.bodyText;
      card.appendChild(body);
    }

    if (ad.ctaText && ad.clickUrl && /^https?:\\/\\//i.test(ad.clickUrl)) {
      var button = document.createElement('a');
      button.href = ad.clickUrl;
      button.target = '_blank';
      button.rel = 'noopener noreferrer';
      button.style.cssText = 'display:inline-block;background:linear-gradient(135deg,#D4143A,#A80F32);color:#FFFFFF;text-decoration:none;padding:8px 18px;border-radius:8px;font-size:13px;font-weight:600;text-align:center;transition:opacity 0.2s;box-shadow:0 4px 12px rgba(212,20,58,0.25);';
      button.textContent = ad.ctaText + ' \\u2192';
      card.appendChild(button);
    }

    container.innerHTML = '';
    container.appendChild(card);
    trackViewability(card, ad, ad.adType === 'video' ? 2 : 1);
  }

  // Queue runner and immediate execution
  window.cfPubQ = window.cfPubQ || [];
  var origPush = window.cfPubQ.push;
  window.cfPubQ.push = function() {
    var res = origPush.apply(window.cfPubQ, arguments);
    initSlots();
    return res;
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSlots);
  } else {
    initSlots();
  }
})();`;
  }

  /**
   * Serve creative asset and log audit ping.
   * Single Money Authority Directive: Does NOT debit escrow or credit promoter earnings here.
   * Interaction telemetry is recorded cleanly for the 30-min settlement cron.
   */
  private parseStringArray(value: string | null | undefined): string[] {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  private parseNumberArray(value: string | null | undefined): number[] {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'number') : [];
    } catch {
      return [];
    }
  }

  private regionMatches(target: string, client: string): boolean {
    const a = target.toUpperCase();
    const b = client.toUpperCase();
    return a === b || a.endsWith(`-${b}`) || b.endsWith(`-${a}`);
  }

  private deviceFromUserAgent(userAgent?: string): 'desktop' | 'android' | 'ios' | 'tablet' | undefined {
    if (!userAgent) return undefined;
    const value = userAgent.toLowerCase();
    if (/ipad|tablet/.test(value)) return 'tablet';
    if (/iphone|ipod/.test(value)) return 'ios';
    if (/android/.test(value)) return /mobile/.test(value) ? 'android' : 'tablet';
    if (/mozilla|chrome|safari|firefox|edg/.test(value)) return 'desktop';
    return undefined;
  }

  /**
   * Apply canonical campaign/stack targeting and effective device/daypart
   * overrides before auction scoring. Unknown client geography fails closed.
   */
  private async filterEligibleCandidates(
    candidates: any[],
    clientGeo?: { country?: string; region?: string; city?: string; device?: string },
  ): Promise<any[]> {
    if (candidates.length === 0) return [];
    const campaignIds = [...new Set(candidates.map((candidate) => candidate.campaignId))];
    const stackIds = [...new Set(candidates.map((candidate) => candidate.adStackId).filter(Boolean))];
    const targetConditions = [and(eq(crimfigGeoTargets.ownerType, 'campaign'), inArray(crimfigGeoTargets.ownerId, campaignIds))];
    if (stackIds.length > 0) {
      targetConditions.push(and(eq(crimfigGeoTargets.ownerType, 'stack'), inArray(crimfigGeoTargets.ownerId, stackIds)) as any);
    }
    const targetRows = await this.db
      .select()
      .from(crimfigGeoTargets)
      .where(targetConditions.length === 1 ? targetConditions[0] : or(...targetConditions));
    const targetsByOwner = new Map<string, typeof targetRows>();
    for (const row of targetRows) {
      const key = `${row.ownerType}:${row.ownerId}`;
      const list = targetsByOwner.get(key) || [];
      list.push(row);
      targetsByOwner.set(key, list);
    }

    const effectiveTargets = (candidate: any) => {
      const stackMode = candidate.stackGeoMode || 'inherit';
      const geoMode = stackMode === 'inherit' ? candidate.campaignGeoMode || 'global' : stackMode;
      if (geoMode === 'global') return { geoMode, rows: [] as typeof targetRows };
      const owner = stackMode === 'targeted' ? `stack:${candidate.adStackId}` : `campaign:${candidate.campaignId}`;
      return { geoMode, rows: targetsByOwner.get(owner) || [] };
    };

    return candidates.filter((candidate) => {
      const targeting = effectiveTargets(candidate);
      const countries = targeting.geoMode === 'targeted'
        ? [...new Set(targeting.rows.flatMap((row) => this.parseStringArray(row.resolvedCountries)))]
        : this.parseStringArray(candidate.targetCountries);
      const subdivisions = targeting.geoMode === 'targeted'
        ? [...new Set(targeting.rows.flatMap((row) => this.parseStringArray(row.resolvedSubdivisions)))]
        : this.parseStringArray(candidate.targetStates);
      const cities = targeting.geoMode === 'targeted'
        ? [...new Set(targeting.rows.flatMap((row) => this.parseStringArray(row.resolvedCities)))]
        : [];
      if (targeting.geoMode === 'targeted' && targeting.rows.length === 0) return false;
      if (countries.length > 0 && (!clientGeo?.country || !countries.map((c) => c.toUpperCase()).includes(clientGeo.country.toUpperCase()))) {
        return false;
      }
      if (subdivisions.length > 0) {
        if (!clientGeo?.region || !subdivisions.some((value) => this.regionMatches(value, clientGeo.region!))) return false;
      }
      if (cities.length > 0) {
        if (!clientGeo?.city || !cities.includes(clientGeo.city)) return false;
      }
      const devices = candidate.stackTargetDevices
        ? this.parseStringArray(candidate.stackTargetDevices)
        : this.parseStringArray(candidate.targetDevices);
      if (devices.length > 0) {
        const device = clientGeo?.device;
        if (!device) return false;
        if (device === 'tablet' && devices.includes('mobile')) {
          // Tablets count as mobile only when the campaign opted into the broad category.
        } else if (!devices.includes(device) && !(device === 'android' || device === 'ios' ? devices.includes('mobile') : false)) {
          return false;
        }
      }
      const hours = candidate.stackTargetHours
        ? this.parseNumberArray(candidate.stackTargetHours)
        : this.parseNumberArray(candidate.targetHours);
      candidate.targetCountries = countries.length ? countries : null;
      candidate.targetStates = subdivisions.length ? subdivisions : null;
      candidate.targetCities = cities.length ? cities : null;
      candidate.targetDevices = devices.length ? devices : null;
      candidate.targetHours = hours.length ? hours : null;
      return true;
    });
  }

  async getAdForPlacement(
    token: string,
    clientIp?: string,
    userAgent?: string,
    referrerDomain?: string,
    mode?: string,
    allowHomeNetworkFill?: boolean,
    clientGeo?: { country?: string; region?: string; city?: string; device?: string },
  ) {
    this.tokenService.assertConfigured();

    // Check if token matches standard slot catalog handles (e.g. cf_slot_0001) or placementToken
    const isDirectBarterMode = mode === 'owned_site_direct';
    const isSlotCatalog = token.startsWith('cf_slot_');

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
        videoUrl: adsCreatives.videoUrl,
        posterUrl: adsCreatives.posterUrl,
        adType: adsCreatives.adType,
        adFormat: adsCreatives.adFormat,
        width: adsCreatives.width,
        height: adsCreatives.height,
        durationSeconds: adsMediaAssets.durationSeconds,
        destinationUrl: adsCreatives.destinationUrl,
      })
      .from(adsPlacements)
      .innerJoin(adsCampaigns, eq(adsPlacements.campaignId, adsCampaigns.id))
      .innerJoin(adsCreatives, eq(adsPlacements.creativeId, adsCreatives.id))
      .leftJoin(adsMediaAssets, eq(adsCreatives.mediaAssetId, adsMediaAssets.id))
      .where(eq(adsPlacements.placementToken, token))
      .limit(1);

    if (!placement && !isDirectBarterMode && !isSlotCatalog) {
      throw new NotFoundException('Ad placement unavailable or budget exhausted');
    }

    if (placement && (placement.status !== 'active' || placement.campaignStatus !== 'active' || placement.remainingBudget <= 0)) {
      if (!isDirectBarterMode) {
        throw new NotFoundException('Ad placement unavailable or budget exhausted');
      }
    }

    // Update website embed ping heartbeat timestamp
    if (placement?.websiteId) {
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
        videoUrl: adsCreatives.videoUrl,
        posterUrl: adsCreatives.posterUrl,
        adType: adsCreatives.adType,
        width: adsCreatives.width,
        height: adsCreatives.height,
        durationSeconds: adsMediaAssets.durationSeconds,
        destinationUrl: adsCreatives.destinationUrl,
        pricingModel: adsCampaigns.pricingModel,
        pricingVersion: adsCampaigns.pricingVersion,
        costPerImpressionUsdCents: adsCampaigns.costPerImpressionUsdCents,
        costPerClickUsdCents: adsCampaigns.costPerClickUsdCents,
        remainingBudgetUsdCents: adsCampaigns.remainingBudgetUsdCents,
        hourlyPacingUsdCents: adsCampaigns.hourlyPacingUsdCents,
        targetCountries: adsCampaigns.targetCountries,
        targetStates: adsCampaigns.targetStates,
        targetDevices: adsCampaigns.targetDevices,
        targetHours: adsCampaigns.targetHours,
        campaignGeoMode: adsCampaigns.geoMode,
        adStackId: adsCreatives.adStackId,
        stackGeoMode: adsCreativeStacks.geoMode,
        stackTargetDevices: adsCreativeStacks.targetDevices,
        stackTargetHours: adsCreativeStacks.targetHours,
        format: adsCreatives.adFormat,
      })
      .from(adsCampaigns)
      .innerJoin(adsCreatives, eq(adsCampaigns.id, adsCreatives.campaignId))
      .innerJoin(adsCreativeStacks, eq(adsCreatives.adStackId, adsCreativeStacks.id))
      .leftJoin(adsMediaAssets, eq(adsCreatives.mediaAssetId, adsMediaAssets.id))
      .where(
        and(
          eq(adsCampaigns.status, 'active'),
          eq(adsCampaigns.pricingVersion, 2),
          eq(adsCampaigns.moderationStatus, 'approved'),
          eq(adsCreatives.status, 'active'),
          eq(adsCreatives.reviewStatus, 'approved'),
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

    const requestedHandle = this.requestedPlacementHandle(token, isSlotCatalog);
    const allowedTypes = new Set(this.allowedAdTypes(requestedHandle));
    if (placement && !allowedTypes.has(((placement.adType || 'text') as 'text' | 'image' | 'video'))) {
      if (!isDirectBarterMode) throw new NotFoundException('This placement does not support the creative type.');
    }
    const eligibleCandidates = await this.filterEligibleCandidates(formattedCandidates, {
      ...clientGeo,
      device: clientGeo?.device || this.deviceFromUserAgent(userAgent),
    });
    const compatibleCandidates = eligibleCandidates.filter((candidate) =>
      allowedTypes.has((candidate.adType || 'text') as 'text' | 'image' | 'video'),
    );

    const auctionResult = this.auctionEngine.resolveAuction(compatibleCandidates, {
      slotHandle: requestedHandle,
      clientIp,
      clientDevice: (clientGeo?.device || this.deviceFromUserAgent(userAgent)) as
        | 'desktop' | 'android' | 'ios' | 'tablet' | undefined,
      clientGeoCountry: clientGeo?.country,
      clientGeoRegion: clientGeo?.region,
      clientGeoCity: clientGeo?.city,
    });

    if (!auctionResult && !placement) {
      throw new NotFoundException('No eligible ad creative available');
    }

    // Select the winning creative
    const winningCreative = auctionResult ? auctionResult.winner : placement!;
    const clearingPriceMicros = isDirectBarterMode && !allowHomeNetworkFill ? 0 : (auctionResult ? auctionResult.clearingPriceMicros : 0);
    const finalCampaignId = auctionResult ? auctionResult.winner.campaignId : placement!.campaignId;
    const finalCreativeId = auctionResult ? auctionResult.winner.creativeId : placement!.creativeId;
    const promoterId = placement?.promoterId || '00000000-0000-0000-0000-000000000000';
    const placementId = placement?.id || '00000000-0000-0000-0000-000000000000';

    const ipHash = this.tokenService.hashIp(clientIp);

    // Record immutable ads_serves record for the auction allocation
    const [serve] = await this.db
      .insert(adsServes)
      .values({
        placementId: placement ? placement.id : null,
        campaignId: finalCampaignId,
        creativeId: finalCreativeId,
        promoterId: placement ? placement.promoterId : null,
        slotHandle: isSlotCatalog ? token : 'cf_slot_auto',
        clearingPriceMicros,
        pricingVersion: 2,
        billingPriceNanos: isDirectBarterMode && !allowHomeNetworkFill ? BigInt(0) : BigInt(auctionResult?.billingPriceNanos || 0),
        pricingModel: isDirectBarterMode && !allowHomeNetworkFill ? 'cpm' : (auctionResult ? auctionResult.winner.pricingModel : 'cpm'),
        ipHash,
        userAgentHash: userAgent ? this.tokenService.hashIp(userAgent) : null,
      })
      .returning();

    // Generate cryptographic signed impression token binding this serve
    const impToken = this.tokenService.generateToken({
      servedId: serve.id,
      placementId,
      campaignId: finalCampaignId,
      creativeId: finalCreativeId,
      promoterId,
      ipHash,
    });

    // Record interaction telemetry (money settlement runs in 30-min cron via PLAN-0002)
    await this.db
      .insert(adsInteractions)
      .values({
        placementId,
        promoterId,
        serveId: serve.id,
        type: 'impression',
        source: placement?.websiteId ? 'embed' : 'share_link',
        actorIp: clientIp,
        userAgent,
        referrer: referrerDomain,
        isValid: true,
      });

    const baseUrl = process.env.ADS_PUBLIC_URL || 'https://ads.crimfig.com';
    const clickUrl = `${baseUrl}/api/v1/delivery/go/${impToken}?pid=${promoterId}`;

    const adType = ((winningCreative as any).adType || ((winningCreative as any).videoUrl ? 'video' : (winningCreative as any).imageUrl ? 'image' : 'text')) as 'text' | 'image' | 'video';
    return {
      adType,
      format: (winningCreative as any).adFormat || (winningCreative as any).format || 'card',
      headline: winningCreative.headline,
      bodyText: winningCreative.bodyText,
      ctaText: winningCreative.ctaText,
      imageUrl: this.absoluteMediaUrl(winningCreative.imageUrl),
      videoUrl: this.absoluteMediaUrl((winningCreative as any).videoUrl),
      posterUrl: this.absoluteMediaUrl((winningCreative as any).posterUrl),
      width: (winningCreative as any).width || null,
      height: (winningCreative as any).height || null,
      durationSeconds: (winningCreative as any).durationSeconds || null,
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
    if (tokenPayload && !(await this.boundServe(tokenPayload))) {
      throw new NotFoundException('Click attribution does not match its ad serve');
    }
    if (!tokenPayload && token.startsWith('imp_')) throw new NotFoundException('Click token invalid or expired');
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
        verificationVersion: tokenPayload && validation.isValid ? 2 : 0,
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
    let signedPayload: ImpressionTokenPayload | undefined;

    // 1. If signed impToken is provided, decode cryptographic payload
    if (params.impToken) {
      const payload = this.tokenService.verifyToken(params.impToken, params.clientIp);
      if (!payload || !(await this.boundServe(payload))) return;
      if (payload) {
        signedPayload = payload;
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

    if (params.type === 'click') {
      const validation = this.fraudRules.validateClick({ placementId, clientIp: params.clientIp,
        userAgent: params.userAgent, tokenTimestampMs: signedPayload?.timestamp });
      isValid = validation.isValid; invalidReason = validation.reasonCode || null;
    }
    if (params.type === 'viewable_impression') {
      const [creative] = signedPayload ? await this.db.select({ adType: adsCreatives.adType, format: adsCreatives.adFormat }).from(adsCreatives)
        .where(eq(adsCreatives.id, signedPayload.creativeId)).limit(1) : [];
      const minimum = creative?.adType === 'video' || creative?.format === 'video' ? 2 : 1;
      if (!creative || !Number.isFinite(params.visibleRatio) || params.visibleRatio! < 0.5 || params.visibleRatio! > 1 ||
        !Number.isFinite(params.durationSeconds) || params.durationSeconds! < minimum || params.durationSeconds! > 900) {
        isValid = false; invalidReason = 'VIEWABILITY_THRESHOLD';
      }
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
      verificationVersion: signedPayload && isValid ? 2 : 0,
      isValid,
      invalidReason,
    });
  }
}
