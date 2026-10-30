import { VersioningType } from '@nestjs/common';

/** Used by runtime and the inert contract exporter. No configuration or I/O side effects. */
export const ADS_API_PREFIX = 'api';
export const ADS_API_VERSION = '1';
export function configureAdsApi(app: {
  enableVersioning(options: { type: VersioningType; defaultVersion: string }): unknown;
  setGlobalPrefix(prefix: string): unknown;
}) {
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: ADS_API_VERSION });
  app.setGlobalPrefix(ADS_API_PREFIX);
}
