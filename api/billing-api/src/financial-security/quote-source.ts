import { createHash } from 'crypto';
import { Pool } from 'pg';
import { IndependentQuoteSource, WithdrawalBinding, FINANCIAL_SECURITY_POLICY as policy, withdrawalDigest } from '@crimfig/shared';

/** Separate read-only credentials. This establishes quote/reservation facts, NOT cleared-funds provenance. */
export class PostgresQuoteSource implements IndependentQuoteSource {
  constructor(private readonly pool: Pool) {}
  async binding(input: { userId: string; requestId: string; quoteId: string; bankAccountId: string; amountUsdCents: number }): Promise<WithdrawalBinding> {
    const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
    if (![input.userId, input.requestId, input.quoteId, input.bankAccountId].every(v => typeof v === 'string' && uuid.test(v))
      || !Number.isSafeInteger(input.amountUsdCents) || input.amountUsdCents < policy.minimumWithdrawalUsdCents) throw new Error('Invalid withdrawal quote identity');
    const reference = 'wd_' + createHash('sha256').update(input.userId + ':' + input.requestId.toLowerCase()).digest('hex').slice(0, 40);
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN READ ONLY'); await db.query("SET LOCAL statement_timeout='3s'");
      const { rows } = await db.query(`SELECT e.raw_payload AS quote,u.status,u.mfa_enabled,i.person_id,i.active,i.recovery_cleared_at,
        b.is_verified,b.recipient_code,b.bank_code,b.account_number,b.updated_at AS bank_version
        FROM billing_provider_events e
        JOIN users u ON u.id=$2 JOIN auth_financial_identities i ON i.user_id=u.id
        JOIN billing_bank_accounts b ON b.id=$3 AND b.user_id=u.id
        WHERE e.provider='paystack' AND e.reference=$1 AND e.event_type='internal.withdrawal.quote'`, [`internal.withdrawal.quote:${reference}`, input.userId, input.bankAccountId]);
      const r = rows[0], q = r?.quote;
      if (!r || r.status !== 'ACTIVE' || !r.mfa_enabled || !r.active || !r.is_verified || !r.person_id
        || !Number.isFinite(new Date(r.recovery_cleared_at).getTime()) || new Date(r.recovery_cleared_at).getTime() > Date.now() || q?.quoteId !== input.quoteId || q.userId !== input.userId
        || q.bankAccountId !== input.bankAccountId || q.amountUsdCents !== input.amountUsdCents || q.reference !== reference
        || q.requestId !== input.requestId.toLowerCase() || q.recipientCode !== r.recipient_code || Date.parse(q.expiresAt) <= Date.now()) throw new Error('Owned current withdrawal quote unavailable');
      const binding: WithdrawalBinding = { reference, requestId: q.requestId, ownerId: input.userId, ownerPersonId: r.person_id,
        destinationKey: createHash('sha256').update(JSON.stringify(['NGN', r.bank_code, r.account_number])).digest('hex'),
        destinationVersion: `${input.bankAccountId}:${new Date(r.bank_version).toISOString()}`, recipientCode: r.recipient_code,
        amountUsdCents: q.amountUsdCents, amountKobo: q.netKobo, feeKobo: q.totalFeeKobo, exchangeRateId: q.rateId, quoteId: q.quoteId,
        environment: q.domain, policyVersion: policy.version, expiresAt: Date.parse(q.expiresAt) };
      withdrawalDigest(binding); await db.query('COMMIT'); return binding;
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  async reservationMatches(binding: WithdrawalBinding): Promise<boolean> {
    const { rows } = await this.pool.query(`SELECT t.metadata,t.amount_usd_cents,t.amount_ngn_kobo,t.user_id,t.status,
      w.status AS withdrawal_status,w.user_id AS withdrawal_owner,w.amount_usd_cents AS withdrawal_usd,
      w.amount_ngn_kobo AS withdrawal_kobo,w.paystack_transfer_reference AS withdrawal_reference,
      wallet.locked_usd_cents,b.recipient_code,b.is_verified,b.updated_at AS bank_version,b.id AS bank_id,
      i.person_id,i.active,i.recovery_cleared_at,u.status AS user_status,u.mfa_enabled
      FROM billing_transactions t JOIN billing_withdrawal_requests w ON w.transaction_id=t.id
      JOIN billing_bank_accounts b ON b.id=w.bank_account_id AND b.user_id=t.user_id
      JOIN users u ON u.id=t.user_id JOIN auth_financial_identities i ON i.user_id=u.id
      JOIN billing_wallets wallet ON wallet.user_id=t.user_id
      WHERE t.reference=$1 AND t.type='wallet_withdraw' AND t.provider='paystack'`, [binding.reference]);
    const r = rows[0]; if (!r) return false;
    let meta: any; try { meta = JSON.parse(r.metadata || '{}'); } catch { return false; }
    return r.user_id === binding.ownerId && r.person_id === binding.ownerPersonId && r.active === true && r.user_status === 'ACTIVE' && r.mfa_enabled === true
      && new Date(r.recovery_cleared_at).getTime() <= Date.now() && r.is_verified === true && r.recipient_code === binding.recipientCode
      && `${r.bank_id}:${new Date(r.bank_version).toISOString()}` === binding.destinationVersion
      && r.amount_usd_cents === binding.amountUsdCents && r.amount_ngn_kobo === binding.amountKobo
      && r.withdrawal_owner === binding.ownerId && r.withdrawal_usd === binding.amountUsdCents
      && r.withdrawal_kobo === binding.amountKobo && r.withdrawal_reference === binding.reference
      && Number.isSafeInteger(r.locked_usd_cents) && r.locked_usd_cents >= binding.amountUsdCents
      && r.status === 'pending' && r.withdrawal_status === 'processing' && meta.dispatch === 'started'
      && meta.authorityDigest === withdrawalDigest(binding) && meta.payoutQuote?.quoteId === binding.quoteId;
  }
}
