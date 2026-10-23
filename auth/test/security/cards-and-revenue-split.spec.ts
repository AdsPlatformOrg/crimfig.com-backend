import { calculateRevenueDistribution, PUBLISHER_REVENUE_SHARE_RATIO, CRIMFIG_BASE_REVENUE_RATIO, MARKETING_COMMISSION_POOL_RATIO } from '../../../api/ads-api/src/modules/billing/billing.constants';
import * as billingConstants from '../../../api/ads-api/src/modules/billing/billing.constants';
import { PaystackService } from '../../../api/billing-api/src/modules/providers/paystack.service';
import { CardsService } from '../../../api/billing-api/src/modules/cards/cards.service';

describe('55/30/15 revenue distribution', () => {
  it('ratios are exactly 55/30/15 and sum to one', () => {
    expect(Math.round(PUBLISHER_REVENUE_SHARE_RATIO * 100)).toBe(55);
    expect(Math.round(CRIMFIG_BASE_REVENUE_RATIO * 100)).toBe(30);
    expect(Math.round(MARKETING_COMMISSION_POOL_RATIO * 100)).toBe(15);
    expect(Math.round((PUBLISHER_REVENUE_SHARE_RATIO + CRIMFIG_BASE_REVENUE_RATIO + MARKETING_COMMISSION_POOL_RATIO) * 100)).toBe(100);
  });

  it('conserves every cent and never over-pays promoters across a broad range', () => {
    for (let gross = 0; gross <= 20000; gross++) {
      const d = calculateRevenueDistribution(gross);
      expect(d.publisherEarningsCents + d.crimfigBaseRevenueCents + d.commissionPoolCents).toBe(gross);
      expect(d.publisherEarningsCents).toBeLessThanOrEqual((gross * 55) / 100);
      expect(d.commissionPoolCents).toBeLessThanOrEqual((gross * 15) / 100);
      expect(d.crimfigBaseRevenueCents).toBeGreaterThanOrEqual(0);
    }
  });

  it('splits $100.00 exactly 55/30/15 and keeps tiny amounts conservative', () => {
    expect(calculateRevenueDistribution(10000)).toMatchObject({ publisherEarningsCents: 5500, crimfigBaseRevenueCents: 3000, commissionPoolCents: 1500 });
    expect(calculateRevenueDistribution(1)).toMatchObject({ publisherEarningsCents: 0, commissionPoolCents: 0, crimfigBaseRevenueCents: 1 });
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid gross %s', (gross) => {
    expect(() => calculateRevenueDistribution(gross as number)).toThrow(RangeError);
  });

  it('exposes no hardcoded FX fallback', () => {
    expect((billingConstants as Record<string, unknown>).DEFAULT_USD_NGN_EXCHANGE_RATE).toBeUndefined();
  });
});

describe('Paystack authorization deactivation (no network)', () => {
  let previous: string | undefined;
  beforeEach(() => { previous = process.env.PAYSTACK_SECRET_KEY; process.env.PAYSTACK_SECRET_KEY = 'sk_test_fixture_only'; });
  afterEach(() => { jest.restoreAllMocks(); if (previous === undefined) delete process.env.PAYSTACK_SECRET_KEY; else process.env.PAYSTACK_SECRET_KEY = previous; });

  it('sends one bounded POST and accepts only an explicit confirmation', async () => {
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: true })));
    await new PaystackService().deactivateAuthorization('AUTH_fixture');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.paystack.co/customer/deactivate_authorization');
    expect(init?.method).toBe('POST'); expect(init?.redirect).toBe('error'); expect(init?.signal).toBeDefined();
    expect(JSON.parse(init?.body as string)).toEqual({ authorization_code: 'AUTH_fixture' });
  });

  it.each([
    [{ status: false }, 200], [{ status: 'true' }, 200], [{ status: true }, 500], [{}, 200],
  ])('rejects unconfirmed response %j (http %s)', async (body, code) => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status: code as number }));
    await expect(new PaystackService().deactivateAuthorization('AUTH_fixture')).rejects.toThrow();
  });

  it('rejects an empty code before sending', async () => {
    const fetch = jest.spyOn(global, 'fetch');
    await expect(new PaystackService().deactivateAuthorization('  ')).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('Saved card removal and default selection', () => {
  const card = { id: 'c1', provider: 'paystack', providerToken: 'AUTH_secret_token' };

  function dbWith(rows: any[]) {
    const deleted = jest.fn();
    const select: any = () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) });
    const db: any = { select, delete: () => ({ where: async () => { deleted(); } }) };
    return { db, deleted };
  }

  it('keeps the local card when the provider does not confirm deactivation (fail closed)', async () => {
    const { db, deleted } = dbWith([card]);
    const paystack: any = { deactivateAuthorization: jest.fn().mockRejectedValue(new Error('provider down')) };
    await expect(new CardsService(db, paystack).deleteCard('u1', 'c1')).rejects.toThrow('did not confirm');
    expect(deleted).not.toHaveBeenCalled();
  });

  it('deactivates at the provider and then deletes, never exposing the token', async () => {
    const { db, deleted } = dbWith([card]);
    const paystack: any = { deactivateAuthorization: jest.fn().mockResolvedValue(undefined) };
    const result = await new CardsService(db, paystack).deleteCard('u1', 'c1');
    expect(paystack.deactivateAuthorization).toHaveBeenCalledWith('AUTH_secret_token');
    expect(deleted).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('AUTH_secret_token');
  });

  it('returns not found for a card the user does not own and calls no provider', async () => {
    const { db, deleted } = dbWith([]);
    const paystack: any = { deactivateAuthorization: jest.fn() };
    await expect(new CardsService(db, paystack).deleteCard('u1', 'foreign')).rejects.toThrow('Card not found');
    expect(paystack.deactivateAuthorization).not.toHaveBeenCalled();
    expect(deleted).not.toHaveBeenCalled();
  });

  it('refuses to remove a non-paystack card rather than orphan its token', async () => {
    const { db, deleted } = dbWith([{ ...card, provider: 'stripe' }]);
    const paystack: any = { deactivateAuthorization: jest.fn() };
    await expect(new CardsService(db, paystack).deleteCard('u1', 'c1')).rejects.toThrow('unavailable');
    expect(deleted).not.toHaveBeenCalled();
  });

  it('rejects setting a foreign card as default and returns safe fields only', async () => {
    const updates: any[] = [];
    const tx: any = {
      execute: jest.fn(),
      select: () => ({ from: () => ({ where: () => ({ for: async () => [{ id: 'c1' }] }) }) }),
      update: () => ({ set: (v: any) => { updates.push(v); return { where: () => ({ returning: async () => [{ id: 'c1', last4: '4242', isDefault: true }] }) }; } }),
    };
    const db: any = { transaction: async (fn: any) => fn(tx) };
    const svc = new CardsService(db, {} as any);
    await expect(svc.setDefaultCard('u1', 'foreign')).rejects.toThrow('Card not found');
    expect(updates).toHaveLength(0);
    const ok = await svc.setDefaultCard('u1', 'c1');
    expect(ok).toEqual({ id: 'c1', last4: '4242', isDefault: true });
    expect(updates).toHaveLength(2);
  });
});
