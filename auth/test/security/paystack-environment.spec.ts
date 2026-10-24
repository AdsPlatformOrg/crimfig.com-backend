import { PaystackService } from '../../../api/billing-api/src/modules/providers/paystack.service';

describe('Paystack deployment environment isolation', () => {
  const keys = ['NODE_ENV', 'RAILWAY_ENVIRONMENT_NAME', 'PAYSTACK_MODE', 'PAYSTACK_SECRET_KEY'] as const;
  let previous: (string | undefined)[];
  beforeEach(() => { previous = keys.map(key => process.env[key]); keys.forEach(key => delete process.env[key]); });
  afterEach(() => keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }));
  test('production cannot use TEST keys even if test mode is requested', () => {
    process.env.NODE_ENV = 'production'; process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
    process.env.PAYSTACK_MODE = 'test'; process.env.PAYSTACK_SECRET_KEY = 'sk_test_fixture';
    expect(() => new PaystackService().paymentDomain()).toThrow();
  });
  test('Railway staging permits TEST keys under a production Node build and refuses LIVE keys', () => {
    process.env.NODE_ENV = 'production'; process.env.RAILWAY_ENVIRONMENT_NAME = 'staging';
    process.env.PAYSTACK_MODE = 'test'; process.env.PAYSTACK_SECRET_KEY = 'sk_test_fixture';
    expect(new PaystackService().paymentDomain()).toBe('test');
    process.env.PAYSTACK_MODE = 'live'; process.env.PAYSTACK_SECRET_KEY = 'sk_live_fixture';
    expect(() => new PaystackService().paymentDomain()).toThrow();
  });
  test('a configured mode must match the key in development too', () => {
    process.env.NODE_ENV = 'development'; process.env.PAYSTACK_MODE = 'live'; process.env.PAYSTACK_SECRET_KEY = 'sk_test_fixture';
    expect(() => new PaystackService().paymentDomain()).toThrow();
  });
});
