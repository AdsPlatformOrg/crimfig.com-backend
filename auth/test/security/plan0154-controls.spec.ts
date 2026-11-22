import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ProgramControlsService } from '../../../api/ads-api/src/modules/advertiser-milestones/program-controls.service';

const actor = '00000000-0000-4000-8000-000000000001';
const req1 = '00000000-0000-4000-8000-000000000101';
const dialect = new PgDialect();

function makeDb(responder: (sqlText: string, params: any[]) => any[]) {
  const writes: string[] = [];
  const execute = jest.fn(async (q: any) => {
    const { sql, params } = dialect.sqlToQuery(q);
    if (/^(INSERT|UPDATE|DELETE)/i.test(sql.trim())) writes.push(sql);
    return { rows: responder(sql, params) };
  });
  const db: any = {
    execute,
    transaction: jest.fn(async (fn: any) => fn({ execute })),
  };
  return { db, service: new ProgramControlsService(db), writes };
}

describe('PLAN-0154 Program Controls & Reserves — failure cases first', () => {
  it('rejects malformed switch/transfer inputs before touching database', async () => {
    const { service, db } = makeDb(() => []);
    await expect(
      service.toggleSwitch('bad-uuid', 'house_cfig_earning', { enabled: false, reason: 'Pause test', requestId: req1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.toggleSwitch(actor, 'house_cfig_earning', { enabled: false, reason: 'ab', requestId: req1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.transferBetweenReserves(actor, {
        fromReserve: 'platform_operating_reserve',
        toReserve: 'platform_operating_reserve',
        amountCents: 100,
        reason: 'Same bucket',
        requestId: req1,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.transferBetweenReserves(actor, {
        fromReserve: 'platform_operating_reserve',
        toReserve: 'promotional_ad_reserve',
        amountCents: 0,
        reason: 'Zero amount',
        requestId: req1,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('prevents enabling locked cfig_to_points_conversion switch and rejects unknown switch keys', async () => {
    const locked = makeDb((sqlText) =>
      sqlText.includes('FROM program_feature_switches WHERE key')
        ? [{ key: 'cfig_to_points_conversion', enabled: false, is_locked_off: true }]
        : [],
    );
    await expect(
      locked.service.toggleSwitch(actor, 'cfig_to_points_conversion', {
        enabled: true,
        reason: 'Attempt unlock',
        requestId: req1,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(locked.writes).toEqual([]);

    const missing = makeDb(() => []);
    await expect(
      missing.service.toggleSwitch(actor, 'unknown_switch', {
        enabled: true,
        reason: 'Unknown toggle',
        requestId: req1,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('blocks reserve transfers that exceed source balance or breach Rewards Fund solvency floor', async () => {
    const breachFloor = makeDb((sqlText) => {
      if (sqlText.includes('FROM platform_operating_reserve')) return [{ id: actor, available_cents: 10000 }];
      if (sqlText.includes('FROM advertiser_promo_budget')) return [{ id: actor, remaining_promo_budget_cents: 500, reserved_liability_cents: 200 }];
      if (sqlText.includes('FROM rewards_fund')) {
        return [{
          id: actor,
          cash_balance_usd_cents: 20000,
          available_usd_cents: 15000,
          allocated_usd_cents: 5000,
          funded_pending_usd_cents: 0,
          reserve_floor_usd_cents: 10000,
        }];
      }
      return [];
    });
    // Available $150, floor $100 -> max transferable is $50; attempting $60 must fail with zero writes
    await expect(
      breachFloor.service.transferBetweenReserves(actor, {
        fromReserve: 'rewards_fund_available',
        toReserve: 'promotional_ad_reserve',
        amountCents: 6000,
        reason: 'Exceeds floor',
        requestId: req1,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    // Promotional unreserved = 500 - 200 = 300; attempting 400 must fail
    await expect(
      breachFloor.service.transferBetweenReserves(actor, {
        fromReserve: 'promotional_ad_reserve',
        toReserve: 'platform_operating_reserve',
        amountCents: 400,
        reason: 'Exceeds unreserved promo',
        requestId: req1,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(breachFloor.writes).toEqual([]);
  });

  it('toggles unlocked switches cleanly, syncs redeemable_points pause, and records audit log', async () => {
    const valid = makeDb((sqlText) => {
      if (sqlText.includes('FROM program_feature_switches WHERE key')) {
        return [{ key: 'redeemable_points', enabled: true, is_locked_off: false }];
      }
      if (sqlText.includes('UPDATE program_feature_switches')) {
        return [{
          key: 'redeemable_points',
          enabled: false,
          is_locked_off: false,
          label: 'Promoter Redeemable Points',
          description: 'desc',
          updated_by: actor,
          updated_at: new Date(),
        }];
      }
      return [];
    });
    const res = await valid.service.toggleSwitch(actor, 'redeemable_points', {
      enabled: false,
      reason: 'Emergency maintenance pause',
      requestId: req1,
    });
    expect(res.enabled).toBe(false);
    expect(valid.writes.some(w => w.includes('INSERT INTO program_feature_switch_audit'))).toBe(true);
    expect(valid.writes.some(w => w.includes('UPDATE rewards_fund_settings SET ads_rewards_global_paused'))).toBe(true);
  });
});
