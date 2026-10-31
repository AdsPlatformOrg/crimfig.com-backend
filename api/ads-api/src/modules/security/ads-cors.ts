import { dashboardOrigins } from '@crimfig/shared';

/** Public ad delivery is cookie-free; private APIs never inherit its wildcard policy. */
export function adsCorsOptions(production: boolean) {
  const origins = dashboardOrigins(production);
  return (req: { url?: string; method?: string }, callback: (error: Error | null, options: object) => void) => {
    const path = (req.url || '').split('?')[0];
    const publicPath = /^\/api\/v1\/delivery(?:\/|$)/.test(path) ||
      path === '/api/v1/px.js' || path === '/api/v1/px/collect' ||
      /^\/api\/v1\/uploads\/media\/[^/]+$/.test(path) || path === '/api/v1/campaigns/catalog';
    callback(null, {
      origin: publicPath ? '*' : origins, credentials: false,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type','Authorization','X-Request-Id','X-Correlation-Id'], exposedHeaders:['X-Request-Id','X-Correlation-Id'],
    });
  };
}
