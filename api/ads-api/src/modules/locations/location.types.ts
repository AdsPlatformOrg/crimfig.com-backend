export type LocationScope = 'global' | 'continent' | 'region' | 'country' | 'state' | 'city';

export type ProviderName = 'google' | 'geoapify';

export interface NormalizedLocationSuggestion {
  scope: Exclude<LocationScope, 'global'>;
  /** Present when the provider response already maps to a canonical CrimFig place. */
  canonicalId: string | null;
  /** Opaque provider selection handle used by POST /locations/resolve. */
  providerPlaceId: string;
  label: string;
  description?: string;
  countryCode?: string;
  subdivisionCode?: string;
  provider: ProviderName;
  latitude?: number;
  longitude?: number;
}

export interface ProviderPrediction {
  provider: ProviderName;
  providerPlaceId: string;
  label: string;
  description?: string;
  scopeHint?: Exclude<LocationScope, 'global'>;
  countryCode?: string;
  subdivisionCode?: string;
  latitude?: number;
  longitude?: number;
  rawTypes?: string[];
}

export interface ProviderPlaceDetails {
  provider: ProviderName;
  providerPlaceId: string;
  name: string;
  scope: Exclude<LocationScope, 'global'>;
  countryCode?: string;
  subdivisionCode?: string;
  countryName?: string;
  subdivisionName?: string;
  cityName?: string;
  latitude?: number;
  longitude?: number;
}

export interface ProviderAutocompleteInput {
  query: string;
  scope: Exclude<LocationScope, 'global'>;
  parentCountryCode?: string;
  parentCanonicalId?: string;
  languageCode: string;
  sessionToken: string;
}

export interface LocationProvider {
  readonly name: ProviderName;
  isConfigured(): boolean;
  autocomplete(input: ProviderAutocompleteInput): Promise<ProviderPrediction[]>;
  details(providerPlaceId: string, languageCode: string, sessionToken: string): Promise<ProviderPlaceDetails>;
}

export class ProviderUnavailableError extends Error {
  constructor(
    readonly provider: ProviderName,
    readonly reason: 'timeout' | 'rate_limit' | 'server' | 'auth' | 'network',
    message: string,
  ) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}
