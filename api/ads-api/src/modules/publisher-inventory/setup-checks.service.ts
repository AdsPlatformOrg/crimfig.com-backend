import { CreateSetupCheckDto } from './create-setup-check.dto';
export { CreateSetupCheckDto } from './create-setup-check.dto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { sql } from 'drizzle-orm';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { DATABASE_TOKEN } from '../database/database.module';

/** PLAN-0066 F5: owner-scoped, challenge-bound SDK/placement setup checks. */
export const SETUP_CHECK_TTL_MS = 30 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHALLENGE_RE = /^cfs_[A-Za-z0-9_-]{8,64}$/;

export class SdkHandshakeDto {
  @IsString() @MaxLength(80) challenge: string;
  @IsString() @MaxLength(32) sdkVersion: string;
  @IsOptional() @IsUUID() sdkInitializationId?: string;
  @IsOptional() @IsUUID() pageViewId?: string;
  @IsString() @MaxLength(255) host: string;
}

export type EvidenceStatus = 'pending' | 'confirmed' | 'stale' | 'unavailable';

export function hostMatchesDomain(domain: string, host: string): boolean {
  const norm = (v: string) => v.trim().toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
  const d = norm(domain);
  return d.length > 0 && d === norm(host);
}

export function normalizePagePath(input?: string): string | null {
  if (input === undefined || input === null || input === '') return null;
  if (typeof input !== 'string' || input.length > 256 || !input.startsWith('/') || /\s/.test(input) || Array.from(input).some(character => character.charCodeAt(0) <= 31) || input.startsWith('//')) {
    throw new BadRequestException('pagePath must be a site-relative path such as /blog');
  }
  return input.split(/[?#]/)[0] || '/';
}

export function hashChallenge(challenge: string): string {
  return crypto.createHash('sha256').update(challenge).digest('hex');
}

export interface SetupCheckRow {
  id: string;
  created_at: Date | string;
  expires_at: Date | string;
  sdk_executed_at: Date | string | null;
  sdk_version: string | null;
}
export interface SetupEvidenceCounts {
  serves: number;
  renders: number;
  measured: number;
  viewable: number;
}

/** Pure state derivation: slot request alone is never promoted to render/measurement. */
export function deriveSetupState(check: SetupCheckRow, now: Date, c: SetupEvidenceCounts) {
  const expired = new Date(check.expires_at).getTime() <= now.getTime();
  const gate = (ok: boolean): EvidenceStatus => (ok ? 'confirmed' : expired ? 'stale' : 'pending');
  const sdk = gate(!!check.sdk_executed_at);
  const states = {
    script_present: {
      status: 'unavailable' as EvidenceStatus,
      reason: 'Static page inspection is not performed; SDK execution evidence is used instead.',
    },
    sdk_executed: { status: sdk, at: check.sdk_executed_at, version: check.sdk_version },
    slot_request_received: { status: gate(c.serves > 0), count: c.serves },
    creative_rendered: { status: gate(c.renders > 0), count: c.renders },
    measurement_received: { status: gate(c.measured > 0), measured: c.measured, viewable: c.viewable },
    setup_complete: { status: gate(sdk === 'confirmed' && c.measured > 0) },
  };
  return { states, slotCodeUnlocked: sdk === 'confirmed', expired };
}

@Injectable()
export class SetupChecksService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: any) {}

  private challengeFor(id: string): string {
    const key = process.env.ADS_IMPRESSION_SIGNING_KEY;
    if (!key || Buffer.byteLength(key) < 32) throw new ServiceUnavailableException('Setup checks are unavailable');
    return 'cfs_' + crypto.createHmac('sha256', key).update('setup:' + id).digest('base64url').slice(0, 32);
  }

  private async ownedWebsite(promoterId: string, websiteId: string) {
    if (!UUID_RE.test(websiteId)) throw new BadRequestException('Invalid website id');
    const r = await this.db.execute(sql`SELECT id, promoter_id, domain FROM ads_promoter_websites WHERE id=${websiteId}::uuid LIMIT 1`);
    const w = r.rows[0];
    if (!w || w.promoter_id !== promoterId) throw new NotFoundException('Website not found');
    return w;
  }

  async create(promoterId: string, websiteId: string, dto: CreateSetupCheckDto) {
    if (!UUID_RE.test(dto.requestId)) throw new BadRequestException('requestId must be a UUID');
    const page = normalizePagePath(dto.pagePath);
    const website = await this.ownedWebsite(promoterId, websiteId);
    const id = crypto.randomUUID();
    const challenge = this.challengeFor(id);
    const expiresAt = new Date(Date.now() + SETUP_CHECK_TTL_MS);
    const inserted = await this.db.execute(sql`INSERT INTO ads_setup_checks (id, website_id, promoter_id, request_id, challenge_hash, page_path, expires_at)
      VALUES (${id}::uuid, ${websiteId}::uuid, ${promoterId}::uuid, ${dto.requestId}::uuid, ${hashChallenge(challenge)}, ${page}, ${expiresAt.toISOString()}::timestamptz)
      ON CONFLICT (promoter_id, request_id) DO NOTHING RETURNING id, created_at, expires_at`);
    let row = inserted.rows[0];
    let checkId = id;
    if (!row) {
      const ex = await this.db.execute(sql`SELECT id, website_id, page_path, created_at, expires_at FROM ads_setup_checks WHERE promoter_id=${promoterId}::uuid AND request_id=${dto.requestId}::uuid LIMIT 1`);
      row = ex.rows[0];
      if (!row || row.website_id !== websiteId || (row.page_path ?? null) !== page) throw new ConflictException('Setup check request identity changed');
      checkId = row.id;
    }
    return {
      id: checkId,
      websiteId,
      domain: website.domain,
      pagePath: page,
      challenge: this.challengeFor(checkId),
      verifyQuery: 'cf_setup=' + this.challengeFor(checkId),
      sdkUrl: (process.env.ADS_PUBLIC_URL || process.env.NEXT_PUBLIC_ADS_API_URL || 'https://api.ads.crimfig.com').replace(/\/$/, '') + '/api/v1/delivery/embed.js',
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  /** Public SDK execution acknowledgement. Unknown/expired/mismatched input writes nothing. */
  async acknowledgeSdk(dto: SdkHandshakeDto, originHost?: string): Promise<boolean> {
    if (!CHALLENGE_RE.test(dto.challenge)) return false;
    const r = await this.db.execute(sql`SELECT c.id, c.expires_at, c.sdk_executed_at, w.domain
      FROM ads_setup_checks c JOIN ads_promoter_websites w ON w.id=c.website_id
      WHERE c.challenge_hash=${hashChallenge(dto.challenge)} LIMIT 1`);
    const c = r.rows[0];
    if (!c || new Date(c.expires_at).getTime() <= Date.now()) return false;
    if (!hostMatchesDomain(c.domain, dto.host)) return false;
    if (originHost && !hostMatchesDomain(c.domain, originHost)) return false;
    if (c.sdk_executed_at) return true; // idempotent: repeat includes never rewrite evidence
    await this.db.execute(sql`UPDATE ads_setup_checks SET sdk_executed_at=now(), sdk_version=${dto.sdkVersion},
      sdk_runtime_id=${dto.sdkInitializationId ?? null}::uuid, sdk_page_view_id=${dto.pageViewId ?? null}::uuid, sdk_host=${dto.host.toLowerCase()}
      WHERE id=${c.id}::uuid AND sdk_executed_at IS NULL`);
    return true;
  }

  async get(promoterId: string, checkId: string) {
    if (!UUID_RE.test(checkId)) throw new BadRequestException('Invalid check id');
    const r = await this.db.execute(sql`SELECT * FROM ads_setup_checks WHERE id=${checkId}::uuid LIMIT 1`);
    const check = r.rows[0];
    if (!check || check.promoter_id !== promoterId) throw new NotFoundException('Setup check not found');
    const accepted = sql`serve_id IS NOT NULL AND (is_valid OR invalid_reason='HOUSE_OR_SHADOW_NON_BILLABLE')`;
    const serves = await this.db.execute(sql`SELECT count(*)::int AS n FROM ads_serves WHERE website_id=${check.website_id}::uuid AND served_at>=${check.created_at}`);
    const ev = await this.db.execute(sql`SELECT
        count(DISTINCT serve_id) FILTER (WHERE type='render')::int AS renders,
        count(DISTINCT serve_id) FILTER (WHERE type IN ('impression','viewable_impression'))::int AS measured,
        count(DISTINCT serve_id) FILTER (WHERE type='viewable_impression')::int AS viewable
      FROM ads_interactions WHERE website_id=${check.website_id}::uuid AND created_at>=${check.created_at} AND ${accepted}`);
    const inst = await this.db.execute(sql`SELECT slot_instance_id AS "instanceId",
        bool_or(type='render') AS rendered, bool_or(type IN ('impression','viewable_impression')) AS measured,
        bool_or(type='viewable_impression') AS viewable, max(instances_detected)::int AS "instancesDetected",
        min(instance_index)::int AS "instanceIndex", count(DISTINCT opportunity_id)::int AS opportunities, max(created_at) AS "lastEventAt"
      FROM ads_interactions WHERE website_id=${check.website_id}::uuid AND created_at>=${check.created_at}
        AND slot_instance_id IS NOT NULL AND ${accepted}
      GROUP BY slot_instance_id ORDER BY min(created_at) LIMIT 20`);
    const counts: SetupEvidenceCounts = {
      serves: Number(serves.rows[0]?.n ?? 0),
      renders: Number(ev.rows[0]?.renders ?? 0),
      measured: Number(ev.rows[0]?.measured ?? 0),
      viewable: Number(ev.rows[0]?.viewable ?? 0),
    };
    const derived = deriveSetupState(check, new Date(), counts);
    return {
      id: check.id,
      websiteId: check.website_id,
      pagePath: check.page_path,
      createdAt: check.created_at,
      expiresAt: check.expires_at,
      ...derived,
      instances: inst.rows,
      evidenceScope: 'website_since_check_start',
      coverage:
        'Evidence reflects beacons that reached CrimFig. Blocked scripts, denied consent, lazy or offline instances may be missing; serve/render evidence is website-scoped, not page-scoped.',
    };
  }
}
