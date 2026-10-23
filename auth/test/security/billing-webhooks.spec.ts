import { createHmac } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { PaystackService } from '../../../api/billing-api/src/modules/providers/paystack.service';
import { WebhooksController } from '../../../api/billing-api/src/modules/webhooks/webhooks.controller';
import { WebhooksService } from '../../../api/billing-api/src/modules/webhooks/webhooks.service';

describe('public provider callback boundary', () => {
  it('checks exact raw bytes and a configured secret; missing/default keys never authenticate', () => {
    const previous = process.env.PAYSTACK_SECRET_KEY;
    const raw = '{ "event": "charge.success", "data": {"reference":"test"} }';
    try {
      delete process.env.PAYSTACK_SECRET_KEY;
      const unconfigured = new PaystackService();
      const oldDefaultSignature = createHmac('sha512', 'sk_test_mock_paystack_key').update(raw).digest('hex');
      expect(unconfigured.verifyWebhookSignature(oldDefaultSignature, raw)).toBe(false);
      process.env.PAYSTACK_SECRET_KEY = 'unit-test-provider-secret';
      const configured = new PaystackService();
      const signature = createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(raw).digest('hex');
      expect(configured.verifyWebhookSignature(signature, Buffer.from(raw))).toBe(true);
      expect(configured.verifyWebhookSignature(signature, JSON.stringify(JSON.parse(raw)))).toBe(false);
      expect(configured.verifyWebhookSignature('short', raw)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.PAYSTACK_SECRET_KEY;
      else process.env.PAYSTACK_SECRET_KEY = previous;
    }
  });

  it('controller forwards captured raw bytes rather than reserialized JSON', async () => {
    const raw = Buffer.from('{ "event": "test" }');
    const service = { handlePaystackWebhook: jest.fn(async () => ({ status: 'accepted' })) };
    const controller = new WebhooksController(service as any);
    await controller.handlePaystack('signature', { body: { event: 'test' }, rawBody: raw });
    expect(service.handlePaystackWebhook).toHaveBeenCalledWith(raw.toString('utf8'), 'signature');
    await expect(controller.handlePaystack('signature', { body: {} })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('invalid signatures are rejected before database work in every environment', async () => {
    const database = { select: jest.fn() };
    const service = new WebhooksService(database as any,
      { verifyWebhookSignature: () => false } as any, {} as any);
    await expect(service.handlePaystackWebhook('{"event":"test"}', 'invalid')).rejects.toBeInstanceOf(BadRequestException);
    expect(database.select).not.toHaveBeenCalled();
  });
});
