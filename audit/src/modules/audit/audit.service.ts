import { Injectable, Inject, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { eq, desc, and } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { DATABASE_TOKEN } from '../database/database.module';
import { connect, NatsConnection, StringCodec } from 'nats';
import { config } from '../../config/config';

export interface CreateAuditLogDto {
  userId?: string;
  organizationId?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
  success?: string;
  errorCode?: string;
}

@Injectable()
export class AuditService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditService.name);
  private nc?: NatsConnection;
  private sc = StringCodec();

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async onModuleInit() {
    const natsUrl = config.NATS.URL;
    try {
      this.nc = await connect({ servers: natsUrl });
      this.logger.log(`Connected to NATS server at ${natsUrl}`);
      this.subscribeToAuditEvents();
    } catch (err) {
      this.logger.warn(`Could not connect to NATS at ${natsUrl}. Operating in standalone REST mode. Error: ${err}`);
    }
  }

  async onModuleDestroy() {
    if (this.nc) {
      await this.nc.drain();
      this.logger.log('NATS connection drained and closed cleanly');
    }
  }

  /**
   * Subscribe to internal NATS JetStream / Core subjects matching crimfig.*.*.*
   */
  private subscribeToAuditEvents() {
    if (!this.nc) return;
    const sub = this.nc.subscribe('crimfig.>');
    (async () => {
      for await (const m of sub) {
        try {
          const payload = JSON.parse(this.sc.decode(m.data));
          this.logger.debug(`Received NATS event on ${m.subject}: ${JSON.stringify(payload)}`);
          await this.recordLog({
            action: m.subject,
            userId: payload.userId,
            organizationId: payload.organizationId,
            resourceType: payload.resourceType,
            resourceId: payload.resourceId,
            metadata: payload.metadata ?? payload,
            ipAddress: payload.ipAddress,
            userAgent: payload.userAgent,
            requestId: payload.requestId,
            success: payload.success ?? 'true',
            errorCode: payload.errorCode,
          });
        } catch (err) {
          this.logger.error(`Error processing NATS audit event on ${m.subject}`, err);
        }
      }
    })();
  }

  /**
   * Insert a new audit log record
   */
  async recordLog(dto: CreateAuditLogDto) {
    const [record] = await this.db
      .insert(schema.auditLogs)
      .values({
        userId: dto.userId,
        organizationId: dto.organizationId,
        action: dto.action,
        resourceType: dto.resourceType,
        resourceId: dto.resourceId,
        metadata: dto.metadata,
        ipAddress: dto.ipAddress,
        userAgent: dto.userAgent,
        requestId: dto.requestId,
        success: dto.success ?? 'true',
        errorCode: dto.errorCode,
      })
      .returning();

    return record;
  }

  /**
   * Query audit logs with pagination & filtering
   */
  async queryLogs(params: {
    userId?: string;
    organizationId?: string;
    action?: string;
    resourceType?: string;
    page?: number;
    limit?: number;
  }) {
    const page = params.page && params.page > 0 ? params.page : 1;
    const limit = params.limit && params.limit > 0 ? Math.min(params.limit, 100) : 20;
    const offset = (page - 1) * limit;

    const conditions = [];
    if (params.userId) conditions.push(eq(schema.auditLogs.userId, params.userId));
    if (params.organizationId) conditions.push(eq(schema.auditLogs.organizationId, params.organizationId));
    if (params.action) conditions.push(eq(schema.auditLogs.action, params.action));
    if (params.resourceType) conditions.push(eq(schema.auditLogs.resourceType, params.resourceType));

    const logs = await this.db.query.auditLogs.findMany({
      where: conditions.length > 0 ? and(...conditions) : undefined,
      orderBy: [desc(schema.auditLogs.createdAt)],
      limit,
      offset,
    });

    return {
      data: logs,
      page,
      limit,
    };
  }
}
