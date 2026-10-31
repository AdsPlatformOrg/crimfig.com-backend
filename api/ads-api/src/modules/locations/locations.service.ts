import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import * as crypto from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { DATABASE_TOKEN } from '../database/database.module';
import {
  LocationProvider,
  LocationScope,
  NormalizedLocationSuggestion,
  ProviderName,
  ProviderPlaceDetails,
  ProviderUnavailableError,
} from './location.types';
import { GooglePlacesProvider } from './providers/google-places.provider';
import { GeoapifyProvider } from './providers/geoapify.provider';

export const GEO_VERSION = process.env.LOCATION_GEO_VERSION || 'crimfig-geo-2026.10';
const MAX_QUERY_LENGTH = 120;
const MIN_QUERY_LENGTH = 3;
const MAX_AUTOCOMPLETE_RESULTS = 6;

interface SessionPayload {
  sub: string;
  exp: number;
  nonce: string;
}

interface RateWindow {
  minuteStart: number;
  minuteCount: number;
  dayKey: string;
  dayCount: number;
}

interface CircuitState {
  failures: number;
  lastFailureAt: number;
  openUntil: number;
  halfOpenProbe: boolean;
}

export interface ResolvedTarget {
  placeId: string;
  scope: Exclude<LocationScope, 'global'>;
  geoVersion: string;
  resolvedCountries: string[];
  resolvedSubdivisions: string[];
  resolvedCities: string[];
}

function normalizeName(value: string): string {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function slug(value: string): string {
  return normalizeName(value).replace(/\s+/g, '-').slice(0, 48) || 'place';
}

@Injectable()
export class LocationsService {
  private readonly logger = new Logger(LocationsService.name);
  private readonly google: GooglePlacesProvider;
  private readonly geoapify: GeoapifyProvider;
  private readonly rateWindows = new Map<string, RateWindow>();
  private readonly circuits = new Map<ProviderName, CircuitState>();
  private readonly providerUsage = new Map<ProviderName, { dayKey: string; count: number }>();
  private placesCache: { loadedAt: number; rows: schema.CrimfigGeoPlace[] } | null = null;

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {
    const timeout = Number(process.env.LOCATION_PROVIDER_TIMEOUT_MS || 2500);
    this.google = new GooglePlacesProvider(process.env.GOOGLE_PLACES_API_KEY, timeout);
    this.geoapify = new GeoapifyProvider(process.env.GEOAPIFY_API_KEY, timeout);
  }

  // ── Session and limits ─────────────────────────────────────────────────────

  private sessionSecret(): string {
    return process.env.LOCATION_SESSION_SECRET || process.env.HMAC_SECRET || 'crimfig-location-session-v1';
  }

  createSession(userId: string): { sessionToken: string; expiresAt: string } {
    if (!userId) throw new UnauthorizedException('A signed-in advertiser is required.');
    const ttl = Number(process.env.LOCATION_SESSION_TTL_SECONDS || 600);
    const payload: SessionPayload = {
      sub: userId,
      exp: Date.now() + ttl * 1000,
      nonce: crypto.randomBytes(12).toString('hex'),
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', this.sessionSecret()).update(body).digest('base64url');
    return { sessionToken: `${body}.${signature}`, expiresAt: new Date(payload.exp).toISOString() };
  }

  private verifySession(sessionToken: string | undefined, userId: string): void {
    if (!sessionToken || !sessionToken.includes('.')) throw new UnauthorizedException('A location session is required.');
    const [body, signature] = sessionToken.split('.');
    const expected = crypto.createHmac('sha256', this.sessionSecret()).update(body).digest('base64url');
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new UnauthorizedException('Invalid location session.');
    let payload: SessionPayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      throw new UnauthorizedException('Invalid location session.');
    }
    if (payload.sub !== userId) throw new UnauthorizedException('Location session belongs to another account.');
    if (!Number.isFinite(payload.exp) || payload.exp <= Date.now()) throw new UnauthorizedException('Location session expired.');
  }

  private checkRateLimit(userId: string): void {
    const now = Date.now();
    const minute = Math.floor(now / 60_000);
    const dayKey = new Date(now).toISOString().slice(0, 10);
    const perMinute = Number(process.env.LOCATION_USER_REQUESTS_PER_MINUTE || 30);
    const perDay = Number(process.env.LOCATION_USER_REQUESTS_PER_DAY || 500);
    let window = this.rateWindows.get(userId);
    if (!window || window.minuteStart !== minute || window.dayKey !== dayKey) {
      window = {
        minuteStart: minute,
        minuteCount: window && window.minuteStart === minute ? window.minuteCount : 0,
        dayKey,
        dayCount: window && window.dayKey === dayKey ? window.dayCount : 0,
      };
    }
    window.minuteCount += 1;
    window.dayCount += 1;
    this.rateWindows.set(userId, window);
    if (window.minuteCount > perMinute || window.dayCount > perDay) {
      throw new ServiceUnavailableException('Location search is temporarily rate limited. Please wait and try again.');
    }
  }

  // ── Provider selection ─────────────────────────────────────────────────────

  private providerByName(name: ProviderName): LocationProvider {
    return name === 'google' ? this.google : this.geoapify;
  }

  private primaryName(): ProviderName {
    return (process.env.LOCATION_PRIMARY_PROVIDER || 'google') === 'geoapify' ? 'geoapify' : 'google';
  }

  private fallbackName(): ProviderName {
    const configured = process.env.LOCATION_FALLBACK_PROVIDER;
    if (configured === 'google' || configured === 'geoapify') {
      return configured === this.primaryName() ? (configured === 'google' ? 'geoapify' : 'google') : configured;
    }
    return this.primaryName() === 'google' ? 'geoapify' : 'google';
  }

  private circuitOpen(name: ProviderName): boolean {
    const circuit = this.circuits.get(name);
    if (!circuit) return false;
    if (circuit.openUntil > Date.now()) return true;
    if (circuit.openUntil > 0) {
      // Half-open: allow one probe after the open window.
      if (circuit.halfOpenProbe) return true;
      circuit.halfOpenProbe = true;
      return false;
    }
    return false;
  }

  private recordProviderSuccess(name: ProviderName): void {
    this.circuits.delete(name);
  }

  private recordProviderFailure(name: ProviderName): void {
    const now = Date.now();
    const circuit = this.circuits.get(name) || { failures: 0, lastFailureAt: 0, openUntil: 0, halfOpenProbe: false };
    if (now - circuit.lastFailureAt > 60_000) circuit.failures = 0;
    circuit.failures += 1;
    circuit.lastFailureAt = now;
    if (circuit.failures >= 5) {
      circuit.openUntil = now + 60_000;
      circuit.halfOpenProbe = false;
      this.logger.warn(`Location provider ${name} circuit opened after repeated failures`);
    }
    this.circuits.set(name, circuit);
  }

  private consumeProviderQuota(name: ProviderName): void {
    const key = name === 'google' ? 'GOOGLE_PLACES_DAILY_CAP' : 'GEOAPIFY_DAILY_CAP';
    const cap = Number(process.env[key] || 0);
    if (!Number.isFinite(cap) || cap <= 0) return;
    const dayKey = new Date().toISOString().slice(0, 10);
    const usage = this.providerUsage.get(name);
    if (!usage || usage.dayKey !== dayKey) {
      this.providerUsage.set(name, { dayKey, count: 1 });
      return;
    }
    if (usage.count >= cap) {
      throw new ProviderUnavailableError(name, 'rate_limit', `${name} daily cap reached`);
    }
    usage.count += 1;
  }

  private async runAutocomplete(
    name: ProviderName,
    input: Parameters<LocationProvider['autocomplete']>[0],
  ): Promise<NormalizedLocationSuggestion[]> {
    const provider = this.providerByName(name);
    if (!provider.isConfigured()) throw new ProviderUnavailableError(name, 'auth', `${name} is not configured`);
    if (this.circuitOpen(name)) throw new ProviderUnavailableError(name, 'server', `${name} circuit is open`);
    this.consumeProviderQuota(name);
    try {
      const predictions = await provider.autocomplete(input);
      this.recordProviderSuccess(name);
      return predictions.slice(0, MAX_AUTOCOMPLETE_RESULTS).map((prediction) => ({
        scope: prediction.scopeHint || (input.scope === 'city' ? 'city' : input.scope),
        canonicalId:
          prediction.scopeHint === 'country' && prediction.countryCode
            ? `country:${prediction.countryCode.toUpperCase()}`
            : null,
        providerPlaceId: prediction.providerPlaceId,
        label: prediction.label,
        description: prediction.description,
        countryCode: prediction.countryCode,
        subdivisionCode: prediction.subdivisionCode,
        provider: prediction.provider,
        latitude: prediction.latitude,
        longitude: prediction.longitude,
      }));
    } catch (error) {
      if (error instanceof ProviderUnavailableError) {
        this.recordProviderFailure(name);
        throw error;
      }
      this.recordProviderFailure(name);
      throw new ProviderUnavailableError(name, 'server', `${name} failed to answer`);
    }
  }

  async suggest(params: {
    userId: string;
    query: string;
    scope: Exclude<LocationScope, 'global'>;
    parentCanonicalId?: string;
    countryCode?: string;
    languageCode?: string;
    sessionToken?: string;
  }): Promise<{ suggestions: NormalizedLocationSuggestion[]; provider: ProviderName; attribution: string }> {
    this.verifySession(params.sessionToken, params.userId);
    this.checkRateLimit(params.userId);
    const query = (params.query || '').trim();
    if (query.length < MIN_QUERY_LENGTH) throw new BadRequestException('Enter at least three characters to search locations.');
    if (query.length > MAX_QUERY_LENGTH) throw new BadRequestException('Location search is too long.');

    const input = {
      query,
      scope: params.scope,
      parentCountryCode: params.countryCode,
      parentCanonicalId: params.parentCanonicalId,
      languageCode: params.languageCode || 'en',
      sessionToken: params.sessionToken!,
    };

    const primary = this.primaryName();
    const fallback = this.fallbackName();
    const fallbackEnabled = (process.env.LOCATION_FALLBACK_ENABLED || 'true') !== 'false';

    if (this.providerByName(primary).isConfigured()) {
      try {
        const suggestions = await this.runAutocomplete(primary, input);
        return { suggestions, provider: primary, attribution: primary === 'google' ? 'Powered by Google' : 'Powered by Geoapify' };
      } catch (error) {
        if (!fallbackEnabled || !this.providerByName(fallback).isConfigured()) throw error;
      }
    }
    if (!this.providerByName(fallback).isConfigured()) {
      throw new ServiceUnavailableException('Location search is unavailable. Configure a location provider and try again.');
    }
    const suggestions = await this.runAutocomplete(fallback, input);
    return { suggestions, provider: fallback, attribution: fallback === 'google' ? 'Powered by Google' : 'Powered by Geoapify' };
  }

  // ── Canonical place resolution ──────────────────────────────────────────────

  private async loadPlaces(force = false): Promise<schema.CrimfigGeoPlace[]> {
    if (!force && this.placesCache && Date.now() - this.placesCache.loadedAt < 5 * 60_000) {
      return this.placesCache.rows;
    }
    const rows = await this.db.select().from(schema.crimfigGeoPlaces);
    this.placesCache = { loadedAt: Date.now(), rows };
    return rows;
  }

  async getHierarchy(parentId?: string): Promise<Array<{
    id: string; scope: string; name: string; parentId: string | null; countryCode: string | null; subdivisionCode: string | null;
  }>> {
    const places = await this.loadPlaces();
    const children = parentId
      ? places.filter((p) => p.parentId === parentId)
      : places.filter((p) => p.scope === 'continent');
    return children
      .sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope.localeCompare(b.scope)))
      .map((p) => ({
        id: p.id,
        scope: p.scope,
        name: p.name,
        parentId: p.parentId,
        countryCode: p.countryCode,
        subdivisionCode: p.subdivisionCode,
      }));
  }

  async resolveTargetsByIds(ids: string[]): Promise<ResolvedTarget[]> {
    const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
    if (unique.length === 0) throw new BadRequestException('Choose at least one location, or select Global.');
    const places = await this.getPlacesByIds(unique);
    if (places.length !== unique.length) throw new BadRequestException('One or more selected locations are unknown.');
    return this.resolveTargets(
      places.map((place) => ({ placeId: place.id, scope: place.scope as ResolvedTarget['scope'] })),
    );
  }

  async getPlace(canonicalId: string): Promise<schema.CrimfigGeoPlace> {
    const [place] = await this.db
      .select()
      .from(schema.crimfigGeoPlaces)
      .where(eq(schema.crimfigGeoPlaces.id, canonicalId))
      .limit(1);
    if (!place) throw new BadRequestException('Unknown location.');
    return place;
  }

  private async findCountry(countryCode: string) {
    const id = `country:${countryCode.toUpperCase()}`;
    const [place] = await this.db.select().from(schema.crimfigGeoPlaces).where(eq(schema.crimfigGeoPlaces.id, id)).limit(1);
    return place || null;
  }

  private async ensureState(countryCode: string, details: ProviderPlaceDetails) {
    const country = await this.findCountry(countryCode);
    if (!country) throw new BadRequestException('The selected country is not in the CrimFig geography.');
    const name = details.subdivisionName || details.subdivisionCode;
    if (!name) return null;
    const normalized = normalizeName(name);
    const places = await this.loadPlaces();
    const iso = details.subdivisionCode && details.subdivisionCode.includes('-') ? details.subdivisionCode : null;
    const existing = places.find(
      (p) =>
        p.scope === 'state' &&
        p.parentId === country.id &&
        (iso ? p.id === `state:${iso}` || p.subdivisionCode === iso : p.normalizedName === normalized),
    );
    if (existing) return existing;
    const id = iso ? `state:${iso}` : `state:${countryCode.toUpperCase()}:${slug(name)}`;
    const [created] = await this.db
      .insert(schema.crimfigGeoPlaces)
      .values({
        id,
        scope: 'state',
        parentId: country.id,
        name,
        normalizedName: normalized,
        countryCode: countryCode.toUpperCase(),
        subdivisionCode: iso || null,
        geoVersion: GEO_VERSION,
        sourceProvider: details.provider,
        sourcePlaceId: details.providerPlaceId,
      })
      .onConflictDoNothing()
      .returning();
    this.placesCache = null;
    if (created) return created;
    return this.getPlace(id);
  }

  private async ensureCity(countryCode: string, details: ProviderPlaceDetails) {
    const country = await this.findCountry(countryCode);
    if (!country) throw new BadRequestException('The selected country is not in the CrimFig geography.');
    const state = await this.ensureState(countryCode, details);
    const parentId = state?.id || country.id;
    const name = details.cityName || details.name;
    if (!name) throw new BadRequestException('The selected city could not be resolved.');
    const normalized = normalizeName(name);
    const places = await this.loadPlaces();
    const existing = places.find(
      (p) => p.scope === 'city' && p.parentId === parentId && p.normalizedName === normalized,
    );
    if (existing) return existing;
    const id = `city:${crypto.randomUUID()}`;
    const [created] = await this.db
      .insert(schema.crimfigGeoPlaces)
      .values({
        id,
        scope: 'city',
        parentId,
        name,
        normalizedName: normalized,
        countryCode: countryCode.toUpperCase(),
        subdivisionCode: state?.subdivisionCode || null,
        latitude: details.latitude,
        longitude: details.longitude,
        geoVersion: GEO_VERSION,
        sourceProvider: details.provider,
        sourcePlaceId: details.providerPlaceId,
      })
      .onConflictDoNothing()
      .returning();
    this.placesCache = null;
    if (created) return created;
    return this.getPlace(id);
  }

  async resolveSelection(params: {
    userId: string;
    provider: ProviderName;
    providerPlaceId: string;
    scope: Exclude<LocationScope, 'global'>;
    languageCode?: string;
    sessionToken?: string;
  }): Promise<schema.CrimfigGeoPlace> {
    this.verifySession(params.sessionToken, params.userId);
    this.checkRateLimit(params.userId);
    if (!['google', 'geoapify'].includes(params.provider)) throw new BadRequestException('Unsupported location provider.');
    const provider = this.providerByName(params.provider);
    if (!provider.isConfigured()) throw new ServiceUnavailableException('The selected location provider is not configured.');
    if (this.circuitOpen(params.provider)) throw new ServiceUnavailableException('Location provider is temporarily unavailable.');

    let details: ProviderPlaceDetails;
    try {
      details = await provider.details(params.providerPlaceId, params.languageCode || 'en', params.sessionToken!);
      this.recordProviderSuccess(params.provider);
    } catch (error) {
      this.recordProviderFailure(params.provider);
      if (error instanceof ProviderUnavailableError) throw new ServiceUnavailableException('Location provider is temporarily unavailable.');
      throw new BadRequestException('The selected location could not be resolved.');
    }

    const countryCode = details.countryCode;
    if (!countryCode) throw new BadRequestException('The selected location has no country; choose a more specific result.');
    if (params.scope === 'country') {
      const country = await this.findCountry(countryCode);
      if (!country) throw new BadRequestException('The selected country is not in the CrimFig geography.');
      return country;
    }
    if (params.scope === 'state') {
      const state = await this.ensureState(countryCode, details);
      if (!state) throw new BadRequestException('The selected state could not be resolved.');
      return state;
    }
    return this.ensureCity(countryCode, details);
  }

  // ── Targeting closure ───────────────────────────────────────────────────────

  async resolveTargets(selections: Array<{ placeId: string; scope: Exclude<LocationScope, 'global'> }>): Promise<ResolvedTarget[]> {
    if (!Array.isArray(selections) || selections.length === 0) {
      throw new BadRequestException('Choose at least one location, or select Global.');
    }
    if (selections.length > 50) throw new BadRequestException('Too many location selections.');
    const places = await this.loadPlaces(true);
    const byId = new Map(places.map((p) => [p.id, p]));
    const children = new Map<string, schema.CrimfigGeoPlace[]>();
    for (const place of places) {
      if (!place.parentId) continue;
      const list = children.get(place.parentId) || [];
      list.push(place);
      children.set(place.parentId, list);
    }

    const descendants = (root: schema.CrimfigGeoPlace): schema.CrimfigGeoPlace[] => {
      const out: schema.CrimfigGeoPlace[] = [];
      const stack = [...(children.get(root.id) || [])];
      while (stack.length) {
        const next = stack.pop()!;
        out.push(next);
        stack.push(...(children.get(next.id) || []));
      }
      return out;
    };

    const seen = new Set<string>();
    return selections.map((selection) => {
      if (!selection?.placeId || !selection?.scope) throw new BadRequestException('Invalid location selection.');
      if (seen.has(selection.placeId)) throw new BadRequestException('Duplicate location selection.');
      seen.add(selection.placeId);
      const place = byId.get(selection.placeId);
      if (!place || place.scope !== selection.scope) throw new BadRequestException('Unknown location or scope mismatch.');

      const tree = descendants(place);
      let countries: string[] = [];
      let subdivisions: string[] = [];
      let cities: string[] = [];
      if (place.scope === 'continent' || place.scope === 'region') {
        countries = tree.filter((p) => p.scope === 'country').map((p) => p.countryCode!).filter(Boolean);
      } else if (place.scope === 'country') {
        countries = [place.countryCode!];
      } else if (place.scope === 'state') {
        countries = place.countryCode ? [place.countryCode] : [];
        subdivisions = place.subdivisionCode ? [place.subdivisionCode] : [];
      } else if (place.scope === 'city') {
        countries = place.countryCode ? [place.countryCode] : [];
        subdivisions = place.subdivisionCode ? [place.subdivisionCode] : [];
        cities = [place.id];
      }

      if (countries.length === 0) throw new BadRequestException('The selected location has no country membership.');
      return {
        placeId: place.id,
        scope: place.scope as ResolvedTarget['scope'],
        geoVersion: place.geoVersion,
        resolvedCountries: [...new Set(countries)],
        resolvedSubdivisions: [...new Set(subdivisions)],
        resolvedCities: [...new Set(cities)],
      };
    });
  }

  /**
   * Replace a campaign/stack's targeting rows atomically from validated selections.
   * The caller owns the surrounding transaction when it needs one.
   */
  async replaceTargets(
    tx: any,
    ownerType: 'campaign' | 'stack',
    ownerId: string,
    targets: ResolvedTarget[],
  ): Promise<void> {
    const current=await tx.select().from(schema.crimfigGeoTargets).where(and(eq(schema.crimfigGeoTargets.ownerType,ownerType),eq(schema.crimfigGeoTargets.ownerId,ownerId)));
    const normalized=(rows:any[])=>rows.map(row=>({placeId:row.placeId,scope:row.scope,geoVersion:row.geoVersion,
      countries:[...(typeof row.resolvedCountries==='string'?JSON.parse(row.resolvedCountries):row.resolvedCountries)].sort(),
      subdivisions:[...(typeof row.resolvedSubdivisions==='string'?JSON.parse(row.resolvedSubdivisions):row.resolvedSubdivisions)].sort(),
      cities:[...(typeof row.resolvedCities==='string'?JSON.parse(row.resolvedCities):row.resolvedCities)].sort()})).sort((a,b)=>a.placeId.localeCompare(b.placeId));
    if(JSON.stringify(normalized(current))===JSON.stringify(normalized(targets)))return;
    await tx
      .delete(schema.crimfigGeoTargets)
      .where(and(eq(schema.crimfigGeoTargets.ownerType, ownerType), eq(schema.crimfigGeoTargets.ownerId, ownerId)));
    if (targets.length === 0) return;
    await tx.insert(schema.crimfigGeoTargets).values(
      targets.map((target) => ({
        ownerType,
        ownerId,
        placeId: target.placeId,
        scope: target.scope,
        geoVersion: target.geoVersion,
        resolvedCountries: JSON.stringify(target.resolvedCountries),
        resolvedSubdivisions: JSON.stringify(target.resolvedSubdivisions),
        resolvedCities: JSON.stringify(target.resolvedCities),
      })),
    );
  }

  async getTargets(ownerType: 'campaign' | 'stack', ownerId: string) {
    return this.db
      .select()
      .from(schema.crimfigGeoTargets)
      .where(and(eq(schema.crimfigGeoTargets.ownerType, ownerType), eq(schema.crimfigGeoTargets.ownerId, ownerId)));
  }

  /** Used by delivery to expand stored closures without trusting client input. */
  static parseJsonArray(value: string | null | undefined): string[] {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
    } catch {
      return [];
    }
  }

  /** Resolve a set of canonical IDs for review rendering. */
  async getPlacesByIds(ids: string[]) {
    if (ids.length === 0) return [];
    return this.db
      .select({
        id: schema.crimfigGeoPlaces.id,
        scope: schema.crimfigGeoPlaces.scope,
        name: schema.crimfigGeoPlaces.name,
        parentId: schema.crimfigGeoPlaces.parentId,
        countryCode: schema.crimfigGeoPlaces.countryCode,
        subdivisionCode: schema.crimfigGeoPlaces.subdivisionCode,
      })
      .from(schema.crimfigGeoPlaces)
      .where(inArray(schema.crimfigGeoPlaces.id, ids));
  }
}
