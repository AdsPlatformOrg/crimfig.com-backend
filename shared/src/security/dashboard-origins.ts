import allowlist from '../config/cors-origins.json';

/** Exact file-defined browser origins; never publisher delivery CORS. */
export function dashboardOrigins(production: boolean, environment = process.env.RAILWAY_ENVIRONMENT_NAME): string[] {
  const origins = environment === 'staging' ? allowlist.staging : production ? allowlist.production : [...allowlist.production, ...allowlist.development];
  return validateDashboardOrigins(origins, production);
}

export function validateDashboardOrigins(values: readonly string[], production: boolean): string[] {
  if (!values.length) throw new Error('CORS allowlist file must contain exact browser origins');
  return [...new Set(values.map(value => {
    if (value.includes('\\') || value.includes('*')) throw new Error('CORS allowlist requires literal origins without wildcards or backslashes');
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        (url.protocol !== 'https:' && !(!production && local && url.protocol === 'http:'))) {
      throw new Error('CORS allowlist file must contain exact HTTPS origins or development loopback origins');
    }
    return url.origin;
  }))];
}
