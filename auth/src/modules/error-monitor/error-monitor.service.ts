import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import {
  errorMonitorGroups,
  errorMonitorOccurrences,
  errorMonitorOutbox,
  errorMonitorSources,
} from '@crimfig/database/schema';
import {
  and,
  desc,
  eq,
  gte,
  lte,
  or,
  sql,
  inArray,
} from 'drizzle-orm';
import {
  ALLOWLISTED_ERROR_SERVICES,
  MAX_OCCURRENCE_SAMPLES_PER_GROUP,
  redactAndSanitizeErrorEvent,
  resolveErrorMonitorConfig,
  sanitizeMonitorString,
  type ErrorMonitorSink,
  type NotificationDeliveryState,
  type RawErrorCaptureInput,
  type SanitizedErrorMonitorEvent,
} from '@crimfig/shared';
import { DATABASE_TOKEN } from '../database/database.module';
import { EmailService } from '../email/email.service';
import { config } from '../../config/config';
import { randomUUID } from 'crypto';

export interface PlatformSourceDescriptor {
  service: string;
  displayName: string;
  sourceType: 'server' | 'browser';
  defaultStatus: 'active' | 'not_reporting' | 'paused' | 'uninstrumented';
  statusNote: string;
}

export const PLATFORM_ERROR_MONITOR_SOURCES: readonly PlatformSourceDescriptor[] = Object.freeze([
  {
    service: 'auth-api',
    displayName: 'Auth API',
    sourceType: 'server',
    defaultStatus: 'active',
    statusNote: 'Instrumented via shared NestJS error capture hook',
  },
  {
    service: 'ads-api',
    displayName: 'Ads API',
    sourceType: 'server',
    defaultStatus: 'active',
    statusNote: 'Instrumented via shared NestJS error capture & global exception filter',
  },
  {
    service: 'billing-api',
    displayName: 'Billing API',
    sourceType: 'server',
    defaultStatus: 'active',
    statusNote: 'Instrumented via shared NestJS error capture & financial route decorators',
  },
  {
    service: 'auth-web',
    displayName: 'Auth Web App',
    sourceType: 'browser',
    defaultStatus: 'active',
    statusNote: 'First-party sanitized browser boundary reporting (monitor only)',
  },
  {
    service: 'ads-web',
    displayName: 'Ads Web App',
    sourceType: 'browser',
    defaultStatus: 'active',
    statusNote: 'First-party sanitized browser boundary reporting (monitor only)',
  },
  {
    service: 'billing-web',
    displayName: 'Billing Web App',
    sourceType: 'browser',
    defaultStatus: 'active',
    statusNote: 'First-party sanitized browser boundary reporting (monitor only)',
  },
  {
    service: 'shop-web',
    displayName: 'Shop Web App',
    sourceType: 'browser',
    defaultStatus: 'not_reporting',
    statusNote: 'Registered first-party app — awaiting traffic',
  },
  {
    service: 'nats',
    displayName: 'NATS Broker',
    sourceType: 'server',
    defaultStatus: 'paused',
    statusNote: 'Paused — intentionally offline per infrastructure directive',
  },
  {
    service: 'chat-frontend',
    displayName: 'CHAT-frontend',
    sourceType: 'browser',
    defaultStatus: 'paused',
    statusNote: 'Paused — intentionally offline per infrastructure directive',
  },
  {
    service: 'tetris-frontend',
    displayName: 'TETRIS-frontend',
    sourceType: 'browser',
    defaultStatus: 'paused',
    statusNote: 'Paused — intentionally offline per infrastructure directive',
  },
]);

export interface ErrorMonitorQueryFilters {
  environment?: string;
  service?: string;
  source?: string;
  statusCode?: number;
  statusClass?: '4xx' | '5xx';
  route?: string;
  errorCategory?: string;
  requestId?: string;
  emailState?: string;
  timeRange?: '1h' | '24h' | '7d' | '30d' | 'all';
  limit?: number;
  offset?: number;
}

@Injectable()
export class ErrorMonitorService implements ErrorMonitorSink {
  private readonly workerId = `auth-error-worker-${randomUUID().slice(0, 8)}`;

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly emailService: EmailService,
  ) {}

  async ingestRawEvent(
    rawInput: RawErrorCaptureInput,
    env: Record<string, string | undefined> = process.env,
  ) {
    const candidateService = String(rawInput?.service || '')
      .trim()
      .toLowerCase();
    if (!ALLOWLISTED_ERROR_SERVICES.includes(candidateService as any)) {
      throw new BadRequestException(
        `Service "${sanitizeMonitorString(candidateService, 40)}" is not an allowlisted CrimFig error source.`,
      );
    }

    const sanitized = redactAndSanitizeErrorEvent(rawInput, env);
    return this.recordEvent(sanitized, env);
  }

  async recordEvent(
    event: SanitizedErrorMonitorEvent,
    env: Record<string, string | undefined> = process.env,
  ) {
    if (event.statusCode < 400 || event.statusCode > 599) {
      return { recorded: false as const, reason: 'NON_ERROR_STATUS' as const };
    }

    const runtimeConfig = resolveErrorMonitorConfig(env);
    const now = event.occurredAt instanceof Date ? event.occurredAt : new Date();
    const monitorUrl = `${config.APP.AUTH_WEB_URL}/admin/error-monitor?requestId=${encodeURIComponent(event.requestId)}`;

    return this.db.transaction(async (tx) => {
      await tx
        .insert(errorMonitorSources)
        .values({
          service: event.service,
          environment: event.environment,
          displayName: event.service,
          sourceType: event.source,
          status: 'active',
          captureEnabled: true,
          lastHeartbeatAt: now,
          lastEventAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [errorMonitorSources.environment, errorMonitorSources.service],
          set: {
            status: 'active',
            lastHeartbeatAt: now,
            lastEventAt: now,
            updatedAt: now,
          },
        });

      const [existingGroup] = await tx
        .select()
        .from(errorMonitorGroups)
        .where(
          and(
            eq(errorMonitorGroups.environment, event.environment),
            eq(errorMonitorGroups.fingerprint, event.fingerprint),
          ),
        )
        .for('update')
        .limit(1);

      let group: typeof errorMonitorGroups.$inferSelect;
      let outboxScheduled: 'none' | 'initial' | 'window_summary' = 'none';

      const isEligible = event.emailEligibility === 'eligible';
      const initialNotificationState: NotificationDeliveryState = !isEligible
        ? 'excluded_by_policy'
        : !runtimeConfig.emailEnabled
          ? 'disabled'
          : 'pending';

      if (!existingGroup) {
        const windowStartedAt = isEligible ? now : null;
        const windowEndsAt = isEligible
          ? new Date(now.getTime() + event.suppressionWindowMs)
          : null;

        const [inserted] = await tx
          .insert(errorMonitorGroups)
          .values({
            fingerprint: event.fingerprint,
            environment: event.environment,
            service: event.service,
            source: event.source,
            httpMethod: event.httpMethod,
            normalizedRoute: event.normalizedRoute,
            statusCode: event.statusCode,
            severity: event.severity,
            errorCategory: event.errorCategory,
            safeSummary: event.safeSummary,
            isFinancialRoute: event.isFinancialRoute,
            financialCategory: event.financialCategory,
            emailEligibility: event.emailEligibility,
            exclusionReason: event.exclusionReason,
            notificationState: initialNotificationState,
            occurrenceCount: 1,
            sampledOccurrenceCount: 1,
            windowStartedAt,
            windowEndsAt,
            windowSuppressedCount: 0,
            firstSeenAt: now,
            lastSeenAt: now,
            lastRequestId: event.requestId,
            railwayLogUrl: event.railwayLogUrl,
            updatedAt: now,
          })
          .returning();

        group = inserted;

        if (isEligible && runtimeConfig.emailEnabled && windowStartedAt && windowEndsAt) {
          const emailPayload = this.emailService.buildErrorAlertEmailContent({
            kind: 'initial',
            environment: event.environment,
            service: event.service,
            httpMethod: event.httpMethod,
            normalizedRoute: event.normalizedRoute,
            statusCode: event.statusCode,
            errorCategory: event.errorCategory,
            safeSummary: event.safeSummary,
            requestId: event.requestId,
            correlationId: event.correlationId,
            occurrenceCount: 1,
            windowStartedAt,
            windowEndsAt,
            railwayLogUrl: event.railwayLogUrl,
            monitorUrl,
          });

          const dedupeKey = `initial:${group.id}:${windowStartedAt.getTime()}`;
          await tx
            .insert(errorMonitorOutbox)
            .values({
              groupId: group.id,
              dedupeKey,
              kind: 'initial',
              environment: event.environment,
              recipients: [...runtimeConfig.recipients],
              subject: emailPayload.subject,
              htmlBody: emailPayload.htmlContent,
              textBody: emailPayload.textContent,
              occurrenceCount: 1,
              windowStartedAt,
              windowEndsAt,
              status: 'pending',
              nextAttemptAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing({ target: errorMonitorOutbox.dedupeKey });

          outboxScheduled = 'initial';
        }
      } else {
        const nextOccurrenceCount = existingGroup.occurrenceCount + 1;
        const canSample = existingGroup.sampledOccurrenceCount < MAX_OCCURRENCE_SAMPLES_PER_GROUP;
        const nextSampledCount = canSample
          ? existingGroup.sampledOccurrenceCount + 1
          : existingGroup.sampledOccurrenceCount;

        const activeWindowValid =
          isEligible &&
          existingGroup.windowStartedAt instanceof Date &&
          existingGroup.windowEndsAt instanceof Date &&
          now.getTime() < existingGroup.windowEndsAt.getTime();

        let windowStartedAt = existingGroup.windowStartedAt;
        let windowEndsAt = existingGroup.windowEndsAt;
        let windowSuppressedCount = existingGroup.windowSuppressedCount;
        let notificationState = existingGroup.notificationState as NotificationDeliveryState;

        if (!isEligible) {
          notificationState = 'excluded_by_policy';
        } else if (!runtimeConfig.emailEnabled) {
          notificationState = 'disabled';
          if (!activeWindowValid) {
            windowStartedAt = now;
            windowEndsAt = new Date(now.getTime() + event.suppressionWindowMs);
            windowSuppressedCount = 0;
          } else {
            windowSuppressedCount += 1;
          }
        } else if (activeWindowValid && windowStartedAt && windowEndsAt) {
          windowSuppressedCount += 1;
          notificationState = 'suppressed_duplicate';

          const totalInWindow = windowSuppressedCount + 1;
          const summaryPayload = this.emailService.buildErrorAlertEmailContent({
            kind: 'window_summary',
            environment: event.environment,
            service: event.service,
            httpMethod: event.httpMethod,
            normalizedRoute: event.normalizedRoute,
            statusCode: event.statusCode,
            errorCategory: event.errorCategory,
            safeSummary: event.safeSummary,
            requestId: event.requestId,
            correlationId: event.correlationId,
            occurrenceCount: totalInWindow,
            windowStartedAt,
            windowEndsAt,
            railwayLogUrl: event.railwayLogUrl,
            monitorUrl,
          });

          const summaryDedupeKey = `summary:${existingGroup.id}:${windowStartedAt.getTime()}`;
          await tx
            .insert(errorMonitorOutbox)
            .values({
              groupId: existingGroup.id,
              dedupeKey: summaryDedupeKey,
              kind: 'window_summary',
              environment: event.environment,
              recipients: [...runtimeConfig.recipients],
              subject: summaryPayload.subject,
              htmlBody: summaryPayload.htmlContent,
              textBody: summaryPayload.textContent,
              occurrenceCount: totalInWindow,
              windowStartedAt,
              windowEndsAt,
              status: 'pending',
              nextAttemptAt: windowEndsAt,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: errorMonitorOutbox.dedupeKey,
              set: {
                subject: summaryPayload.subject,
                htmlBody: summaryPayload.htmlContent,
                textBody: summaryPayload.textContent,
                occurrenceCount: totalInWindow,
                updatedAt: now,
              },
            });

          outboxScheduled = 'window_summary';
        } else {
          windowStartedAt = now;
          windowEndsAt = new Date(now.getTime() + event.suppressionWindowMs);
          windowSuppressedCount = 0;
          notificationState = 'pending';

          const emailPayload = this.emailService.buildErrorAlertEmailContent({
            kind: 'initial',
            environment: event.environment,
            service: event.service,
            httpMethod: event.httpMethod,
            normalizedRoute: event.normalizedRoute,
            statusCode: event.statusCode,
            errorCategory: event.errorCategory,
            safeSummary: event.safeSummary,
            requestId: event.requestId,
            correlationId: event.correlationId,
            occurrenceCount: 1,
            windowStartedAt,
            windowEndsAt,
            railwayLogUrl: event.railwayLogUrl,
            monitorUrl,
          });

          const dedupeKey = `initial:${existingGroup.id}:${windowStartedAt.getTime()}`;
          await tx
            .insert(errorMonitorOutbox)
            .values({
              groupId: existingGroup.id,
              dedupeKey,
              kind: 'initial',
              environment: event.environment,
              recipients: [...runtimeConfig.recipients],
              subject: emailPayload.subject,
              htmlBody: emailPayload.htmlContent,
              textBody: emailPayload.textContent,
              occurrenceCount: 1,
              windowStartedAt,
              windowEndsAt,
              status: 'pending',
              nextAttemptAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing({ target: errorMonitorOutbox.dedupeKey });

          outboxScheduled = 'initial';
        }

        const [updated] = await tx
          .update(errorMonitorGroups)
          .set({
            occurrenceCount: nextOccurrenceCount,
            sampledOccurrenceCount: nextSampledCount,
            windowStartedAt,
            windowEndsAt,
            windowSuppressedCount,
            notificationState,
            lastSeenAt: now,
            lastRequestId: event.requestId,
            railwayLogUrl: event.railwayLogUrl,
            updatedAt: now,
          })
          .where(eq(errorMonitorGroups.id, existingGroup.id))
          .returning();

        group = updated;
      }

      const shouldInsertSample =
        !existingGroup || existingGroup.sampledOccurrenceCount < MAX_OCCURRENCE_SAMPLES_PER_GROUP;

      if (shouldInsertSample) {
        await tx.insert(errorMonitorOccurrences).values({
          groupId: group.id,
          requestId: event.requestId,
          correlationId: event.correlationId,
          environment: event.environment,
          service: event.service,
          deploymentId: event.deploymentId,
          source: event.source,
          httpMethod: event.httpMethod,
          normalizedRoute: event.normalizedRoute,
          statusCode: event.statusCode,
          errorCategory: event.errorCategory,
          safeSummary: event.safeSummary,
          upstreamService: event.upstreamService,
          upstreamStatusCode: event.upstreamStatusCode,
          actorUserId: event.actorUserId,
          deviceType: event.deviceType,
          countryCode: event.countryCode,
          sanitizedContext: event.sanitizedContext,
          railwayLogUrl: event.railwayLogUrl,
          occurredAt: now,
        });
      }

      return {
        recorded: true as const,
        groupId: group.id,
        fingerprint: group.fingerprint,
        emailEligibility: group.emailEligibility,
        exclusionReason: group.exclusionReason,
        notificationState: group.notificationState,
        occurrenceCount: group.occurrenceCount,
        windowSuppressedCount: group.windowSuppressedCount,
        outboxScheduled,
      };
    });
  }

  async processDueOutbox(now: Date = new Date(), batchSize = 10) {
    const leaseDurationMs = 60_000;
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

    const dueItems = await this.db
      .select()
      .from(errorMonitorOutbox)
      .where(
        and(
          inArray(errorMonitorOutbox.status, ['pending', 'failed']),
          lte(errorMonitorOutbox.nextAttemptAt, now),
          or(
            sql`${errorMonitorOutbox.leaseExpiresAt} IS NULL`,
            lte(errorMonitorOutbox.leaseExpiresAt, now),
          ),
        ),
      )
      .orderBy(errorMonitorOutbox.nextAttemptAt)
      .limit(Math.max(1, Math.min(batchSize, 50)));

    const results: Array<{
      outboxId: string;
      groupId: string;
      kind: string;
      status: string;
      providerMessageId?: string;
      error?: string;
    }> = [];

    for (const item of dueItems) {
      if (item.attempts >= item.maxAttempts) {
        continue;
      }

      const [leased] = await this.db
        .update(errorMonitorOutbox)
        .set({
          status: 'processing',
          leaseOwner: this.workerId,
          leaseExpiresAt,
          updatedAt: now,
        })
        .where(
          and(
            eq(errorMonitorOutbox.id, item.id),
            or(
              sql`${errorMonitorOutbox.leaseExpiresAt} IS NULL`,
              lte(errorMonitorOutbox.leaseExpiresAt, now),
            ),
          ),
        )
        .returning();

      if (!leased) continue;

      const delivery = await this.emailService.sendErrorAlertEmail({
        recipients: Array.isArray(leased.recipients) ? leased.recipients : [],
        subject: leased.subject,
        htmlContent: leased.htmlBody,
        textContent: leased.textBody,
      });

      const nextAttempts = leased.attempts + 1;
      if (delivery.accepted) {
        await this.db
          .update(errorMonitorOutbox)
          .set({
            status: 'provider_accepted',
            attempts: nextAttempts,
            providerMessageId: delivery.providerMessageId ?? null,
            lastError: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: now,
          })
          .where(eq(errorMonitorOutbox.id, leased.id));

        await this.db
          .update(errorMonitorGroups)
          .set({
            notificationState: 'provider_accepted',
            updatedAt: now,
          })
          .where(eq(errorMonitorGroups.id, leased.groupId));

        results.push({
          outboxId: leased.id,
          groupId: leased.groupId,
          kind: leased.kind,
          status: 'provider_accepted',
          providerMessageId: delivery.providerMessageId,
        });
      } else {
        const backoffSeconds = Math.min(900, Math.pow(2, nextAttempts) * 15);
        const nextAttemptAt = new Date(now.getTime() + backoffSeconds * 1000);
        const exhausted = nextAttempts >= leased.maxAttempts;

        await this.db
          .update(errorMonitorOutbox)
          .set({
            status: 'failed',
            attempts: nextAttempts,
            nextAttemptAt,
            lastError: delivery.error ?? 'DELIVERY_FAILED',
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: now,
          })
          .where(eq(errorMonitorOutbox.id, leased.id));

        await this.db
          .update(errorMonitorGroups)
          .set({
            notificationState: exhausted ? 'failed' : 'pending',
            updatedAt: now,
          })
          .where(eq(errorMonitorGroups.id, leased.groupId));

        results.push({
          outboxId: leased.id,
          groupId: leased.groupId,
          kind: leased.kind,
          status: 'failed',
          error: delivery.error,
        });
      }
    }

    return {
      processedCount: results.length,
      results,
    };
  }

  private resolveSinceTimestamp(timeRange?: string): Date | null {
    const now = Date.now();
    switch (timeRange) {
      case '1h':
        return new Date(now - 60 * 60 * 1000);
      case '24h':
        return new Date(now - 24 * 60 * 60 * 1000);
      case '7d':
        return new Date(now - 7 * 24 * 60 * 60 * 1000);
      case '30d':
        return new Date(now - 30 * 24 * 60 * 60 * 1000);
      case 'all':
        return null;
      default:
        return new Date(now - 24 * 60 * 60 * 1000);
    }
  }

  async getSummary(filters: ErrorMonitorQueryFilters = {}) {
    const since = this.resolveSinceTimestamp(filters.timeRange);
    const conditions = [];

    if (filters.environment && filters.environment !== 'all') {
      conditions.push(eq(errorMonitorGroups.environment, filters.environment));
    }
    if (filters.service && filters.service !== 'all') {
      conditions.push(eq(errorMonitorGroups.service, filters.service));
    }
    if (since) {
      conditions.push(gte(errorMonitorGroups.lastSeenAt, since));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const groups = await this.db
      .select()
      .from(errorMonitorGroups)
      .where(whereClause);

    let totalGroups = 0;
    let totalOccurrences = 0;
    let server5xxGroups = 0;
    let financialAlertGroups = 0;
    let monitorOnlyGroups = 0;
    let providerAcceptedGroups = 0;
    let suppressedDuplicateCount = 0;
    let failedEmailGroups = 0;

    for (const g of groups) {
      totalGroups += 1;
      totalOccurrences += g.occurrenceCount;
      suppressedDuplicateCount += g.windowSuppressedCount;
      if (g.statusCode >= 500) server5xxGroups += 1;
      if (g.isFinancialRoute && g.emailEligibility === 'eligible') financialAlertGroups += 1;
      if (g.emailEligibility === 'excluded_by_policy') monitorOnlyGroups += 1;
      if (g.notificationState === 'provider_accepted') providerAcceptedGroups += 1;
      if (g.notificationState === 'failed') failedEmailGroups += 1;
    }

    const runtimeConfig = resolveErrorMonitorConfig();

    return {
      totalGroups,
      totalOccurrences,
      server5xxGroups,
      financialAlertGroups,
      monitorOnlyGroups,
      providerAcceptedGroups,
      suppressedDuplicateCount,
      failedEmailGroups,
      runtimePolicy: {
        environment: runtimeConfig.environment,
        captureEnabled: runtimeConfig.captureEnabled,
        emailEnabled: runtimeConfig.emailEnabled,
        recipientsCount: runtimeConfig.recipients.length,
        suppressionWindowMinutes: Math.round(runtimeConfig.suppressionWindowMs / 60_000),
        excludedStatuses: [403, 404, 429],
      },
    };
  }

  async listErrorGroups(filters: ErrorMonitorQueryFilters = {}) {
    const since = this.resolveSinceTimestamp(filters.timeRange);
    const conditions = [];

    if (filters.environment && filters.environment !== 'all') {
      conditions.push(eq(errorMonitorGroups.environment, filters.environment));
    }
    if (filters.service && filters.service !== 'all') {
      conditions.push(eq(errorMonitorGroups.service, filters.service));
    }
    if (filters.source && filters.source !== 'all') {
      conditions.push(eq(errorMonitorGroups.source, filters.source));
    }
    if (typeof filters.statusCode === 'number' && Number.isInteger(filters.statusCode)) {
      conditions.push(eq(errorMonitorGroups.statusCode, filters.statusCode));
    } else if (filters.statusClass === '5xx') {
      conditions.push(gte(errorMonitorGroups.statusCode, 500));
    } else if (filters.statusClass === '4xx') {
      conditions.push(
        and(gte(errorMonitorGroups.statusCode, 400), lte(errorMonitorGroups.statusCode, 499)),
      );
    }
    if (filters.errorCategory && filters.errorCategory.trim()) {
      conditions.push(
        eq(errorMonitorGroups.errorCategory, filters.errorCategory.trim().toUpperCase()),
      );
    }
    if (filters.route && filters.route.trim()) {
      const normalized = filters.route.trim();
      conditions.push(sql`${errorMonitorGroups.normalizedRoute} ILIKE ${`%${normalized}%`}`);
    }
    if (filters.emailState && filters.emailState !== 'all') {
      if (filters.emailState === 'excluded_by_policy') {
        conditions.push(eq(errorMonitorGroups.emailEligibility, 'excluded_by_policy'));
      } else {
        conditions.push(eq(errorMonitorGroups.notificationState, filters.emailState));
      }
    }
    if (since) {
      conditions.push(gte(errorMonitorGroups.lastSeenAt, since));
    }

    let requestMatchedGroupIds: string[] | null = null;
    let correlatedChain: Array<typeof errorMonitorOccurrences.$inferSelect> = [];
    if (filters.requestId && filters.requestId.trim()) {
      const targetId = filters.requestId.trim().toLowerCase();
      const matchingOccurrences = await this.db
        .select()
        .from(errorMonitorOccurrences)
        .where(
          or(
            eq(errorMonitorOccurrences.requestId, targetId),
            eq(errorMonitorOccurrences.correlationId, targetId),
          ),
        )
        .orderBy(errorMonitorOccurrences.occurredAt);

      correlatedChain = matchingOccurrences;
      requestMatchedGroupIds = [...new Set(matchingOccurrences.map((occ) => occ.groupId))];
      if (requestMatchedGroupIds.length === 0) {
        return {
          items: [],
          total: 0,
          correlatedOccurrences: [],
        };
      }
      conditions.push(inArray(errorMonitorGroups.id, requestMatchedGroupIds));
    }

    const limit = Math.max(1, Math.min(Number(filters.limit) || 50, 100));
    const offset = Math.max(0, Number(filters.offset) || 0);
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const items = await this.db
      .select()
      .from(errorMonitorGroups)
      .where(whereClause)
      .orderBy(desc(errorMonitorGroups.lastSeenAt))
      .limit(limit)
      .offset(offset);

    return {
      items: items.map((item) => ({
        ...item,
        emailStatusLabel: this.describeNotificationState(
          item.emailEligibility,
          item.notificationState,
          item.exclusionReason,
        ),
      })),
      total: items.length,
      correlatedOccurrences: correlatedChain,
    };
  }

  async getErrorGroupDetail(groupId: string) {
    const [group] = await this.db
      .select()
      .from(errorMonitorGroups)
      .where(eq(errorMonitorGroups.id, groupId))
      .limit(1);

    if (!group) {
      throw new NotFoundException('Error monitor group not found.');
    }

    const occurrences = await this.db
      .select()
      .from(errorMonitorOccurrences)
      .where(eq(errorMonitorOccurrences.groupId, group.id))
      .orderBy(desc(errorMonitorOccurrences.occurredAt))
      .limit(MAX_OCCURRENCE_SAMPLES_PER_GROUP);

    const outboxHistory = await this.db
      .select({
        id: errorMonitorOutbox.id,
        kind: errorMonitorOutbox.kind,
        status: errorMonitorOutbox.status,
        occurrenceCount: errorMonitorOutbox.occurrenceCount,
        windowStartedAt: errorMonitorOutbox.windowStartedAt,
        windowEndsAt: errorMonitorOutbox.windowEndsAt,
        attempts: errorMonitorOutbox.attempts,
        nextAttemptAt: errorMonitorOutbox.nextAttemptAt,
        providerMessageId: errorMonitorOutbox.providerMessageId,
        lastError: errorMonitorOutbox.lastError,
        createdAt: errorMonitorOutbox.createdAt,
        updatedAt: errorMonitorOutbox.updatedAt,
      })
      .from(errorMonitorOutbox)
      .where(eq(errorMonitorOutbox.groupId, group.id))
      .orderBy(desc(errorMonitorOutbox.createdAt))
      .limit(20);

    const requestIds = [
      ...new Set(
        occurrences
          .flatMap((occ) => [occ.requestId, occ.correlationId])
          .filter((val): val is string => Boolean(val)),
      ),
    ];

    const correlatedOccurrences =
      requestIds.length > 0
        ? await this.db
            .select()
            .from(errorMonitorOccurrences)
            .where(
              or(
                inArray(errorMonitorOccurrences.requestId, requestIds),
                inArray(errorMonitorOccurrences.correlationId, requestIds),
              ),
            )
            .orderBy(errorMonitorOccurrences.occurredAt)
            .limit(50)
        : [];

    return {
      group: {
        ...group,
        emailStatusLabel: this.describeNotificationState(
          group.emailEligibility,
          group.notificationState,
          group.exclusionReason,
        ),
      },
      occurrences,
      outboxHistory,
      correlatedOccurrences,
    };
  }

  async listSources(environment?: string) {
    const recordedSources = await this.db
      .select()
      .from(errorMonitorSources)
      .where(
        environment && environment !== 'all'
          ? eq(errorMonitorSources.environment, environment)
          : undefined,
      );

    const byService = new Map(recordedSources.map((s) => [s.service, s]));

    return PLATFORM_ERROR_MONITOR_SOURCES.map((descriptor) => {
      const recorded = byService.get(descriptor.service);
      if (descriptor.defaultStatus === 'paused') {
        return {
          service: descriptor.service,
          displayName: descriptor.displayName,
          sourceType: descriptor.sourceType,
          status: 'paused' as const,
          captureEnabled: false,
          statusNote: descriptor.statusNote,
          lastHeartbeatAt: null,
          lastEventAt: null,
        };
      }

      return {
        service: descriptor.service,
        displayName: descriptor.displayName,
        sourceType: descriptor.sourceType,
        status: recorded ? recorded.status : descriptor.defaultStatus,
        captureEnabled: recorded ? recorded.captureEnabled : true,
        statusNote: descriptor.statusNote,
        lastHeartbeatAt: recorded?.lastHeartbeatAt ?? null,
        lastEventAt: recorded?.lastEventAt ?? null,
      };
    });
  }

  private describeNotificationState(
    emailEligibility: string,
    notificationState: string,
    exclusionReason?: string | null,
  ): string {
    if (emailEligibility === 'excluded_by_policy') {
      if (exclusionReason === 'HTTP_STATUS_EXCLUDED') {
        return 'Monitor only — email excluded by policy (403/404/429)';
      }
      if (exclusionReason === 'NON_FINANCIAL_4XX') {
        return 'Monitor only — email excluded by policy (non-financial 4xx)';
      }
      if (exclusionReason === 'UNTRUSTED_BROWSER_SOURCE') {
        return 'Monitor only — email excluded by policy (browser report)';
      }
      return 'Monitor only — email excluded by policy';
    }

    switch (notificationState) {
      case 'provider_accepted':
        return 'Email provider accepted';
      case 'suppressed_duplicate':
        return 'Suppressed duplicate (window summary scheduled)';
      case 'pending':
        return 'Pending outbox delivery';
      case 'failed':
        return 'Email delivery failed (retry/outbox)';
      case 'disabled':
        return 'Email delivery disabled in environment';
      default:
        return 'Monitor only — email excluded by policy';
    }
  }
}

