import { Injectable } from '@nestjs/common';
import { PaystackService } from '../providers/paystack.service';
import { WithdrawalLedgerService } from './withdrawal-ledger.service';
import { verifiedTransferOutcome } from './withdrawal-state';

/** Unexposed until endpoint/webhook/operator integration is verified. No automatic write retries. */
@Injectable()
export class WithdrawalDispatchService {
  constructor(private readonly ledger: WithdrawalLedgerService, private readonly paystack: PaystackService) {}

  async dispatch(userId: string, reference: string) {
    const intent = await this.ledger.dispatchIntent(userId, reference, true);
    if (!intent.claimed) return { reference, status: intent.status, confirmation: 'recovery_required' };
    try {
      const data = await this.paystack.initiateTransfer({ reference, amountKobo: intent.amountKobo, recipientCode: intent.recipientCode });
      return await this.consume(intent, data);
    } catch {
      // Started is durable even if dispatch never reached provider. Keep reservation; never assume failure/refund.
      return { reference, status: 'processing', confirmation: 'unconfirmed' };
    }
  }

  async recover(userId: string, reference: string) {
    const intent = await this.ledger.dispatchIntent(userId, reference, false);
    if (!intent.dispatchStarted) return { reference, status: intent.status, confirmation: 'not_dispatched' };
    try { return await this.consume(intent, await this.paystack.verifyTransfer(reference)); }
    catch { return { reference, status: intent.status, refund: intent.refund, confirmation: 'unconfirmed' }; }
  }

  private async consume(intent: Awaited<ReturnType<WithdrawalLedgerService['dispatchIntent']>>, data: unknown) {
    const proof = data as { status?: string } | null;
    const expected = { reference: intent.reference, amountKobo: intent.amountKobo, recipientCode: intent.recipientCode,
      domain: intent.domain, transferCode: intent.transferCode };
    if (proof && ['pending', 'otp', 'received', 'queued'].includes(proof.status || '')) {
      // Same strict evidence binding as terminal events; only status classification differs.
      verifiedTransferOutcome(expected, { ...proof, status: 'success' });
      const current = await this.ledger.dispatchIntent(intent.userId, intent.reference, false);
      if (['completed', 'failed', 'reversed'].includes(current.status)) return { reference: intent.reference, status: current.status, refund: current.refund, confirmation: 'confirmed' };
      return { reference: intent.reference, status: current.status,
        confirmation: proof.status === 'otp' ? 'operator_approval_required' : 'pending' };
    }
    verifiedTransferOutcome(expected, data);
    await this.ledger.complete(intent.reference, data);
    const current = await this.ledger.dispatchIntent(intent.userId, intent.reference, false);
    return { reference: intent.reference, status: current.status, refund: current.refund, confirmation: 'confirmed' };
  }
}
