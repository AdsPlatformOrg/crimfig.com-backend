jest.mock('@crimfig/shared', () => ({ ...jest.requireActual('../../../shared/src/financial-security/policy.config'), ...jest.requireActual('../../../shared/src/financial-security/authorization') }));
import { createHash } from 'crypto';
import { withdrawalDigest } from '../../../shared/src/financial-security/authorization';
import { PostgresQuoteSource } from '../../../api/billing-api/src/financial-security/quote-source';
describe('PLAN-0052 independent read model', () => {
  const input = { userId: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222', quoteId: '33333333-3333-4333-8333-333333333333', bankAccountId: '44444444-4444-4444-8444-444444444444', amountUsdCents: 5000 };
  const reference = 'wd_' + createHash('sha256').update(input.userId + ':' + input.requestId).digest('hex').slice(0, 40);
  function setup() {
    const row: any = { status: 'ACTIVE', mfa_enabled: true, active: true, is_verified: true, person_id: 'person', recovery_cleared_at: new Date(0),
      recipient_code: 'RCP_1', bank_code: '001', account_number: '0123456789', bank_version: new Date(1000),
      quote: { ...input, reference, recipientCode: 'RCP_1', netKobo: 500000, totalFeeKobo: 5000, rateId: 'rate', domain: 'test', expiresAt: new Date(Date.now() + 60000).toISOString() } };
    const db = { query: jest.fn(async (query: string) => ({ rows: query.startsWith('SELECT e.') ? [row] : [] })), release: jest.fn() };
    const pool = { connect: jest.fn().mockResolvedValue(db), query: jest.fn().mockResolvedValue({ rows: [] }) };
    return { row, db, pool, source: new PostgresQuoteSource(pool as any) };
  }
  test('invalid input cannot access the read source', async () => {
    const s = setup(); await expect(s.source.binding({ ...input, userId: 'forged' })).rejects.toThrow(); expect(s.pool.connect).not.toHaveBeenCalled();
  });
  test.each(['suspended', 'changed-recipient', 'wrong-amount', 'expired', 'recovery-hold'])('rejects %s source facts without a binding', async scenario => {
    const s = setup();
    if (scenario === 'suspended') s.row.status = 'SUSPENDED';
    if (scenario === 'changed-recipient') s.row.recipient_code = 'RCP_other';
    if (scenario === 'wrong-amount') s.row.quote.amountUsdCents++;
    if (scenario === 'expired') s.row.quote.expiresAt = new Date(0).toISOString();
    if (scenario === 'recovery-hold') s.row.recovery_cleared_at = new Date(Date.now() + 60000);
    await expect(s.source.binding(input)).rejects.toThrow(); expect(s.db.query).toHaveBeenCalledWith('ROLLBACK'); expect(s.db.release).toHaveBeenCalledTimes(1);
  });
  test('missing ledger reservation cannot establish funds were locked', async () => {
    const s = setup(); expect(await s.source.reservationMatches({ reference } as any)).toBe(false);
  });
  test('matching metadata cannot hide a mismatched withdrawal owner or amount', async () => {
    const s = setup(); const b = await s.source.binding(input);
    const row = { metadata: JSON.stringify({ dispatch: 'started', authorityDigest: withdrawalDigest(b), payoutQuote: { quoteId: b.quoteId } }),
      user_id: b.ownerId, person_id: b.ownerPersonId, active: true, user_status: 'ACTIVE', mfa_enabled: true, recovery_cleared_at: new Date(0),
      is_verified: true, recipient_code: b.recipientCode, bank_id: input.bankAccountId, bank_version: new Date(1000),
      amount_usd_cents: b.amountUsdCents, amount_ngn_kobo: b.amountKobo, status: 'pending', withdrawal_status: 'processing',
      withdrawal_owner: b.ownerId, withdrawal_usd: b.amountUsdCents, withdrawal_kobo: b.amountKobo, withdrawal_reference: b.reference, locked_usd_cents: b.amountUsdCents };
    for (const bad of [{ withdrawal_owner: 'other' }, { withdrawal_usd: 1 }, { withdrawal_kobo: 1 }, { locked_usd_cents: 0 }]) {
      s.pool.query.mockResolvedValue({ rows: [{ ...row, ...bad }] }); expect(await s.source.reservationMatches(b)).toBe(false);
    }
    s.pool.query.mockResolvedValue({ rows: [row] }); expect(await s.source.reservationMatches(b)).toBe(true);
  });
  test('current owned quote produces canonical destination and exact amount using read-only transaction', async () => {
    const s = setup(); const binding = await s.source.binding(input);
    expect(binding).toMatchObject({ reference, ownerId: input.userId, ownerPersonId: 'person', amountUsdCents: 5000, amountKobo: 500000, feeKobo: 5000 });
    expect(binding.destinationKey).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(binding)).not.toContain('0123456789');
    expect(s.db.query).toHaveBeenCalledWith('BEGIN READ ONLY'); expect(s.db.query).toHaveBeenCalledWith('COMMIT');
  });
});
