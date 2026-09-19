/**
 * Crimfig Database Schema — Central Export
 *
 * Import from here in drizzle.config.ts and in application code.
 * Never import individual schema files directly in application code —
 * always use this index to keep imports stable.
 *
 * ─── Ecosystem Naming Conventions ───
 * 1. Shared / Core Infrastructure: Common names (users, individual_profiles, organizations, etc.)
 * 2. App-Specific Services: Explicitly prefixed (billing_*, ads_*, chat_*, reels_*, stream_*)
 * 3. Any new tables must be checked against this file to prevent name and enum collisions.
 */

// ─── Core Auth & Identity ──────────────────────────────────────────────────────
export * from './users';
export * from './individual_profiles';
export * from './organizations';
export * from './organization_members';
export * from './apps';
export * from './user_app_consents';
export * from './mfa_devices';
export * from './oauth_clients';
export * from './refresh_tokens';
export * from './audit_logs';

// ─── Billing ──────────────────────────────────────────────────────────────────
export * from './billing_exchange_rates';
export * from './billing_wallets';
export * from './billing_saved_cards';
export * from './billing_transactions';
export * from './billing_subscriptions';
export * from './billing_provider_events';
export * from './billing_bank_accounts';
export * from './billing_withdrawal_requests';

// ─── Ads Platform ─────────────────────────────────────────────────────────────
export * from './ads_campaigns';
export * from './ads_creatives';
export * from './ads_promoters';     // includes: adsPromoters, adsPromoterWebsites, adsPromoterApps, adsPlacements
export * from './ads_interactions';  // includes: adsInteractions, adsPromoterEarnings, adsReelsConsents

