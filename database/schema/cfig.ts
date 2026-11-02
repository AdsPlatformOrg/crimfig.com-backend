import { adsServes } from "./ads_serves_and_assets";
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  bigint,
  boolean,
  date,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { adsInteractions } from "./ads_interactions";
import { adsPromoters } from "./ads_promoters";
export const cfigPolicies = pgTable(
  "cfig_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id").notNull().unique(),
    fingerprint: text("fingerprint").notNull(),
    terms: jsonb("terms").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvalRequestId: uuid("approval_request_id").unique(),
    approvalReason: text("approval_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("cfig_policy_version_uq").on(sql`(${t.terms}->>'version')`),
  ],
);
export const cfigLedger = pgTable(
  "cfig_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id").notNull().unique(),
    fingerprint: text("fingerprint").notNull(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => adsInteractions.id),
    promoterId: uuid("promoter_id")
      .notNull()
      .references(() => adsPromoters.id),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => cfigPolicies.id),
    kind: text("kind").notNull(),
    pendingDelta: bigint("pending_delta", { mode: "bigint" }).notNull(),
    availableDelta: bigint("available_delta", { mode: "bigint" }).notNull(),
    convertedDelta: bigint("converted_delta", { mode: "bigint" }).notNull().default(0n),
    invalidDelta: bigint("invalid_delta", { mode: "bigint" }).notNull(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("cfig_ledger_event_kind_uq").on(t.eventId, t.kind).where(sql`${t.kind} <> 'convert'`),
    index("cfig_ledger_promoter_created").on(t.promoterId, t.createdAt),
    index("cfig_ledger_event_created").on(t.eventId, t.createdAt),
  ],
);

export const cfigEventReviews = pgTable(
  "cfig_event_reviews",
  {
    id: uuid("id").primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => adsInteractions.id),
    requestId: uuid("request_id").notNull().unique(),
    fingerprint: text("fingerprint").notNull(),
    outcome: text("outcome").notNull(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    reason: text("reason").notNull(),
    payload: jsonb("payload").notNull(),
    keyId: text("key_id").notNull(),
    recordHash: text("record_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("cfig_reviews_event_time").on(t.eventId, t.createdAt, t.id)],
);
export const cfigPeriodBudgets = pgTable("cfig_period_budgets", {
  month: text("month").primaryKey(),
  policyId: uuid("policy_id")
    .notNull()
    .references(() => cfigPolicies.id),
  snapshot: jsonb("snapshot").notNull(),
  snapshotHash: text("snapshot_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const cfigFinalizations = pgTable("cfig_finalizations", {
  day: date("day", { mode: "string" }).primaryKey(),
  requestId: uuid("request_id").notNull().unique(),
  fingerprint: text("fingerprint").notNull(),
  actorId: uuid("actor_id")
    .notNull()
    .references(() => users.id),
  reason: text("reason").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  snapshotHash: text("snapshot_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const cfigAllocations = pgTable("cfig_allocations", {
  eventId: uuid("event_id")
    .primaryKey()
    .references(() => adsInteractions.id),
  day: date("day", { mode: "string" })
    .notNull()
    .references(() => cfigFinalizations.day),
  serveId: uuid("serve_id")
    .notNull()
    .references(() => adsServes.id),
  promoterId: uuid("promoter_id")
    .notNull()
    .references(() => adsPromoters.id),
  policyId: uuid("policy_id").references(() => cfigPolicies.id),
  metric: text("metric").notNull(),
  outcome: text("outcome").notNull(),
  entitled: bigint("entitled", { mode: "bigint" }).notNull(),
  allocated: bigint("allocated", { mode: "bigint" }).notNull(),
  badgeEligible: boolean("badge_eligible").notNull(),
  sourceKey: text("source_key").notNull().unique(),
  reviewId: uuid("review_id").references(() => cfigEventReviews.id),
  sourceSnapshot: jsonb("source_snapshot").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
