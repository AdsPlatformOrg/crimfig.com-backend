import { pgTable, uuid, varchar, text, integer, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * growth_referral_status_enum
 *
 * Single-level referral state lifecycle:
 *  - invited: referee has visited or registered via link
 *  - qualified: referee has completed the qualifying action (e.g. verified profile + initial ad share or campaign launch)
 *  - reward_credited: points successfully awarded to referrer and referee
 *  - rejected: failed anti-fraud / duplicate check (shared IP/device/payment fingerprint)
 */
export const growthReferralStatusEnum = pgEnum('growth_referral_status', [
  'invited',
  'qualified',
  'reward_credited',
  'rejected',
]);

/**
 * growth_referral_codes
 *
 * Immutable unique single-level referral codes per user.
 */
export const growthReferralCodes = pgTable(
  'growth_referral_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
    code: varchar('code', { length: 32 }).notNull().unique(), // e.g. 'JED-8942'

    clicksCount: integer('clicks_count').notNull().default(0),
    signupsCount: integer('signups_count').notNull().default(0),
    qualifiedCount: integer('qualified_count').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('growth_referral_codes_code_idx').on(t.code),
    index('growth_referral_codes_user_id_idx').on(t.userId),
  ],
);

/**
 * growth_referrals
 *
 * Strict single-level referral relationship table.
 * Enforces: One referee can only ever have ONE referrer (uniqueIndex on refereeId).
 * Disallows self-referrals (checked at service and DB level).
 */
export const growthReferrals = pgTable(
  'growth_referrals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    referrerId: uuid('referrer_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    refereeId: uuid('referee_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
    referralCode: varchar('referral_code', { length: 32 }).notNull(),

    status: growthReferralStatusEnum('status').notNull().default('invited'),

    attributionSource: varchar('attribution_source', { length: 64 }), // 'link', 'direct_code', 'social_share'
    channel: varchar('channel', { length: 64 }), // 'twitter', 'whatsapp', 'email', 'copy'

    deviceFingerprintHash: varchar('device_fingerprint_hash', { length: 64 }),
    signupIp: varchar('signup_ip', { length: 45 }),

    rejectionReason: text('rejection_reason'),
    qualifiedAt: timestamp('qualified_at', { withTimezone: true }),
    rewardCreditedAt: timestamp('reward_credited_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('growth_referrals_referrer_id_idx').on(t.referrerId),
    index('growth_referrals_status_idx').on(t.status),
    index('growth_referrals_created_at_idx').on(t.createdAt),
  ],
);

/**
 * growth_share_links
 *
 * Multi-channel tracked share links created by promoters.
 */
export const growthShareLinks = pgTable(
  'growth_share_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    shareCode: varchar('share_code', { length: 32 }).notNull().unique(), // e.g. 's-72ka91'
    channel: varchar('channel', { length: 64 }).notNull(), // 'x', 'whatsapp', 'telegram', 'linkedin', 'facebook', 'generic'
    targetPath: varchar('target_path', { length: 255 }).notNull().default('/'), // Destination path

    totalClicks: integer('total_clicks').notNull().default(0),
    totalSignups: integer('total_signups').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('growth_share_links_user_id_idx').on(t.userId),
    index('growth_share_links_share_code_idx').on(t.shareCode),
  ],
);

/**
 * growth_link_clicks
 *
 * Click log for tracked share and referral links.
 */
export const growthLinkClicks = pgTable(
  'growth_link_clicks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    linkType: varchar('link_type', { length: 32 }).notNull(), // 'referral' | 'share'
    code: varchar('code', { length: 32 }).notNull(),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
    referer: text('referer'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('growth_link_clicks_code_idx').on(t.code),
    index('growth_link_clicks_created_at_idx').on(t.createdAt),
  ],
);

export type GrowthReferralCode = typeof growthReferralCodes.$inferSelect;
export type NewGrowthReferralCode = typeof growthReferralCodes.$inferInsert;
export type GrowthReferral = typeof growthReferrals.$inferSelect;
export type NewGrowthReferral = typeof growthReferrals.$inferInsert;
export type GrowthShareLink = typeof growthShareLinks.$inferSelect;
export type NewGrowthShareLink = typeof growthShareLinks.$inferInsert;
