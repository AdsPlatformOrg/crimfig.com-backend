import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import { WalletService } from '../../../api/billing-api/src/modules/wallet/wallet.service';
import { EcosystemController } from '../../../api/billing-api/src/modules/ecosystem/ecosystem.controller';

describe('Billing owner and internal service boundaries', () => {
  it('requires a funding owner and cannot verify another user reference or call the provider for it', async () => {
    const provider = { verifyTransaction: jest.fn() };
    const transaction = { userId: 'owner', reference: 'payment-reference', status: 'completed' };
    const dialect = new PgDialect();
    const db = { select: () => ({ from: () => ({ where: (where: any) => ({ limit: async () => {
      const query = dialect.sqlToQuery(where);
      return query.params.includes(transaction.userId) && query.params.includes(transaction.reference) ? [transaction] : [];
    } }) }) }) };
    const service = new WalletService(db as any, {} as any, provider as any);
    await expect(service.verifyFunding(transaction.reference, '')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.verifyFunding(transaction.reference, 'intruder')).rejects.toBeInstanceOf(NotFoundException);
    expect(await service.verifyFunding(transaction.reference, 'owner')).toMatchObject({ status: 'already_completed' });
    expect(provider.verifyTransaction).not.toHaveBeenCalled();
  });

  it('internal wallet access fails closed in development too; no built-in secret', async () => {
    const previous = process.env.INTERNAL_ECOSYSTEM_KEY;
    const wallet = { getBalance: jest.fn(async () => ({ usd: 0 })) };
    try {
      delete process.env.INTERNAL_ECOSYSTEM_KEY;
      const missing = new EcosystemController(wallet as any, {} as any);
      await expect(missing.getBalance('victim', 'anything')).rejects.toBeInstanceOf(UnauthorizedException);
      process.env.INTERNAL_ECOSYSTEM_KEY = 'test-only-internal-service-key';
      const guarded = new EcosystemController(wallet as any, {} as any);
      for (const value of ['', 'wrong', 'crimfig-internal-eco-key-2026']) {
        await expect(guarded.getBalance('victim', value)).rejects.toBeInstanceOf(UnauthorizedException);
      }
      expect(wallet.getBalance).not.toHaveBeenCalled();
      await expect(guarded.getBalance('owner', process.env.INTERNAL_ECOSYSTEM_KEY)).resolves.toMatchObject({ status: 'success' });
    } finally {
      if (previous === undefined) delete process.env.INTERNAL_ECOSYSTEM_KEY;
      else process.env.INTERNAL_ECOSYSTEM_KEY = previous;
    }
  });
});
