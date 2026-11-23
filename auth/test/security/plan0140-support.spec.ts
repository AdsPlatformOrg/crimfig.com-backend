jest.mock('../../src/config/config', () => ({
  config: {
    SUPPORT: { OUTBOX_WORKER_ENABLED: false },
    APP: { AUTH_WEB_URL: 'https://auth.example.test', ADS_WEB_URL: 'https://ads.example.test' },
    EMAIL: { BREVO_API_KEY: '', FROM: 'noreply@crimfig.com', FROM_NAME: 'CrimFig' },
  },
}));

import { ForbiddenException } from '@nestjs/common';
import { SUPPORT_STAFF_MAIL, ticketReference, checkSupportTransition } from '../../src/modules/support/support-policy';
import { EmailService } from '../../src/modules/email/email.service';
import { SupportService } from '../../src/modules/support/support.service';
import { SupportWorker } from '../../src/modules/support/support.worker';

describe('Support policy & service negative-first checks', () => {
  test('rejects unknown transition and allows reopen review', () => {
    expect(() => checkSupportTransition('closed', 'open')).toThrow();
    expect(() => checkSupportTransition('open', 'invalid')).toThrow();
    expect(() => checkSupportTransition('closed', 'in_progress')).not.toThrow();
  });

  test('references preserve all digits with minimum two', () => {
    expect(ticketReference(1)).toBe('#01');
    expect(ticketReference(1013)).toBe('#1013');
    expect(ticketReference('100000001')).toBe('#100000001');
  });

  test('rejects invalid input and ungranted staff access before database writes', async () => {
    const db = { transaction: jest.fn(), execute: jest.fn() } as any;
    const grants = { rolesFor: jest.fn().mockResolvedValue(['auth_admin']) } as any;
    const email = { sendSupportEmail: jest.fn() } as any;
    const service = new SupportService(db, grants, email);

    await expect(
      service.create('user-1', { requestId: 'req-1', category: 'technical', subject: '   ', body: 'Valid length body here.' }),
    ).rejects.toThrow();
    await expect(
      service.create('user-1', { requestId: 'req-2', category: 'technical', subject: 'Help', body: 'short' }),
    ).rejects.toThrow();
    expect(db.transaction).not.toHaveBeenCalled();

    await expect(service.list('user-1', {}, true)).rejects.toThrow(ForbiddenException);
    await expect(service.reply('user-1', 't-1', { requestId: 'req-3', body: 'hi' }, false, true)).rejects.toThrow(ForbiddenException);
    expect(db.execute).not.toHaveBeenCalled();
  });

  test('staff mail target routes to support@crimfig.com and customer mail includes support@crimfig.com without admin links', () => {
    expect(SUPPORT_STAFF_MAIL).toEqual({ to: 'support@crimfig.com', bcc: 'jedaccthree@gmail.com' });

    const email = new EmailService();
    const ticket = { id: '11111111-1111-4111-8111-111111111111', ticket_number: '#01' };
    const ack = email.buildSupportEmailContent('ack', ticket);
    const reply = email.buildSupportEmailContent('reply', ticket);
    const staff = email.buildSupportEmailContent('staff', ticket);

    expect(ack.textContent).toContain('#01');
    expect(ack.textContent).toContain('support@crimfig.com');
    expect(ack.textContent).not.toContain('/admin/support');
    expect(ack.textContent).not.toContain('jedaccthree@gmail.com');

    expect(reply.textContent).toContain('support@crimfig.com');
    expect(reply.textContent).not.toContain('/admin/support');

    expect(staff.textContent).toContain('/admin/support?ticket=' + ticket.id);
  });

  test('worker stays disabled in test mode and handles dispatch failure gracefully', async () => {
    const dispatch = jest.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(1);
    const worker = new SupportWorker({ dispatch } as any);

    worker.onModuleInit();
    await worker.tick();
    await worker.tick();
    worker.onModuleDestroy();

    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});
