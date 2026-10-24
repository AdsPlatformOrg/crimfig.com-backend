import { ExchangeRateController } from '../../../api/billing-api/src/modules/exchange-rate/exchange-rate.controller';
import { ExchangeRateService } from '../../../api/billing-api/src/modules/exchange-rate/exchange-rate.service';
import { BankAccountsController } from '../../../api/billing-api/src/modules/bank-accounts/bank-accounts.controller';
import { BankAccountsService } from '../../../api/billing-api/src/modules/bank-accounts/bank-accounts.service';
import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { BillingAccessGuard } from '../../../api/billing-api/src/modules/security/billing-access.guard';
import { WalletController } from '../../../api/billing-api/src/modules/wallet/wallet.controller';
import { WalletService } from '../../../api/billing-api/src/modules/wallet/wallet.service';
import { DATABASE_TOKEN } from '../../../api/billing-api/src/modules/database/database.module';
import { Public } from '../../../shared/src/decorators';
import { dashboardOrigins, validateDashboardOrigins } from '../../../shared/src/security/dashboard-origins';
import { DashboardAuthModule } from '../../../shared/src/security/access-token.guard';

const secret = 'test-only-billing-access-signing-key';
const owner = { id: 'e68f2fac-09d2-481b-85b2-896300cd169e', email: 'owner@example.test', status: 'ACTIVE' };
let account: typeof owner | null;
const database = { query: { users: { findFirst: jest.fn(async () => account) } } };
const banks = { listBanks: jest.fn(async () => []), resolveAccount: jest.fn(async () => ({ account_name: 'TEST HOLDER' })) };
const fx = { getUsdToNgnRate: jest.fn(), convertUsdCentsToNgn: jest.fn(async (value: number) => ({ usdCents: value })), getHistory: jest.fn(async () => [{ id: 'rate', usdToNgn: '1550', source: 'exchangerate_api', fetchedAt: new Date(), rawMainResponse: { private: 'not-public' } }]) };
const wallet = { getBalance: jest.fn(async (id: string) => ({ userId: id })), initializeFunding: jest.fn() };

@Controller('health')
class PublicHealth {
  @Public()
  @Get()
  get() { return { healthy: true }; }
}

@Module({
  imports: [DashboardAuthModule],
  controllers: [WalletController, PublicHealth, BankAccountsController, ExchangeRateController],
  providers: [
    { provide: DATABASE_TOKEN, useValue: database },
    { provide: WalletService, useValue: wallet },
    { provide: ExchangeRateService, useValue: fx },
    { provide: BankAccountsService, useValue: banks },
    { provide: APP_GUARD, useClass: BillingAccessGuard },
  ],
})
class Fixture {}

describe('Billing default-deny authentication over HTTP', () => {
  let app: INestApplication;
  let base: string;
  const jwt = new JwtService({ secret });
  const access = (payload: object = {}, options: any = {}) => jwt.sign({
    sub: owner.id, email: 'old-email@example.test', type: 'access', ...payload,
  }, { expiresIn: '5m', ...options });

  beforeAll(async () => {
    const previous = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET = secret;
    let module;
    try { module = await Test.createTestingModule({ imports: [Fixture] }).compile(); }
    finally {
      if (previous === undefined) delete process.env.JWT_ACCESS_SECRET;
      else process.env.JWT_ACCESS_SECRET = previous;
    }
    app = module.createNestApplication({ logger: false });
    app.enableCors({
      origin: dashboardOrigins(true), credentials: false,
      methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'],
    });
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  beforeEach(() => { account = { ...owner }; jest.clearAllMocks(); });
  afterAll(async () => { await app?.close(); });

  it('missing bearer and forged x-user identity cannot read a wallet', async () => {
    const response = await fetch(`${base}/wallet`, { headers: { 'x-user-id': owner.id, 'x-user-email': owner.email } });
    expect(response.status).toBe(401);
    expect(wallet.getBalance).not.toHaveBeenCalled();
    expect(database.query.users.findFirst).not.toHaveBeenCalled();
  });

  it('keeps the bank directory public but requires a verified current account before resolving account-holder data', async () => {
    expect((await fetch(`${base}/bank-accounts/banks`)).status).toBe(200);
    expect((await fetch(`${base}/bank-accounts/resolve?accountNumber=1234567890&bankCode=058`)).status).toBe(401);
    expect(banks.resolveAccount).not.toHaveBeenCalled();
    const res = await fetch(`${base}/bank-accounts/resolve?accountNumber=1234567890&bankCode=058`, { headers: { Authorization: `Bearer ${access()}` } });
    expect(res.status).toBe(200); expect(banks.resolveAccount).toHaveBeenCalledWith('1234567890', '058');
  });

  it('verifies bearer and derives current email/identity from the account, ignoring forged headers', async () => {
    const response = await fetch(`${base}/wallet`, { headers: {
      Authorization: `Bearer ${access()}`, 'x-user-id': 'victim', 'x-user-email': 'victim@example.test',
    } });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { userId: string } };
    expect(body.data.userId).toBe(owner.id);
    expect(wallet.getBalance).toHaveBeenCalledWith(owner.id);
  });

  it('rejects MFA, expired, wrong-key, invalid-sub and missing-exp tokens', async () => {
    const noExpiry = jwt.sign({ sub: owner.id, email: owner.email, type: 'access' });
    const wrongKey = new JwtService({ secret: 'wrong-key' }).sign({ sub: owner.id, email: owner.email, type: 'access' }, { expiresIn: '5m' });
    for (const token of [access({ type: 'mfa_challenge' }), access({}, { expiresIn: -1 }),
      wrongKey, access({ sub: 'invalid' }), noExpiry]) {
      expect((await fetch(`${base}/wallet`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
    }
    expect(wallet.getBalance).not.toHaveBeenCalled();
  });

  it('rejects suspended, deleted and removed accounts even with a valid JWT', async () => {
    for (const status of ['SUSPENDED', 'DELETED', null]) {
      account = status ? { ...owner, status } : null;
      expect((await fetch(`${base}/wallet`, { headers: { Authorization: `Bearer ${access()}` } })).status).toBe(401);
    }
    expect(wallet.getBalance).not.toHaveBeenCalled();
  });

  it('FX endpoints require authentication and manual refresh stays unavailable', async () => {
    for (const [path, method] of [['current', 'GET'], ['convert?usdCents=100', 'GET'], ['history', 'GET'], ['refresh', 'POST']]) {
      expect((await fetch(`${base}/exchange-rates/${path}`, { method })).status).toBe(401);
    }
    expect((await fetch(`${base}/exchange-rates/refresh`, { method: 'POST', headers: { Authorization: `Bearer ${access()}` } })).status).toBe(503);
    expect(fx.getUsdToNgnRate).not.toHaveBeenCalled();
  });
  it('FX integer parsing rejects truncation and conflicting amounts before service calls', async () => {
    for (const query of ['usdCents=1.5', 'usdCents=100garbage', 'usdCents=-1', 'usdCents=1&ngnKobo=1', 'usdCents=9007199254740992']) {
      expect((await fetch(`${base}/exchange-rates/convert?${query}`, { headers: { Authorization: `Bearer ${access()}` } })).status).toBe(400);
    }
    expect(fx.convertUsdCentsToNgn).not.toHaveBeenCalled();
    expect((await fetch(`${base}/exchange-rates/convert?usdCents=0`, { headers: { Authorization: `Bearer ${access()}` } })).status).toBe(200);
    expect(fx.convertUsdCentsToNgn).toHaveBeenCalledWith(0);
  });
  it('FX history bounds rows and excludes raw provider responses', async () => {
    const response = await fetch(`${base}/exchange-rates/history`, { headers: { Authorization: `Bearer ${access()}` } });
    expect(response.status).toBe(200); expect(JSON.stringify(await response.json())).not.toContain('not-public');
    expect((await fetch(`${base}/exchange-rates/history?limit=10000`, { headers: { Authorization: `Bearer ${access()}` } })).status).toBe(400);
  });

  it('public health remains available without authentication', async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect(database.query.users.findFirst).not.toHaveBeenCalled();
  });

  it('forged identity cannot initialize a funding mutation', async () => {
    const response = await fetch(`${base}/wallet/fund`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user-id': owner.id },
      body: JSON.stringify({ amountUsd: 1 }),
    });
    expect(response.status).toBe(401);
    expect(wallet.initializeFunding).not.toHaveBeenCalled();
  });

  it('permits unauthenticated preflight for trusted dashboards without broadening cookie access', async () => {
    const response = await fetch(`${base}/wallet`, { method: 'OPTIONS', headers: {
      Origin: 'https://billing.crimfig.com', 'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization',
    } });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://billing.crimfig.com');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    expect(response.headers.get('access-control-allow-headers')).not.toContain('x-user-id');
    const foreign = await fetch(`${base}/health`, { headers: { Origin: 'https://foreign.example' } });
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('private API browser origin policy', () => {
  it('authentication module refuses startup without a configured signing secret', async () => {
    const previous = process.env.JWT_ACCESS_SECRET;
    try {
      delete process.env.JWT_ACCESS_SECRET;
      await expect(Test.createTestingModule({ imports: [DashboardAuthModule] }).compile()).rejects.toThrow('JWT_ACCESS_SECRET is required');
    } finally {
      if (previous === undefined) delete process.env.JWT_ACCESS_SECRET;
      else process.env.JWT_ACCESS_SECRET = previous;
    }
  });

  it('uses exact defaults and rejects wildcard, credential URLs, paths and production HTTP', () => {
    expect(dashboardOrigins(true)).toContain('https://billing.crimfig.com');
    expect(validateDashboardOrigins(['https://billing.crimfig.com', 'https://ads.crimfig.com'], true)).toHaveLength(2);
    for (const origin of ['*', '', 'https://*.example.com', 'https:\\//example.com', 'https://user:password@example.com', 'https://example.com/path',
      'http://example.com', 'http://localhost:3007']) expect(() => validateDashboardOrigins([origin], true)).toThrow();
    expect(validateDashboardOrigins(['http://localhost:3007'], false)).toEqual(['http://localhost:3007']);
  });

  it('loads first-party file origins and excludes development origins in production', () => {
    const origins = dashboardOrigins(true);
    for (const origin of ['https://auth.crimfig.com', 'https://ads.crimfig.com', 'https://billing.crimfig.com']) {
      expect(origins).toContain(origin);
    }
    expect(origins).not.toContain('http://localhost:3000');
    expect(origins).not.toContain('https://unlisted.example.com');
    expect(dashboardOrigins(false)).toContain('http://localhost:3000');
  });
  it('isolates staging browser origins from production while retaining exact file entries', () => {
    const origins = dashboardOrigins(true, 'staging');
    expect(origins).toContain('https://staging-auth.crimfig.com');
    expect(origins).toContain('https://staging-ads.crimfig.com');
    expect(origins).not.toContain('https://auth.crimfig.com');
    expect(origins).not.toContain('http://localhost:3000');
    expect(dashboardOrigins(true, 'production')).not.toContain('https://staging-auth.crimfig.com');
  });
});
