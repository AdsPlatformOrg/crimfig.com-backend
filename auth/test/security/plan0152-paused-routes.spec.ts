import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConversionsController } from '../../../api/ads-api/src/modules/conversions/conversions.controller';
import { DisputesController } from '../../../api/ads-api/src/modules/disputes/disputes.controller';
import { PromotersController } from '../../../api/ads-api/src/modules/promoters/promoters.controller';

describe('PLAN-0152 paused conversions and standalone disputes routes', () => {
  it('reads a promoter profile for the current account without provisioning one', async () => {
    const existing = { userId: 'owner-1', displayName: 'Promoter' };
    const service = {
      getExistingPromoter: jest.fn().mockResolvedValueOnce(existing).mockRejectedValueOnce(new NotFoundException()),
      getOrCreatePromoter: jest.fn(),
    };
    const controller = new PromotersController(service as any);
    const request = { user: { sub: 'owner-1' } };
    await expect(controller.getExistingProfile(request)).resolves.toEqual({ status: 'success', data: existing });
    await expect(controller.getExistingProfile(request)).resolves.toEqual({ status: 'success', data: null });
    expect(service.getExistingPromoter).toHaveBeenNthCalledWith(1, 'owner-1');
    expect(service.getOrCreatePromoter).not.toHaveBeenCalled();
  });
  it('pauses pixel/S2S conversion ingestion and API key issuance while preserving reads, revocation, and reversals', async () => {
    const service = {
      ingestConversion: jest.fn(),
      createApiKey: jest.fn(),
      getConversions: jest.fn().mockResolvedValue([{ id: 'conv-1' }]),
      reverseConversion: jest.fn().mockResolvedValue({ reversed: true }),
      listApiKeys: jest.fn().mockResolvedValue([{ id: 'key-1' }]),
      revokeApiKey: jest.fn().mockResolvedValue({ revoked: true }),
    };
    const controller = new ConversionsController(service as any);

    await controller.collectPixel({ advertiserId: 'adv-1', event: 'purchase' });
    expect(service.ingestConversion).not.toHaveBeenCalled();

    await expect(
      controller.reportS2SConversion('Bearer secret', { event: 'purchase' }),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(service.ingestConversion).not.toHaveBeenCalled();

    await expect(
      controller.createApiKey({ user: { sub: 'adv-1' } }, { name: 'key' }),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(service.createApiKey).not.toHaveBeenCalled();

    const hist = await controller.getConversions({ user: { sub: 'adv-1' } });
    expect(hist).toEqual({ status: 'success', data: [{ id: 'conv-1' }] });
    await controller.reverseConversion('conv-1', { user: { sub: 'adv-1' } }, { reason: 'refund' });
    expect(service.reverseConversion).toHaveBeenCalledWith('conv-1', 'adv-1', 'refund');
    await controller.revokeApiKey('key-1', { user: { sub: 'adv-1' } });
    expect(service.revokeApiKey).toHaveBeenCalledWith('key-1', 'adv-1');
  });

  it('pauses standalone customer dispute creation while preserving reads and admin resolution', async () => {
    const disputesService = {
      createDispute: jest.fn(),
      getDisputes: jest.fn().mockResolvedValue([{ id: 'disp-1' }]),
      getDisputeById: jest.fn().mockResolvedValue({ id: 'disp-1' }),
      resolveDispute: jest.fn().mockResolvedValue({ id: 'disp-1', status: 'resolved_upheld' }),
    };
    const controller = new DisputesController(disputesService as any);

    await expect(
      controller.createDispute(
        { user: { sub: 'user-1' } },
        { role: 'advertiser', scope: 'general', periodFrom: '2026-11-01', periodTo: '2026-11-22', reason: 'ivt', details: 'check' },
      ),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(disputesService.createDispute).not.toHaveBeenCalled();

    const list = await controller.getDisputes({ user: { sub: 'user-1' } });
    expect(list).toEqual({ status: 'success', data: [{ id: 'disp-1' }] });
    await expect(controller.resolveDispute('disp-1', { user: { sub: 'staff-1' } }, {
      status: 'resolved_upheld', outcome: 'Existing case reviewed',
    })).resolves.toEqual({ status: 'success', data: { id: 'disp-1', status: 'resolved_upheld' } });
    expect(disputesService.resolveDispute).toHaveBeenCalledWith('disp-1', expect.objectContaining({
      adminId: 'staff-1', status: 'resolved_upheld',
    }));
  });
});
