import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { sql } from "drizzle-orm";
import {
  readPlatformRoles,
  type PlatformScope,
} from "@crimfig/database/schema";
import { MfaService } from "../mfa/mfa.service";
const rows = (r: any): any[] => r.rows ?? r;
const uuid = (v: unknown) =>
  typeof v === "string" &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
export interface RoleProposal {
  requestId: string;
  targetUserId: string;
  roleKey: string;
  scope: PlatformScope;
  action: "grant" | "revoke";
  reason: string;
  grantExpiresAt?: string;
  code: string;
}
@Injectable()
export class PlatformAccessService {
  constructor(
    @Inject("DATABASE") private readonly db: any,
    private readonly mfa: MfaService,
  ) {}
  private async administrator(tx: any, actor: string, stepup = false) {
    if (!uuid(actor)) throw new ForbiddenException("Platform Admin required");
    const user = rows(
      await tx.execute(
        sql`SELECT status,mfa_enabled FROM users WHERE id=${actor}::uuid FOR SHARE`,
      ),
    )[0];
    if (
      user?.status !== "ACTIVE" ||
      !(await readPlatformRoles(tx, actor, "auth", true)).includes(
        "super_admin",
      )
    )
      throw new ForbiddenException("Active Platform Admin required");
    if (stepup && !user.mfa_enabled)
      throw new ForbiddenException(
        "Enroll MFA before changing platform access",
      );
  }
  private async transaction<T>(work: (tx: any) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction(async (tx: any) => {
        await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
        await tx.execute(sql`SET LOCAL statement_timeout='8s'`);
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended('platform-role-administration',0))`,
        );
        return work(tx);
      });
    } catch (error) {
      if ((error as any)?.code === "42P01" || (error as any)?.code === "08006")
        throw new ServiceUnavailableException(
          "Platform access authority is unavailable",
        );
      throw error;
    }
  }
  async overview(actor: string) {
    return this.transaction(async (tx) => {
      await this.administrator(tx, actor);
      const grants = rows(
        await tx.execute(
          sql`SELECT g.id,g.user_id,g.role_key,g.scope,g.state,g.valid_from,g.expires_at,g.version,g.source,g.updated_at,u.status AS account_status,u.mfa_enabled FROM platform_user_role_grants g JOIN users u ON u.id=g.user_id ORDER BY g.updated_at DESC,g.id LIMIT 200`,
        ),
      );
      const requests = rows(
        await tx.execute(
          sql`SELECT id,target_user_id,role_key,scope,action,reason,requested_by,approved_by,state,expires_at,created_at,decided_at FROM platform_role_change_requests ORDER BY created_at DESC,id LIMIT 100`,
        ),
      );
      const audit = rows(
        await tx.execute(
          sql`SELECT id,request_id,target_user_id,role_key,scope,action,actor_id,approver_id,reason,source,created_at FROM platform_role_audit ORDER BY created_at DESC,id LIMIT 100`,
        ),
      );
      const roles = rows(
        await tx.execute(
          sql`SELECT key,label,scopes FROM platform_roles ORDER BY label`,
        ),
      );
      const accounts = rows(
        await tx.execute(
          sql`SELECT id,email,status FROM users ORDER BY created_at DESC,id LIMIT 200`,
        ),
      );
      return {
        actorId: actor,
        grants,
        requests,
        audit,
        roles,
        accounts,
        proposalValidityMinutes: 15,
      };
    });
  }
  async propose(actor: string, input: RoleProposal) {
    if (
      !uuid(input.requestId) ||
      !uuid(input.targetUserId) ||
      !["ads", "auth", "billing", "auth_finance"].includes(input.scope) ||
      !["grant", "revoke"].includes(input.action) ||
      typeof input.reason !== "string" ||
      input.reason.trim().length < 3 ||
      input.reason.length > 500
    )
      throw new BadRequestException(
        "Valid target, role, scope, action, reason and request ID required",
      );
    if (
      input.grantExpiresAt &&
      !Number.isFinite(Date.parse(input.grantExpiresAt))
    )
      throw new BadRequestException("Invalid grant expiry");
    return this.transaction(async (tx) => {
      await this.administrator(tx, actor, true);
      const old = rows(
        await tx.execute(
          sql`SELECT * FROM platform_role_change_requests WHERE id=${input.requestId}::uuid`,
        ),
      )[0];
      if (old) {
        if (
          old.requested_by !== actor ||
          old.target_user_id !== input.targetUserId ||
          old.role_key !== input.roleKey ||
          old.scope !== input.scope ||
          old.action !== input.action ||
          old.reason !== input.reason.trim() ||
          new Date(old.grant_expires_at ?? 0).getTime() !==
            new Date(input.grantExpiresAt ?? 0).getTime()
        )
          throw new ConflictException(
            "Request identity already binds different proposal details",
          );
        return old;
      }
      const role = rows(
        await tx.execute(
          sql`SELECT key FROM platform_roles WHERE key=${input.roleKey} AND ${input.scope}=ANY(scopes)`,
        ),
      )[0];
      if (!role)
        throw new BadRequestException("Role is not available in that scope");
      const target = rows(
        await tx.execute(
          sql`SELECT status FROM users WHERE id=${input.targetUserId}::uuid FOR SHARE`,
        ),
      )[0];
      if (!target) throw new NotFoundException("Existing user required");
      if (input.action === "grant" && target.status !== "ACTIVE")
        throw new ConflictException(
          "Target account must be active; role grants do not activate accounts",
        );
      const clock = rows(
        await tx.execute(sql`SELECT clock_timestamp() AS now`),
      )[0];
      if (
        input.grantExpiresAt &&
        Date.parse(input.grantExpiresAt) <= new Date(clock.now).getTime()
      )
        throw new BadRequestException("Grant expiry must be in the future");
      if (
        !(await this.mfa.consumeFinancialTotp(
          tx,
          actor,
          input.code,
          new Date(clock.now).getTime(),
        ))
      )
        throw new ForbiddenException(
          "A fresh eligible authenticator code is required",
        );
      const grant = rows(
        await tx.execute(
          sql`SELECT version FROM platform_user_role_grants WHERE user_id=${input.targetUserId}::uuid AND role_key=${input.roleKey} AND scope=${input.scope} FOR UPDATE`,
        ),
      )[0];
      if (input.action === "revoke" && !grant)
        throw new ConflictException("No grant exists to revoke");
      const proposal = rows(
        await tx.execute(
          sql`INSERT INTO platform_role_change_requests(id,target_user_id,role_key,scope,action,reason,requested_by,expected_version,grant_expires_at) VALUES (${input.requestId}::uuid,${input.targetUserId}::uuid,${input.roleKey},${input.scope},${input.action},${input.reason.trim()},${actor}::uuid,${grant?.version ?? 0},${input.grantExpiresAt ?? null}::timestamptz) RETURNING *`,
        ),
      )[0];
      await tx.execute(
        sql`INSERT INTO platform_role_audit(request_id,target_user_id,role_key,scope,action,actor_id,reason,after_state,source) VALUES (${proposal.id}::uuid,${input.targetUserId}::uuid,${input.roleKey},${input.scope},'proposed',${actor}::uuid,${input.reason.trim()},${JSON.stringify({ action: input.action, version: grant?.version ?? 0 })}::jsonb,'admin_management')`,
      );
      return proposal;
    });
  }
  async decide(
    actor: string,
    id: string,
    input: { decision: "approve" | "reject"; code: string },
  ) {
    if (!uuid(id) || !["approve", "reject"].includes(input.decision))
      throw new BadRequestException("Valid proposal and decision required");
    return this.transaction(async (tx) => {
      await this.administrator(tx, actor, true);
      const proposal = rows(
        await tx.execute(
          sql`SELECT * FROM platform_role_change_requests WHERE id=${id}::uuid FOR UPDATE`,
        ),
      )[0];
      if (!proposal) throw new NotFoundException("Proposal not found");
      if (proposal.requested_by === actor)
        throw new ForbiddenException(
          "A different Platform Admin must review this proposal",
        );
      if (proposal.state !== "pending") {
        if (
          proposal.approved_by !== actor ||
          proposal.state !==
            (input.decision === "approve" ? "approved" : "rejected")
        )
          throw new ConflictException("Proposal already decided");
        return proposal;
      }
      await this.administrator(tx, proposal.requested_by, true);
      const clock = rows(
          await tx.execute(sql`SELECT clock_timestamp() AS now`),
        )[0],
        now = new Date(clock.now);
      if (new Date(proposal.expires_at) <= now)
        throw new ConflictException("Proposal expired; create a new proposal");
      if (
        !(await this.mfa.consumeFinancialTotp(
          tx,
          actor,
          input.code,
          now.getTime(),
        ))
      )
        throw new ForbiddenException(
          "A fresh eligible authenticator code is required",
        );
      const prior = rows(
        await tx.execute(
          sql`SELECT * FROM platform_user_role_grants WHERE user_id=${proposal.target_user_id}::uuid AND role_key=${proposal.role_key} AND scope=${proposal.scope} FOR UPDATE`,
        ),
      )[0];
      if ((prior?.version ?? 0) !== proposal.expected_version)
        throw new ConflictException(
          "Assignment changed; create a new proposal",
        );
      if (input.decision === "approve") {
        const target = rows(
          await tx.execute(
            sql`SELECT status FROM users WHERE id=${proposal.target_user_id}::uuid FOR SHARE`,
          ),
        )[0];
        if (proposal.action === "grant" && target?.status !== "ACTIVE")
          throw new ConflictException("Target account must be active");
        if (
          proposal.grant_expires_at &&
          new Date(proposal.grant_expires_at) <= now
        )
          throw new ConflictException("Grant expiry has passed");
        if (
          proposal.action === "revoke" &&
          proposal.role_key === "super_admin"
        ) {
          const other = rows(
            await tx.execute(
              sql`SELECT g.id FROM platform_user_role_grants g JOIN users u ON u.id=g.user_id WHERE g.role_key='super_admin' AND g.scope=${proposal.scope} AND g.user_id<>${proposal.target_user_id}::uuid AND g.state='active' AND u.status='ACTIVE' AND g.valid_from<=clock_timestamp() AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp()) LIMIT 1`,
            ),
          );
          if (!other.length)
            throw new ConflictException(
              "Cannot revoke the last eligible Platform Admin in this scope",
            );
        }
        await tx.execute(
          sql`INSERT INTO platform_user_role_grants(user_id,role_key,scope,state,expires_at,change_request_id,source) VALUES (${proposal.target_user_id}::uuid,${proposal.role_key},${proposal.scope},${proposal.action === "grant" ? "active" : "revoked"},${proposal.action === "grant" ? proposal.grant_expires_at : null}::timestamptz,${id}::uuid,'admin_management') ON CONFLICT(user_id,role_key,scope) DO UPDATE SET state=EXCLUDED.state,valid_from=clock_timestamp(),expires_at=EXCLUDED.expires_at,version=platform_user_role_grants.version+1,change_request_id=EXCLUDED.change_request_id,source=EXCLUDED.source,updated_at=clock_timestamp()`,
        );
      }
      const result = rows(
        await tx.execute(
          sql`UPDATE platform_role_change_requests SET state=${input.decision === "approve" ? "approved" : "rejected"},approved_by=${actor}::uuid,decided_at=clock_timestamp() WHERE id=${id}::uuid RETURNING *`,
        ),
      )[0];
      await tx.execute(
        sql`INSERT INTO platform_role_audit(request_id,target_user_id,role_key,scope,action,actor_id,approver_id,reason,before_state,after_state,source) VALUES (${id}::uuid,${proposal.target_user_id}::uuid,${proposal.role_key},${proposal.scope},${result.state},${proposal.requested_by}::uuid,${actor}::uuid,${proposal.reason},${JSON.stringify(prior ?? null)}::jsonb,${JSON.stringify({ action: proposal.action, decision: input.decision })}::jsonb,'admin_management')`,
      );
      return result;
    });
  }
}
