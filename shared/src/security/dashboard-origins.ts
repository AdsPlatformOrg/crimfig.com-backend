/** Exact browser origins for private dashboard APIs; never publisher delivery CORS. */
export function dashboardOrigins(raw: string | undefined, production: boolean): string[] {
  const defaults = ['https://ads.crimfig.com', 'https://billing.crimfig.com', 'https://auth.crimfig.com'];
  if (!production) defaults.push('http://localhost:3000', 'http://localhost:3005', 'http://localhost:3007');
  const values = raw === undefined ? defaults : raw.split(',').map(value => value.trim()).filter(Boolean);
  if (!values.length) throw new Error('ALLOWED_ORIGINS must contain exact dashboard origins');
  return [...new Set(values.map(value => {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        (url.protocol !== 'https:' && !(!production && local && url.protocol === 'http:'))) {
      throw new Error('ALLOWED_ORIGINS must contain exact HTTPS origins or development loopback origins');
    }
    return url.origin;
  }))];
}
