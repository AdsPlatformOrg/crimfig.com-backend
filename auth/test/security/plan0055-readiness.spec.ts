import * as vm from 'vm';
import { ServiceUnavailableException } from '@nestjs/common';
import { DeliveryService } from '../../../api/ads-api/src/modules/delivery/delivery.service';
import { EvidenceService } from '../../../api/ads-api/src/modules/delivery/evidence.service';
import { AdstationService } from '../../../api/ads-api/src/modules/adstation/adstation.service';
import { evidenceSignature, validEvidenceSignature } from '@crimfig/shared';

describe('PLAN-0055 evidence keys', () => {
  const original = { ...process.env };
  afterEach(() => { process.env = { ...original }; });
  it('does not reuse impression/HMAC keys or write evidence when the dedicated key is absent', async () => {
    delete process.env.ADS_EVIDENCE_HASH_SECRET;
    process.env.ADS_IMPRESSION_SIGNING_KEY = 'i'.repeat(32);
    process.env.HMAC_SECRET = 'h'.repeat(32);
    const tx = { execute: jest.fn() };
    const service = new EvidenceService({} as any, {} as any);
    await expect(service.append('event', {}, tx)).rejects.toThrow(ServiceUnavailableException);
    expect(tx.execute).not.toHaveBeenCalled();
  });
  it('retains historical verification by explicit key ID, without trying replacement keys', () => {
    const oldEnv = { ADS_EVIDENCE_HASH_SECRET: 'a'.repeat(32), ADS_EVIDENCE_HASH_KEY_ID: 'old' };
    const event = { keyId: 'old', value: 'original observation' };
    const signature = evidenceSignature(event, oldEnv as any);
    const rotated = { ADS_EVIDENCE_HASH_SECRET: 'b'.repeat(32), ADS_EVIDENCE_HASH_KEY_ID: 'new' };
    expect(validEvidenceSignature(event, signature, rotated as any)).toBe(false);
    expect(validEvidenceSignature(event, signature, { ...rotated, ADS_EVIDENCE_VERIFICATION_KEYS: JSON.stringify({ old: oldEnv.ADS_EVIDENCE_HASH_SECRET }) } as any)).toBe(true);
  });
  it('signs a real journal append with the dedicated key and configured ID', async () => {
    process.env.ADS_EVIDENCE_HASH_SECRET = 'd'.repeat(32);
    process.env.ADS_EVIDENCE_HASH_KEY_ID = 'dedicated-v2';
    process.env.ADS_IMPRESSION_SIGNING_KEY = 'i'.repeat(32);
    const tx = { execute: jest.fn(async () => ({ rows: [] })) };
    const payload = { stage: 'issued', inventoryClass: 'house' };
    const service = new EvidenceService({} as any, {} as any);
    const result = await service.append('event', payload, tx);
    expect(result.recordHash).toBe(evidenceSignature({ eventId: 'event', partition: `ads:${new Date().toISOString().slice(0, 10)}`, previousHash: null, payload, keyId: 'dedicated-v2' }));
    expect(tx.execute).toHaveBeenCalledTimes(4);
  });
});

describe('PLAN-0055 installation requires render evidence', () => {
  function service(serveCount: number, renderCount: number, websiteOverrides = {}, lifecycleStatus = 'testing') {
    const slot = { id: 'slot', websiteId: 'site', slotTagId: 'cf-slot-test', lifecycleStatus, isConsiderationSlot: false };
    let selected = 0;
    const results = [[slot], [{ id: 'site', domain: 'example.com', policyStatus: 'testing', promoterId: 'owner', verificationStatus: 'verified', verificationExpiresAt: new Date(Date.now() + 86400000), ...websiteOverrides }], [{ serveCount }], [{ renderCount, impressionCount: 0 }]];
    const saved: any = {};
    const db = {
      select: () => { const rows = results[selected++]; const query: any = { from: () => query, where: () => query, for: () => query, limit: async () => rows, then: (resolve: any) => Promise.resolve(rows).then(resolve) }; return query; },
      update: jest.fn(() => { const query: any = { set: (value: any) => { Object.assign(saved, value); return query; }, where: () => query, returning: async () => [{ ...slot, ...saved }] }; return query; }),
    };
    (db as any).execute = jest.fn(async () => ({ rows: [] }));
    (db as any).transaction = (callback: any) => callback(db);
    return new AdstationService(db as any);
  }
  it.each([{ promoterId: 'another-owner' }, { verificationExpiresAt: new Date(0) }, { isSuspended: true }])('refuses invalid website state without installation writes: %j', async overrides => {
    const instance = service(2, 1, overrides);
    await expect(instance.checkSlotInstallation('owner', 'slot')).rejects.toThrow();
    expect((instance as any).db.update).not.toHaveBeenCalled();
  });
  it('does not certify requests without a render receipt', async () => {
    const result = await service(2, 0).checkSlotInstallation('owner', 'slot');
    expect(result.isInstalled).toBe(false);
    expect(result.installationStatus).toBe('missing');
    expect(result.diagnostic).toContain('no render receipt');
  });
  it('certifies observed render plus serve without promoting a testing website to paid-active', async () => {
    const result = await service(2, 1).checkSlotInstallation('owner', 'slot');
    expect(result.isInstalled).toBe(true);
    expect(result.lifecycleStatus).toBe('testing');
  });
  it('cannot clear a locked administrative suspension through installation checking', async () => {
    expect((await service(2, 1, {}, 'suspended').checkSlotInstallation('owner', 'slot')).lifecycleStatus).toBe('suspended');
  });
});

describe('PLAN-0055 actual loader lifecycle in a DOM fixture', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
  const ad = { adType: 'text', headline: 'House', bodyText: 'Test', impToken: 'signed-test', isHouseAd: true };
  function fixture(reply: () => Promise<any>, top = 0) {
    const nodes: any[] = [], observers: any[] = [];
    class Node extends EventTarget {
      style: any = { minHeight: '0px', height: '', padding: '', margin: '' };
      attributes: any = {}; children: any[] = []; isConnected = true; tagName: string; textContent = ''; src = '';
      constructor(tag: string) { super(); this.tagName = tag.toUpperCase(); nodes.push(this); }
      getAttribute(k: string) { return this.attributes[k] ?? null; }
      setAttribute(k: string, v: any) { this.attributes[k] = v; }
      getBoundingClientRect() { return { top, left: 0, width: 300, height: 90 }; }
      appendChild(node: any) { this.children.push(node); }
      get firstElementChild() { return this.children[0]; }
      set innerHTML(value: string) { this.children = []; }
      replaceChildren() { this.children = []; }
      querySelectorAll() { return this.children.flatMap(c => [c, ...c.querySelectorAll()]); }
    }
    const slot = new Node('ins'); slot.setAttribute('data-ad-slot', 'cf-slot-test'); slot.setAttribute('data-cf-height', '90');
    const fetch = jest.fn((url: string) => url.includes('/delivery/ad/') ? reply() : Promise.resolve({ ok: true }));
    class Observer { constructor(public callback: any, public options: any) { observers.push(this); } observe() {} disconnect() {} }
    const document: any = { readyState: 'complete', visibilityState: 'visible', currentScript: { src: 'https://staging.example/api/v1/delivery/embed.js' },
      documentElement: {}, querySelectorAll: (selector: string) => selector.startsWith('ins.') && slot.isConnected ? [slot] : [], createElement: (tag: string) => new Node(tag), addEventListener() {}, removeEventListener() {}, elementFromPoint: () => null };
    const window: any = { location: { hostname: 'example.com' }, innerHeight: 800, innerWidth: 400, IntersectionObserver: Observer, addEventListener() {}, removeEventListener() {} };
    const sandbox: any = { window, document, fetch, AbortController, IntersectionObserver: Observer, MutationObserver: class { observe() {} },
      setTimeout, clearTimeout, setInterval, clearInterval, console: { warn() {} } };
    const loader = new DeliveryService({} as any, {} as any, {} as any, {} as any).getEmbedScript();
    const run = () => vm.runInNewContext(loader, sandbox);
    return { slot, nodes, observers, fetch, run, window, setTop: (value: number) => { top = value; } };
  }
  it.each(['network', 'empty', 'invalid'])('collapses %s failure without render events', async mode => {
    const f = fixture(() => mode === 'network' ? Promise.reject(new Error('offline')) : Promise.resolve({ ok: true, json: async () => ({ data: mode === 'empty' ? null : {} }) }));
    f.run(); await flush();
    expect(f.slot.getAttribute('data-cf-state')).toBe('unavailable');
    expect(f.slot.style.display).toBe('none');
    expect(f.slot.style.minHeight).toBe('0px');
    expect(f.slot.children).toHaveLength(0);
    expect(f.fetch.mock.calls.filter(c => !c[0].includes('/delivery/ad/'))).toHaveLength(0);
  });
  it('ignores late responses after timeout and retries only when explicitly refreshed', async () => {
    let resolve: any;
    const f = fixture(() => new Promise(r => { resolve = r; })); f.run();
    jest.advanceTimersByTime(15000);
    resolve({ ok: true, json: async () => ({ data: ad }) }); await flush();
    expect(f.slot.style.display).toBe('none'); expect(f.slot.children).toHaveLength(0);
    f.window.__cfLoaderV2.scan(); expect(f.fetch).toHaveBeenCalledTimes(1);
    f.window.__cfLoaderV2.refresh(f.slot); expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.slot.style.display).toBe('block'); expect(f.slot.style.height).toBe(''); expect(f.slot.style.minHeight).toBe('90px');
  });
  it('collapses a broken image and emits no render receipt', async () => {
    const f = fixture(() => Promise.resolve({ ok: true, json: async () => ({ data: { ...ad, adType: 'image', imageUrl: '/api/v1/uploads/media/test' } }) }));
    f.run(); await flush();
    expect(f.fetch).toHaveBeenCalledTimes(1);
    f.nodes.find(n => n.tagName === 'IMG').dispatchEvent(new Event('error')); await flush();
    expect(f.slot.style.display).toBe('none'); expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it('ignores a request that completes after its slot has been removed', async () => {
    let resolve: any;
    const f = fixture(() => new Promise(r => { resolve = r; })); f.run();
    f.slot.isConnected = false; f.window.__cfLoaderV2.scan();
    resolve({ ok: true, json: async () => ({ data: ad }) }); await flush();
    expect(f.slot.children).toHaveLength(0); expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('waits for successful asset loading before reporting a render', async () => {
    const f = fixture(() => Promise.resolve({ ok: true, json: async () => ({ data: { ...ad, adType: 'image', imageUrl: '/api/v1/uploads/media/test' } }) }));
    f.run(); await flush(); expect(f.fetch).toHaveBeenCalledTimes(1);
    f.nodes.find(n => n.tagName === 'IMG').dispatchEvent(new Event('load')); await flush();
    expect(f.slot.getAttribute('data-cf-state')).toBe('rendered');
    expect(f.fetch.mock.calls.filter(c => c[0].includes('/interaction'))).toHaveLength(1);
  });
  it('never reserves space if the script does not run, and loads an offscreen slot from its measurable anchor', async () => {
    const f = fixture(() => Promise.resolve({ ok: true, json: async () => ({ data: ad }) }), 2000);
    expect(f.slot.style.minHeight).toBe('0px'); expect(f.fetch).not.toHaveBeenCalled();
    f.run(); expect(f.fetch).not.toHaveBeenCalled();
    f.setTop(10); f.observers[0].callback([{ isIntersecting: true }]); await flush();
    expect(f.slot.getAttribute('data-cf-state')).toBe('rendered');
    expect(f.slot.style.minHeight).toBe('0px');
    expect(f.fetch.mock.calls.filter(c => c[0].includes('/interaction'))).toHaveLength(1);
    f.window.__cfLoaderV2.scan(); expect(f.fetch.mock.calls.filter(c => c[0].includes('/delivery/ad/'))).toHaveLength(1);
  });
});
