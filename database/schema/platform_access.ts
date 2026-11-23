import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  unique,
} from "drizzle-orm/pg-core";
import { users } from "./users";
export type PlatformScope = "ads" | "auth" | "billing" | "auth_finance";
export const platformRoles = pgTable("platform_roles", {
  key: text("key").primaryKey(),
  label: text("label").notNull(),
  scopes: text("scopes").array().notNull(),
});
export const platformRoleChangeRequests = pgTable(
  "platform_role_change_requests",
  {
    id: uuid("id").primaryKey(),
    targetUserId: uuid("target_user_id")
      .notNull()
      .references(() => users.id),
    roleKey: text("role_key")
      .notNull()
      .references(() => platformRoles.key),
    scope: text("scope").notNull(),
    action: text("action").notNull(),
    reason: text("reason").notNull(),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    approvedBy: uuid("approved_by").references(() => users.id),
    expectedVersion: integer("expected_version").notNull(),
    grantExpiresAt: timestamp("grant_expires_at", { withTimezone: true }),
    state: text("state").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`now()+interval '15 minutes'`),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
);
export const platformUserRoleGrants = pgTable(
  "platform_user_role_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    roleKey: text("role_key")
      .notNull()
      .references(() => platformRoles.key),
    scope: text("scope").notNull(),
    state: text("state").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    changeRequestId: uuid("change_request_id").references(
      () => platformRoleChangeRequests.id,
    ),
    source: text("source").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique().on(t.userId, t.roleKey, t.scope)],
);
export const platformRoleAudit = pgTable("platform_role_audit", {
  id: uuid("id").primaryKey().defaultRandom(),
  requestId: uuid("request_id").references(() => platformRoleChangeRequests.id),
  targetUserId: uuid("target_user_id")
    .notNull()
    .references(() => users.id),
  roleKey: text("role_key")
    .notNull()
    .references(() => platformRoles.key),
  scope: text("scope").notNull(),
  action: text("action").notNull(),
  actorId: uuid("actor_id").references(() => users.id),
  approverId: uuid("approver_id").references(() => users.id),
  reason: text("reason").notNull(),
  beforeState: jsonb("before_state"),
  afterState: jsonb("after_state").notNull(),
  source: text("source").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Never reads environment grants or token roles. Every call observes current DB state. */
export async function readPlatformRoles(
  db: any,
  userId: string,
  scope: PlatformScope,
  lock = false,
): Promise<string[]> {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(userId || ""))
    return [];
  const result =
    await db.execute(sql`SELECT g.role_key FROM platform_user_role_grants g
 JOIN users u ON u.id=g.user_id JOIN platform_roles r ON r.key=g.role_key
 WHERE g.user_id=${userId}::uuid AND u.status='ACTIVE' AND g.scope=${scope} AND ${scope}=ANY(r.scopes)
 AND g.state='active' AND g.valid_from<=clock_timestamp() AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp()) ORDER BY g.role_key ${lock ? sql`FOR SHARE OF g,u,r` : sql``}`);
  return (result.rows ?? result).map((row: any) => row.role_key);
}
export async function readPlatformAccounts(
  db: any,
  role: string,
  scope: PlatformScope,
): Promise<string[]> {
  const result = await db.execute(
    sql`SELECT DISTINCT g.user_id FROM platform_user_role_grants g JOIN users u ON u.id=g.user_id JOIN platform_roles r ON r.key=g.role_key WHERE g.role_key=${role} AND g.scope=${scope} AND ${scope}=ANY(r.scopes) AND u.status='ACTIVE' AND g.state='active' AND g.valid_from<=clock_timestamp() AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp()) ORDER BY g.user_id`,
  );
  return (result.rows ?? result).map((row: any) => row.user_id);
}
