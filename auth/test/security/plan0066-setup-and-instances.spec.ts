import * as vm from 'vm';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  SetupChecksService,
  deriveSetupState,
  hostMatchesDomain,
  normalizePagePath,
} from '../../../api/ads-api/src/modules/adstation/setup-checks.service';
import { SdkHandshakeController } from '../../../api/ads-api/src/modules/adstation/sdk-handshake.controller';
import { DeliveryService } from '../../../api/ads-api/src/modules/delivery/delivery.service';

const KEY = 'test-only-setup-check-key-32-characters-minimum';
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const PROMOTER = '33333333-3333-4333-8333-333333333333';
const WEBSITE = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  process.env.ADS_IMPRESSION_SIGNING_KEY = KEY;
});

/** db.execute mock returning queued row sets and recording statements. */
function mockDb(...results: any[][]) {
  const queue = [...results];
  const calls: string[] = [];
  const execute = jest.fn(async (q: any) => {
    const text = JSON.stringify(q?.queryChunks ?? q);
    calls.push(text);
    return { rows: queue.shift() ?? [] };
  });
  return { db: { execute } as any, execute, calls };
}
const writes = (calls: string[]) => calls.filter((c) => /INSERT|UPDATE/i.test(c));

describe('PLAN-0066 F5 setup-check rejection cases', () => {
  it('rejects malformed page paths', () => {
    for (const bad of ['blog', '//evil.com', '/a b', '/x'.padEnd(300, 'y'), '/a\u0000b']) {
      expect(() => normalizePagePath(bad)).toThrow(BadRequestException);
    }
    expect(normalizePagePath('/blog?x=1#h')).toBe('/blog');
    expect(normalizePagePath(undefined)).toBeNull();
  });

  it('host matching is exact (www-insensitive) and never suffix-based', () => {
    expect(hostMatchesDomain('example.com', 'www.example.com')).toBe(true);
    expect(hostMatchesDomain('example.com', 'evil-example.com')).toBe(false);
    expect(hostMatchesDomain('example.com', 'example.com.evil.com')).toBe(false);
    expect(hostMatchesDomain('', '')).toBe(false);
  });

  it('create: non-owner gets NotFound and nothing is written', async () => {
    const { db, calls } = mockDb([{ id: WEBSITE, promoter_id: U2, domain: 'example.com' }]);
    await expect(
      new SetupChecksService(db).create(PROMOTER, WEBSITE, { requestId: U1 }),
    ).rejects.toThrow(NotFoundException);
    expect(writes(calls)).toHaveLength(0);
  });

  it('create: invalid ids are rejected before any query', async () => {
    const { db, execute } = mockDb();
    const svc = new SetupChecksService(db);
    await expect(svc.create(PROMOTER, 'nope', { requestId: U1 })).rejects.toThrow(BadRequestException);
    await expect(svc.create(PROMOTER, WEBSITE, { requestId: 'nope' })).rejects.toThrow(BadRequestException);
    expect(execute).not.toHaveBeenCalled();
  });

  it('create: same requestId with a different page is a conflict', async () => {
    const { db } = mockDb(
      [{ id: WEBSITE, promoter_id: PROMOTER, domain: 'example.com' }],
      [], // ON CONFLICT DO NOTHING -> no row
      [{ id: U2, website_id: WEBSITE, page_path: '/a', created_at: new Date(), expires_at: new Date() }],
    );
    await expect(
      new SetupChecksService(db).create(PROMOTER, WEBSITE, { requestId: U1, pagePath: '/b' }),
    ).rejects.toThrow(ConflictException);
  });

  it('create: unconfigured signing key fails closed', async () => {
    delete process.env.ADS_IMPRESSION_SIGNING_KEY;
    const { db, calls } = mockDb([{ id: WEBSITE, promoter_id: PROMOTER, domain: 'example.com' }]);
    await expect(
      new SetupChecksService(db).create(PROMOTER, WEBSITE, { requestId: U1 }),
    ).rejects.toThrow('unavailable');
    expect(writes(calls)).toHaveLength(0);
  });

  it('get: another promoter cannot read a check', async () => {
    const { db } = mockDb([{ id: U1, promoter_id: U2 }]);
    await expect(new SetupChecksService(db).get(PROMOTER, U1)).rejects.toThrow(NotFoundException);
  });

  describe('SDK acknowledgement writes nothing unless fully bound', () => {
    const future = new Date(Date.now() + 60_000);
    const check = { id: U1, expires_at: future, sdk_executed_at: null, domain: 'example.com' };
    const dto = { challenge: 'cfs_abcdefghijklmnopqrstuvwx', sdkVersion: 'cf-sdk/2', host: 'example.com' };

    it('malformed challenge does not even query', async () => {
      const { db, execute } = mockDb();
      expect(await new SetupChecksService(db).acknowledgeSdk({ ...dto, challenge: 'x' })).toBe(false);
      expect(execute).not.toHaveBeenCalled();
    });

    it('unknown, expired, wrong-host and wrong-origin challenges are ignored', async () => {
      const cases: Array<[any[], any, string | undefined]> = [
        [[], dto, undefined],
        [[{ ...check, expires_at: new Date(Date.now() - 1) }], dto, undefined],
        [[check], { ...dto, host: 'evil.com' }, undefined],
        [[check], dto, 'evil.com'],
      ];
      for (const [rows, d, origin] of cases) {
        const { db, calls } = mockDb(rows);
        expect(await new SetupChecksService(db).acknowledgeSdk(d, origin)).toBe(false);
        expect(writes(calls)).toHaveLength(0);
      }
    });

    it('a repeat acknowledgement is idempotent and never rewrites evidence', async () => {
      const { db, calls } = mockDb([{ ...check, sdk_executed_at: new Date() }]);
      expect(await new SetupChecksService(db).acknowledgeSdk(dto, 'example.com')).toBe(true);
      expect(writes(calls)).toHaveLength(0);
    });

    it('the public controller always answers without revealing the outcome', async () => {
      const ack = jest.fn().mockResolvedValue(false);
      await expect(
        new SdkHandshakeController({ acknowledgeSdk: ack } as any).handshake(dto as any, { headers: { origin: 'not a url' } }),
      ).resolves.toBeUndefined();
      expect(ack).toHaveBeenCalledWith(dto, 'invalid.invalid');
    });

    it('accepts a bound first acknowledgement with exactly one write', async () => {
      const { db, calls } = mockDb([check], []);
      expect(await new SetupChecksService(db).acknowledgeSdk(dto, 'www.example.com')).toBe(true);
      expect(writes(calls)).toHaveLength(1);
    });
  });
});

describe('PLAN-0066 F5 evidence states', () => {
  const base = { id: U1, created_at: new Date(), expires_at: new Date(Date.now() + 60_000), sdk_executed_at: null, sdk_version: null };
  const zero = { serves: 0, renders: 0, measured: 0, viewable: 0 };

  it('a slot request alone never confirms render, measurement, SDK or completion', () => {
    const s = deriveSetupState(base, new Date(), { ...zero, serves: 3 });
    expect(s.states.slot_request_received.status).toBe('confirmed');
    expect(s.states.creative_rendered.status).toBe('pending');
    expect(s.states.measurement_received.status).toBe('pending');
    expect(s.states.sdk_executed.status).toBe('pending');
    expect(s.states.setup_complete.status).toBe('pending');
    expect(s.slotCodeUnlocked).toBe(false);
  });

  it('static script detection is reported unavailable, never as a pass', () => {
    expect(deriveSetupState(base, new Date(), zero).states.script_present.status).toBe('unavailable');
  });

  it('expired incomplete evidence is stale, not success', () => {
    const s = deriveSetupState({ ...base, expires_at: new Date(Date.now() - 1) }, new Date(), zero);
    expect(s.states.sdk_executed.status).toBe('stale');
    expect(s.states.setup_complete.status).toBe('stale');
  });

  it('SDK execution with zero slots unlocks slot code without claiming data', () => {
    const s = deriveSetupState({ ...base, sdk_executed_at: new Date(), sdk_version: 'cf-sdk/2' }, new Date(), zero);
    expect(s.slotCodeUnlocked).toBe(true);
    expect(s.states.setup_complete.status).toBe('pending');
  });

  it('completion needs execution plus accepted measurement', () => {
    const s = deriveSetupState({ ...base, sdk_executed_at: new Date() }, new Date(), { serves: 2, renders: 2, measured: 2, viewable: 1 });
    expect(s.states.setup_complete.status).toBe('confirmed');
  });
});

describe('PLAN-0066 loader: identities, instances and handshake', () => {
  function run(opts: { slots: number; search?: string }) {
    let counter = 0;
    const uuid = () => '00000000-0000-4000-8000-' + String(++counter).padStart(12, '0');
    const fetched: Array<{ url: string; body?: any }> = [];
    const mkSlot = () => ({
      attrs: new Map<string, string>([['data-ad-slot', 'cf-slot-network-x'], ['data-cf-api-base', 'https://api.example.test']]),
      getAttribute(n: string) { return this.attrs.get(n) || null; },
      setAttribute(n: string, v: string) { this.attrs.set(n, v); },
      innerHTML: '', children: [] as any[],
      get firstElementChild() { return this.children[0]; },
      style: { minHeight: '', display: '', height: '', padding: '', margin: '' },
      isConnected: true,
      getBoundingClientRect() { return { top: 0, left: 0, bottom: 90, right: 728, width: 728, height: 90 }; },
      appendChild(c: any) { this.children.push(c); },
      querySelectorAll() { return []; },
    });
    const slots = Array.from({ length: opts.slots }, mkSlot);
    const createElement = (tag: string) => ({
      tag, isConnected: true, style: { cssText: '' }, textContent: '', children: [] as any[], attributes: {} as any,
      appendChild(c: any) { this.children.push(c); },
      setAttribute(k: string, v: string) { this.attributes[k] = v; },
      getAttribute(k: string) { return this.attributes[k]; },
      getBoundingClientRect() { return { top: 0, left: 0, bottom: 90, right: 728, width: 728, height: 90 }; },
      addEventListener(e: string, cb: () => void) { if (tag === 'img' && e === 'load') Promise.resolve().then(cb); },
      removeEventListener() {}, querySelectorAll() { return []; },
    });
    const fetchMock = jest.fn((url: string, options?: any) => {
      fetched.push({ url, body: options?.body ? JSON.parse(options.body) : undefined });
      if (url.includes('/api/v1/delivery/ad/')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { adType: 'image', format: 'banner', imageUrl: '/api/v1/uploads/media/a.jpg', impToken: 'imp_t', clickUrl: 'https://example.test', isHouseAd: true } }) });
      }
      return Promise.resolve({ ok: true });
    });
    const win: any = {
      location: { hostname: 'example.com', search: opts.search ?? '' }, innerHeight: 1000, innerWidth: 1000, cfPubQ: [],
      IntersectionObserver: function () { return { observe() {}, disconnect() {} }; },
      crypto: { randomUUID: uuid },
    };
    const doc: any = {
      readyState: 'complete', visibilityState: 'visible', documentElement: {},
      currentScript: { src: 'https://api.example.test/api/v1/delivery/embed.js' },
      querySelectorAll: (sel: string) => (sel.startsWith('ins.crimfig-pub-slot') ? slots : []),
      getElementById: () => null, createElement, addEventListener: jest.fn(), removeEventListener: jest.fn(),
    };
    const sandbox: any = {
      window: win, document: doc, fetch: fetchMock, setTimeout: (fn: any, d: number) => { if (d < 15000) fn(); return 1; },
      clearTimeout: jest.fn(), setInterval: jest.fn(() => 2), clearInterval: jest.fn(), AbortController, Date, Math, JSON, encodeURIComponent, Map,
      MutationObserver: class { observe() {} disconnect() {} },
    };
    win.document = doc; win.fetch = fetchMock; win.addEventListener = jest.fn(); win.removeEventListener = jest.fn();
    const script = new DeliveryService({} as any, {} as any, {} as any, {} as any).getEmbedScript();
    vm.runInNewContext(script, sandbox);
    return { fetched, win, script, rerun: () => vm.runInNewContext(script, sandbox) };
  }
  const tick = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };

  it('sends no handshake without a setup challenge in the URL', async () => {
    const { fetched } = run({ slots: 0 });
    await tick();
    expect(fetched.some((f) => f.url.includes('sdk-handshake'))).toBe(false);
  });

  it('ignores a malformed challenge parameter', async () => {
    const { fetched } = run({ slots: 0, search: '?cf_setup=<script>' });
    await tick();
    expect(fetched.some((f) => f.url.includes('sdk-handshake'))).toBe(false);
  });

  it('acknowledges execution once with zero slots, carrying runtime identity', async () => {
    const { fetched, rerun } = run({ slots: 0, search: '?x=1&cf_setup=cfs_abcdefghijklmnopqrstuvwx' });
    await tick();
    rerun(); // duplicate include in the same document must not acknowledge again
    await tick();
    const hs = fetched.filter((f) => f.url.includes('/api/v1/delivery/sdk-handshake'));
    expect(hs).toHaveLength(1);
    expect(hs[0].body).toMatchObject({ challenge: 'cfs_abcdefghijklmnopqrstuvwx', host: 'example.com', sdkVersion: 'cf-sdk/2' });
    expect(hs[0].body.sdkInitializationId).toMatch(/^00000000-/);
  });

  it('gives two elements of one slot independent instances and opportunities', async () => {
    const { fetched } = run({ slots: 2 });
    await tick();
    const adRequests = fetched.filter((f) => f.url.includes('/api/v1/delivery/ad/'));
    expect(adRequests).toHaveLength(2);
    const renders = fetched
      .filter((f) => f.url.includes('/delivery/interaction') && f.body?.type === 'render')
      .map((f) => f.body);
    expect(renders).toHaveLength(2);
    expect(new Set(renders.map((b) => b.slotInstanceId)).size).toBe(2);
    expect(new Set(renders.map((b) => b.opportunityId)).size).toBe(2);
    expect(new Set(renders.map((b) => b.pageViewId)).size).toBe(1);
    expect(renders.map((b) => b.instancesDetected)).toEqual([2, 2]);
    expect(renders.map((b) => b.instanceIndex).sort()).toEqual([0, 1]);
  });

  it('a repeated script include does not duplicate requests or events', async () => {
    const { fetched, rerun } = run({ slots: 1 });
    await tick();
    const before = fetched.length;
    rerun();
    await tick();
    expect(fetched.filter((f) => f.url.includes('/api/v1/delivery/ad/'))).toHaveLength(1);
    expect(fetched.length).toBe(before);
  });
});

