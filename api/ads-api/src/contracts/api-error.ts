import { randomUUID } from 'crypto';

const codes: Record<number, string> = { 400: 'VALIDATION_FAILED', 401: 'AUTHENTICATION_REQUIRED', 403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND', 409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 422: 'VALIDATION_FAILED', 429: 'RATE_LIMITED', 503: 'SERVICE_UNAVAILABLE' };
const messages: Record<number, string> = { 400: 'Check the supplied values.', 401: 'Sign in to continue.', 403: 'You do not have permission for this action.',
  404: 'The requested item was not found.', 409: 'This request conflicts with the current state. Refresh its status before trying again.',
  413: 'The upload is too large.', 422: 'Check the supplied values.', 429: 'Too many requests. Please try again later.', 503: 'The service could not confirm the request. Check its status before retrying.' };
const knownMessages: Record<string, { code: string; message: string }> = {
  'Your wallet cannot reserve this campaign budget. Check your balance or choose a smaller budget.': {
    code: 'BUDGET_REJECTED', message: 'Your wallet cannot reserve this campaign budget. Check your balance or choose a smaller budget.',
  },
};

/** Deliberately never echoes exception text, raw URLs, query values, tokens or request bodies. */
export function safeApiError(status: number, payload: unknown, route?: string, incomingId?: unknown) {
  const source = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const rawMessage = typeof payload === 'string' ? payload : source.message;
  const known = status === 409 && typeof rawMessage === 'string' ? knownMessages[rawMessage] : undefined;
  const fieldErrors: Record<string, string[]> = {};
  if ([400, 422].includes(status) && Array.isArray(rawMessage)) {
    for (const item of rawMessage.slice(0, 30)) {
      if (typeof item !== 'string') continue;
      const field = /^([a-zA-Z][a-zA-Z0-9_.]{0,63}) (?:must|should|is required|has failed)/.exec(item)?.[1];
      if (field && !/password|token|secret|cookie|authorization/i.test(field)) fieldErrors[field] = ['Check this field.'];
    }
  }
  return {
    status: 'error' as const, statusCode: status,
    code: known?.code || codes[status] || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED'),
    message: known?.message || messages[status] || 'The request could not be completed.',
    requestId: typeof incomingId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(incomingId) ? incomingId : randomUUID(),
    path: route && /^\/[a-zA-Z0-9_/:.*{}-]{1,220}$/.test(route) ? route : '/<unresolved>',
    timestamp: new Date().toISOString(),
    ...(Object.keys(fieldErrors).length ? { fieldErrors } : {}),
  };
}
