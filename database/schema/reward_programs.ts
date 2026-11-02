import { rewardsFund, rewardsFundLedger } from "./rewards_fund";
import { billingProviderEvents } from "./billing_provider_events";
import { adsEventAssessments } from "./ad_delivery_authority";
import {
  pgTable,
  uuid,
  text,
  bigint,
  integer,
  jsonb,
  timestamp,
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { adsInteractions } from "./ads_interactions";
import { adsServes } from "./ads_serves_and_assets";
import { adsPromoters } from "./ads_promoters";
const created = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
export const rewardProgramAllocations = pgTable("reward_program_allocations", {
  id: uuid("id").primaryKey(),
  requestId: uuid("request_id").notNull().unique(),
  fingerprint: text("fingerprint").notNull(),
  program: text("program").notNull(),
  fundId: uuid("fund_id")
    .notNull()
    .references(() => rewardsFund.id),
  proofId: uuid("proof_id")
    .notNull()
    .unique()
    .references(() => billingProviderEvents.id),
  backingSourceRef: uuid("backing_source_ref")
    .notNull()
    .unique()
    .references(() => rewardsFundLedger.id),
  amountCents: bigint("amount_cents", { mode: "bigint" }).notNull(),
  policySnapshot: jsonb("policy_snapshot").notNull(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  approvedBy: uuid("approved_by").references(() => users.id),
  approvalRequestId: uuid("approval_request_id").unique(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: created(),
});
export const rewardProgramIssues = pgTable("reward_program_issues", {
  id: uuid("id").primaryKey(),
  requestId: uuid("request_id").notNull().unique(),
  fingerprint: text("fingerprint").notNull(),
  allocationId: uuid("allocation_id").references(
    () => rewardProgramAllocations.id,
  ),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  kind: text("kind").notNull(),
  points: integer("points").notNull(),
  microCfig: bigint("micro_cfig", { mode: "bigint" }).notNull().default(0n),
  sourceRef: text("source_ref").notNull().unique(),
  payload: jsonb("payload").notNull(),
  createdAt: created(),
});
export const rewardPerformanceReceipts = pgTable(
  "reward_performance_receipts",
  {
    eventId: uuid("event_id")
      .primaryKey()
      .references(() => adsInteractions.id),
    requestId: uuid("request_id").notNull().unique(),
    fingerprint: text("fingerprint").notNull(),
    serveId: uuid("serve_id")
      .notNull()
      .unique()
      .references(() => adsServes.id),
    promoterId: uuid("promoter_id")
      .notNull()
      .references(() => adsPromoters.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    model: text("model").notNull(),
    allocationId: uuid("allocation_id")
      .notNull()
      .references(() => rewardProgramAllocations.id),
    payload: jsonb("payload").notNull(),
    createdAt: created(),
  },
);
export const rewardIssuancePeriods = pgTable(
  "reward_issuance_periods",
  {
    period: text("period").notNull(),
    kind: text("kind").notNull(),
    capPoints: integer("cap_points").notNull(),
    snapshot: jsonb("snapshot").notNull(),
  },
  (t) => [primaryKey({ columns: [t.period, t.kind] })],
);
export const rewardRecoveryCases = pgTable(
  "reward_recovery_cases",
  {
    id: uuid("id").primaryKey(),
    requestId: uuid("request_id").notNull().unique(),
    fingerprint: text("fingerprint").notNull(),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => rewardProgramIssues.id),
    evidenceId: uuid("evidence_id")
      .notNull()
      .references(() => adsEventAssessments.id),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    reason: text("reason").notNull(),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex("reward_recovery_issue_evidence_uq").on(
      t.issueId,
      t.evidenceId,
    ),
  ],
);

export const rewardReconciliationReviews = pgTable(
  "reward_reconciliation_reviews",
  {
    id: uuid("id").primaryKey(),
    requestId: uuid("request_id").notNull().unique(),
    fingerprint: text("fingerprint").notNull(),
    kind: text("kind").notNull(),
    sourceId: uuid("source_id").notNull(),
    sourceSnapshot: jsonb("source_snapshot").notNull(),
    sourceHash: text("source_hash").notNull(),
    preparedBy: uuid("prepared_by")
      .notNull()
      .references(() => users.id),
    reason: text("reason").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
);
export const rewardReconciliationApprovals = pgTable(
  "reward_reconciliation_approvals",
  {
    reviewId: uuid("review_id")
      .primaryKey()
      .references(() => rewardReconciliationReviews.id),
    requestId: uuid("request_id").notNull().unique(),
    proofId: uuid("proof_id")
      .notNull()
      .unique()
      .references(() => billingProviderEvents.id),
    approvedBy: uuid("approved_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
);
