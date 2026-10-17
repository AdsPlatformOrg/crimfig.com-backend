import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  Inject,
} from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import {
  adsConversions,
  adsClicks,
  adsAdvertiserApiKeys,
  adsCampaigns,
  users,
} from '@crimfig/database/schema';
import { eq, and, sql, desc, gte } from 'drizzle-orm';
import * as crypto from 'crypto';

export interface ReportConversionParams {
  advertiserId?: string;
  apiKey?: string;
  clickId?: string;
  event: string;
  orderId?: string;
  value?: number; // monetary amount in main units e.g. 50.00
  currency?: string;
  occurredAt?: Date;
  metadata?: Record<string, any>;
  source: 'pixel' | 's2s';
}

export interface CreateApiKeyParams {
  advertiserId: string;
  name: string;
  scopes?: string;
}

@Injectable()
export class ConversionsService {
  private readonly logger = new Logger(ConversionsService.name);

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Hashes an API key using SHA-256 for persistent comparison
   */
  private hashKey(secret: string): string {
    return crypto.createHash('sha256').update(secret).digest('hex');
  }

  /**
   * Verifies an advertiser API key from S2S Authorization header
   */
  async verifyApiKey(rawKey: string) {
    if (!rawKey || !rawKey.startsWith('cf_adv_')) {
      throw new UnauthorizedException('Invalid or missing API key format');
    }

    const keyHash = this.hashKey(rawKey);
    const [keyRecord] = await this.db
      .select()
      .from(adsAdvertiserApiKeys)
      .where(and(eq(adsAdvertiserApiKeys.keyHash, keyHash), sql`${adsAdvertiserApiKeys.revokedAt} IS NULL`))
      .limit(1);

    if (!keyRecord) {
      throw new UnauthorizedException('Advertiser API key not recognized or revoked');
    }

    // Update lastUsedAt asynchronously
    this.db
      .update(adsAdvertiserApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(adsAdvertiserApiKeys.id, keyRecord.id))
      .catch((err) => this.logger.warn(`Failed to update key lastUsedAt: ${err.message}`));

    return keyRecord;
  }

  /**
   * Creates a scoped API key for an advertiser
   * Returns plaintext key ONCE to the user.
   */
  async createApiKey(params: CreateApiKeyParams) {
    const rawSecret = `cf_adv_${crypto.randomBytes(24).toString('hex')}`;
    const prefix = rawSecret.slice(0, 15);
    const keyHash = this.hashKey(rawSecret);

    const [keyRecord] = await this.db
      .insert(adsAdvertiserApiKeys)
      .values({
        advertiserId: params.advertiserId,
        name: params.name,
        prefix,
        keyHash,
        scopes: params.scopes || 'conversions:write',
      })
      .returning();

    return {
      id: keyRecord.id,
      name: keyRecord.name,
      prefix: keyRecord.prefix,
      key: rawSecret, // shown once
      scopes: keyRecord.scopes,
      createdAt: keyRecord.createdAt,
    };
  }

  /**
   * Lists an advertiser's active API keys (without secret keys)
   */
  async listApiKeys(advertiserId: string) {
    return this.db
      .select({
        id: adsAdvertiserApiKeys.id,
        name: adsAdvertiserApiKeys.name,
        prefix: adsAdvertiserApiKeys.prefix,
        scopes: adsAdvertiserApiKeys.scopes,
        lastUsedAt: adsAdvertiserApiKeys.lastUsedAt,
        revokedAt: adsAdvertiserApiKeys.revokedAt,
        createdAt: adsAdvertiserApiKeys.createdAt,
      })
      .from(adsAdvertiserApiKeys)
      .where(and(eq(adsAdvertiserApiKeys.advertiserId, advertiserId), sql`${adsAdvertiserApiKeys.revokedAt} IS NULL`))
      .orderBy(desc(adsAdvertiserApiKeys.createdAt));
  }

  /**
   * Revokes an advertiser API key
   */
  async revokeApiKey(keyId: string, advertiserId: string) {
    const [revoked] = await this.db
      .update(adsAdvertiserApiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(adsAdvertiserApiKeys.id, keyId), eq(adsAdvertiserApiKeys.advertiserId, advertiserId)))
      .returning();

    if (!revoked) {
      throw new NotFoundException('API key not found or unauthorized');
    }

    return { status: 'success', message: 'API key revoked' };
  }

  /**
   * Ingests a conversion event (Pixel or S2S Postback)
   * Performs deduplication by (advertiserId, orderId, event) and last-click attribution.
   */
  async ingestConversion(params: ReportConversionParams) {
    let advertiserId = params.advertiserId;

    // If S2S with API key, authenticate
    if (params.apiKey && !advertiserId) {
      const verifiedKey = await this.verifyApiKey(params.apiKey);
      advertiserId = verifiedKey.advertiserId;
    }

    if (!advertiserId) {
      throw new BadRequestException('Advertiser identity required to record conversion');
    }

    // 1. Deduplication Check: if orderId is provided, check if (advertiserId, orderId, event) exists
    if (params.orderId) {
      const [existing] = await this.db
        .select()
        .from(adsConversions)
        .where(
          and(
            eq(adsConversions.advertiserId, advertiserId),
            eq(adsConversions.orderId, params.orderId),
            eq(adsConversions.event, params.event),
          ),
        )
        .limit(1);

      if (existing) {
        this.logger.log(`Duplicate conversion detected for order ${params.orderId} (${params.event}). Skipping.`);
        return {
          status: 'duplicate',
          conversionId: existing.id,
          message: 'Conversion event already recorded for this order',
        };
      }
    }

    // 2. Attribution: resolve click record by clickId
    let campaignId: string | undefined;
    let attributedPromoterId: string | undefined;
    let attributionStatus: 'attributed' | 'unattributed' = 'unattributed';

    if (params.clickId) {
      const [click] = await this.db
        .select()
        .from(adsClicks)
        .where(and(eq(adsClicks.clickId, params.clickId), gte(adsClicks.expiresAt, new Date())))
        .limit(1);

      if (click) {
        campaignId = click.campaignId;
        attributedPromoterId = click.promoterId || undefined;
        attributionStatus = 'attributed';
      }
    }

    // Convert value to micros ($1 = 1,000,000 micros)
    const valueMicros = params.value ? Math.round(params.value * 1_000_000) : null;
    const valueUsdMicros = valueMicros; // Default 1:1 USD fallback
    const holdbackReleaseAt = new Date(Date.now() + 72 * 60 * 60 * 1000); // 72-Hour Clearance Hold

    // 3. Insert conversion record into ads_conversions
    const [conversion] = await this.db
      .insert(adsConversions)
      .values({
        advertiserId,
        campaignId,
        clickId: params.clickId || null,
        event: params.event,
        orderId: params.orderId || null,
        valueMicros,
        currency: params.currency || 'USD',
        valueUsdMicros,
        source: params.source,
        status: attributionStatus,
        attributedPromoterId: attributedPromoterId || null,
        holdbackReleaseAt,
        metadata: params.metadata ? JSON.stringify(params.metadata) : null,
        occurredAt: params.occurredAt || new Date(),
      })
      .returning();

    this.logger.log(
      `Recorded ${params.source} conversion #${conversion.id}: ${params.event} (${attributionStatus}, campaign: ${campaignId || 'none'})`,
    );

    return {
      status: attributionStatus,
      conversionId: conversion.id,
      campaignId: conversion.campaignId,
      attributedPromoterId: conversion.attributedPromoterId,
      occurredAt: conversion.occurredAt,
    };
  }

  /**
   * Reverses a conversion within the 72-hour holdback period (e.g. order refund / chargeback)
   */
  async reverseConversion(conversionId: string, advertiserId: string, reason: string) {
    const [conversion] = await this.db
      .select()
      .from(adsConversions)
      .where(and(eq(adsConversions.id, conversionId), eq(adsConversions.advertiserId, advertiserId)))
      .limit(1);

    if (!conversion) {
      throw new NotFoundException('Conversion not found or unauthorized');
    }

    if (conversion.status === 'reversed') {
      return { status: 'already_reversed', conversion };
    }

    const [reversed] = await this.db
      .update(adsConversions)
      .set({
        status: 'reversed',
        metadata: JSON.stringify({
          ...JSON.parse(conversion.metadata || '{}'),
          reversedAt: new Date().toISOString(),
          reverseReason: reason,
        }),
      })
      .where(eq(adsConversions.id, conversionId))
      .returning();

    this.logger.log(`Reversed conversion #${conversionId} within 72h holdback: ${reason}`);
    return { status: 'reversed', conversion: reversed };
  }

  /**
   * Returns paginated conversions for an advertiser
   */
  async getConversions(advertiserId: string, options?: { campaignId?: string; limit?: number }) {
    const limit = options?.limit || 50;

    let query = this.db
      .select()
      .from(adsConversions)
      .where(eq(adsConversions.advertiserId, advertiserId))
      .orderBy(desc(adsConversions.createdAt))
      .limit(limit);

    return query;
  }

  /**
   * Serves the public lightweight browser pixel tracking script (/api/v1/px.js)
   */
  getPixelScript(): string {
    return `
/**
 * CrimFig Ads Conversion Tracking Pixel (px.js)
 * High-performance, consent-gated browser beacon.
 */
(function(window, document) {
  'use strict';
  if (window.cfq && window.cfq.loaded) return;

  var COOKIE_NAME = '_cfclk';
  var COOKIE_TTL_DAYS = 30;

  function getQueryParam(name) {
    var match = RegExp('[?&]' + name + '=([^&]*)').exec(window.location.search);
    return match ? decodeURIComponent(match[1].replace(/\\+/g, ' ')) : null;
  }

  function setCookie(name, val, days) {
    var d = new Date();
    d.setTime(d.getTime() + (days * 24 * 60 * 60 * 1000));
    var expires = "expires=" + d.toUTCString();
    document.cookie = name + "=" + val + ";" + expires + ";path=/;SameSite=Lax";
  }

  function getCookie(name) {
    var nameEQ = name + "=";
    var ca = document.cookie.split(';');
    for (var i = 0; i < ca.length; i++) {
      var c = ca[i];
      while (c.charAt(0) == ' ') c = c.substring(1, c.length);
      if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length, c.length);
    }
    return null;
  }

  // Capture cf_click from landing URL and store in first-party cookie
  var clickId = getQueryParam('cf_click');
  if (clickId) {
    setCookie(COOKIE_NAME, clickId, COOKIE_TTL_DAYS);
  }

  // Get current script element to read advertiser ID
  var scripts = document.getElementsByTagName('script');
  var currentScript = scripts[scripts.length - 1];
  var advertiserId = currentScript ? currentScript.getAttribute('data-cf-adv') : null;

  function track(eventName, params) {
    params = params || {};
    var activeClickId = getCookie(COOKIE_NAME);
    var payload = {
      advertiserId: advertiserId,
      clickId: activeClickId,
      event: eventName,
      orderId: params.orderId || params.order_id,
      value: params.value,
      currency: params.currency || 'USD',
      metadata: params,
      source: 'pixel',
      url: window.location.href,
      ts: Date.now()
    };

    var beaconUrl = currentScript && currentScript.src ? currentScript.src.replace('/px.js', '/px/collect') : '/api/v1/px/collect';

    if (navigator.sendBeacon) {
      navigator.sendBeacon(beaconUrl, JSON.stringify(payload));
    } else {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', beaconUrl, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify(payload));
    }
  }

  var existingQ = window.cfq && window.cfq.q ? window.cfq.q : [];
  window.cfq = function(cmd, arg1, arg2) {
    if (cmd === 'track') {
      track(arg1, arg2);
    }
  };
  window.cfq.loaded = true;

  // Process queued commands
  for (var j = 0; j < existingQ.length; j++) {
    var item = existingQ[j];
    window.cfq.apply(null, item);
  }
})(window, document);
    `.trim();
  }
}
