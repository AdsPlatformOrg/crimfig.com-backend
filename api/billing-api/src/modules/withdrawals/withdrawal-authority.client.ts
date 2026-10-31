import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { FINANCIAL_SECURITY_POLICY as policy, FinancialProof, signPrivateRequest, readPrivateResponse } from '@crimfig/shared';

@Injectable()
export class WithdrawalAuthorityClient {
  async availability() {
    if (!policy.executionEnabled) return { available: false, reason: 'security_setup' };
    try {
      const result = await this.call('/internal/v1/withdrawals/availability', {});
      return { available: result?.available === true, reason: result?.available === true ? null : 'security_unavailable' };
    } catch { return { available: false, reason: 'security_unavailable' }; }
  }
  assertReleased(): void {
    if (!policy.executionEnabled) throw new ServiceUnavailableException('New withdrawal execution is held while independent security controls are being activated. Existing requests remain available for status checks.');
    this.credentials();
  }
  private credentials() {
    try {
      const url = new URL(process.env.FINANCIAL_AUTHORITY_URL || '');
      const privateKey = process.env.BILLING_FINANCIAL_WORKLOAD_PRIVATE_KEY;
      const keyId = process.env.BILLING_FINANCIAL_WORKLOAD_KEY_ID;
      const keys = JSON.parse(process.env.FINANCIAL_AUTHORITY_PUBLIC_KEYS || '{}');
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/'
        || !privateKey || !keyId || !keys || Array.isArray(keys) || !Object.keys(keys).length) throw new Error();
      return { origin: url.origin, privateKey, keyId, keys };
    } catch { throw new ServiceUnavailableException('Independent withdrawal authority is not configured'); }
  }
  private async call(path: string, body: unknown): Promise<any> {
    const c = this.credentials(); const request = signPrivateRequest(path, body, c.keyId, c.privateKey);
    const response = await fetch(`${c.origin}${path}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    if (!response.ok) throw new ServiceUnavailableException('Independent withdrawal approval is unavailable');
    const value = await response.text(); if (Buffer.byteLength(value) > 65536) throw new ServiceUnavailableException('Invalid authority response');
    return readPrivateResponse(JSON.parse(value), request, c.keys);
  }
  async authorize(params: { userId: string; requestId: string; bankAccountId: string; amountUsdCents: number; quoteId: string; ownerProof?: FinancialProof }) {
    this.assertReleased();
    if (!params.ownerProof) throw new UnauthorizedException('Confirm this withdrawal with transaction-specific MFA first');
    const result = await this.call('/internal/v1/withdrawals/authorize', params);
    if (result?.state !== 'authorized' || result.userId !== params.userId || result.requestId !== params.requestId
      || result.quoteId !== params.quoteId || result.amountUsdCents !== params.amountUsdCents || result.bankAccountId !== params.bankAccountId
      || !/^[a-f0-9]{64}$/.test(result.digest)) throw new UnauthorizedException('Independent withdrawal approval is required');
    return result.digest as string;
  }
  async prepare(params: { userId: string; requestId: string; bankAccountId: string; amountUsdCents: number; quoteId: string }) {
    const result = await this.call('/internal/v1/withdrawals/prepare', params);
    if (result?.state !== 'awaiting_authorization' || !/^wd_[a-f0-9]{40}$/.test(result.reference) || !/^[a-f0-9]{64}$/.test(result.digest)) throw new ServiceUnavailableException('Withdrawal authorization could not be prepared');
    return result;
  }
  async review(userId: string, reference: string, proof: FinancialProof) {
    if (proof?.actorId !== userId || proof.purpose !== 'independent_review') throw new UnauthorizedException('Independent review proof required');
    const result = await this.call('/internal/v1/withdrawals/review', { userId, reference, proof });
    if (result?.reference !== reference || result.state !== 'review_recorded') throw new ServiceUnavailableException('Review could not be confirmed');
    return result;
  }
  async execute(intent: { userId: string; reference: string; amountKobo: number; recipientCode: string; domain: string; authorityDigest?: string }) {
    this.assertReleased();
    if (!intent.authorityDigest) throw new UnauthorizedException('Legacy withdrawal requires independent reconciliation');
    const result = await this.call('/internal/v1/withdrawals/execute', { ...intent, digest: intent.authorityDigest });
    if (result?.reference !== intent.reference || result.digest !== intent.authorityDigest
      || !['held', 'recovery_required', 'submitted', 'unknown'].includes(result.state)) throw new ServiceUnavailableException('Withdrawal execution is unconfirmed');
    return result;
  }
}
