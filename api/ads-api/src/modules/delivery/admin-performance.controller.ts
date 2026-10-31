import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiOkResponse,
} from "@nestjs/swagger";
import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
} from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DATABASE_TOKEN } from "../database/database.module";
import { AdsRoles } from "../security/ads-staff-grants";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function performanceWindow(q: Record<string, string>, now = new Date()) {
  if (Object.values(q).some((value) => typeof value !== "string"))
    throw new BadRequestException("Reporting query values must be strings");
  const days = ({ "24h": 1, "7d": 7, "30d": 30 } as Record<string, number>)[
    q.range || "7d"
  ];
  if (!days) throw new BadRequestException("Unsupported reporting range");
  const to = q.to ? new Date(q.to) : now;
  const from = q.from
    ? new Date(q.from)
    : new Date(to.getTime() - days * 86400000);
  if (
    !Number.isFinite(+from) ||
    !Number.isFinite(+to) ||
    +from >= +to ||
    +to - +from > 90 * 86400000
  )
    throw new BadRequestException(
      "Use an ordered reporting window of at most 90 days",
    );
  for (const key of ["websiteId", "slotId", "promoterId", "creativeId"])
    if (q[key] && !uuid.test(q[key]))
      throw new BadRequestException(`Invalid ${key}`);
  const page = Number(q.page || 1),
    limit = Number(q.limit || 25);
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    page > 10000 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new BadRequestException("Invalid pagination");
  if (q.format && !/^[a-z_]{1,50}$/.test(q.format))
    throw new BadRequestException("Invalid format");
  if (
    q.inventory &&
    !["house", "shadow", "paid", "direct", "simulated_paid"].includes(
      q.inventory,
    )
  )
    throw new BadRequestException("Invalid inventory class");
  return { from: from.toISOString(), to: to.toISOString(), page, limit };
}
export function performanceRates(row: any) {
  const count = (key: string) => Number(row[key] || 0);
  const serves = count("serves"),
    renders = count("renders"),
    impressions = count("impressions"),
    clicks = count("clicks"),
    measurable = count("measurable");
  return {
    ...row,
    serves,
    renders,
    impressions,
    clicks,
    measurable,
    viewable: count("viewable"),
    ctr: impressions ? (count("impressionClicks") / impressions) * 100 : null,
    renderRate: serves ? (renders / serves) * 100 : null,
    viewability: measurable ? (count("viewable") / measurable) * 100 : null,
    renderPending: Math.max(0, serves - renders),
    clickToServeRate: serves ? (clicks / serves) * 100 : null,
  };
}

@ApiTags("Admin Delivery Performance")
@ApiBearerAuth()
@AdsRoles("ads_admin", "super_admin")
@Controller("admin/ads")
export class AdminPerformanceController {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: any) {}

  /** Cohort report: select issued serves in [from,to), count their events before to. */
  async report(
    kind: "creatives" | "websites" | "slots" | "promoters",
    q: Record<string, string>,
    id?: string,
    houseOnly = false,
  ) {
    const window = performanceWindow(q);
    const filter = sql`AND (${q.websiteId || null}::uuid IS NULL OR s.website_id=${q.websiteId || null}::uuid)
      AND (${q.slotId || null}::uuid IS NULL OR s.slot_id=${q.slotId || null}::uuid)
      AND (${q.promoterId || null}::uuid IS NULL OR s.promoter_id=${q.promoterId || null}::uuid)
      AND (${q.format || null}::text IS NULL OR EXISTS(SELECT 1 FROM adstation_slots fs WHERE fs.id=s.slot_id AND fs.format=${q.format || null}))
      AND (${q.creativeId || null}::uuid IS NULL OR s.house_creative_id=${q.creativeId || null}::uuid)
      AND (${houseOnly ? "house" : q.inventory || null}::text IS NULL OR s.inventory_class=${houseOnly ? "house" : q.inventory || null})`;
    // All SQL identifiers below are server constants, never user supplied.
    const dimension = {
      creatives: "house_creative_id",
      websites: "website_id",
      slots: "slot_id",
      promoters: "promoter_id",
    }[kind];
    const table = {
      creatives: "ads_house_creatives",
      websites: "ads_promoter_websites",
      slots: "adstation_slots",
      promoters: "ads_promoters",
    }[kind];
    const label = {
      creatives: "d.title",
      websites: "d.domain",
      slots: "d.name",
      promoters: "d.id::text",
    }[kind];
    const extra =
      kind === "websites"
        ? sql`d.domain, d.promoter_id AS "promoterId", d.verification_status AS "verificationStatus", d.policy_status AS "policyStatus",`
        : kind === "slots"
          ? sql`d.website_id AS "websiteId", d.promoter_id AS "promoterId", d.format, d.lifecycle_status AS "lifecycleStatus", d.installation_status AS "installationStatus",`
          : kind === "creatives"
            ? sql`d.is_archived AS "isArchived", d.ad_type AS "adType", d.format,`
            : sql``;
    const base = sql`WITH events AS (
      SELECT serve_id, bool_or(type='render') AS rendered, bool_or(type='impression') AS impressed,
        bool_or(type='viewable_impression') AS viewable, bool_or(type='impression' AND measurable) AS measurable,
        bool_or(type='click') AS clicked, max(created_at) AS last_event, max(created_at) FILTER(WHERE type='render') AS last_render
      FROM ads_interactions WHERE created_at >= ${window.from}::timestamptz AND created_at < ${window.to}::timestamptz
      GROUP BY serve_id
    ), cohort AS (
      SELECT s.*, e.rendered, e.impressed, e.viewable, e.measurable, e.clicked, e.last_event, e.last_render FROM ads_serves s
      LEFT JOIN events e ON e.serve_id=s.id
      WHERE s.served_at >= ${window.from}::timestamptz AND s.served_at < ${window.to}::timestamptz ${filter}
    )`;
    const aggregate = sql`count(s.id)::int AS serves, count(s.id) FILTER(WHERE s.rendered)::int AS renders,
      count(s.id) FILTER(WHERE s.impressed)::int AS impressions, count(s.id) FILTER(WHERE s.measurable)::int AS measurable,
      count(s.id) FILTER(WHERE s.viewable AND s.measurable)::int AS viewable,
      count(s.id) FILTER(WHERE s.clicked)::int AS clicks, count(s.id) FILTER(WHERE s.clicked AND s.impressed)::int AS "impressionClicks",
      max(s.served_at) AS "lastServeAt", max(s.last_event) AS "lastEventAt", max(s.last_render) AS "lastRenderAt"`;
    return this.db.transaction(
      async (tx: any) => {
        await tx.execute(sql`SET LOCAL statement_timeout='8s'`);
        let subject: any = null;
        for (const [key, objectTable] of Object.entries({
          websiteId: "ads_promoter_websites",
          slotId: "adstation_slots",
          promoterId: "ads_promoters",
          creativeId: "ads_house_creatives",
        })) {
          if (q[key]) {
            const fields =
              key === "websiteId"
                ? sql`id,domain AS label,verification_status AS "verificationStatus",policy_status AS "policyStatus",promoter_id AS "promoterId"`
                : key === "slotId"
                  ? sql`id,name AS label,format,lifecycle_status AS "lifecycleStatus",installation_status AS "installationStatus",website_id AS "websiteId",promoter_id AS "promoterId"`
                  : key === "creativeId"
                    ? sql`id,title AS label,version,is_archived AS "isArchived"`
                    : sql`id,id::text AS label`;
            const found = await tx.execute(
              sql`SELECT ${fields} FROM ${sql.raw(objectTable)} WHERE id=${q[key]}::uuid LIMIT 1`,
            );
            if (!found.rows.length)
              throw new NotFoundException("Reporting object not found");
            subject = { ...subject, [key]: found.rows[0] };
          }
        }
        const summary = (
          await tx.execute(
            sql`${base} SELECT ${aggregate}, count(s.id) FILTER(WHERE s.house_creative_id IS NULL AND s.inventory_class='house')::int AS unattributed FROM cohort s`,
          )
        ).rows[0];
        const rows = (
          await tx.execute(sql`${base} SELECT d.id, ${sql.raw(label)} AS label, ${extra} ${aggregate}
        FROM ${sql.raw(table)} d LEFT JOIN cohort s ON s.${sql.raw(dimension)}=d.id
        WHERE (${id || null}::uuid IS NULL OR d.id=${id || null}::uuid)
        ${kind === "websites" && q.promoterId ? sql`AND d.promoter_id=${q.promoterId}::uuid` : sql``}
        ${kind === "slots" && q.websiteId ? sql`AND d.website_id=${q.websiteId}::uuid` : sql``}
        ${kind === "slots" && q.promoterId ? sql`AND d.promoter_id=${q.promoterId}::uuid` : sql``}
        GROUP BY d.id ORDER BY serves DESC, d.id LIMIT ${window.limit} OFFSET ${(window.page - 1) * window.limit}`)
        ).rows;
        if (id && !rows.length)
          throw new NotFoundException("Reporting object not found");
        const total = (
          await tx.execute(sql`SELECT count(*)::int AS total FROM ${sql.raw(table)} d
        WHERE (${id || null}::uuid IS NULL OR d.id=${id || null}::uuid)
        ${kind === "websites" && q.promoterId ? sql`AND d.promoter_id=${q.promoterId}::uuid` : sql``}
        ${kind === "slots" && q.websiteId ? sql`AND d.website_id=${q.websiteId}::uuid` : sql``}
        ${kind === "slots" && q.promoterId ? sql`AND d.promoter_id=${q.promoterId}::uuid` : sql``}`)
        ).rows[0].total;
        const series = (
          await tx.execute(
            sql`${base} SELECT date_trunc('day', s.served_at AT TIME ZONE 'UTC') AS day, ${aggregate} FROM cohort s GROUP BY day ORDER BY day`,
          )
        ).rows;
        const inventory = (
          await tx.execute(
            sql`${base} SELECT s.inventory_class AS "inventoryClass", ${aggregate} FROM cohort s GROUP BY s.inventory_class ORDER BY s.inventory_class`,
          )
        ).rows;
        return {
          status: "success",
          data: {
            subject,
            summary: performanceRates(summary),
            items: rows.map(performanceRates),
            series: series.map(performanceRates),
            inventory: inventory.map(performanceRates),
            ...window,
            total: Number(total),
            asOf: new Date().toISOString(),
            definitions: {
              basis:
                "Serves issued in UTC [from,to); deduplicated events observed before to. CTR counts clicked-and-impressed serves / impressed serves.",
              requests: "unknown",
              noFill: "unknown",
              browserFailures: "unknown",
              billing:
                "House and Shadow are non-payable. These are operational counts.",
              coverage:
                "Historical House creative identity may be unavailable; unattributed serves remain in summary.",
            },
          },
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }
  @Get("house-creatives/analytics") house(@Query() q: Record<string, string>) {
    return this.report("creatives", q, undefined, true);
  }
  @Get("house-creatives/:id/analytics") creative(
    @Param("id", ParseUUIDPipe) id: string,
    @Query() q: Record<string, string>,
  ) {
    return this.report("websites", { ...q, creativeId: id }, undefined, true);
  }
  @Get("websites/analytics") websites(@Query() q: Record<string, string>) {
    return this.report("websites", q);
  }
  @Get("websites/:id/analytics") website(
    @Param("id", ParseUUIDPipe) id: string,
    @Query() q: Record<string, string>,
  ) {
    return this.report("slots", { ...q, websiteId: id });
  }
  @Get("slots/analytics") slots(@Query() q: Record<string, string>) {
    return this.report("slots", q);
  }
  @Get("slots/:id/analytics") slot(
    @Param("id", ParseUUIDPipe) id: string,
    @Query() q: Record<string, string>,
  ) {
    return this.report("creatives", { ...q, slotId: id });
  }
  @Get("promoters/:id/analytics") promoter(
    @Param("id", ParseUUIDPipe) id: string,
    @Query() q: Record<string, string>,
  ) {
    return this.report("websites", { ...q, promoterId: id });
  }
}

// Explicit API metadata for the shared reporting contract; queries remain validated by performanceWindow.
for (const name of [
  "house",
  "creative",
  "websites",
  "website",
  "slots",
  "slot",
  "promoter",
]) {
  const descriptor = Object.getOwnPropertyDescriptor(
    AdminPerformanceController.prototype,
    name,
  )!;
  ApiOperation({
    operationId: `AdminPerformance_${name}`,
    summary: "Read scoped, deduplicated operational delivery evidence",
  })(AdminPerformanceController.prototype, name, descriptor);
  for (const key of [
    "range",
    "from",
    "to",
    "page",
    "limit",
    "inventory",
    "format",
    "creativeId",
    "websiteId",
    "slotId",
    "promoterId",
  ])
    ApiQuery({
      name: key,
      required: false,
      type: String,
      description:
        key === "limit"
          ? "1�100"
          : key === "range"
            ? "24h, 7d, 30d"
            : key === "from" || key === "to"
              ? "ISO 8601 UTC; window at most 90 days"
              : "Reporting scope",
    })(AdminPerformanceController.prototype, name, descriptor);
  ApiOkResponse({
    schema: {
      type: "object",
      required: ["status", "data"],
      properties: {
        status: { type: "string", enum: ["success"] },
        data: {
          type: "object",
          required: [
            "summary",
            "items",
            "series",
            "inventory",
            "page",
            "limit",
            "total",
            "asOf",
            "definitions",
          ],
          properties: {
            summary: { type: "object", additionalProperties: true },
            items: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
            series: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
            inventory: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
            page: { type: "integer" },
            limit: { type: "integer" },
            total: { type: "integer" },
            asOf: { type: "string", format: "date-time" },
            definitions: {
              type: "object",
              additionalProperties: { type: "string" },
            },
          },
        },
      },
    },
  })(AdminPerformanceController.prototype, name, descriptor);
}
