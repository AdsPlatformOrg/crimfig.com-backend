import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { sql } from "drizzle-orm";
import { JwtAuthGuard } from "../../guards/jwt-auth.guard";
import { AuthRoles } from "../../security/auth-staff-grants";
import { AuthStaffRoleGuard } from "../../security/auth-staff-role.guard";
import { DATABASE_TOKEN } from "../database/database.module";
import { sanitizedDiagnostics } from "@crimfig/shared";

export function diagnosticQuery(q: Record<string, string>) {
  if (Object.values(q).some((value) => typeof value !== "string"))
    throw new BadRequestException("Diagnostic query values must be strings");
  const limit = Number(q.limit || 25),
    offset = Number(q.offset || 0);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 100000
  )
    throw new BadRequestException("Invalid pagination");
  for (const key of [
    "environment",
    "service",
    "requestId",
    "correlationId",
    "groupId",
  ])
    if (q[key] && !/^[a-zA-Z0-9_.-]{1,96}$/.test(q[key]))
      throw new BadRequestException(`Invalid ${key}`);
  if (
    q.groupId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      q.groupId,
    )
  )
    throw new BadRequestException("Invalid group ID");
  return { limit, offset };
}
@ApiTags("Platform Admin � Request Diagnostics")
@ApiBearerAuth()
@UseGuards(ThrottlerGuard, JwtAuthGuard, AuthStaffRoleGuard)
@AuthRoles("super_admin")
@Controller({ path: "admin/error-monitor/occurrences", version: "1" })
export class ErrorDiagnosticsController {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: any) {}
  @Get()
  @Header("Cache-Control", "private, no-store")
  async list(@Query() q: Record<string, string>) {
    const { limit, offset } = diagnosticQuery(q);
    const result = await this.db.execute(sql`
 SELECT id,group_id AS "groupId",request_id AS "requestId",correlation_id AS "correlationId",environment,service,status_code AS "statusCode",normalized_route AS route,occurred_at AS "occurredAt",
 CASE WHEN diagnostics_expires_at<=now() THEN 'expired' WHEN diagnostics IS NULL THEN 'legacy_metadata_only' ELSE 'captured' END AS availability
 FROM error_monitor_occurrences WHERE occurred_at>=now()-interval '90 days'
 AND (${q.environment || null}::text IS NULL OR environment=${q.environment || null})
 AND (${q.service || null}::text IS NULL OR service=${q.service || null})
 AND (${q.requestId || null}::text IS NULL OR request_id=${q.requestId || null})
 AND (${q.correlationId || null}::text IS NULL OR correlation_id=${q.correlationId || null})
 AND (${q.groupId || null}::uuid IS NULL OR group_id=${q.groupId || null}::uuid)
 ORDER BY occurred_at DESC,id DESC LIMIT ${limit} OFFSET ${offset}`);
    return { status: "success", data: { items: result.rows, limit, offset } };
  }
  async read(
    id: string,
    q: Record<string, string>,
    req: any,
    action = "ERROR_DIAGNOSTICS_VIEW",
  ) {
    diagnosticQuery(q);
    const result = await this.db
      .execute(sql`SELECT id,request_id AS "requestId",correlation_id AS "correlationId",environment,service,diagnostics,diagnostics_expires_at AS expires FROM error_monitor_occurrences
   WHERE id=${id}::uuid AND (${q.environment || null}::text IS NULL OR environment=${q.environment || null}) AND (${q.service || null}::text IS NULL OR service=${q.service || null}) LIMIT 1`);
    const row = result.rows[0];
    if (!row) throw new NotFoundException("Occurrence not found in this scope");
    await this.db.execute(
      sql`INSERT INTO audit_logs(user_id,action,resource_type,resource_id,request_id) VALUES(${req.user.sub}::uuid,${action},'error_diagnostic',${id},${req.requestId || null})`,
    );
    const availability =
      row.expires && new Date(row.expires) <= new Date()
        ? "expired"
        : row.diagnostics
          ? "captured"
          : "legacy_metadata_only";
    return {
      status: "success",
      data: {
        id: row.id,
        requestId: row.requestId,
        correlationId: row.correlationId,
        environment: row.environment,
        service: row.service,
        availability,
        diagnostics:
          availability === "captured"
            ? sanitizedDiagnostics(row.diagnostics)
            : null,
      },
    };
  }
  @Get(":id/diagnostics")
  @Header("Cache-Control", "private, no-store")
  detail(
    @Param("id", ParseUUIDPipe) id: string,
    @Query() q: Record<string, string>,
    @Req() req: any,
  ) {
    return this.read(id, q, req);
  }
  @Get(":id/logs")
  @Header("Cache-Control", "private, no-store")
  async logs(
    @Param("id", ParseUUIDPipe) id: string,
    @Query() q: Record<string, string>,
    @Req() req: any,
  ) {
    const { limit, offset } = diagnosticQuery(q);
    const result = await this.read(id, q, req);
    const logs = Array.isArray(result.data.diagnostics?.logs)
      ? result.data.diagnostics.logs
      : [];
    return {
      status: "success",
      data: {
        availability: result.data.availability,
        items: logs.slice(offset, offset + limit),
        total: logs.length,
        limit,
        offset,
      },
    };
  }
  @Get(":id/export")
  @Header("Cache-Control", "private, no-store")
  @Header(
    "Content-Disposition",
    'attachment; filename="masked-error-diagnostics.json"',
  )
  export(
    @Param("id", ParseUUIDPipe) id: string,
    @Query() q: Record<string, string>,
    @Req() req: any,
  ) {
    return this.read(id, q, req, "ERROR_DIAGNOSTICS_EXPORT");
  }
}

for (const name of ["list", "detail", "logs", "export"])
  ApiOperation({
    operationId: `ErrorDiagnostics_${name}`,
    summary: "Super admin only: retained masked error-request diagnostics",
  })(
    ErrorDiagnosticsController.prototype,
    name,
    Object.getOwnPropertyDescriptor(
      ErrorDiagnosticsController.prototype,
      name,
    )!,
  );
