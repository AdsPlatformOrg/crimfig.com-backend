import { PaystackProviderBroker } from '../../../shared/src/financial-security/provider-broker';
import { createHmac } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { PaystackService } from '../../../api/billing-api/src/modules/providers/paystack.service';
import { WebhooksController } from '../../../api/billing-api/src/modules/webhooks/webhooks.controller';
import { WebhooksService } from '../../../api/billing-api/src/modules/webhooks/webhooks.service';

describe('public provider callback boundary', () => {
  it('checks exact raw bytes and a configured secret; missing/default keys never authenticate', () => {
    const raw = '{ "event": "charge.success" }';
    expect(() => new PaystackProviderBroker('')).toThrow();
    const secret = 'sk_test_unit_provider_fixture';
    const broker = new PaystackProviderBroker(secret);
    const signature = createHmac('sha512', secret).update(raw).digest('hex');
    expect(broker.verifyWebhook(Buffer.from(raw).toString('base64'), signature)).toBe(true);
    expect(broker.verifyWebhook(Buffer.from(JSON.stringify(JSON.parse(raw))).toString('base64'), signature)).toBe(false);
    expect(broker.verifyWebhook(Buffer.from(raw).toString('base64'), 'short')).toBe(false);
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
