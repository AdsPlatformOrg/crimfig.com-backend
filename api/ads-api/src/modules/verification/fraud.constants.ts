/**
 * CrimFig Anti-Fraud Engine Constants
 *
 * Strict single-source thresholds for click and impression validation.
 * NEVER configured in .env per system guidelines.
 */

export const FRAUD_CLICK_DEDUPE_WINDOW_MS = 30 * 1000; // 30 seconds between clicks on same placement from same IP
export const FRAUD_MIN_VIEW_TO_CLICK_MS = 300; // Click must occur >= 300ms after viewability
export const FRAUD_MAX_HOURLY_IP_IMPRESSIONS = 25; // Max 25 impressions per IP per placement per hour
export const FRAUD_MAX_HOURLY_IP_CLICKS = 3; // Max 3 clicks per IP per placement per hour

export const KNOWN_BOT_USER_AGENTS = [
  'googlebot',
  'bingbot',
  'slurp',
  'duckduckbot',
  'baiduspider',
  'yandexbot',
  'sogou',
  'exabot',
  'facebot',
  'facebookexternalhit',
  'ia_archiver',
  'bytespider',
  'petalbot',
  'semrushbot',
  'ahrefsbot',
  'dotbot',
  'mj12bot',
  'headlesschrome',
  'phantomjs',
  'selenium',
  'puppeteer',
  'playwright',
  'python-requests',
  'curl',
  'wget',
  'go-http-client',
  'postmanruntime',
];

export const FRAUD_REASON_CODES = {
  DUP_IMP: 'DUP_IMP',
  DUP_CLICK: 'DUP_CLICK',
  IP_RATE_IMP: 'IP_RATE_IMP',
  IP_RATE_CLK: 'IP_RATE_CLK',
  BOT_UA: 'BOT_UA',
  FAST_CLICK: 'FAST_CLICK',
  SELF_TRAFFIC: 'SELF_TRAFFIC',
  DOMAIN_MISMATCH: 'DOMAIN_MISMATCH',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  INVALID_TOKEN: 'INVALID_TOKEN',
} as const;
