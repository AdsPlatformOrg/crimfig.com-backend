import {DeliveryDeadlineError,DELIVERY_RUNTIME,requireDeliveryTime,withinDeliveryBudget} from './delivery-budgets';
import {EvidenceService} from './evidence.service';
import {OpportunityClient} from '../billing/opportunity-client';
import {adDigest,approvedAdPolicy,stableAdValue} from '@crimfig/shared';
import { currentApproval } from '../campaigns/campaign-workflow';
import { paidDeliveryReadiness } from './paid-delivery-policy';
import { selectImageRendition } from '../uploads/prepared-image';
import { resolvedSchedule, scheduleMatches } from '../campaigns/daily-schedule';
import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
  Logger,
  Optional,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import {
  adsPlacements,
  adsCampaigns,
  adsCreatives,
  adsInteractions,
  adsPromoterWebsites,
  adsPromoters,
  adstationSlots,
  adsEmbedRunAudits,
  adsServes,
  adsMediaAssets,
  adsCreativeStacks,
  adsAuctionDecisions,
  adsOpportunityReservations,
  crimfigGeoTargets,
} from '@crimfig/database/schema';
import { eq, sql, and, or, inArray } from 'drizzle-orm';
import {
  ImpressionTokenService,
  ImpressionTokenPayload,
} from './impression-token.service';
import { AuctionEngineService } from './auction-engine.service';
import { FraudRulesService } from '../verification/fraud-rules.service';
import { DEFAULT_AUCTION_POLICY_VERSION } from './pricing-contract';

export const HOUSE_CAMPAIGN_UUID = '00000000-0000-4000-8000-00000000cf01';
export const HOUSE_CREATIVE_UUID = '00000000-0000-4000-8000-00000000cf02';
export const HOUSE_PLACEMENT_UUID = '00000000-0000-4000-8000-00000000cf03';

export const CRIMFIG_HOUSE_CREATIVE = {
  campaignId: HOUSE_CAMPAIGN_UUID,
  creativeId: HOUSE_CREATIVE_UUID,
  adType: 'text' as const,
  format: 'banner',
  headline: 'Advertise or Monetize with CrimFig Ads',
  bodyText:
    'Reach verified audiences across Websites, Reels & Mobile Apps with transparent pricing and instant escrow protection.',
  ctaText: 'Explore CrimFig Ads',
  imageUrl: null,
  videoUrl: null,
  posterUrl: null,
  width: 728,
  height: 90,
  durationSeconds: null,
  destinationUrl: 'https://ads.crimfig.com',
};

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

const VIDEO_PLACEMENTS = new Set([
  'in_content_mid',
  'in_content_end',
  'listing_interstitial',
]);

function videoDeliveryEnabled(): boolean {
  return (
    (process.env.CREATIVE_VIDEO_AUTHORING_ENABLED || 'false').toLowerCase() ===
    'true'
  );
}

export function extractHostnameFromHeader(
  rawUrlOrDomain?: string,
): string | null {
  if (!rawUrlOrDomain) return null;
  const trimmed = rawUrlOrDomain.trim();
  if (!trimmed) return null;
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      return new URL(trimmed).hostname.toLowerCase().replace(/^www\./, '');
    }
    return trimmed
      .toLowerCase()
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '')
      .replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function domainMatchesRegisteredSite(
  registeredDomain: string,
  candidateHost: string | null,
): boolean {
  if (!candidateHost) return false;
  const reg = registeredDomain.toLowerCase().replace(/^www\./, '');
  const host = candidateHost.toLowerCase().replace(/^www\./, '');
  return host === reg || host.endsWith(`.${reg}`);
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
    @Optional() private readonly opportunities?:OpportunityClient,
    @Optional() private readonly evidence?:EvidenceService,
  ) {}

  private publicBaseUrl(): string {
    return (process.env.ADS_PUBLIC_URL || 'https://ads.crimfig.com').replace(
      /\/+$/,
      '',
    );
  }

  /** Media is served by the Ads API itself; reject unrelated or relative external paths. */
  private absoluteMediaUrl(value: string | null | undefined): string | null {
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith('/api/v1/uploads/media/'))
      return `${this.publicBaseUrl()}${value}`;
    return null;
  }

  private requestedPlacementHandle(
    token: string,
    isSlotCatalog: boolean,
  ): string {
    if (isSlotCatalog) return SLOT_HANDLE_BY_ID[token] || 'unknown';
    return 'in_content_mid';
  }

  private allowedAdTypes(handle: string): Array<'text' | 'image' | 'video'> {
    if (videoDeliveryEnabled() && VIDEO_PLACEMENTS.has(handle))
      return ['text', 'image', 'video'];
    return ['text', 'image'];
  }

  /** A valid signature is necessary but never sufficient: bind every identity to its stored serve. */
  private async boundServe(payload: ImpressionTokenPayload): Promise<boolean> {
    const [serve] = await this.db
      .select()
      .from(adsServes)
      .where(eq(adsServes.id, payload.servedId))
      .limit(1);
    if (!serve) return false;

    const placementMatches =
      serve.placementId === payload.placementId ||
      (!serve.placementId && payload.placementId === HOUSE_PLACEMENT_UUID);

    return (
      placementMatches &&
      ((serve.inventoryClass==='house'||serve.inventoryClass==='shadow') ? !serve.campaignId&&!serve.creativeId&&payload.campaignId===HOUSE_CAMPAIGN_UUID&&payload.creativeId===HOUSE_CREATIVE_UUID&&serve.billingPriceNanos===0n : serve.campaignId===payload.campaignId&&serve.creativeId===payload.creativeId) &&
      (serve.promoterId === payload.promoterId || !serve.promoterId) &&
      serve.ipHash === payload.ipHash &&
      serve.servedAt.getTime() <= payload.timestamp &&
      payload.timestamp - serve.servedAt.getTime() <= 60_000
    );
  }

  /**
   * Return client-side embed.js / pub-loader.js script code.
   * Fixes G06 (`apiBase` ReferenceError across `resolvedMedia` and `trackViewability`,
   * top-level `document.currentScript` capture, single-initialization guard,
   * `data-ad-slot` + `data-cf-placement` compatibility, render receipt beacon,
   * and visibility/focus viewability gating).
   */
  getEmbedScript(): string {
    const defaultBase = this.publicBaseUrl();
    return `(function() {
  var currentScript = typeof document !== 'undefined' ? document.currentScript : null;
  var apiBase = ${JSON.stringify(defaultBase)};
  if (currentScript && currentScript.src) {
    apiBase = currentScript.src.replace(/\\/api\\/v1\\/delivery\\/(embed|pub-loader)\\.js.*/, '') || apiBase;
  }

  function resolvedMedia(value, baseOverride) {
    var base = baseOverride || apiBase;
    if (!value) return '';
    if (/^https?:\\/\\//i.test(value)) return value;
    if (value.charAt(0) === '/' && value.indexOf('/api/v1/uploads/media/') === 0) return base + value;
    return '';
  }

  if (typeof window !== 'undefined' && window.__cfLoaderV2) { window.__cfLoaderV2.scan(); return; }
  var instances = new Map(), lazySlots=new Map();
  function eventIdentity() { return window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : undefined; }
  function sendRenderBeacon(ad, baseOverride) {
    if (!ad || !ad.impToken || typeof fetch !== 'function') return;
    fetch((baseOverride || apiBase) + '/api/v1/delivery/interaction', {
      method:'POST', credentials:'omit', keepalive:true, headers:{'Content-Type':'application/json'},
      body:JSON.stringify({eventId:eventIdentity(),occurredAt:new Date().toISOString(),impToken:ad.impToken,type:'render',source:'embed'})
    }).catch(function() {});
  }
  function trackViewability(container, ad, minSeconds, baseOverride) {
    if (!ad || !ad.impToken || !('IntersectionObserver' in window)) return;
    var sent=false, timer=null, ratio=0, startedAt=0;
    function clear(){if(timer)clearTimeout(timer);timer=null;startedAt=0;}
    function visible(){
      if(!container.isConnected || document.visibilityState!=='visible' || (document.hasFocus&&!document.hasFocus()) || ratio<0.5)return false;
      var rect=container.getBoundingClientRect();
      var x=Math.max(0,Math.min(window.innerWidth-1,rect.left+rect.width/2));
      var y=Math.max(0,Math.min(window.innerHeight-1,rect.top+rect.height/2));
      var top=document.elementFromPoint?document.elementFromPoint(x,y):null;
      return !top || top===container || container.contains(top);
    }
    function update(){
      if(sent)return;
      if(!visible()){clear();return;}
      if(timer)return;
      startedAt=Date.now();
      timer=setTimeout(function(){
        timer=null;if(!visible()){clear();return;}sent=true;
        fetch((baseOverride||apiBase)+'/api/v1/delivery/viewability',{
          method:'POST',credentials:'omit',keepalive:true,headers:{'Content-Type':'application/json'},
          body:JSON.stringify({eventId:eventIdentity(),occurredAt:new Date().toISOString(),impToken:ad.impToken,visibleRatio:ratio,durationSeconds:(Date.now()-startedAt)/1000,format:ad.format||undefined})
        }).catch(function(){});cleanup();
      },minSeconds*1000);
    }
    var observer=new window.IntersectionObserver(function(entries){entries.forEach(function(entry){ratio=entry.intersectionRatio;update();});},{threshold:[0,0.5,1]});
    var poll=setInterval(update,200);
    function cleanup(){clear();clearInterval(poll);observer.disconnect();document.removeEventListener('visibilitychange',changed);window.removeEventListener('blur',changed);window.removeEventListener('focus',update);}
    function changed(){clear();update();}
    observer.observe(container);document.addEventListener('visibilitychange',changed);window.addEventListener('blur',changed);window.addEventListener('focus',update);
    container.__cfCleanup=cleanup;
  }
  function dispose(element){
    var lazy=lazySlots.get(element);if(lazy){lazy.disconnect();lazySlots.delete(element);}
    var state=instances.get(element);if(state){state.closed=true;state.controller.abort();clearTimeout(state.timer);instances.delete(element);}
    element.querySelectorAll('*').forEach(function(child){if(child.__cfCleanup)child.__cfCleanup();if(child.tagName==='VIDEO')child.pause();});
  }
  function requestSlot(element,token,base,consent){
    if(instances.has(element)||lazySlots.has(element))return;
    if('IntersectionObserver' in window && element.getBoundingClientRect().top>window.innerHeight+200){
      var lazy=new IntersectionObserver(function(entries){if(entries.some(function(e){return e.isIntersecting;})){lazy.disconnect();lazySlots.delete(element);requestSlot(element,token,base,consent);}},{rootMargin:'200px'});
      lazySlots.set(element,lazy);lazy.observe(element);return;
    }
    var state={generation:eventIdentity(),closed:false,controller:new AbortController(),timer:null};instances.set(element,state);
    element.style.minHeight=element.style.minHeight||'90px';element.style.display='block';
    state.timer=setTimeout(function(){state.closed=true;state.controller.abort();element.setAttribute('data-cf-state','unavailable');},15000);
    var query='?domain='+encodeURIComponent(window.location.hostname)+'&consent='+(consent==='granted'?'granted':'unknown');
    fetch(base+'/api/v1/delivery/ad/'+encodeURIComponent(token)+query,{credentials:'omit',signal:state.controller.signal,headers:{Accept:'application/json'}})
      .then(function(res){if(!res.ok)throw new Error('Ad unavailable');return res.json();})
      .then(function(data){if(state.closed||instances.get(element)!==state||!element.isConnected)return;
        clearTimeout(state.timer);state.closed=true;
        if(data&&data.data){renderAdCard(element,data.data,'publisher_network',base);element.setAttribute('data-cf-state','rendered');}
        else element.setAttribute('data-cf-state','unavailable');})
      .catch(function(){clearTimeout(state.timer);if(instances.get(element)===state){state.closed=true;element.setAttribute('data-cf-state','unavailable');}});
  }
  function initSlots(){
    if(typeof document==='undefined'||typeof window==='undefined')return;
    instances.forEach(function(state,element){if(!element.isConnected)dispose(element);});
    lazySlots.forEach(function(observer,element){if(!element.isConnected)dispose(element);});
    document.querySelectorAll('ins.crimfig-pub-slot').forEach(function(slot){
      var token=slot.getAttribute('data-ad-slot')||slot.getAttribute('data-cf-placement');
      if(token)requestSlot(slot,token,slot.getAttribute('data-cf-api-base')||apiBase,slot.getAttribute('data-cf-consent'));
    });
    document.querySelectorAll('script[data-placement]').forEach(function(script){
      var token=script.getAttribute('data-placement');var container=document.getElementById('cf-ad-'+token);
      if(token&&container)requestSlot(container,token,apiBase,script.getAttribute('data-cf-consent'));
    });
  }

  function renderAdCard(container, ad, mode, slotApiBase) {
    var activeBase = slotApiBase || apiBase;
    var card = document.createElement('div');
    card.style.cssText = "border:1px solid rgba(255,255,255,0.08);background:#171B2A;color:#FFFFFF;border-radius:12px;padding:16px;font-family:'Poppins',Arial,Helvetica,sans-serif;max-width:100%;box-shadow:0 10px 25px rgba(0,0,0,0.3);position:relative;overflow:hidden;box-sizing:border-box;margin:12px 0;";

    var badge = document.createElement('div');
    badge.style.cssText = 'font-size:10px;text-transform:uppercase;color:#94a3b8;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;letter-spacing:0.05em;';
    var badgeLeft = document.createElement('span');
    badgeLeft.textContent = ad.isHouseAd ? 'CrimFig House Ad' : (mode === 'owned_site_direct' ? 'Direct Partner' : 'Promoted');
    var badgeRight = document.createElement('span');
    badgeRight.textContent = 'CrimFig Ads';
    badgeRight.style.cssText = 'font-weight:700;color:#D4143A;';
    badge.appendChild(badgeLeft);
    badge.appendChild(badgeRight);
    card.appendChild(badge);

    var videoSource = ad.adType === 'video' ? resolvedMedia(ad.videoUrl, activeBase) : '';
    if (videoSource) {
      var videoWrap = document.createElement('div');
      videoWrap.style.cssText = 'position:relative;margin-bottom:12px;';
      var video = document.createElement('video');
      video.src = videoSource;
      if (ad.posterUrl) video.poster = resolvedMedia(ad.posterUrl, activeBase);
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
        var videoObserver=new window.IntersectionObserver(function(entries) {
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
        }, { threshold: [0, 0.5] });videoObserver.observe(videoWrap);videoWrap.__cfCleanup=function(){videoObserver.disconnect();video.pause();};
      } else if (!reduced) {
        started = true;
        play.style.display = 'none';
        video.play().catch(function() { started = false; play.style.display = 'block'; });
      }
      card.appendChild(videoWrap);
    } else if (ad.imageUrl && resolvedMedia(ad.imageUrl, activeBase)) {
      var img = document.createElement('img');
      img.src = resolvedMedia(ad.imageUrl, activeBase);
      img.alt = ad.headline || 'Advertisement';
      img.style.cssText = 'width:100%;height:auto;object-fit:contain;border-radius:8px;margin-bottom:12px;display:block;';
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
    sendRenderBeacon(ad, activeBase);
    function engagement(type){fetch(activeBase+'/api/v1/delivery/interaction',{method:'POST',credentials:'omit',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify({eventId:eventIdentity(),occurredAt:new Date().toISOString(),impToken:ad.impToken,type:type,source:'embed'})}).catch(function(){});}
    card.addEventListener('pointerenter',function(){engagement('hover');},{once:true});
    card.addEventListener('pointerdown',function(event){if(event.pointerType==='touch')engagement('touch');},{once:true});
    trackViewability(card, ad, ad.adType === 'video' ? 2 : 1, activeBase);
  }

  if (typeof window !== 'undefined') {
    window.__cfLoaderV2={scan:initSlots,refresh:function(element){if(!element)return;dispose(element);element.replaceChildren();initSlots();}};
    var scheduled=false;
    new MutationObserver(function(){if(!scheduled){scheduled=true;setTimeout(function(){scheduled=false;initSlots();},100);}}).observe(document.documentElement,{childList:true,subtree:true});
    window.addEventListener('pagehide',function(){instances.forEach(function(state,element){dispose(element);});});
    window.addEventListener('pageshow',initSlots);
    window.cfPubQ = window.cfPubQ || [];
    if (!window.__cfPubLoaderBound) {
      window.__cfPubLoaderBound = true;
      var origPush = window.cfPubQ.push;
      window.cfPubQ.push = function() {
        var res = origPush.apply(window.cfPubQ, arguments);
        initSlots();
        return res;
      };
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initSlots);
    } else {
      initSlots();
    }
  }
})();`;
  }

  private parseStringArray(value: string | null | undefined): string[] {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((item) => typeof item === 'string')
        : [];
    } catch {
      return [];
    }
  }

  private parseNumberArray(value: string | null | undefined): number[] {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((item) => typeof item === 'number')
        : [];
    } catch {
      return [];
    }
  }

  private regionMatches(target: string, client: string): boolean {
    const a = target.toUpperCase();
    const b = client.toUpperCase();
    return a === b || a.endsWith(`-${b}`) || b.endsWith(`-${a}`);
  }

  private deviceFromUserAgent(
    userAgent?: string,
  ): 'desktop' | 'android' | 'ios' | 'tablet' | undefined {
    if (!userAgent) return undefined;
    const value = userAgent.toLowerCase();
    if (/ipad|tablet/.test(value)) return 'tablet';
    if (/iphone|ipod/.test(value)) return 'ios';
    if (/android/.test(value))
      return /mobile/.test(value) ? 'android' : 'tablet';
    if (/mozilla|chrome|safari|firefox|edg/.test(value)) return 'desktop';
    return undefined;
  }

  /**
   * Apply canonical campaign/stack targeting and effective device/daypart
   * overrides before auction scoring. Unknown client geography fails closed.
   */
  private async filterEligibleCandidates(
    candidates: any[],
    clientGeo?: {
      country?: string;
      region?: string;
      city?: string;
      device?: string;
    },
  ): Promise<any[]> {
    if (candidates.length === 0) return [];
    const campaignIds = [
      ...new Set(candidates.map((candidate) => candidate.campaignId)),
    ];
    const stackIds = [
      ...new Set(
        candidates.map((candidate) => candidate.adStackId).filter(Boolean),
      ),
    ];
    const targetConditions = [
      and(
        eq(crimfigGeoTargets.ownerType, 'campaign'),
        inArray(crimfigGeoTargets.ownerId, campaignIds),
      ),
    ];
    if (stackIds.length > 0) {
      targetConditions.push(
        and(
          eq(crimfigGeoTargets.ownerType, 'stack'),
          inArray(crimfigGeoTargets.ownerId, stackIds),
        ) as any,
      );
    }
    const targetRows = await this.db
      .select()
      .from(crimfigGeoTargets)
      .where(
        targetConditions.length === 1
          ? targetConditions[0]
          : or(...targetConditions),
      );
    const targetsByOwner = new Map<string, typeof targetRows>();
    for (const row of targetRows) {
      const key = `${row.ownerType}:${row.ownerId}`;
      const list = targetsByOwner.get(key) || [];
      list.push(row);
      targetsByOwner.set(key, list);
    }

    const effectiveTargets = (candidate: any) => {
      const stackMode = candidate.stackGeoMode || 'inherit';
      const geoMode =
        stackMode === 'inherit'
          ? candidate.campaignGeoMode || 'global'
          : stackMode;
      if (geoMode === 'global')
        return { geoMode, rows: [] as typeof targetRows };
      const owner =
        stackMode === 'targeted'
          ? `stack:${candidate.adStackId}`
          : `campaign:${candidate.campaignId}`;
      return { geoMode, rows: targetsByOwner.get(owner) || [] };
    };

    return candidates.filter((candidate) => {
      const targeting = effectiveTargets(candidate);
      const countries =
        targeting.geoMode === 'targeted'
          ? [
              ...new Set(
                targeting.rows.flatMap((row) =>
                  this.parseStringArray(row.resolvedCountries),
                ),
              ),
            ]
          : this.parseStringArray(candidate.targetCountries);
      const subdivisions =
        targeting.geoMode === 'targeted'
          ? [
              ...new Set(
                targeting.rows.flatMap((row) =>
                  this.parseStringArray(row.resolvedSubdivisions),
                ),
              ),
            ]
          : this.parseStringArray(candidate.targetStates);
      const cities =
        targeting.geoMode === 'targeted'
          ? [
              ...new Set(
                targeting.rows.flatMap((row) =>
                  this.parseStringArray(row.resolvedCities),
                ),
              ),
            ]
          : [];
      if (targeting.geoMode === 'targeted' && targeting.rows.length === 0)
        return false;
      if (
        countries.length > 0 &&
        (!clientGeo?.country ||
          !countries
            .map((c) => c.toUpperCase())
            .includes(clientGeo.country.toUpperCase()))
      ) {
        return false;
      }
      if (subdivisions.length > 0) {
        if (
          !clientGeo?.region ||
          !subdivisions.some((value) =>
            this.regionMatches(value, clientGeo.region!),
          )
        )
          return false;
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
        } else if (
          !devices.includes(device) &&
          !(device === 'android' || device === 'ios'
            ? devices.includes('mobile')
            : false)
        ) {
          return false;
        }
      }
      try {
        candidate.schedule = resolvedSchedule(
          candidate.campaignSchedule,
          candidate.stackSchedule,
          candidate.targetHours,
          candidate.stackTargetHours,
        );
        candidate.scheduleValidated = true;
      } catch {
        this.logger.warn('Invalid stored campaign schedule excluded');
        return false;
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

  /**
   * Builds and persists a zero-charge CrimFig House Ad or Shadow Ad response (`PLAN-0047`).
   * Invariant: billingPriceNanos = 0n, clearingPriceMicros = 0, financialEligibility = 'invalid'.
   * Never debits advertiser budgets or credits promoter earnings/points.
   */
  private async serveHouseOrShadowAd(params: {
    requestId: string;
    serveBefore?:number;
    parentOpportunityId?:string;
    slotTagId: string;
    slotId: string | null;
    websiteId: string | null;
    promoterId: string;
    placementId: string | null;
    format: string;
    inventoryClass: 'house' | 'shadow';
    deliveryMode: 'normal' | 'shadow';
    trafficRiskStatus: 'normal' | 'suspicious' | 'high_risk' | 'confirmed_fraud';
    clientIp?: string;
    userAgent?: string;
    referrerDomain?: string;
    clientGeo?: { country?: string; region?: string; device?: string };
  }) {
    const ipHash = this.tokenService.hashIp(params.clientIp);
    const tieSeed = `${params.requestId}:${params.slotTagId}`;
    const decisionDraft = {
      requestId: params.requestId,
      slotHandle: params.slotTagId,
      policyVersion: DEFAULT_AUCTION_POLICY_VERSION,
      bidderGroupingMode: 'advertiser' as const,
      tieSeed,
      candidateCount: 0,
      eligibleGroupCount: 0,
      evaluatedCandidates: [],
      excludedCandidates: [],
      winnerCampaignId: null,
      winnerCreativeId: null,
      runnerUpCampaignId: null,
      pricingModel: 'cpm' as const,
      clearingPriceMicros: 0,
      billingPriceNanos: 0n,
      secondPriceMicros: 0,
      winnerScoreMicros: 0,
      previousHash: null,
    };
    const recordHash = this.auctionEngine.computeDecisionHash(decisionDraft);

    const {serveId,decisionId}=await this.db.transaction(async tx=>{
      if(params.serveBefore)requireDeliveryTime(params.serveBefore,'default_commit');
      await tx.execute(sql`set local lock_timeout='5s'`);await tx.execute(sql`set local statement_timeout='8s'`);
      if(params.slotId){
        const [supply]=await tx.select({slot:adstationSlots,site:adsPromoterWebsites,promoter:adsPromoters}).from(adstationSlots)
          .innerJoin(adsPromoterWebsites,eq(adsPromoterWebsites.id,adstationSlots.websiteId)).innerJoin(adsPromoters,eq(adsPromoters.id,adstationSlots.promoterId)).where(eq(adstationSlots.id,params.slotId)).for('share').limit(1);
        if(!supply||supply.promoter.id!==params.promoterId||supply.site.id!==params.websiteId||supply.site.promoterId!==params.promoterId||!supply.slot.isActive||!['testing','installation_pending','active'].includes(supply.slot.lifecycleStatus)||!supply.site.isActive||supply.site.isSuspended||supply.site.verificationStatus!=='verified'||!supply.site.verificationExpiresAt||supply.site.verificationExpiresAt<=new Date()||!['testing','pending_approval','approved'].includes(supply.site.policyStatus)||!supply.promoter.isActive||supply.promoter.isSuspended)throw new ForbiddenException('Ad delivery is unavailable');
        const [owner]=await tx.select({status:schema.users.status}).from(schema.users).where(eq(schema.users.id,supply.promoter.userId)).for('share').limit(1);
        if(owner?.status!=='ACTIVE')throw new ForbiddenException('Ad delivery is unavailable');
        const controls=await tx.execute(sql`SELECT 1 FROM ads_traffic_controls WHERE is_active AND (expires_at IS NULL OR expires_at>now()) AND ((target_scope='slot' AND target_id=${params.slotId}) OR(target_scope='website' AND target_id=${params.websiteId}) OR(target_scope='promoter' AND target_id=${params.promoterId})) LIMIT 1`);
        if(controls.rows.length){params.inventoryClass='shadow';params.deliveryMode='shadow';params.trafficRiskStatus='suspicious';}
      }
      const [decision]=await tx.insert(adsAuctionDecisions).values({
          requestId: params.requestId,
          promoterId: params.promoterId,
          websiteId: params.websiteId,
          slotId: params.slotId,
          slotTagId: params.slotTagId,
          inventoryClass: params.inventoryClass,
          deliveryMode: params.deliveryMode,
          trafficRiskStatus: params.trafficRiskStatus,
          financialEligibility: 'invalid',
          policyVersion: DEFAULT_AUCTION_POLICY_VERSION,
          bidderGroupingMode: 'advertiser',
          tieSeed,
          candidateCount: 0,
          eligibleGroupCount: 0,
          evaluatedCandidates: [],
          excludedCandidates: [],
          winnerCampaignId: null,
          winnerCreativeId: null,
          runnerUpCampaignId: null,
          pricingModel: 'cpm',
          clearingPriceMicros: 0,
          billingPriceNanos: 0n,
          recordHash,
        })
.returning({id:adsAuctionDecisions.id});
      if(!decision?.id)throw new Error('House decision could not be recorded');
      const decisionId=decision.id;
      const [serve]=await tx.insert(adsServes).values({
          placementId: params.placementId,
          campaignId: null,
          creativeId: null,
          promoterId: params.promoterId,
          slotHandle: params.slotTagId,
          requestId: params.requestId,
          websiteId: params.websiteId,
          slotId: params.slotId,
          inventoryClass: params.inventoryClass,
          deliveryMode: params.deliveryMode,
          trafficRiskStatus: params.trafficRiskStatus,
          financialEligibility: 'invalid',
          auctionDecisionId: decisionId,
          policyVersion: DEFAULT_AUCTION_POLICY_VERSION,
          clearingPriceMicros: 0,
          pricingVersion: 2,
          billingPriceNanos: 0n,
          pricingModel: 'cpm',
          ipHash,
          userAgentHash: params.userAgent
            ? this.tokenService.hashIp(params.userAgent)
            : null,
          geoCountry: params.clientGeo?.country || null,
          geoRegion: params.clientGeo?.region || null,
          deviceType: params.clientGeo?.device || null,
        })
.returning({id:adsServes.id});
      if(!serve?.id)throw new Error('House serve could not be recorded');
      await tx.update(adsAuctionDecisions).set({serveId:serve.id}).where(eq(adsAuctionDecisions.id,decisionId));
      if(!this.evidence)throw new Error('Durable decision recording is unavailable');
      await this.evidence.append(params.requestId,{version:1,stage:'issued',serveId:serve.id,inventoryClass:params.inventoryClass,deliveryMode:params.deliveryMode,slotId:params.slotId,websiteId:params.websiteId,decisionId,parentOpportunityId:params.parentOpportunityId??null,runtimeVersion:DELIVERY_RUNTIME.version,decision:stableAdValue(decisionDraft)},tx);
      if(params.serveBefore)requireDeliveryTime(params.serveBefore,'default_commit');
      return {serveId:serve.id,decisionId};
    });

    const tokenPlacementId = params.placementId || HOUSE_PLACEMENT_UUID;
    const impToken = this.tokenService.generateToken({
      servedId: serveId,
      placementId: tokenPlacementId,
      campaignId: HOUSE_CAMPAIGN_UUID,
      creativeId: HOUSE_CREATIVE_UUID,
      promoterId: params.promoterId,
      ipHash,
    });

    const baseUrl = this.publicBaseUrl();
    const clickUrl = `${baseUrl}/api/v1/delivery/go/${impToken}?pid=${params.promoterId}`;

    return {
      adType: CRIMFIG_HOUSE_CREATIVE.adType,
      format: params.format || CRIMFIG_HOUSE_CREATIVE.format,
      headline: CRIMFIG_HOUSE_CREATIVE.headline,
      bodyText: CRIMFIG_HOUSE_CREATIVE.bodyText,
      ctaText: CRIMFIG_HOUSE_CREATIVE.ctaText,
      imageUrl: null,
      videoUrl: null,
      posterUrl: null,
      width: CRIMFIG_HOUSE_CREATIVE.width,
      height: CRIMFIG_HOUSE_CREATIVE.height,
      durationSeconds: null,
      isHouseAd: params.inventoryClass === 'house',
      impToken,
      clickUrl,
    };
  }

  /**
   * Serve creative asset and log audit ping (`GET /api/v1/delivery/ad/:placementToken`).
   * Enforces:
   * - Supply Admission (`G01`, `G03`): Rejects unknown or unverified/suspended slots/sites,
   *   validates domain match against registered website domain, and ignores client `mode`/`fill` overrides.
   * - Zero-Charge House Ad & Shadow Serving (`G04`, `A19`, `A20`): Serves CrimFig House Ad when
   *   website/slot is in `testing`, when traffic risk is suspicious/high_risk, or when no paid campaign fills.
   * - Unlimited Candidate Evaluation & Tamper-Evident Decision Audit (`G02`, `PLAN-0049`):
   *   Evaluates all eligible active campaigns (no `.limit(20)` truncation) and records an immutable decision snapshot.
   */
  async getAdForPlacement(
    token: string,
    clientIp?: string,
    userAgent?: string,
    referrerDomain?: string,
    _ignoredClientMode?: string,
    _ignoredClientFill?: boolean,
    clientGeo?: {
      country?: string;
      region?: string;
      city?: string;
      device?: string;
    },
    requestHeaders?: { origin?: string; referer?: string;measurementConsent?:boolean },
  ) {
    this.tokenService.assertConfigured();
    const requestId = crypto.randomUUID();
    const serverDeadline=Date.now()+DELIVERY_RUNTIME.serverMs;
    let canonicalSlot:any=null,canonicalWebsite:any=null,canonicalPromoter:any=null;
    try {
    const isSlotCatalog = token.startsWith('cf_slot_');

    // Reject unowned shared catalog slot IDs (`cf_slot_0001`..`cf_slot_0010`) on public delivery (`G01`)
    if (isSlotCatalog) {
      throw new ForbiddenException(
        'Shared slot catalog handles cannot serve ads directly. Register and verify your website in AdStation to create a canonical slot tag.',
      );
    }

    // 1. Check if token is a canonical AdStation slot (`adstation_slots.slotTagId`)


    if (token.startsWith('cf-slot-')) {
      const [slotRow] = await this.db
        .select({
          slot: adstationSlots,
          website: adsPromoterWebsites,
          promoter: adsPromoters,
        })
        .from(adstationSlots)
        .innerJoin(
          adsPromoterWebsites,
          eq(adstationSlots.websiteId, adsPromoterWebsites.id),
        )
        .innerJoin(
          adsPromoters,
          eq(adstationSlots.promoterId, adsPromoters.id),
        )
        .where(eq(adstationSlots.slotTagId, token))
        .limit(1);

      if (!slotRow) {
        throw new NotFoundException('Ad slot not found');
      }

      canonicalSlot = slotRow.slot;
      canonicalWebsite = slotRow.website;
      canonicalPromoter = slotRow.promoter;

      // Supply admission gates (`G01`):
      if (
        !canonicalPromoter.isActive ||
        canonicalPromoter.isSuspended ||
        !canonicalWebsite.isActive ||
        canonicalWebsite.isSuspended ||
        canonicalWebsite.verificationStatus !== 'verified' || !canonicalWebsite.verificationExpiresAt || canonicalWebsite.verificationExpiresAt<=new Date() ||
        canonicalWebsite.policyStatus === 'unverified' ||
        canonicalWebsite.policyStatus === 'rejected' ||
        canonicalWebsite.policyStatus === 'suspended'
      ) {
        throw new ForbiddenException(
          'This website is not verified or eligible for ad delivery.',
        );
      }

      if (
        !canonicalSlot.isActive ||
        ['paused', 'suspended', 'disabled', 'draft'].includes(
          canonicalSlot.lifecycleStatus,
        )
      ) {
        throw new ForbiddenException(
          `Ad slot "${canonicalSlot.slotTagId}" is currently ${canonicalSlot.lifecycleStatus}.`,
        );
      }

      // Enforce domain match against Origin / Referer / domain query parameter
      const headerHost =
        extractHostnameFromHeader(requestHeaders?.origin) ||
        extractHostnameFromHeader(requestHeaders?.referer) ||
        extractHostnameFromHeader(referrerDomain);

      if (
        !headerHost ||
        !domainMatchesRegisteredSite(canonicalWebsite.domain, headerHost)
      ) {
        throw new ForbiddenException(
          `Domain mismatch: slot "${canonicalSlot.slotTagId}" is bound exclusively to https://${canonicalWebsite.domain}.`,
        );
      }

      // Update website heartbeat timestamp
      await this.db
        .update(adsPromoterWebsites)
        .set({ embedPingLastAt: new Date() })
        .where(eq(adsPromoterWebsites.id, canonicalWebsite.id));

      const controls=await this.db.execute(sql`SELECT action FROM ads_traffic_controls WHERE is_active AND (expires_at IS NULL OR expires_at>now()) AND
        ((target_scope='slot' AND target_id=${canonicalSlot.id}) OR(target_scope='website' AND target_id=${canonicalWebsite.id}) OR(target_scope='promoter' AND target_id=${canonicalPromoter.id}))`);
      const restricted=controls.rows.length>0;
      // Evaluate supply-time traffic risk for shadow-serving protection
      const riskAssessment = this.fraudRules.assessSupplyRequestRisk({
        slotTagId: canonicalSlot.slotTagId,
        clientIp,
        userAgent,
        originOrRefererHost: headerHost,
        registeredDomain: canonicalWebsite.domain,
        trustScore: Math.min(
          canonicalPromoter.trustScore ?? 70,
          canonicalWebsite.trustScore ?? 70,
        ),
      });

      // If website or slot is in TESTING policy state, or if paid serving is not yet enabled,
      // or if traffic is flagged as suspicious/high_risk, serve a zero-charge CrimFig House/Shadow Ad.
      const paidServingEnabled = paidDeliveryReadiness().ready;
      const isTestingMode =
        canonicalWebsite.policyStatus === 'testing' ||
        canonicalWebsite.policyStatus === 'pending_approval' ||
        canonicalSlot.lifecycleStatus === 'testing' ||
        canonicalSlot.lifecycleStatus === 'installation_pending' ||
        !paidServingEnabled || restricted || requestHeaders?.measurementConsent!==true;
      const isShadowRisk = restricted || riskAssessment.trafficRiskStatus !== 'normal';

      if (isTestingMode || isShadowRisk) {
        return this.serveHouseOrShadowAd({serveBefore:serverDeadline,
          requestId,
          slotTagId: canonicalSlot.slotTagId,
          slotId: canonicalSlot.id,
          websiteId: canonicalWebsite.id,
          promoterId: canonicalPromoter.id,
          placementId: null,
          format: canonicalSlot.format || 'banner',
          inventoryClass: isShadowRisk ? 'shadow' : 'house',
          deliveryMode: isShadowRisk ? 'shadow' : 'normal',
          trafficRiskStatus: riskAssessment.trafficRiskStatus,
          clientIp,
          userAgent,
          referrerDomain: headerHost,
          clientGeo: {
            country: clientGeo?.country,
            region: clientGeo?.region,
            device: clientGeo?.device || this.deviceFromUserAgent(userAgent),
          },
        });
      }
    }

    // Legacy routes must obey the same release gate; a token cannot bypass the
    // missing distributed reservation authority by selecting a different path.
    if (!paidDeliveryReadiness().ready) throw new ForbiddenException('Paid ad delivery is not available. Verified canonical slots can serve CrimFig default ads.');

    // 2. Legacy / Share-Link Placement lookup (`ads_placements.placementToken`)
    let placement: any = null;
    if (!canonicalSlot) {
      const [foundPlacement] = await this.db
        .select({
          id: adsPlacements.id,
          promoterId: adsPlacements.promoterId,
          imageMaxBytes: adsPlacements.imageMaxBytes,
          campaignId: adsPlacements.campaignId,
          creativeId: adsPlacements.creativeId,
          websiteId: adsPlacements.websiteId,
          status: adsPlacements.status,
          campaignStatus: adsCampaigns.status,
          campaignModeration: adsCampaigns.moderationStatus,
          contentRevision: adsCampaigns.contentRevision,
          currentSubmissionId: adsCampaigns.currentSubmissionId,
          approvedSubmissionId: adsCampaigns.approvedSubmissionId,
          approvedRevision: adsCampaigns.approvedRevision,
          submissionIntentId: adsCampaigns.submissionIntentId,
          creativeReview: adsCreatives.reviewStatus,
          creativeStatus: adsCreatives.status,
          campaignSchedule: adsCampaigns.schedule,
          stackSchedule: adsCreativeStacks.schedule,
          campaignGeoMode: adsCampaigns.geoMode,
          stackGeoMode: adsCreativeStacks.geoMode,
          adStackId: adsCreatives.adStackId,
          targetHours: adsCampaigns.targetHours,
          stackTargetHours: adsCreativeStacks.targetHours,
          targetCountries: adsCampaigns.targetCountries,
          targetStates: adsCampaigns.targetStates,
          targetDevices: adsCampaigns.targetDevices,
          stackTargetDevices: adsCreativeStacks.targetDevices,
          remainingBudget: adsCampaigns.remainingBudgetUsdCents,
          headline: adsCreatives.headline,
          bodyText: adsCreatives.bodyText,
          ctaText: adsCreatives.ctaText,
          imageUrl: adsCreatives.imageUrl,
          preparation: adsMediaAssets.preparation,
          imageBytes: adsMediaAssets.bytes,
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
        .leftJoin(
          adsCreativeStacks,
          eq(adsCreatives.adStackId, adsCreativeStacks.id),
        )
        .leftJoin(
          adsMediaAssets,
          eq(adsCreatives.mediaAssetId, adsMediaAssets.id),
        )
        .where(eq(adsPlacements.placementToken, token))
        .limit(1);

      placement = foundPlacement;

      if (!placement) {
        throw new NotFoundException(
          'Ad placement unavailable or budget exhausted',
        );
      }

      if (
        placement.status !== 'active' ||
        placement.campaignStatus !== 'active' ||
        placement.remainingBudget <= 0
      ) {
        throw new NotFoundException(
          'Ad placement unavailable or budget exhausted',
        );
      }

      // If placement is bound to a website, verify website status and domain match (`G01`)
      if (placement.websiteId) {
        const [site] = await this.db
          .select()
          .from(adsPromoterWebsites)
          .where(eq(adsPromoterWebsites.id, placement.websiteId))
          .limit(1);

        if (
          !site ||
          !site.isActive ||
          site.isSuspended ||
          site.verificationStatus !== 'verified'
        ) {
          throw new ForbiddenException(
            'Promoter website is not verified or active for ad delivery',
          );
        }

        const headerHost =
          extractHostnameFromHeader(requestHeaders?.origin) ||
          extractHostnameFromHeader(requestHeaders?.referer) ||
          extractHostnameFromHeader(referrerDomain);

        if (
          headerHost &&
          !domainMatchesRegisteredSite(site.domain, headerHost)
        ) {
          throw new ForbiddenException(
            `Domain mismatch for placement on ${site.domain}`,
          );
        }

        await this.db
          .update(adsPromoterWebsites)
          .set({ embedPingLastAt: new Date() })
          .where(eq(adsPromoterWebsites.id, placement.websiteId));
      }
    }

    // Complete bounded candidate snapshot: exceeding capacity yields no-fill, never an auction over an arbitrary prefix.
    const candidateDeadline=Math.min(serverDeadline,Date.now()+DELIVERY_RUNTIME.candidateMs);
    const activeCandidates = await withinDeliveryBudget(this.db
      .select({
        campaignId: adsCampaigns.id,
        creativeId: adsCreatives.id,
        ownerId: adsCampaigns.advertiserId,
        category: adsCampaigns.category,
        startsAt: adsCampaigns.startsAt,
        endsAt: adsCampaigns.endsAt,
        frequencyCapPerDay: adsCampaigns.frequencyCapPerDay,
        headline: adsCreatives.headline,
        bodyText: adsCreatives.bodyText,
        ctaText: adsCreatives.ctaText,
        imageUrl: adsCreatives.imageUrl,
        preparation: adsMediaAssets.preparation,
        imageBytes: adsMediaAssets.bytes,
        videoUrl: adsCreatives.videoUrl,
        posterUrl: adsCreatives.posterUrl,
        adType: adsCreatives.adType,
        width: adsCreatives.width,
        height: adsCreatives.height,
        durationSeconds: adsMediaAssets.durationSeconds,
        destinationUrl: adsCreatives.destinationUrl,
        pricingModel: adsCampaigns.pricingModel,
        pricingVersion: adsCampaigns.pricingVersion,
        contentRevision: adsCampaigns.contentRevision,
        currentSubmissionId: adsCampaigns.currentSubmissionId,
        costPerImpressionUsdCents: adsCampaigns.costPerImpressionUsdCents,
        costPerClickUsdCents: adsCampaigns.costPerClickUsdCents,
        remainingBudgetUsdCents: adsCampaigns.remainingBudgetUsdCents,
        hourlyPacingUsdCents: adsCampaigns.hourlyPacingUsdCents,
        targetCountries: adsCampaigns.targetCountries,
        targetStates: adsCampaigns.targetStates,
        targetDevices: adsCampaigns.targetDevices,
        targetHours: adsCampaigns.targetHours,
        campaignSchedule: adsCampaigns.schedule,
        campaignGeoMode: adsCampaigns.geoMode,
        adStackId: adsCreatives.adStackId,
        stackGeoMode: adsCreativeStacks.geoMode,
        stackTargetDevices: adsCreativeStacks.targetDevices,
        stackTargetHours: adsCreativeStacks.targetHours,
        stackSchedule: adsCreativeStacks.schedule,
        format: adsCreatives.adFormat,
      })
      .from(adsCampaigns)
      .innerJoin(adsCreatives, eq(adsCampaigns.id, adsCreatives.campaignId))
      .innerJoin(
        adsCreativeStacks,
        eq(adsCreatives.adStackId, adsCreativeStacks.id),
      )
      .leftJoin(
        adsMediaAssets,
        eq(adsCreatives.mediaAssetId, adsMediaAssets.id),
      )
      .where(
        and(
          eq(adsCampaigns.status, 'active'),
          eq(adsCampaigns.pricingVersion, 2),
          eq(adsCampaigns.moderationStatus, 'approved'),
          sql`${adsCampaigns.currentSubmissionId} = ${adsCampaigns.approvedSubmissionId}`,
          sql`${adsCampaigns.contentRevision} = ${adsCampaigns.approvedRevision}`,
          sql`${adsCampaigns.submissionIntentId} IS NULL`,
          eq(adsCreatives.status, 'active'),
          eq(adsCreatives.reviewStatus, 'approved'),
          sql`${adsCampaigns.remainingBudgetUsdCents} > 0`,
        ),
      ).limit(2001),candidateDeadline,'candidate_fetch');
    if(activeCandidates.length>2000)throw new Error('CANDIDATE_CAPACITY_EXCEEDED');

    const formattedCandidates = activeCandidates.map((c) => ({
      ...c,
      pricingModel: (c.pricingModel || 'cpm') as 'cpm' | 'cpc',
      targetCountries: c.targetCountries ? JSON.parse(c.targetCountries) : null,
      targetStates: c.targetStates ? JSON.parse(c.targetStates) : null,
      targetDevices: c.targetDevices ? JSON.parse(c.targetDevices) : null,
      targetHours: c.targetHours ? JSON.parse(c.targetHours) : null,
    }));

    const requestedHandle = canonicalSlot
      ? canonicalSlot.slotTagId
      : this.requestedPlacementHandle(token, false);
    const allowedTypes = new Set(
      canonicalSlot?.allowedAdTypes
        ? this.parseStringArray(canonicalSlot.allowedAdTypes)
        : this.allowedAdTypes(requestedHandle),
    );
    if (allowedTypes.size === 0) {
      allowedTypes.add('text');
      allowedTypes.add('image');
    }

    if (
      placement &&
      !allowedTypes.has(
        (placement.adType || 'text') as 'text' | 'image' | 'video',
      )
    ) {
      throw new NotFoundException(
        'This placement does not support the creative type.',
      );
    }

    const resolvedDevice = (clientGeo?.device ||
      this.deviceFromUserAgent(userAgent)) as
      | 'desktop'
      | 'android'
      | 'ios'
      | 'tablet'
      | undefined;

    const eligibleCandidates = await withinDeliveryBudget(this.filterEligibleCandidates(
      formattedCandidates,
      {
        ...clientGeo,
        device: resolvedDevice,
      },
    ),candidateDeadline,'candidate_targeting');

    const requestedLayout = canonicalSlot
      ? canonicalSlot.format || 'banner'
      : requestedHandle.startsWith('banner_')
        ? 'banner'
        : 'card';
    const imageCap = Math.min(
      placement?.imageMaxBytes ?? 250000,
      requestedLayout === 'banner' ? 100000 : 300000,
    );

    const compatibleCandidates = eligibleCandidates.filter((candidate: any) => {
      if (!allowedTypes.has(candidate.adType || 'text')) return false;
      if (candidate.format !== requestedLayout && candidate.adType !== 'video')
        return false;
      if (candidate.adType === 'image') {
        const rendition = selectImageRendition(
          candidate,
          requestedLayout,
          imageCap,
        );
        if (!rendition) return false;
        candidate.imageUrl = rendition.url;
        candidate.width = rendition.width;
        candidate.height = rendition.height;
      }
      return true;
    });

    const allowedCategories = canonicalWebsite?.allowedCategories
      ? this.parseStringArray(canonicalWebsite.allowedCategories)
      : canonicalPromoter?.allowedCategories
        ? this.parseStringArray(canonicalPromoter.allowedCategories)
        : undefined;

    const auctionDeadline=Math.min(serverDeadline,Date.now()+DELIVERY_RUNTIME.auctionMs);
    requireDeliveryTime(auctionDeadline,'auction');
    const auctionResult = this.auctionEngine.resolveAuction(
      compatibleCandidates,
      {
        slotHandle: requestedHandle,
        requestId,
        policyVersion:approvedAdPolicy()?.version,
        bidderGroupingMode:approvedAdPolicy()?.bidderGrouping,
        promoterAllowedCategories:
          allowedCategories && allowedCategories.length > 0
            ? allowedCategories
            : undefined,
        clientIp,
        clientDevice: resolvedDevice,
        clientGeoCountry: clientGeo?.country,
        clientGeoRegion: clientGeo?.region,
        clientGeoCity: clientGeo?.city,
      },
    );

    requireDeliveryTime(auctionDeadline,'auction');
    // If canonical slot has no eligible paid campaign winner, fall back cleanly to zero-charge CrimFig House Ad (`G04`)
    if (!auctionResult && canonicalSlot) {
      return this.serveHouseOrShadowAd({serveBefore:serverDeadline,
        requestId,
        slotTagId: canonicalSlot.slotTagId,
        slotId: canonicalSlot.id,
        websiteId: canonicalWebsite.id,
        promoterId: canonicalPromoter.id,
        placementId: null,
        format: canonicalSlot.format || 'banner',
        inventoryClass: 'house',
        deliveryMode: 'normal',
        trafficRiskStatus: 'normal',
        clientIp,
        userAgent,
        referrerDomain,
        clientGeo: {
          country: clientGeo?.country,
          region: clientGeo?.region,
          device: resolvedDevice,
        },
      });
    }

    if (!auctionResult && !placement) {
      throw new NotFoundException('No eligible ad creative available');
    }

    if (!auctionResult && placement) {
      if (
        !currentApproval({
          ...placement,
          moderationStatus: placement.campaignModeration,
        }) ||
        placement.creativeReview !== 'approved' ||
        placement.creativeStatus !== 'active'
      )
        throw new NotFoundException(
          'This creative is not approved for delivery.',
        );
      const direct = await this.filterEligibleCandidates([placement], {
        ...clientGeo,
        device: resolvedDevice,
      });
      if (!direct.length || !scheduleMatches(direct[0].schedule, new Date()))
        throw new NotFoundException(
          'This placement is outside its effective schedule or targeting.',
        );
    }

    const winningCreative = auctionResult ? auctionResult.winner : placement!;
    if (
      (winningCreative as any).adType === 'image' &&
      winningCreative === placement
    ) {
      const rendition = selectImageRendition(
        winningCreative,
        (winningCreative as any).adFormat || 'card',
        Math.min((placement as any).imageMaxBytes ?? 250000, 300000),
      );
      if (!rendition)
        throw new NotFoundException(
          'No compatible image rendition for this placement.',
        );
      winningCreative.imageUrl = rendition.url;
      (winningCreative as any).width = rendition.width;
      (winningCreative as any).height = rendition.height;
    }

    // Never trust client mode/fill parameters to zero out paid campaign prices (`G03`)
    const clearingPriceMicros = auctionResult
      ? auctionResult.clearingPriceMicros
      : 0;
    const billingPriceNanos = BigInt(auctionResult?.billingPriceNanos || 0);
    const finalCampaignId = auctionResult
      ? auctionResult.winner.campaignId
      : placement!.campaignId;
    const finalCreativeId = auctionResult
      ? auctionResult.winner.creativeId
      : placement!.creativeId;
    const promoterId = canonicalPromoter
      ? canonicalPromoter.id
      : placement!.promoterId;
    const placementId = placement ? placement.id : HOUSE_PLACEMENT_UUID;
    const ipHash = this.tokenService.hashIp(clientIp);

    if(!canonicalSlot || !canonicalWebsite || !this.opportunities || !auctionResult)throw new ForbiddenException('Paid delivery requires canonical funded inventory');
    let serve:{id:string};
    try {
      const viewer=this.fraudRules.computeKeyedIpHash(clientIp).keyedIpHash;
      requireDeliveryTime(serverDeadline,'reserve');
      const receipt=await this.opportunities.reserve({serveBefore:new Date(serverDeadline).toISOString(),opportunityId:requestId,campaignId:finalCampaignId,creativeId:finalCreativeId,
        submissionId:(winningCreative as any).currentSubmissionId,contentRevision:(winningCreative as any).contentRevision,
        promoterId,websiteId:canonicalWebsite.id,slotId:canonicalSlot.id,policyVersion:approvedAdPolicy()!.version,
        priceNanos:billingPriceNanos.toString(),clearingPriceMicros,visitorKey:viewer,ipHash,selectedImageUrl:winningCreative.imageUrl??undefined,
        decision:stableAdValue(auctionResult.decisionSnapshot)});
      const issued=await this.opportunities.issue(receipt);serve={id:issued.serveId};
    } catch(error) {
      // Unknown remote outcomes retain their existing opportunity for reconciliation. Never locally release an issued token.
      return this.serveHouseOrShadowAd({serveBefore:serverDeadline,parentOpportunityId:requestId,requestId:crypto.randomUUID(),slotTagId:canonicalSlot.slotTagId,slotId:canonicalSlot.id,websiteId:canonicalWebsite.id,
        promoterId,placementId:null,format:canonicalSlot.format||'banner',inventoryClass:'house',deliveryMode:'normal',trafficRiskStatus:'normal',clientIp,userAgent,referrerDomain:canonicalWebsite.domain,clientGeo});
    }

    // Generate cryptographic signed impression token binding this serve
    const impToken = this.tokenService.generateToken({
      servedId: serve.id,
      placementId,
      campaignId: finalCampaignId,
      creativeId: finalCreativeId,
      promoterId,
      ipHash,
    });

    const { keyedIpHash, keyId } = this.fraudRules.computeKeyedIpHash(clientIp);

    // Record provisional impression telemetry (payable settlement requires validated viewable_impression or click)
    if (placement) {
      await this.db.insert(adsInteractions).values({
        placementId: placement.id,
        promoterId,
        serveId: serve.id,
        websiteId: canonicalWebsite?.id || placement.websiteId || null,
        slotId: canonicalSlot?.id || null,
        type: 'impression',
        source:
          canonicalSlot || placement.websiteId ? 'embed' : 'share_link',
        actorIp: clientIp,
        userAgent,
        referrer: referrerDomain,
        isValid: true,
        assessmentStatus: 'provisional',
        ivtCategory: 'unclassified',
        financialEligibility: 'pending',
        keyedIpHash,
        keyId,
      });
    }

    const baseUrl = this.publicBaseUrl();
    const clickUrl = `${baseUrl}/api/v1/delivery/go/${impToken}?pid=${promoterId}`;

    const adType = ((winningCreative as any).adType ||
      ((winningCreative as any).videoUrl
        ? 'video'
        : (winningCreative as any).imageUrl
          ? 'image'
          : 'text')) as 'text' | 'image' | 'video';

    return {
      adType,
      format:
        (winningCreative as any).adFormat ||
        (winningCreative as any).format ||
        'card',
      headline: winningCreative.headline,
      bodyText: winningCreative.bodyText,
      ctaText: winningCreative.ctaText,
      imageUrl: this.absoluteMediaUrl(winningCreative.imageUrl),
      videoUrl: this.absoluteMediaUrl((winningCreative as any).videoUrl),
      posterUrl: this.absoluteMediaUrl((winningCreative as any).posterUrl),
      width: (winningCreative as any).width || null,
      height: (winningCreative as any).height || null,
      durationSeconds: (winningCreative as any).durationSeconds || null,
      isHouseAd: false,
      impToken,
      clickUrl,
    };
    } catch(error) {
      if(this.evidence)await this.evidence.append(requestId,{version:1,stage:'no_fill',reasonCode:'REQUEST_NOT_SERVED',errorCategory:error instanceof Error?error.name:'UNKNOWN',runtimeVersion:DELIVERY_RUNTIME.version,elapsedMs:DELIVERY_RUNTIME.serverMs-(serverDeadline-Date.now()),slotHandleHash:adDigest(token),serverReceivedAt:new Date()});
      if(error instanceof DeliveryDeadlineError&&['candidate_fetch','candidate_targeting','auction'].includes(error.stage)&&canonicalSlot&&Date.now()<serverDeadline){
        return this.serveHouseOrShadowAd({serveBefore:serverDeadline,parentOpportunityId:requestId,requestId:crypto.randomUUID(),slotTagId:canonicalSlot.slotTagId,slotId:canonicalSlot.id,websiteId:canonicalWebsite.id,
          promoterId:canonicalPromoter.id,placementId:null,format:canonicalSlot.format||'banner',inventoryClass:'house',deliveryMode:'normal',trafficRiskStatus:'normal',clientIp,userAgent,referrerDomain,clientGeo});
      }
      throw error;
    }
  }

  /**
   * Handle click redirect from share link or embed card (`GET /api/v1/delivery/go/:placementToken`).
   * Supports zero-charge House/Shadow Ad clicks (`G11`) without requiring campaign budget,
   * while enforcing active state, budget, and GIVT/SIVT validation on paid campaign clicks.
   */
  async handleClick(
    token: string,
    clientIp?: string,
    userAgent?: string,
    referrer?: string,
  ) {
    let placementId: string | undefined;
    let serveId: string | undefined;
    let campaignId: string | undefined;
    let creativeId: string | undefined;
    let promoterId: string | undefined;
    let destinationUrl: string | undefined;

    // 1. Try to decode as cryptographically signed impression token
    const tokenPayload = this.tokenService.verifyToken(token, clientIp);

    // Zero-charge CrimFig House/Shadow Ad click path (`G11`)
    if (
      tokenPayload &&
      tokenPayload.campaignId === HOUSE_CAMPAIGN_UUID &&
      tokenPayload.creativeId === HOUSE_CREATIVE_UUID
    ) {
      if(!(await this.boundServe(tokenPayload)))throw new NotFoundException('House click attribution is unavailable');
      await this.logInteraction({impToken:token,type:'click',source:'embed',clientIp,userAgent,referrer});
      return CRIMFIG_HOUSE_CREATIVE.destinationUrl;
    }

    if (tokenPayload && !(await this.boundServe(tokenPayload))) {
      throw new NotFoundException(
        'Click attribution does not match its ad serve',
      );
    }
    if (!tokenPayload && token.startsWith('imp_'))
      throw new NotFoundException('Click token invalid or expired');

    if (tokenPayload) {
      serveId = tokenPayload.servedId;
      placementId = tokenPayload.placementId;
      campaignId = tokenPayload.campaignId;
      creativeId = tokenPayload.creativeId;
      promoterId = tokenPayload.promoterId;

      const [issued]=await this.db.select().from(adsServes).where(eq(adsServes.id,serveId!)).limit(1);
      const render=issued?.contentSnapshot as any;
      if(render?.destinationUrl)destinationUrl=render.destinationUrl;
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
      throw new NotFoundException(
        'Placement or click token invalid or expired',
      );
    }

    // Verify campaign is active with budget
    const [campaign] = await this.db
      .select({
        status: adsCampaigns.status,
        moderationStatus: adsCampaigns.moderationStatus,
        contentRevision: adsCampaigns.contentRevision,
        currentSubmissionId: adsCampaigns.currentSubmissionId,
        approvedSubmissionId: adsCampaigns.approvedSubmissionId,
        approvedRevision: adsCampaigns.approvedRevision,
        submissionIntentId: adsCampaigns.submissionIntentId,
        remainingBudget: adsCampaigns.remainingBudgetUsdCents,
      })
      .from(adsCampaigns)
      .where(eq(adsCampaigns.id, campaignId))
      .limit(1);

    if (
      !campaign ||
      (tokenPayload?campaign.status==='suspended':campaign.status!=='active'||!currentApproval(campaign)||campaign.remainingBudget<=0)
    ) {
      throw new NotFoundException('Campaign inactive or budget exhausted');
    }

    // Run anti-fraud GIVT/SIVT evaluation on click
    const validation = this.fraudRules.validateClick({
      placementId,
      serveId,
      clientIp,
      userAgent,
      referrer,
      tokenTimestampMs: tokenPayload ? tokenPayload.timestamp : undefined,
    });

    const { keyedIpHash, keyId } = this.fraudRules.computeKeyedIpHash(clientIp);

    // Record click interaction telemetry with validation & GIVT/SIVT status for batch settlement
    if(!tokenPayload)throw new NotFoundException('Signed click attribution is required');
    const interaction=tokenPayload?await this.logInteraction({impToken:token,type:'click',source:'share_link',clientIp,userAgent,referrer}):undefined;

    const clickId = `clk_${Date.now().toString(36)}_${crypto.randomBytes(8).toString('hex')}`;
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    try {
      await this.db.insert(schema.adsClicks).values({
        clickId,
        serveId,
        interactionId: interaction?.id??null,
        campaignId,
        promoterId: promoterId || null,
        actorIp: null,
        userAgent: userAgent?.slice(0,512) || null,
        expiresAt,
      });
    } catch (clickErr: any) {
      this.logger.warn(
        `Failed to insert ads_clicks entry: ${clickErr.message}`,
      );
    }

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
   * Fast-path tracking for user engagement, render receipts, and verified viewability events (`G07`).
   * Persists `visibleRatio`, `durationMs`, `assessmentStatus`, `ivtCategory`, `financialEligibility`,
   * and keyed IP hash while enforcing zero financial eligibility on House/Shadow serves.
   */
  async logInteraction(params: {
    placementToken?: string;
    impToken?: string;
    type:
      | 'hover'
      | 'touch'
      | 'render'
      | 'impression'
      | 'viewable_impression'
      | 'click'
      | 'reels_view'
      | 'video_q25'
      | 'video_q50'
      | 'video_q75'
      | 'video_complete';
    source?: string;
    clientIp?: string;
    userAgent?: string;
    referrer?: string;
    visibleRatio?: number;
    durationSeconds?: number;
    eventId?:string;occurredAt?:string;
  }) {
    let placementId: string | undefined;
    let promoterId: string | undefined;
    let serveId: string | undefined;
    let websiteId: string | null = null;
    let slotId: string | null = null;
    let isHouseOrShadowServe = false;
    let signedPayload: ImpressionTokenPayload | undefined;

    // 1. If signed impToken is provided, decode cryptographic payload
    if (params.impToken) {
      const payload = this.tokenService.verifyToken(
        params.impToken,
        params.clientIp,
      );
      if (!payload) return;

      isHouseOrShadowServe =
        payload.campaignId === HOUSE_CAMPAIGN_UUID &&
        payload.creativeId === HOUSE_CREATIVE_UUID;

      if (!(await this.boundServe(payload))) return;

      signedPayload = payload;
      placementId = payload.placementId;
      promoterId = payload.promoterId;
      serveId = payload.servedId;

      const [serveRecord] = await this.db
        .select()
        .from(adsServes)
        .where(eq(adsServes.id, payload.servedId))
        .limit(1);

      if (serveRecord) {
        websiteId = serveRecord.websiteId || null;
        slotId = serveRecord.slotId || null;
        if (
          serveRecord.inventoryClass === 'house' ||
          serveRecord.inventoryClass === 'shadow' ||
          serveRecord.deliveryMode === 'shadow'
        ) {
          isHouseOrShadowServe = true;
        }
      }
    }

    // 2. Fallback to placementToken lookup if not resolved from impToken
    if (!placementId && params.placementToken) {
      const [placement] = await this.db
        .select({
          id: adsPlacements.id,
          promoterId: adsPlacements.promoterId,
          websiteId: adsPlacements.websiteId,
        })
        .from(adsPlacements)
        .where(eq(adsPlacements.placementToken, params.placementToken))
        .limit(1);

      if (placement) {
        placementId = placement.id;
        promoterId = placement.promoterId;
        websiteId = placement.websiteId || null;
      }
    }

    if (!placementId) {
      return;
    }

    // Evaluate GIVT/SIVT & viewability thresholds
    let isValid = true;
    let invalidReason: string | null = null;
    let ivtCategory: 'unclassified' | 'GIVT' | 'SIVT' = 'unclassified';
    let assessmentStatus:
      | 'provisional'
      | 'validated'
      | 'suspicious'
      | 'invalidated'
      | 'unknown' = 'provisional';
    let financialEligibility:
      | 'pending'
      | 'eligible'
      | 'quarantined'
      | 'invalid' = 'pending';

    if (
      params.type === 'impression' ||
      params.type === 'viewable_impression' ||
      params.type === 'render'
    ) {
      let minDuration = 1;
      if (params.type === 'viewable_impression' && signedPayload && !isHouseOrShadowServe) {
        const [issued]=await this.db.select({snapshot:adsServes.contentSnapshot}).from(adsServes).where(eq(adsServes.id,signedPayload.servedId)).limit(1);
        const snapshot=issued?.snapshot as any;
        const creative=snapshot?{adType:snapshot.adType,format:snapshot.adFormat}:null;
        if (!creative) {
          isValid = false;
          invalidReason = 'VIEWABILITY_THRESHOLD';
          ivtCategory = 'GIVT';
          assessmentStatus = 'invalidated';
          financialEligibility = 'invalid';
        } else {
          minDuration =
            creative.adType === 'video' || creative.format === 'video' ? 2 : 1;
        }
      }

      if (isValid) {
        const validation = this.fraudRules.validateImpression({
          placementId,
          serveId,
          clientIp: params.clientIp,
          userAgent: params.userAgent,
          referrer: params.referrer,
          visibleRatio: params.visibleRatio,
          durationSeconds: params.durationSeconds,
          minDurationSeconds: minDuration,
          isViewableEvent: params.type === 'viewable_impression',
        });
        isValid = validation.isValid;
        invalidReason = validation.reasonCode || null;
        ivtCategory = validation.ivtCategory;
        assessmentStatus = validation.assessmentStatus;
        financialEligibility = validation.financialEligibility;
      }
    } else if (params.type === 'click') {
      const validation = this.fraudRules.validateClick({
        placementId,
        serveId,
        clientIp: params.clientIp,
        userAgent: params.userAgent,
        tokenTimestampMs: signedPayload?.timestamp,
      });
      isValid = validation.isValid;
      invalidReason = validation.reasonCode || null;
      ivtCategory = validation.ivtCategory;
      assessmentStatus = validation.assessmentStatus;
      financialEligibility = validation.financialEligibility;
    }

    // House and Shadow serves are permanently non-payable (`financialEligibility = 'invalid'`)
    if (isHouseOrShadowServe) {
      financialEligibility = 'invalid';
    }

    const { keyedIpHash, keyId } = this.fraudRules.computeKeyedIpHash(
      params.clientIp,
    );
    const durationMs =
      typeof params.durationSeconds === 'number' &&
      Number.isFinite(params.durationSeconds)
        ? Math.round(params.durationSeconds * 1000)
        : null;
    const visibleRatioStr =
      typeof params.visibleRatio === 'number' &&
      Number.isFinite(params.visibleRatio)
        ? params.visibleRatio.toFixed(4)
        : null;

    if (placementId === HOUSE_PLACEMENT_UUID && !slotId) {
      // Do not fail on foreign key constraint if HOUSE_PLACEMENT_UUID is not seeded in ads_placements
      return;
    }

    if(!this.evidence)throw new Error('Durable evidence collection is unavailable');
    const rawId=crypto.randomUUID(),clientEventId=params.eventId??crypto.randomUUID();
    let safeReferrer:string|null=null;try{if(params.referrer){const url=new URL(params.referrer);safeReferrer=url.origin;}}catch{safeReferrer=null;}
    const recorded=await this.db.transaction(async tx=>{
      await tx.execute(sql`set local lock_timeout='5s'`);await tx.execute(sql`set local statement_timeout='8s'`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ad-event:${clientEventId}`},0))`);
      if(signedPayload&&!isHouseOrShadowServe){
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ads-escrow:${signedPayload.campaignId}`},0))`);
      }
      const [existing]=await tx.select().from(adsInteractions).where(eq(adsInteractions.eventId,clientEventId)).limit(1);
      if(existing){if(existing.serveId!==serveId||existing.type!==params.type)throw new ForbiddenException('Event identity changed');return existing;}
      const [event]=await tx.insert(adsInteractions).values({
        id:rawId,eventId:clientEventId,createdAt:new Date(),
        placementId:placementId===HOUSE_PLACEMENT_UUID?null:placementId,
        promoterId: promoterId || placementId,
        serveId,
        websiteId,
        slotId,
        type: params.type,
        source: params.source || 'embed',
        actorIp: null,
        userAgent: params.userAgent?.slice(0,512),
        referrer: safeReferrer,
        visibleRatio: visibleRatioStr,
        durationMs,
        measurable: true,
        assessmentStatus,
        ivtCategory,
        financialEligibility:isHouseOrShadowServe||!signedPayload?'invalid':financialEligibility==='invalid'?'invalid':'pending',
        keyedIpHash,
        keyId,
        verificationVersion:
          signedPayload && isValid && !isHouseOrShadowServe ? 2 : 0,
        isValid: isHouseOrShadowServe ? false : isValid,
        invalidReason: isHouseOrShadowServe
          ? invalidReason || 'HOUSE_OR_SHADOW_NON_BILLABLE'
          : invalidReason,
      }).returning();
      await this.evidence!.append(event.id,{version:1,serveId,eventId:clientEventId,type:event.type,serverReceivedAt:event.createdAt,
        clientOccurredAt:params.occurredAt??null,clientTimeTrust:'untrusted',visibleRatio:event.visibleRatio,durationMs:event.durationMs,
        measurable:event.measurable,verificationVersion:event.verificationVersion,assessmentStatus:event.assessmentStatus,financialEligibility:event.financialEligibility,
        keyedIpHash:event.keyedIpHash,keyId:event.keyId,websiteId,slotId,referrer:safeReferrer},tx);
      return event;
    });
    if(recorded.serveId&&recorded.verificationVersion===2&&recorded.financialEligibility==='pending'&&['click','viewable_impression'].includes(recorded.type)){
      const [serve]=await this.db.select().from(adsServes).where(eq(adsServes.id,recorded.serveId)).limit(1);
      if(serve?.opportunityReservationId&&this.opportunities){try{await this.opportunities.claim(serve.opportunityReservationId,recorded.id);}catch{/* Durable event remains available to the reconciler; no payment is inferred. */}}
    }
    return recorded;

  }
}
