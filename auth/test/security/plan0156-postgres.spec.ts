jest.mock("../../src/config/config", () => ({
  config: {
    JWT: { ACCESS_SECRET: "plan0156-local-only-signing-key" },
    ENCRYPTION: { KEY: "ab".repeat(32) },
  },
}));
// Use Node's unmodified installed otplib loader: its ESM dependency cannot be parsed
// by Jest's legacy CommonJS loader. This is the actual crypto library, not an OTP stub.
jest.mock("otplib", () =>
  jest
    .requireActual("node:module")
    .Module._load(require.resolve("otplib"), module, false),
);
import { Module, ValidationPipe, VersioningType } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { PassportModule } from "@nestjs/passport";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { JwtService } from "@nestjs/jwt";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { randomUUID, createCipheriv, randomBytes } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";
import { tap } from "rxjs";
import * as schema from "@crimfig/database/schema";
import { PlatformAccessService } from "../../src/modules/platform-access/platform-access.service";
import { PlatformAccessController } from "../../src/modules/platform-access/platform-access.controller";
import { JwtStrategy } from "../../src/strategies/jwt.strategy";
import { MfaService } from "../../src/modules/mfa/mfa.service";
import { AdsStaffGrants } from "../../../api/ads-api/src/modules/security/ads-staff-grants";
import { AuthStaffGrants } from "../../src/security/auth-staff-grants";
import { BillingStaffGrants } from "../../../api/billing-api/src/modules/security/billing-staff-grants";
const { generateSecret, generateSync } = require("otplib");
let service: PlatformAccessService;
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: "jwt" }),
    ThrottlerModule.forRoot([
      { name: "short", ttl: 60000, limit: 10000 },
      { name: "medium", ttl: 60000, limit: 10000 },
    ]),
  ],
  controllers: [PlatformAccessController],
  providers: [
    JwtStrategy,
    { provide: ThrottlerGuard, useValue: { canActivate: () => true } },
    { provide: PlatformAccessService, useFactory: () => service },
  ],
})
class TestModule {}
const run = process.env.PLAN0009_PG_URL ? describe : describe.skip;
run("PLAN0156 real PostgreSQL and HTTP platform access", () => {
  let pool: Pool, db: any, app: any, origin: string;
  const jwt = new JwtService({ secret: "plan0156-local-only-signing-key" }),
    devices = new Map<string, string>();
  beforeAll(async () => {
    const url = new URL(process.env.PLAN0009_PG_URL!);
    if (
      url.hostname !== "127.0.0.1" ||
      url.port !== "25456" ||
      url.pathname !== "/plan0009_test" ||
      url.username !== "plan0009test"
    )
      throw Error("Disposable PostgreSQL required");
    pool = new Pool({
      connectionString: url.href,
      max: 8,
      statement_timeout: 10000,
    });
    db = drizzle(pool, { schema });
    await pool.query(
      "CREATE TABLE users(id uuid PRIMARY KEY,status text NOT NULL,mfa_enabled boolean NOT NULL DEFAULT false,email text,created_at timestamptz DEFAULT now())",
    );
    await pool.query(
      "CREATE TABLE mfa_devices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid REFERENCES users(id),type text,nickname text,credential_id text UNIQUE,counter text DEFAULT '0',is_primary boolean DEFAULT false,is_verified boolean,revoked_at timestamptz,created_at timestamptz,last_used_at timestamptz,secret_or_public_key text)",
    );
    await pool.query(
      "CREATE TABLE auth_financial_totp_uses(device_id uuid REFERENCES mfa_devices(id),step bigint,used_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(device_id,step))",
    );
    await pool.query(
      readFileSync(
        resolve(
          __dirname,
          "../../../database/migrations/0054_platform_access.sql",
        ),
        "utf8",
      ),
    );
    const mfa = new MfaService(db, {} as any, {} as any);
    service = new PlatformAccessService(db, mfa);
    const testing = await Test.createTestingModule({ imports: [TestModule] })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = testing.createNestApplication({ logger: false });
    app.setGlobalPrefix("api");
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalInterceptors({
      intercept(ctx: any, next: any) {
        return next.handle().pipe(
          tap(() => {
            if (
              ctx.switchToHttp().getRequest().headers[
                "x-fixture-drop-response"
              ] === "1"
            )
              ctx.switchToHttp().getResponse().destroy();
          }),
        );
      },
    });
    await app.listen(0, "127.0.0.1");
    origin = await app.getUrl();
  }, 30000);
  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });
  async function user(admin = false) {
    const id = randomUUID(),
      secret = generateSecret(),
      iv = randomBytes(12),
      cipher = createCipheriv(
        "aes-256-gcm",
        Buffer.from("ab".repeat(32), "hex"),
        iv,
      ),
      encrypted = Buffer.concat([
        cipher.update(secret, "utf8"),
        cipher.final(),
      ]);
    await pool.query(
      "INSERT INTO users(id,status,mfa_enabled,email) VALUES($1,'ACTIVE',true,$2)",
      [id, id + "@example.test"],
    );
    await pool.query(
      "INSERT INTO mfa_devices(user_id,type,is_verified,created_at,secret_or_public_key) VALUES($1,'TOTP',true,now()-interval '30 days',$2)",
      [
        id,
        Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64"),
      ],
    );
    devices.set(id, secret);
    if (admin)
      await pool.query(
        "INSERT INTO platform_user_role_grants(user_id,role_key,scope,state,source) VALUES($1,'super_admin','auth','active','isolated-fixture')",
        [id],
      );
    return id;
  }
  const code = (id: string) =>
    generateSync({
      secret: devices.get(id),
      epoch: Math.floor(Date.now() / 1000),
    });
  const token = (id: string, extra = {}) =>
    jwt.sign({ sub: id, type: "access", ...extra }, { expiresIn: "10m" });
  function request(
    actor?: string,
    path = "",
    body?: any,
    drop = false,
    extra = {},
  ) {
    return fetch(origin + "/api/v1/auth/platform-access" + path, {
      method: body ? "POST" : "GET",
      headers: {
        ...(actor ? { Authorization: "Bearer " + token(actor, extra) } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(drop ? { "x-fixture-drop-response": "1" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  }
  async function fixture() {
    const actor = await user(true),
      reviewer = await user(true),
      target = await user();
    return { actor, reviewer, target };
  }
  function input(target: string, actor: string, extra = {}) {
    return {
      requestId: randomUUID(),
      targetUserId: target,
      roleKey: "ads_support",
      scope: "ads",
      action: "grant",
      reason: "Approved support assignment",
      code: code(actor),
      ...extra,
    } as any;
  }
  it("rejects anonymous, ordinary and forged token-role access", async () => {
    expect((await request()).status).toBe(401);
    const plain = await user();
    expect(
      (await request(plain, "", undefined, false, { roles: ["super_admin"] }))
        .status,
    ).toBe(403);
  });
  it("requires current scoped grants; environment maps cannot grant access", async () => {
    const plain = await user();
    const prior = process.env.AUTH_STAFF_ROLE_GRANTS;
    process.env.AUTH_STAFF_ROLE_GRANTS = JSON.stringify({
      [plain]: ["super_admin"],
    });
    try {
      expect((await request(plain)).status).toBe(403);
    } finally {
      if (prior === undefined) delete process.env.AUTH_STAFF_ROLE_GRANTS;
      else process.env.AUTH_STAFF_ROLE_GRANTS = prior;
    }
    await pool.query(
      "INSERT INTO platform_user_role_grants(user_id,role_key,scope,state,source) VALUES($1,'super_admin','ads','active','fixture')",
      [plain],
    );
    expect(await new AdsStaffGrants(db).rolesFor(plain)).toEqual([
      "super_admin",
    ]);
    expect(await new AuthStaffGrants(db).rolesFor(plain)).toEqual([]);
    expect(await new BillingStaffGrants(db).rolesFor(plain)).toEqual([]);
  });
  it("does not mutate a grant on proposal and rejects self-approval and altered proposal retry", async () => {
    const f = await fixture(),
      p = input(f.target, f.actor);
    const response = await request(f.actor, "/proposals", p);
    expect(response.status).toBe(201);
    expect(await new AdsStaffGrants(db).rolesFor(f.target)).toEqual([]);
    expect(
      (
        await request(f.actor, "/proposals/" + p.requestId + "/decision", {
          decision: "approve",
          code: code(f.actor),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(f.actor, "/proposals", {
          ...p,
          reason: "Changed request reason",
        })
      ).status,
    ).toBe(409);
  });
  it("rejects missing MFA, wrong code and unsupported role scope with no grants", async () => {
    const f = await fixture();
    await pool.query("UPDATE users SET mfa_enabled=false WHERE id=$1", [
      f.actor,
    ]);
    expect(
      (await request(f.actor, "/proposals", input(f.target, f.actor))).status,
    ).toBe(403);
    await pool.query("UPDATE users SET mfa_enabled=true WHERE id=$1", [
      f.actor,
    ]);
    expect(
      (
        await request(
          f.actor,
          "/proposals",
          input(f.target, f.actor, { code: "000000" }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          f.actor,
          "/proposals",
          input(f.target, f.actor, { scope: "billing" }),
        )
      ).status,
    ).toBe(400);
  });
  it("replays a proposal idempotently and consumes an authenticator step only once", async () => {
    const f = await fixture(),
      p = input(f.target, f.actor);
    await service.propose(f.actor, p);
    expect((await service.propose(f.actor, p)).id).toBe(p.requestId);
    await expect(
      service.propose(f.actor, input(f.target, f.actor)),
    ).rejects.toThrow("fresh eligible");
    expect(
      (
        await pool.query(
          "SELECT count(*) FROM platform_role_change_requests WHERE id=$1",
          [p.requestId],
        )
      ).rows[0].count,
    ).toBe("1");
  });
  it("approves once under concurrent requests and recovers a lost acknowledgement", async () => {
    const f = await fixture(),
      p = input(f.target, f.actor);
    await service.propose(f.actor, p);
    await expect(
      request(
        f.reviewer,
        "/proposals/" + p.requestId + "/decision",
        { decision: "approve", code: code(f.reviewer) },
        true,
      ),
    ).rejects.toThrow();
    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        request(f.reviewer, "/proposals/" + p.requestId + "/decision", {
          decision: "approve",
          code: code(f.reviewer),
        }),
      ),
    );
    expect(responses.every((response) => response.status === 201)).toBe(true);
    expect(await new AdsStaffGrants(db).rolesFor(f.target)).toEqual([
      "ads_support",
    ]);
    expect(
      (
        await pool.query(
          "SELECT count(*) FROM platform_role_audit WHERE request_id=$1 AND action='approved'",
          [p.requestId],
        )
      ).rows[0].count,
    ).toBe("1");
  });
  it("revocation affects existing tokens and a second resolver immediately", async () => {
    const f = await fixture();
    await pool.query(
      "INSERT INTO platform_user_role_grants(user_id,role_key,scope,state,source) VALUES($1,'super_admin','auth','active','fixture')",
      [f.target],
    );
    expect((await request(f.target)).status).toBe(200);
    const second = new AuthStaffGrants(db);
    expect(await second.rolesFor(f.target)).toEqual(["super_admin"]);
    const p = input(f.target, f.actor, {
      roleKey: "super_admin",
      scope: "auth",
      action: "revoke",
    });
    await service.propose(f.actor, p);
    await service.decide(f.reviewer, p.requestId, {
      decision: "approve",
      code: code(f.reviewer),
    });
    expect((await request(f.target)).status).toBe(403);
    expect(await second.rolesFor(f.target)).toEqual([]);
  });
  it("rechecks requester/reviewer account status and stale target versions", async () => {
    const f = await fixture(),
      p = input(f.target, f.actor);
    await service.propose(f.actor, p);
    await pool.query("UPDATE users SET status='SUSPENDED' WHERE id=$1", [
      f.actor,
    ]);
    await expect(
      service.decide(f.reviewer, p.requestId, {
        decision: "approve",
        code: code(f.reviewer),
      }),
    ).rejects.toThrow("Active Platform Admin");
    await pool.query("UPDATE users SET status='ACTIVE' WHERE id=$1", [f.actor]);
    await pool.query(
      "INSERT INTO platform_user_role_grants(user_id,role_key,scope,state,source) VALUES($1,'ads_support','ads','revoked','fixture')",
      [f.target],
    );
    await expect(
      service.decide(f.reviewer, p.requestId, {
        decision: "approve",
        code: code(f.reviewer),
      }),
    ).rejects.toThrow("Assignment changed");
  });
  it("rejects expired requests and protects the last administrator in a service scope", async () => {
    const f = await fixture();
    await pool.query(
      "INSERT INTO platform_user_role_grants(user_id,role_key,scope,state,source) VALUES($1,'super_admin','billing','active','fixture')",
      [f.target],
    );
    const p = input(f.target, f.actor, {
      roleKey: "super_admin",
      scope: "billing",
      action: "revoke",
    });
    await service.propose(f.actor, p);
    await expect(
      service.decide(f.reviewer, p.requestId, {
        decision: "approve",
        code: code(f.reviewer),
      }),
    ).rejects.toThrow("last eligible");
    // An expired fixture is inserted directly; the immutable proposal cannot be edited into expiry.
    const expired = randomUUID();
    await pool.query(
      "INSERT INTO platform_role_change_requests(id,target_user_id,role_key,scope,action,reason,requested_by,expected_version,expires_at) VALUES($1,$2,'ads_support','ads','grant','Expired fixture',$3,0,now()-interval '1 second')",
      [expired, f.target, f.actor],
    );
    await expect(
      service.decide(f.reviewer, expired, {
        decision: "approve",
        code: code(f.reviewer),
      }),
    ).rejects.toThrow("Proposal expired");
  });
  it("rolls back grants and decision if audit insert fails, then retries safely", async () => {
    const f = await fixture(),
      p = input(f.target, f.actor);
    await service.propose(f.actor, p);
    await pool.query(
      "CREATE FUNCTION fail_platform_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit fixture failure'; END $$; CREATE TRIGGER fail_platform_audit_fixture BEFORE INSERT ON platform_role_audit FOR EACH ROW EXECUTE FUNCTION fail_platform_audit_fixture()",
    );
    try {
      await expect(
        service.decide(f.reviewer, p.requestId, {
          decision: "approve",
          code: code(f.reviewer),
        }),
      ).rejects.toThrow("audit fixture failure");
    } finally {
      await pool.query(
        "DROP TRIGGER fail_platform_audit_fixture ON platform_role_audit; DROP FUNCTION fail_platform_audit_fixture()",
      );
    }
    expect(await new AdsStaffGrants(db).rolesFor(f.target)).toEqual([]);
    await service.decide(f.reviewer, p.requestId, {
      decision: "approve",
      code: code(f.reviewer),
    });
    expect(await new AdsStaffGrants(db).rolesFor(f.target)).toEqual([
      "ads_support",
    ]);
  });
  it("protects audit/proposal history and fails closed on missing authority tables", async () => {
    await expect(pool.query("DELETE FROM platform_role_audit")).rejects.toThrow(
      "append-only",
    );
    await expect(
      pool.query("UPDATE platform_role_change_requests SET reason='tampered'"),
    ).rejects.toThrow("immutable");
    const f = await fixture();
    await pool.query(
      "ALTER TABLE platform_user_role_grants RENAME TO platform_grants_missing_fixture",
    );
    try {
      expect((await request(f.actor)).status).toBe(503);
    } finally {
      await pool.query(
        "ALTER TABLE platform_grants_missing_fixture RENAME TO platform_user_role_grants",
      );
    }
  });
});
