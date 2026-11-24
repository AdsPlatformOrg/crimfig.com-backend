import 'reflect-metadata';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ADS_ROLES_KEY } from '../../../api/ads-api/src/modules/security/ads-staff-grants';
import { AdminRewardsControlsController } from '../../../api/ads-api/src/modules/advertiser-milestones/admin-rewards-controls.controller';
import { ProgramControlsService } from '../../../api/ads-api/src/modules/advertiser-milestones/program-controls.service';

const actor = '00000000-0000-4000-8000-000000000001';
const req1 = '00000000-0000-4000-8000-000000000101';
const dialect = new PgDialect();

function makeDb(responder: (sqlText: string, params: any[]) => any[]) {
  const writes: Array<{ sql: string; params: any[] }> = [];
  const execute = jest.fn(async (q: any) => {
    const { sql, params } = dialect.sqlToQuery(q);
    if (/^(INSERT|UPDATE|DELETE)/i.test(sql.trim())) writes.push({ sql, params });
    return { rows: responder(sql, params) };
  });
  const db: any = {
    execute,
    transaction: jest.fn(async (fn: any) => fn({ execute })),
  };
  return { db, service: new ProgramControlsService(db), writes };
}

describe('PLAN-0168 Manual Owner Pool Commitments & $cfig Reserve — failure cases first', () => {
  it('enforces super_admin-only @AdsRoles on POST /admin/rewards/controls/reserves/manual-commitment', () => {
    const roles = Reflect.getMetadata(
      ADS_ROLES_KEY,
      AdminRewardsControlsController.prototype.recordManualCommitment,
    );
    expect(roles).toEqual(['super_admin']);
  });

  it('rejects invalid UUIDs, unsupported pool, non-positive cents, and short notes before opening a DB transaction', async () => {
    const { service, db, writes } = makeDb(() => []);
    for (const bad of [
      ['bad-actor', { targetPool: 'rewards_fund_available', amountCents: 20000, commitmentRef: 'Seed-1', reason: 'Valid reason', requestId: req1 }],
      [actor, { targetPool: 'unknown_pool', amountCents: 2000, commitmentRef: 'Seed-1', reason: 'Valid reason', requestId: req1 }],
      [actor, { targetPool: 'cfig_conversion_reserve', amountCents: 0, commitmentRef: 'Seed-1', reason: 'Valid reason', requestId: req1 }],
      [actor, { targetPool: 'cfig_conversion_reserve', amountCents: -500, commitmentRef: 'Seed-1', reason: 'Valid reason', requestId: req1 }],
      [actor, { targetPool: 'cfig_conversion_reserve', amountCents: 2000, commitmentRef: 'ab', reason: 'Valid reason', requestId: req1 }],
      [actor, { targetPool: 'cfig_conversion_reserve', amountCents: 2000, commitmentRef: 'Seed-1', reason: 'no', requestId: 'bad-req' }],
    ] as const) {
      await expect(service.recordManualCommitment(bad[0], bad[1] as any)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(db.transaction).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('rejects mismatched requestId replay with ConflictException and zero writes', async () => {
    const { service, writes } = makeDb((sqlText) => {
      if (sqlText.includes('FROM platform_reserve_transfers WHERE request_id')) {
        return [{
          id: actor,
          request_id: req1,
          from_reserve: 'owner_seed_commitment',
          to_reserve: 'cfig_conversion_reserve',
          amount_cents: 2000,
          reason: 'Founder Seed: Original note',
          actor_id: actor,
          created_at: new Date(),
        }];
      }
      return [];
    });

    await expect(
      service.recordManualCommitment(actor, {
        targetPool: 'cfig_conversion_reserve',
        amountCents: 5000,
        commitmentRef: 'Founder Seed',
        reason: 'Changed amount on replay',
        requestId: req1,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(writes).toEqual([]);
  });

  it('blocks transfer from cfig_conversion_reserve when available balance is insufficient', async () => {
    const { service, writes } = makeDb((sqlText) => {
      if (sqlText.includes('FROM cfig_conversion_reserve')) {
        return [{ id: actor, available_cents: 1500, reserved_cents: 0, spent_cents: 0 }];
      }
      return [];
    });

    await expect(
      service.transferBetweenReserves(actor, {
        fromReserve: 'cfig_conversion_reserve',
        toReserve: 'rewards_fund_available',
        amountCents: 2000,
        reason: 'Attempt overdraft transfer',
        requestId: req1,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(writes).toEqual([]);
  });

  it('commits $200 to Rewards Fund preserving $100 floor, writing rewards_fund_ledger without fake Paystack events', async () => {
    const fundId = '00000000-0000-4000-8000-000000000999';
    const { service, writes } = makeDb((sqlText) => {
      if (sqlText.includes('FROM rewards_fund WHERE currency')) {
        return [{
          id: fundId,
          cash_balance_usd_cents: 0,
          available_usd_cents: 0,
          allocated_usd_cents: 0,
          funded_pending_usd_cents: 0,
          reserve_floor_usd_cents: 10000,
        }];
      }
      if (sqlText.includes('INSERT INTO platform_reserve_transfers')) {
        return [{
          id: '00000000-0000-4000-8000-000000000555',
          request_id: req1,
          from_reserve: 'owner_seed_commitment',
          to_reserve: 'rewards_fund_available',
          amount_cents: 20000,
          reason: 'Founder Seed-2026: Initial $200 stake above $100 floor',
          actor_id: actor,
          created_at: new Date(),
        }];
      }
      return [];
    });

    const record = await service.recordManualCommitment(actor, {
      targetPool: 'rewards_fund_available',
      amountCents: 20000,
      commitmentRef: 'Founder Seed-2026',
      reason: 'Initial $200 stake above $100 floor',
      requestId: req1,
    });

    expect(record.from_reserve).toBe('owner_seed_commitment');
    expect(record.to_reserve).toBe('rewards_fund_available');
    expect(Number(record.amount_cents)).toBe(20000);
    expect(writes.some(w => w.sql.includes('UPDATE rewards_fund'))).toBe(true);
    expect(writes.some(w => w.sql.includes('INSERT INTO rewards_fund_ledger'))).toBe(true);
    expect(writes.some(w => w.sql.includes('billing_provider_events'))).toBe(false);
  });

  it('commits $20 to $cfig Conversion Reserve, Promotional Ad Reserve, and Platform Operating Reserve cleanly', async () => {
    for (const targetPool of ['cfig_conversion_reserve', 'promotional_ad_reserve', 'platform_operating_reserve'] as const) {
      const { service, writes } = makeDb((sqlText) => {
        if (sqlText.includes('INSERT INTO platform_reserve_transfers')) {
          return [{
            id: '00000000-0000-4000-8000-000000000777',
            request_id: req1,
            from_reserve: 'owner_seed_commitment',
            to_reserve: targetPool,
            amount_cents: 2000,
            reason: `Seed-${targetPool}: Bootstrap stake`,
            actor_id: actor,
            created_at: new Date(),
          }];
        }
        return [];
      });

      const res = await service.recordManualCommitment(actor, {
        targetPool,
        amountCents: 2000,
        commitmentRef: `Seed-${targetPool}`,
        reason: 'Bootstrap stake',
        requestId: req1,
      });

      expect(res.to_reserve).toBe(targetPool);
      expect(writes.some(w => w.sql.includes('INSERT INTO platform_reserve_transfers'))).toBe(true);
    }
  });
});
