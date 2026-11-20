/** API allowlist mirrored by the frontend registry; parity is checked in PLAN0110 tests. */
export const SUPPORTED_LOCALES = ['en','fr','es','pt-BR','ar','sw','zh-Hans','zh-Hant','hi','bn','ur','id','de','ru','tr','ja','ko','ha','yo','ig','pcm'] as const;
export type SupportedLocale = typeof SUPPORTED_LOCALES[number];
export function isSupportedLocale(value:unknown):value is SupportedLocale {
  return typeof value==='string'&&(SUPPORTED_LOCALES as readonly string[]).includes(value);
}
