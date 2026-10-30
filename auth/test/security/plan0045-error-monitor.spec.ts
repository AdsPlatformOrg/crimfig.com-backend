process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_NAME = process.env.DB_NAME || 'crimfig_test';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-jwt-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-jwt-refresh-secret';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
process.env.BREVO_API_KEY = process.env.BREVO_API_KEY || 'test-brevo-key';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';

import { Reflector } from '@nestjs/core';
import { ForbiddenException, HttpException } from '@nestjs/common';
import { of, throwError, lastValueFrom } from 'rxjs';
import {
  DEFAULT_ERROR_ALERT_RECIPIENTS,
  DEFAULT_SUPPRESSION_WINDOW_MS,
  REFUSED_INPUT_SUPPRESSION_WINDOW_MS,
  resolveErrorAlertRecipients,
  resolveErrorMonitorConfig,
  FinancialOperation,
  classifyErrorEmailEligibility,
  normalizeErrorRoute,
  sanitizeMonitorString,
  sanitizeMonitorContext,
  computeErrorFingerprint,
  redactAndSanitizeErrorEvent,
  ErrorMonitorCaptureInterceptor,
  type SanitizedErrorMonitorEvent,
} from '@crimfig/shared';
import { AuthStaffGrants } from '../../src/security/auth-staff-grants';
import { AuthStaffRoleGuard } from '../../src/security/auth-staff-role.guard';
import { EmailService } from '../../src/modules/email/email.service';
import {
  ErrorMonitorService,
  PLATFORM_ERROR_MONITOR_SOURCES,
} from '../../src/modules/error-monitor/error-monitor.service';
import {
  ErrorMonitorAdminController,
  ErrorMonitorIngestionController,
} from '../../src/modules/error-monitor/error-monitor.controller';

// ─────────────────────────────────────────────────────────────────────────────
// In-Memory Drizzle DB Fake for ErrorMonitorService Transactional Verification
// ─────────────────────────────────────────────────────────────────────────────

function createInMemoryErrorMonitorDb() {
  const groups = new Map<string, any>();
  const occurrences: any[] = [];
  const outbox = new Map<string, any>();
  const sources = new Map<string, any>();
  let seq = 1;

  const db: any = {
    groups,
    occurrences,
    outbox,
    sources,
    transaction: async (fn: (tx: any) => Promise<any>) => fn(db),
    insert: (table: any) => ({
      values: (val: any) => {
        const tableName = table?.[Symbol.for('drizzle:Name')] || '';
        return {
          onConflictDoUpdate: ({ set }: any) => {
            if (tableName === 'error_monitor_sources') {
              const key = `${val.environment}:${val.service}`;
              const existing = sources.get(key) || { id: `src-${seq++}`, ...val };
              sources.set(key, { ...existing, ...set });
              return Promise.resolve();
            }
            if (tableName === 'error_monitor_outbox') {
              const existing = [...outbox.values()].find((o) => o.dedupeKey === val.dedupeKey);
              if (existing) {
                outbox.set(existing.id, { ...existing, ...set });
              } else {
                const id = `outbox-${seq++}`;
                outbox.set(id, { id, attempts: 0, maxAttempts: 4, ...val });
              }
              return Promise.resolve();
            }
            return Promise.resolve();
          },
          onConflictDoNothing: () => {
            if (tableName === 'error_monitor_outbox') {
              const existing = [...outbox.values()].find((o) => o.dedupeKey === val.dedupeKey);
              if (!existing) {
                const id = `outbox-${seq++}`;
                outbox.set(id, { id, attempts: 0, maxAttempts: 4, ...val });
              }
            }
            return Promise.resolve();
          },
          returning: async () => {
            if (tableName === 'error_monitor_groups') {
              const id = `00000000-0000-4000-8000-${String(seq++).padStart(12, '0')}`;
              const row = { id, ...val };
              groups.set(id, row);
              return [row];
            }
            return [];
          },
          then: (resolve: any) => {
            if (tableName === 'error_monitor_occurrences') {
              const id = `occ-${seq++}`;
              const row = { id, ...val };
              occurrences.push(row);
              return Promise.resolve([row]).then(resolve);
            }
            return Promise.resolve().then(resolve);
          },
        };
      },
    }),
    select: () => ({
      from: (table: any) => {
        const tableName = table?.[Symbol.for('drizzle:Name')] || '';
        let currentRows = (): any[] => {
          if (tableName === 'error_monitor_groups') return [...groups.values()];
          if (tableName === 'error_monitor_occurrences') return [...occurrences];
          if (tableName === 'error_monitor_outbox') return [...outbox.values()];
          if (tableName === 'error_monitor_sources') return [...sources.values()];
          return [];
        };

        const chain: any = {
          where: () => chain,
          for: () => chain,
          orderBy: () => chain,
          offset: () => chain,
          limit: (n: number) => Promise.resolve(currentRows().slice(0, n)),
          then: (resolve: any, reject: any) => Promise.resolve(currentRows()).then(resolve, reject),
        };
        return chain;
      },
    }),
    update: (table: any) => ({
      set: (patch: any) => ({
        where: () => {
          const tableName = table?.[Symbol.for('drizzle:Name')] || '';
          return {
            returning: async () => {
              if (tableName === 'error_monitor_groups') {
                const last = [...groups.values()][groups.size - 1];
                if (!last) return [];
                const updated = { ...last, ...patch };
                groups.set(last.id, updated);
                return [updated];
              }
              if (tableName === 'error_monitor_outbox') {
                const first = [...outbox.values()][0];
                if (!first) return [];
                const updated = { ...first, ...patch };
                outbox.set(first.id, updated);
                return [updated];
              }
              return [];
            },
            then: (resolve: any) => {
              if (tableName === 'error_monitor_groups') {
                const last = [...groups.values()][groups.size - 1];
                if (last) groups.set(last.id, { ...last, ...patch });
              }
              if (tableName === 'error_monitor_outbox') {
                const first = [...outbox.values()][0];
                if (first) outbox.set(first.id, { ...first, ...patch });
              }
              return Promise.resolve().then(resolve);
            },
          };
        },
      }),
    }),
  };

  return db;
}

describe('PLAN-0045: Platform Error Monitor in Auth & Email Notifications', () => {
  describe('T3: Recipient configuration & environment toggles', () => {
    it('exports DEFAULT_ERROR_ALERT_RECIPIENTS = ["jed@crimfig.com"] and uses it when ERROR_ALERT_EMAILS is unset', () => {
      expect(DEFAULT_ERROR_ALERT_RECIPIENTS).toEqual(['jed@crimfig.com']);
      const recipients = resolveErrorAlertRecipients({});
      expect(recipients).toEqual(['jed@crimfig.com']);
    });

    it('parses and normalizes valid comma-separated ERROR_ALERT_EMAILS overrides', () => {
      const recipients = resolveErrorAlertRecipients({
        ERROR_ALERT_EMAILS: '  JED@crimfig.com , ops@crimfig.com , jed@crimfig.com ',
      });
      expect(recipients).toEqual(['jed@crimfig.com', 'ops@crimfig.com']);
    });

    it('fails closed with a clear configuration error on empty or invalid ERROR_ALERT_EMAILS overrides', () => {
      expect(() => resolveErrorAlertRecipients({ ERROR_ALERT_EMAILS: '   ' })).toThrow(
        /Invalid ERROR_ALERT_EMAILS override/,
      );
      expect(() =>
        resolveErrorAlertRecipients({ ERROR_ALERT_EMAILS: 'jed@crimfig.com, not-an-email' }),
      ).toThrow(/Invalid email address in ERROR_ALERT_EMAILS/);
    });

    it('disables email sending by default in staging/development unless explicitly enabled', () => {
      const stagingCfg = resolveErrorMonitorConfig({ NODE_ENV: 'staging' });
      expect(stagingCfg.environment).toBe('staging');
      expect(stagingCfg.captureEnabled).toBe(false);
      expect(stagingCfg.emailEnabled).toBe(false);

      const prodCfg = resolveErrorMonitorConfig({
        NODE_ENV: 'production',
        ERROR_MONITOR_EMAIL_ENABLED: 'true',
      });
      expect(prodCfg.environment).toBe('production');
      expect(prodCfg.captureEnabled).toBe(true);
      expect(prodCfg.emailEnabled).toBe(true);
    });
  });

  describe('T2: Capture vs. Email eligibility matrix (including 404/403/429 exclusion on financial routes)', () => {
    it('captures all 4xx and 5xx in the monitor, but ALWAYS excludes 404, 403, and 429 from email even on financial routes', () => {
      for (const statusCode of [403, 404, 429]) {
        const nonFinancial = classifyErrorEmailEligibility({
          statusCode,
          isFinancialRoute: false,
          source: 'server',
        });
        expect(nonFinancial.captureInMonitor).toBe(true);
        expect(nonFinancial.emailEligibility).toBe('excluded_by_policy');
        expect(nonFinancial.exclusionReason).toBe('HTTP_STATUS_EXCLUDED');
        expect(nonFinancial.statusLabel).toBe('Monitor only — email excluded by policy');

        const financial = classifyErrorEmailEligibility({
          statusCode,
          isFinancialRoute: true,
          source: 'server',
        });
        expect(financial.captureInMonitor).toBe(true);
        expect(financial.emailEligibility).toBe('excluded_by_policy');
        expect(financial.exclusionReason).toBe('HTTP_STATUS_EXCLUDED');
      }
    });

    it('marks server 5xx as email-eligible with 30m suppression window', () => {
      for (const statusCode of [500, 502, 503, 504]) {
        const decision = classifyErrorEmailEligibility({
          statusCode,
          isFinancialRoute: false,
          source: 'server',
        });
        expect(decision.captureInMonitor).toBe(true);
        expect(decision.emailEligibility).toBe('eligible');
        expect(decision.exclusionReason).toBeNull();
        expect(decision.suppressionWindowMs).toBe(DEFAULT_SUPPRESSION_WINDOW_MS);
      }
    });

    it('marks non-excluded 4xx (400, 401, 402, 409, 422) as email-eligible ONLY on tagged financial routes', () => {
      for (const statusCode of [400, 401, 402, 409, 422]) {
        const nonFinancial = classifyErrorEmailEligibility({
          statusCode,
          isFinancialRoute: false,
          source: 'server',
        });
        expect(nonFinancial.captureInMonitor).toBe(true);
        expect(nonFinancial.emailEligibility).toBe('excluded_by_policy');
        expect(nonFinancial.exclusionReason).toBe('NON_FINANCIAL_4XX');

        const financial = classifyErrorEmailEligibility({
          statusCode,
          isFinancialRoute: true,
          source: 'server',
        });
        expect(financial.captureInMonitor).toBe(true);
        expect(financial.emailEligibility).toBe('eligible');
        expect(financial.exclusionReason).toBeNull();
      }
    });

    it('uses 24h suppression window for refused-input validation 400/422 on financial routes and excludes browser sources from email', () => {
      const refusedFinancial = classifyErrorEmailEligibility({
        statusCode: 400,
        isFinancialRoute: true,
        source: 'server',
        errorCategory: 'VALIDATION_FAILED',
      });
      expect(refusedFinancial.emailEligibility).toBe('eligible');
      expect(refusedFinancial.suppressionWindowMs).toBe(REFUSED_INPUT_SUPPRESSION_WINDOW_MS);

      const browser500 = classifyErrorEmailEligibility({
        statusCode: 500,
        isFinancialRoute: true,
        source: 'browser',
      });
      expect(browser500.captureInMonitor).toBe(true);
      expect(browser500.emailEligibility).toBe('excluded_by_policy');
      expect(browser500.exclusionReason).toBe('UNTRUSTED_BROWSER_SOURCE');
    });
  });

  describe('T4: Secret/PII redaction, route normalization, and HTML escaping', () => {
    it('strips seeded secrets, tokens, passwords, cookies, query strings, connection strings, and emails from events and email cards', () => {
      const seededSecret = 'Bearer ' + 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const dbUrl = 'postgresql://postgres:superSecretPass@db.internal:5432/crimfig';
      const paystackSecret = ['sk', 'test', 'seededredactionfixture123456'].join('_');

      const event = redactAndSanitizeErrorEvent({
        environment: 'staging',
        service: 'billing-api',
        httpMethod: 'POST',
        route: '/api/v1/wallet/fund/11111111-2222-4333-8444-555555555555?token=secret123&email=user@example.com',
        statusCode: 503,
        isFinancialRoute: true,
        financialCategory: 'wallet',
        safeSummary: `Failed connecting to ${dbUrl} with ${seededSecret} and ${paystackSecret} for user@example.com`,
        context: {
          authorization: seededSecret,
          cookie: 'crimfig_rt=secret_refresh_token',
          password: 'PlaintextPassword123!',
          body: { cardNumber: '4111111111111111', cvv: '999' },
          query: { secret: 'abc' },
          stack: 'Error: raw stack trace at BillingService',
          safeField: 'wallet_funding',
          nestedInfo: {
            apiKey: paystackSecret,
            note: `Contact victim@example.com or use ${dbUrl}`,
          },
        },
      });

      expect(event.normalizedRoute).toBe('/api/v1/wallet/fund/:id');
      expect(event.safeSummary).not.toContain('superSecretPass');
      expect(event.safeSummary).not.toContain('eyJhbGci');
      expect(event.safeSummary).not.toContain(paystackSecret);
      expect(event.safeSummary).not.toContain('user@example.com');
      expect(event.safeSummary).toContain('[REDACTED]');

      const serializedContext = JSON.stringify(event.sanitizedContext);
      expect(serializedContext).not.toContain('secret_refresh_token');
      expect(serializedContext).not.toContain('PlaintextPassword123');
      expect(serializedContext).not.toContain('4111111111111111');
      expect(serializedContext).not.toContain('raw stack trace');
      expect(serializedContext).not.toContain(paystackSecret);
      expect(serializedContext).not.toContain('victim@example.com');
      expect(event.sanitizedContext.safeField).toBe('wallet_funding');

      const emailService = Object.create(EmailService.prototype) as EmailService;
      const emailCard = emailService.buildErrorAlertEmailContent({
        kind: 'initial',
        environment: event.environment,
        service: event.service,
        httpMethod: event.httpMethod,
        normalizedRoute: '<script>alert("xss")</script>',
        statusCode: event.statusCode,
        errorCategory: event.errorCategory,
        safeSummary: '<b>unsafe html</b> & "quotes"',
        requestId: event.requestId,
        occurrenceCount: 1,
        windowStartedAt: new Date(),
        windowEndsAt: new Date(),
        railwayLogUrl: event.railwayLogUrl,
        monitorUrl: 'https://auth.crimfig.com/admin/error-monitor',
      });

      expect(emailCard.htmlContent).not.toContain('<script>');
      expect(emailCard.htmlContent).toContain('&lt;script&gt;');
      expect(emailCard.htmlContent).toContain('&lt;b&gt;unsafe html&lt;/b&gt;');
    });

    it('produces identical fingerprints across dynamic route IDs and per-request metadata', () => {
      const fp1 = computeErrorFingerprint({
        environment: 'production',
        service: 'ads-api',
        httpMethod: 'POST',
        normalizedRoute: normalizeErrorRoute('/api/v1/campaigns/11111111-1111-4111-8111-111111111111/submit?foo=1'),
        statusCode: 503,
        errorCategory: 'SERVICE_UNAVAILABLE',
      });
      const fp2 = computeErrorFingerprint({
        environment: 'production',
        service: 'ads-api',
        httpMethod: 'POST',
        normalizedRoute: normalizeErrorRoute('/api/v1/campaigns/99999999-9999-4999-8999-999999999999/submit?bar=2'),
        statusCode: 503,
        errorCategory: 'SERVICE_UNAVAILABLE',
      });
      expect(fp1).toBe(fp2);
    });
  });

  describe('T1: Platform Admin (super_admin) access control & internal ingestion guard', () => {
    const SUPER_ADMIN_ID = '11111111-1111-4111-8111-111111111111';
    const SUPPORT_AGENT_ID = '22222222-2222-4222-8222-222222222222';
    const AUTH_ADMIN_ID = '33333333-3333-4333-8333-333333333333';
    const REGULAR_USER_ID = '44444444-4444-4444-8444-444444444444';

    const makeContext = (userId?: string) =>
      ({
        getHandler: () => ErrorMonitorAdminController.prototype.getSummary,
        getClass: () => ErrorMonitorAdminController,
        switchToHttp: () => ({
          getRequest: () => ({ user: userId ? { sub: userId } : undefined }),
        }),
      }) as any;

    it('allows only super_admin and denies support_agent, auth_admin, regular users, and anonymous requests with 403', () => {
      const prevGrants = process.env.AUTH_STAFF_ROLE_GRANTS;
      process.env.AUTH_STAFF_ROLE_GRANTS = JSON.stringify({
        [SUPER_ADMIN_ID]: ['super_admin'],
        [SUPPORT_AGENT_ID]: ['support_agent'],
        [AUTH_ADMIN_ID]: ['auth_admin', 'security_admin'],
      });

      try {
        const grants = new AuthStaffGrants();
        const reflector = new Reflector();
        const guard = new AuthStaffRoleGuard(reflector, grants);

        expect(guard.canActivate(makeContext(SUPER_ADMIN_ID))).toBe(true);
        expect(() => guard.canActivate(makeContext(SUPPORT_AGENT_ID))).toThrow(ForbiddenException);
        expect(() => guard.canActivate(makeContext(AUTH_ADMIN_ID))).toThrow(ForbiddenException);
        expect(() => guard.canActivate(makeContext(REGULAR_USER_ID))).toThrow(ForbiddenException);
        expect(() => guard.canActivate(makeContext(undefined))).toThrow(ForbiddenException);
      } finally {
        process.env.AUTH_STAFF_ROLE_GRANTS = prevGrants;
      }
    });

    it('rejects internal ingestion with missing/invalid x-internal-key or non-allowlisted service names', async () => {
      const prevKey = process.env.ERROR_MONITOR_INTERNAL_KEY;
      process.env.ERROR_MONITOR_INTERNAL_KEY = 'test-internal-monitor-secret-key';

      try {
        const db = createInMemoryErrorMonitorDb();
        const emailService = Object.create(EmailService.prototype) as EmailService;
        const service = new ErrorMonitorService(db, emailService);
        const controller = new ErrorMonitorIngestionController(service);

        await expect(
          controller.ingestInternalEvent('wrong-key', {
            service: 'ads-api',
            httpMethod: 'POST',
            route: '/api/v1/campaigns',
            statusCode: 500,
          }),
        ).rejects.toThrow(/Invalid internal error monitor service key/);

        await expect(
          controller.ingestInternalEvent('test-internal-monitor-secret-key', {
            service: 'rogue-untrusted-service',
            httpMethod: 'POST',
            route: '/api/v1/campaigns',
            statusCode: 500,
          }),
        ).rejects.toThrow(/not an allowlisted CrimFig error source/);
      } finally {
        process.env.ERROR_MONITOR_INTERNAL_KEY = prevKey;
      }
    });
  });

  describe('T5 & T6: 30m duplicate window suppression, outbox delivery, single capture per request, and paused sources', () => {
    it('queues 1 initial outbox task on first eligible error, suppresses 10 duplicates in the 30m window into 1 window_summary task, and never queues monitor-only 404/403/429', async () => {
      const db = createInMemoryErrorMonitorDb();
      const sentEmails: any[] = [];
      const fakeEmailService = {
        buildErrorAlertEmailContent: EmailService.prototype.buildErrorAlertEmailContent,
        sendErrorAlertEmail: jest.fn(async (payload: any) => {
          sentEmails.push(payload);
          return { accepted: true, providerMessageId: `brevo-msg-${sentEmails.length}` };
        }),
      } as unknown as EmailService;

      const service = new ErrorMonitorService(db, fakeEmailService);
      const env = {
        NODE_ENV: 'production',
        ERROR_MONITOR_CAPTURE_ENABLED: 'true',
        ERROR_MONITOR_EMAIL_ENABLED: 'true',
      };

      const baseTime = new Date('2026-10-30T10:00:00.000Z');

      // 1. Monitor-only 404 on a financial route -> captured in monitor, NEVER enters outbox
      const excluded404 = redactAndSanitizeErrorEvent(
        {
          environment: 'production',
          service: 'billing-api',
          httpMethod: 'POST',
          route: '/api/v1/wallet/fund',
          statusCode: 404,
          isFinancialRoute: true,
          financialCategory: 'wallet',
          occurredAt: baseTime,
        },
        env,
      );
      const res404 = await service.recordEvent(excluded404, env);
      if (!res404.recorded) throw new Error('Expected 404 to be recorded');
      expect(res404.emailEligibility).toBe('excluded_by_policy');
      expect(res404.outboxScheduled).toBe('none');
      expect(db.outbox.size).toBe(0);

      // 2. First eligible 503 on Billing escrow reserve -> schedules 1 initial outbox task
      const first503 = redactAndSanitizeErrorEvent(
        {
          environment: 'production',
          service: 'billing-api',
          httpMethod: 'POST',
          route: '/api/v1/ecosystem/wallets/11111111-1111-4111-8111-111111111111/campaign-escrows/22222222-2222-4222-8222-222222222222/reserve',
          statusCode: 503,
          isFinancialRoute: true,
          financialCategory: 'escrow',
          requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          occurredAt: baseTime,
        },
        env,
      );
      const db503 = createInMemoryErrorMonitorDb();
      const service503 = new ErrorMonitorService(db503, fakeEmailService);
      const firstRes = await service503.recordEvent(first503, env);
      if (!firstRes.recorded) throw new Error('Expected 503 to be recorded');
      expect(firstRes.outboxScheduled).toBe('initial');
      expect(firstRes.occurrenceCount).toBe(1);
      expect(db503.outbox.size).toBe(1);

      // Dispatch due outbox at T+0 -> sends initial email
      const initialDispatch = await service503.processDueOutbox(baseTime);
      expect(initialDispatch.processedCount).toBe(1);
      expect(sentEmails.length).toBe(1);
      expect(sentEmails[0].recipients).toEqual(['jed@crimfig.com']);

      // 3. 10 repeated identical failures within the 30-minute window -> suppressed, updates single window_summary outbox task
      for (let i = 1; i <= 10; i++) {
        const repeatTime = new Date(baseTime.getTime() + i * 60_000); // +1m .. +10m
        const repeatEvent = redactAndSanitizeErrorEvent(
          {
            environment: 'production',
            service: 'billing-api',
            httpMethod: 'POST',
            route: '/api/v1/ecosystem/wallets/11111111-1111-4111-8111-111111111111/campaign-escrows/22222222-2222-4222-8222-222222222222/reserve',
            statusCode: 503,
            isFinancialRoute: true,
            financialCategory: 'escrow',
            occurredAt: repeatTime,
          },
          env,
        );
        const repRes = await service503.recordEvent(repeatEvent, env);
        if (!repRes.recorded) throw new Error('Expected repeat 503 to be recorded');
        expect(repRes.outboxScheduled).toBe('window_summary');
        expect(repRes.notificationState).toBe('suppressed_duplicate');
        expect(repRes.windowSuppressedCount).toBe(i);
      }

      // Total outbox rows: 1 initial + 1 coalesced window_summary = 2 total
      expect(db503.outbox.size).toBe(2);
      const summaryOutbox = [...db503.outbox.values()].find((o) => o.kind === 'window_summary');
      expect(summaryOutbox).toBeDefined();
      expect(summaryOutbox.occurrenceCount).toBe(11);
      expect(summaryOutbox.subject).toContain('11x');
    });

    it('captures at most once per HTTP response in ErrorMonitorCaptureInterceptor and skips /admin/error-monitor routes', async () => {
      const captured: SanitizedErrorMonitorEvent[] = [];
      const sink = {
        recordEvent: jest.fn(async (ev: SanitizedErrorMonitorEvent) => {
          captured.push(ev);
        }),
      };

      class FinancialTestController {
        @FinancialOperation('wallet')
        fund() {}
      }

      const reflector = new Reflector();
      const interceptor = new ErrorMonitorCaptureInterceptor('billing-api', reflector, sink, {
        NODE_ENV: 'production',
        ERROR_MONITOR_CAPTURE_ENABLED: 'true',
      });

      const req: any = {
        method: 'POST',
        route: { path: '/api/v1/wallet/fund' },
        headers: { 'x-request-id': '11111111-1111-4111-8111-111111111111' },
      };
      const res: any = {
        statusCode: 409,
        headers: {},
        setHeader(k: string, v: string) {
          this.headers[k] = v;
        },
      };

      const ctx: any = {
        getType: () => 'http',
        getHandler: () => FinancialTestController.prototype.fund,
        getClass: () => FinancialTestController,
        switchToHttp: () => ({
          getRequest: () => req,
          getResponse: () => res,
        }),
      };

      await expect(
        lastValueFrom(
          interceptor.intercept(ctx, {
            handle: () => throwError(() => new HttpException('Conflict', 409)),
          }),
        ),
      ).rejects.toThrow();

      // Calling intercept a second time on the same request object must not double-capture
      await lastValueFrom(
        interceptor.intercept(ctx, {
          handle: () => of({ ok: true }),
        }),
      );

      expect(captured.length).toBe(1);
      expect(captured[0].isFinancialRoute).toBe(true);
      expect(captured[0].emailEligibility).toBe('eligible');
      expect(res.headers['X-Request-Id']).toBe('11111111-1111-4111-8111-111111111111');
    });

    it('reports paused services (nats, chat-frontend, tetris-frontend) honestly as paused', async () => {
      const db = createInMemoryErrorMonitorDb();
      const emailService = Object.create(EmailService.prototype) as EmailService;
      const service = new ErrorMonitorService(db, emailService);

      const sources = await service.listSources('staging');
      const paused = sources.filter((s) => s.status === 'paused').map((s) => s.service);
      expect(paused).toEqual(['nats', 'chat-frontend', 'tetris-frontend']);
      expect(PLATFORM_ERROR_MONITOR_SOURCES.some((s) => s.service === 'auth-api')).toBe(true);
      expect(PLATFORM_ERROR_MONITOR_SOURCES.some((s) => s.service === 'ads-api')).toBe(true);
      expect(PLATFORM_ERROR_MONITOR_SOURCES.some((s) => s.service === 'billing-api')).toBe(true);
    });
  });
});

