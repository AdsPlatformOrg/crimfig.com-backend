import {
  LocationProvider,
  ProviderAutocompleteInput,
  ProviderPlaceDetails,
  ProviderPrediction,
  ProviderUnavailableError,
} from '../location.types';

const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const DETAILS_URL = 'https://places.googleapis.com/v1/places/';
const AUTOCOMPLETE_FIELDS = [
  'suggestions.placePrediction.placeId',
  'suggestions.placePrediction.text.text',
  'suggestions.placePrediction.structuredFormat.mainText.text',
  'suggestions.placePrediction.structuredFormat.secondaryText.text',
  'suggestions.placePrediction.types',
].join(',');
const DETAILS_FIELDS = [
  'id',
  'displayName',
  'formattedAddress',
  'addressComponents',
  'location',
  'types',
].join(',');

function scopeFromTypes(types: string[] | undefined): ProviderPrediction['scopeHint'] {
  if (!types) return undefined;
  if (types.includes('country')) return 'country';
  if (types.includes('administrative_area_level_1')) return 'state';
  if (types.some((t) => ['locality', 'postal_town', 'sublocality', 'sublocality_level_1'].includes(t))) return 'city';
  return undefined;
}

export class GooglePlacesProvider implements LocationProvider {
  readonly name = 'google' as const;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly timeoutMs: number,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  private async request(url: string, init: RequestInit): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.status === 429) {
        throw new ProviderUnavailableError('google', 'rate_limit', 'Google Places rate limit reached');
      }
      if (response.status === 401 || response.status === 403) {
        throw new ProviderUnavailableError('google', 'auth', 'Google Places credentials rejected');
      }
      if (response.status >= 500) {
        throw new ProviderUnavailableError('google', 'server', 'Google Places is unavailable');
      }
      if (!response.ok) {
        // A malformed request is our bug, not a provider outage: do not fail over.
        throw new Error(`Google Places request rejected (${response.status})`);
      }
      return await response.json();
    } catch (error: any) {
      if (error instanceof ProviderUnavailableError) throw error;
      if (error?.name === 'AbortError') {
        throw new ProviderUnavailableError('google', 'timeout', 'Google Places timed out');
      }
      throw new ProviderUnavailableError('google', 'network', 'Google Places could not be reached');
    } finally {
      clearTimeout(timer);
    }
  }

  async autocomplete(input: ProviderAutocompleteInput): Promise<ProviderPrediction[]> {
    if (!this.apiKey) throw new ProviderUnavailableError('google', 'auth', 'Google Places is not configured');
    const body: Record<string, unknown> = {
      input: input.query,
      sessionToken: input.sessionToken,
      languageCode: input.languageCode,
    };
    if (input.parentCountryCode) body.includedRegionCodes = [input.parentCountryCode.toLowerCase()];
    if (input.scope === 'city') body.includedPrimaryTypes = ['locality', 'postal_town'];

    const data = await this.request(AUTOCOMPLETE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.apiKey,
        'X-Goog-FieldMask': AUTOCOMPLETE_FIELDS,
      },
      body: JSON.stringify(body),
    });

    const suggestions = Array.isArray(data?.suggestions) ? data.suggestions : [];
    return suggestions
      .map((item: any) => item?.placePrediction)
      .filter(Boolean)
      .map((prediction: any) => ({
        provider: 'google' as const,
        providerPlaceId: prediction.placeId as string,
        label: prediction.structuredFormat?.mainText?.text || prediction.text?.text || '',
        description: prediction.structuredFormat?.secondaryText?.text || undefined,
        scopeHint: scopeFromTypes(prediction.types),
        rawTypes: prediction.types,
      }))
      .filter((p: ProviderPrediction) => Boolean(p.providerPlaceId && p.label));
  }

  async details(providerPlaceId: string, languageCode: string, sessionToken: string): Promise<ProviderPlaceDetails> {
    if (!this.apiKey) throw new ProviderUnavailableError('google', 'auth', 'Google Places is not configured');
    const url = new URL(DETAILS_URL + encodeURIComponent(providerPlaceId));
    url.searchParams.set('sessionToken', sessionToken);
    url.searchParams.set('languageCode', languageCode);
    const data = await this.request(url.toString(), {
      method: 'GET',
      headers: {
        'X-Goog-Api-Key': this.apiKey,
        'X-Goog-FieldMask': DETAILS_FIELDS,
      },
    });

    const components: any[] = Array.isArray(data?.addressComponents) ? data.addressComponents : [];
    const find = (type: string) => components.find((c) => Array.isArray(c.types) && c.types.includes(type));
    const country = find('country');
    const admin1 = find('administrative_area_level_1');
    const locality = find('locality') || find('postal_town') || find('sublocality_level_1') || find('administrative_area_level_2');
    const types: string[] = Array.isArray(data?.types) ? data.types : [];

    let scope: ProviderPlaceDetails['scope'] = 'city';
    if (types.includes('country') || (!admin1 && country)) scope = 'country';
    else if (types.includes('administrative_area_level_1')) scope = 'state';

    const displayName = data?.displayName?.text || locality?.longText || admin1?.longText || country?.longText || 'Unknown location';
    return {
      provider: 'google',
      providerPlaceId,
      name: displayName,
      scope,
      countryCode: country?.shortText?.toUpperCase(),
      countryName: country?.longText,
      subdivisionCode: admin1?.shortText,
      subdivisionName: admin1?.longText || admin1?.shortText,
      cityName: locality?.longText || locality?.shortText,
      latitude: data?.location?.latitude,
      longitude: data?.location?.longitude,
    };
  }
}
