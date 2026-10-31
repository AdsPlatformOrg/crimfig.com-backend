import { WithdrawalBinding, withdrawalDigest } from './authorization';
import { IsolatedPayoutAdapter } from './executor';

export interface VerifiedProviderTransfer {
  reference: string; amountKobo: number; recipientCode: string; currency: 'NGN';
  environment: 'test' | 'live'; transferCode: string; status: string;
}
export function exactProviderTransfer(data: unknown, binding: WithdrawalBinding): VerifiedProviderTransfer {
  const value = data as any;
  if (!value || value.reference !== binding.reference || value.amount !== binding.amountKobo
    || value.currency !== 'NGN' || value.domain !== binding.environment
    || value.recipient?.recipient_code !== binding.recipientCode || typeof value.transfer_code !== 'string'
    || !/^TRF_[A-Za-z0-9]+$/.test(value.transfer_code)
    || !['pending', 'otp', 'received', 'queued', 'success', 'failed', 'reversed', 'blocked', 'rejected', 'abandoned'].includes(value.status)) {
    throw new Error('Provider transfer does not match the authorized withdrawal');
  }
  return { reference: binding.reference, amountKobo: binding.amountKobo, recipientCode: binding.recipientCode,
    currency: 'NGN', environment: binding.environment, transferCode: value.transfer_code, status: value.status };
}
/** Instantiate only inside the isolated executor. Fixed provider origin; no arbitrary URL or generic signing API. */
export class IsolatedPaystackAdapter implements IsolatedPayoutAdapter {
  constructor(private readonly secret: string, private readonly environment: 'test' | 'live',
    private readonly request: typeof fetch = fetch) {
    if (!secret.startsWith(environment === 'live' ? 'sk_live_' : 'sk_test_') || secret.length < 20) throw new Error('Independent provider credentials unavailable');
  }
  private assertBinding(binding: WithdrawalBinding) {
    withdrawalDigest(binding);
    if (binding.environment !== this.environment || !/^wd_[a-f0-9]{40}$/.test(binding.reference)
      || !/^RCP_[A-Za-z0-9]+$/.test(binding.recipientCode)) throw new Error('Invalid provider binding');
  }
  async submit(binding: WithdrawalBinding): Promise<{ reference: string; digest: string; receipt: string }> {
    this.assertBinding(binding);
    const response = await this.request('https://api.paystack.co/transfer', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${this.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'balance', currency: 'NGN', amount: binding.amountKobo,
        recipient: binding.recipientCode, reference: binding.reference, reason: 'CrimFig Withdrawal' }),
    });
    const body: any = await response.json();
    if (!response.ok || body?.status !== true) throw new Error('Provider submission unconfirmed');
    let transfer: VerifiedProviderTransfer;
    if (Number.isSafeInteger(body.data?.recipient) && body.data.recipient > 0) {
      // Paystack initiation can return a numeric recipient ID. Resolve it through read-only verification,
      // never pretend that ID proves the authorized RCP code or repeat the transfer POST.
      if (body.data.reference !== binding.reference || body.data.amount !== binding.amountKobo
        || body.data.currency !== 'NGN' || body.data.domain !== binding.environment
        || !/^TRF_[A-Za-z0-9]+$/.test(body.data.transfer_code)) throw new Error('Provider submission binding mismatch');
      transfer = await this.read(binding);
      if (transfer.transferCode !== body.data.transfer_code) throw new Error('Provider transfer identity changed');
    } else transfer = exactProviderTransfer(body.data, binding);
    return { reference: binding.reference, digest: withdrawalDigest(binding), receipt: transfer.transferCode };
  }
  async read(binding: WithdrawalBinding): Promise<VerifiedProviderTransfer> {
    this.assertBinding(binding);
    const response = await this.request(`https://api.paystack.co/transfer/verify/${encodeURIComponent(binding.reference)}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${this.secret}` },
    });
    const body: any = await response.json();
    if (!response.ok || body?.status !== true) throw new Error('Provider outcome unavailable');
    return exactProviderTransfer(body.data, binding);
  }
}
