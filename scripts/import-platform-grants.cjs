/* global require, process, console, __dirname */
// Explicit operator migration command. Input JSON arrives on stdin; never log grants or DB URLs.
// Does not modify accounts, MFA, settlement/refund operators, or replace revoked grants.
const { createRequire } = require("node:module");
const path = require("node:path"),
  fs = require("node:fs");
const load = createRequire(path.resolve(__dirname, "../database/package.json"));
const { Client } = load("pg");
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
(async () => {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  if (
    !process.env.DATABASE_URL ||
    !["staging", "production", "isolated-test"].includes(input.environment) ||
    !Array.isArray(input.grants)
  )
    throw Error(
      "Explicit DB URL, environment and approved grant manifest required",
    );
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: 8000,
    statement_timeout: 10000,
    application_name: "plan0156-owner-approved-import",
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('platform-role-administration',0))",
    );
    const stats = {
      imported: 0,
      alreadyPresent: 0,
      missingAccounts: 0,
      inactiveAccounts: 0,
      mfaNotEnrolled: 0,
      platformAdmins: 0,
    };
    const seen = new Set();
    for (const grant of input.grants) {
      if (
        !uuid(grant.userId) ||
        typeof grant.roleKey !== "string" ||
        !["ads", "auth", "billing", "auth_finance"].includes(grant.scope) ||
        typeof grant.source !== "string" ||
        !grant.source.startsWith("PLAN0156:")
      )
        throw Error("Invalid import manifest");
      const identity = [
        grant.userId.toLowerCase(),
        grant.roleKey,
        grant.scope,
      ].join(":");
      if (seen.has(identity)) continue;
      seen.add(identity);
      const role = await client.query(
        "SELECT key FROM platform_roles WHERE key=$1 AND $2=ANY(scopes)",
        [grant.roleKey, grant.scope],
      );
      if (!role.rowCount) throw Error("Unsupported role/scope in manifest");
      const user = await client.query(
        "SELECT status,mfa_enabled FROM users WHERE id=$1 FOR SHARE",
        [grant.userId],
      );
      if (!user.rowCount) {
        stats.missingAccounts++;
        continue;
      }
      if (user.rows[0].status !== "ACTIVE") stats.inactiveAccounts++;
      if (!user.rows[0].mfa_enabled) stats.mfaNotEnrolled++;
      const prior = await client.query(
        "SELECT id,state FROM platform_user_role_grants WHERE user_id=$1 AND role_key=$2 AND scope=$3 FOR UPDATE",
        [grant.userId, grant.roleKey, grant.scope],
      );
      if (prior.rowCount) {
        stats.alreadyPresent++;
        continue;
      }
      const inserted = await client.query(
        "INSERT INTO platform_user_role_grants(user_id,role_key,scope,state,source) VALUES ($1,$2,$3,'active',$4) RETURNING id",
        [grant.userId, grant.roleKey, grant.scope, grant.source],
      );
      await client.query(
        "INSERT INTO platform_role_audit(target_user_id,role_key,scope,action,reason,after_state,source) VALUES ($1,$2,$3,'bootstrap','Owner-approved import of existing service-scoped grants',$4::jsonb,$5)",
        [
          grant.userId,
          grant.roleKey,
          grant.scope,
          JSON.stringify({
            grantId: inserted.rows[0].id,
            imported: true,
            accountStatus: user.rows[0].status,
          }),
          grant.source,
        ],
      );
      stats.imported++;
      if (grant.roleKey === "super_admin") stats.platformAdmins++;
    }
    const eligible = await client.query(
      "SELECT count(DISTINCT g.user_id)::int AS count FROM platform_user_role_grants g JOIN users u ON u.id=g.user_id WHERE g.role_key='super_admin' AND g.scope='auth' AND g.state='active' AND u.status='ACTIVE' AND g.valid_from<=now() AND (g.expires_at IS NULL OR g.expires_at>now())",
    );
    if (!eligible.rows[0].count)
      throw Error(
        "No active identity administrator would remain; import rolled back",
      );
    if (stats.missingAccounts)
      throw Error("Manifest references missing accounts; import rolled back");
    await client.query("COMMIT");
    console.log(
      JSON.stringify({
        environment: input.environment,
        ...stats,
        eligibleIdentityAdmins: eligible.rows[0].count,
      }),
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
})().catch((error) => {
  console.error(error.code || error.message);
  process.exitCode = 1;
});
