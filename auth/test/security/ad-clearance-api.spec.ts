import 'reflect-metadata';
import { validate } from 'class-validator';
import { AdClearanceController, ApproveAdClearanceDto, PrepareAdClearanceDto } from '../../../api/billing-api/src/modules/ecosystem/ad-clearance.controller';

describe('Ad clearance API identity boundary', () => {
  test('all operations use the authenticated subject, never request operator identities', async () => {
    const service: any = { read: jest.fn(), prepare: jest.fn(), approve: jest.fn() };
    const controller = new AdClearanceController(service);
    const req = { user: { sub: 'authenticated-operator' } };
    await controller.read(req, 'item');
    await controller.prepare(req, 'item', { evidenceId: 'report', preparedBy: 'attacker' } as any);
    await controller.approve(req, 'item', { draftId: 'draft', reviewedBy: 'attacker' } as any);
    expect(service.read).toHaveBeenCalledWith('authenticated-operator', 'item');
    expect(service.prepare).toHaveBeenCalledWith('authenticated-operator', 'item', 'report');
    expect(service.approve).toHaveBeenCalledWith('authenticated-operator', 'item', 'draft');
  });
  test('review DTOs reject missing evidence and malformed draft identifiers', async () => {
    expect((await validate(Object.assign(new PrepareAdClearanceDto(), { evidenceId: '' }))).length).toBeGreaterThan(0);
    expect((await validate(Object.assign(new ApproveAdClearanceDto(), { draftId: 'not-a-uuid' }))).length).toBeGreaterThan(0);
  });
});
