import { DeliveryService } from '../../../api/ads-api/src/modules/delivery/delivery.service';
const { JSDOM } = require('jsdom');

const tick = async () => {
  await new Promise((done) => setImmediate(done));
  await new Promise((done) => setImmediate(done));
};

test('PLAN0134 corner attribution icon uses clean light surface at rest (never warning red) and high contrast on interaction', async () => {
  const previous = process.env.ADS_PUBLIC_URL;
  process.env.ADS_PUBLIC_URL = 'https://ads.example.test';
  const dom = new JSDOM(
    '<!doctype html><ins class="crimfig-pub-slot" data-ad-slot="cf-slot-test" style="display:block;min-height:250px"></ins>',
    { url: 'https://publisher.example.test', runScripts: 'outside-only' },
  );
  const win = dom.window;
  const slot = win.document.querySelector('ins');
  slot.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 250, width: 320, height: 250 });
  win.fetch = async () => ({
    ok: true,
    json: async () => ({
      data: {
        id: 'ad-1',
        adType: 'image',
        format: 'medium_rectangle',
        width: 300,
        height: 250,
        imageUrl: 'https://ads.example.test/image.webp',
        clickUrl: 'https://advertiser.example.test/landing',
        impToken: 'imp_signed_fixture',
        isHouseAd: false,
      },
    }),
  });
  win.navigator.sendBeacon = () => false;

  try {
    const service = new DeliveryService({} as any, {} as any, {} as any, {} as any);
    win.eval(service.getEmbedScript());
    win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
    await tick();
    win.document.querySelector('img').dispatchEvent(new win.Event('load'));
    await tick();

    const trigger = win.document.querySelector('[data-cf-rating-trigger="true"]');
    const dot = win.document.querySelector('[data-cf-attribution-icon="true"]');
    const label = win.document.querySelector('[data-cf-attribution-label="true"]');
    expect(trigger).not.toBeNull();
    expect(dot).not.toBeNull();

    // Negative: must NOT use crimson/warning red (#D4143A / rgb(212, 20, 58))
    expect(dot.style.background).not.toMatch(/212,\s*20,\s*58|#d4143a/i);
    expect(dot.style.background).toMatch(/#e2e8f0|rgb\(226,\s*232,\s*240\)/i);
    expect(trigger.style.opacity).toBe('0.88');
    expect(label.style.display).toBe('none');

    // Interaction (hover) elevates to crisp light pill, dark icon circle, and full opacity
    const card = trigger.parentElement;
    card.dispatchEvent(new win.Event('mouseenter'));
    expect(label.style.display).toBe('inline');
    expect(trigger.style.opacity).toBe('1');
    expect(trigger.style.background).toMatch(/#ffffff|rgb\(255,\s*255,\s*255\)/i);
    expect(dot.style.background).toMatch(/#171b2a|rgb\(23,\s*27,\s*42\)/i);

    // Leaving card returns to muted resting state
    card.dispatchEvent(new win.Event('mouseleave'));
    expect(label.style.display).toBe('none');
    expect(trigger.style.opacity).toBe('0.88');
    expect(dot.style.background).toMatch(/#e2e8f0|rgb\(226,\s*232,\s*240\)/i);
  } finally {
    win.close();
    if (previous === undefined) delete process.env.ADS_PUBLIC_URL;
    else process.env.ADS_PUBLIC_URL = previous;
  }
});
