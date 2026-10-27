import {
  LocationProvider,
  ProviderAutocompleteInput,
  ProviderPlaceDetails,
  ProviderPrediction,
  ProviderUnavailableError,
} from '../location.types';

const AUTOCOMPLETE_URL = 'https://api.geoapify.com/v1/geocode/autocomplete';
const DETAILS_URL = 'https://api.geoapify.com/v1/geocode/place';

function scopeFromResultType(resultType: string | undefined): ProviderPrediction['scopeHint'] {
  if (!resultType) return undefined;
  if (resultType === 'country') return 'country';
  if (resultType === 'state') return 'state';
  if (['city', 'locality', 'postcode', 'street', 'amenity', 'building'].includes(resultType)) return 'city';
  return undefined;
}

export class GeoapifyProvider implements LocationProvider {
  readonly name = 'geoapify' as const;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly timeoutMs: number,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  private async request(url: URL): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url.toString(), { signal: controller.signal });
      if (response.status === 429) {
        throw new ProviderUnavailableError('geoapify', 'rate_limit', 'Geoapify rate limit reached');
      }
      if (response.status === 401 || response.status === 403) {
        throw new ProviderUnavailableError('geoapify', 'auth', 'Geoapify credentials rejected');
      }
      if (response.status >= 500) {
        throw new ProviderUnavailableError('geoapify', 'server', 'Geoapify is unavailable');
      }
      if (!response.ok) throw new Error(`Geoapify request rejected (${response.status})`);
      return await response.json();
    } catch (error: any) {
      if (error instanceof ProviderUnavailableError) throw error;
      if (error?.name === 'AbortError') {
        throw new ProviderUnavailableError('geoapify', 'timeout', 'Geoapify timed out');
      }
      throw new ProviderUnavailableError('geoapify', 'network', 'Geoapify could not be reached');
    } finally {
      clearTimeout(timer);
    }
  }

  async autocomplete(input: ProviderAutocompleteInput): Promise<ProviderPrediction[]> {
    if (!this.apiKey) throw new ProviderUnavailableError('geoapify', 'auth', 'Geoapify is not configured');
    const url = new URL(AUTOCOMPLETE_URL);
    url.searchParams.set('text', input.query);
    url.searchParams.set('apiKey', this.apiKey);
    url.searchParams.set('limit', '6');
    url.searchParams.set('lang', input.languageCode.split('-')[0].toLowerCase());
    if (input.parentCountryCode) url.searchParams.set('filter', `countrycode:${input.parentCountryCode.toLowerCase()}`);
    if (input.scope === 'city') url.searchParams.set('type', 'city');
    if (input.scope === 'state') url.searchParams.set('type', 'state');

    const data = await this.request(url);
    const features = Array.isArray(data?.features) ? data.features : [];
    return features
      .map((feature: any) => {
        const props = feature?.properties || {};
        return {
          provider: 'geoapify' as const,
          providerPlaceId: props.place_id,
          label: props.name || props.address_line1 || props.formatted || '',
          description: props.formatted && props.formatted !== props.name ? props.formatted : undefined,
          scopeHint: scopeFromResultType(props.result_type),
          countryCode: props.country_code?.toUpperCase(),
          subdivisionCode: props.state_code,
          latitude: props.lat,
          longitude: props.lon,
        };
      })
      .filter((p: ProviderPrediction) => Boolean(p.providerPlaceId && p.label));
  }

  async details(providerPlaceId: string, languageCode: string, _sessionToken: string): Promise<ProviderPlaceDetails> {
    if (!this.apiKey) throw new ProviderUnavailableError('geoapify', 'auth', 'Geoapify is not configured');
    const url = new URL(DETAILS_URL);
    url.searchParams.set('id', providerPlaceId);
    url.searchParams.set('apiKey', this.apiKey);
    url.searchParams.set('lang', languageCode.split('-')[0].toLowerCase());
    const data = await this.request(url);
    const feature = Array.isArray(data?.features) ? data.features[0] : null;
    if (!feature) throw new Error('Geoapify place details were not found');
    const props = feature.properties || {};
    const resultType = props.result_type as string | undefined;
    const scope: ProviderPlaceDetails['scope'] =
      resultType === 'country' ? 'country' : resultType === 'state' ? 'state' : 'city';
    return {
      provider: 'geoapify',
      providerPlaceId,
      name: props.name || props.city || props.state || props.country || props.address_line1 || 'Unknown location',
      scope,
      countryCode: props.country_code?.toUpperCase(),
      countryName: props.country,
      subdivisionCode: props.state_code,
      subdivisionName: props.state,
      cityName: props.city || props.county || props.locality,
      latitude: props.lat,
      longitude: props.lon,
    };
  }
}
