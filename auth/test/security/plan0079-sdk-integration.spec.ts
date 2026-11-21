import { DeliveryService } from '../../../api/ads-api/src/modules/delivery/delivery.service';
const {JSDOM}=require('jsdom');
const tick=async()=>{await new Promise(done=>setImmediate(done));await new Promise(done=>setImmediate(done));};
describe('PLAN0079 actual generated SDK DOM integration with synthetic nonbillable delivery',()=>{
 const previous={...process.env};afterEach(()=>{process.env={...previous};});
 async function run(width:number,height:number,viewport:number,fail=false,format?:string){
  process.env.ADS_PUBLIC_URL='https://ads.example.test';const dom=new JSDOM('<!doctype html><ins class="crimfig-pub-slot" data-ad-slot="cf-slot-test" style="display:block;min-height:250px"></ins>',{url:'https://publisher.example.test',runScripts:'outside-only'});const win=dom.window;
  const slot=win.document.querySelector('ins');if(format)slot.setAttribute('data-ad-format',format);slot.getBoundingClientRect=()=>({x:0,y:0,top:0,left:0,right:viewport,bottom:250,width:viewport,height:250});
  const calls:any[]=[];win.fetch=async(url:string,init:any={})=>{calls.push({url,body:init.body?JSON.parse(init.body):null});return {ok:true,json:async()=>({data:{id:'synthetic-house',adType:'image',imageUrl:'https://ads.example.test/api/v1/uploads/media/test',width,height,impToken:'synthetic-impression',isHouseAd:true,inventoryClass:'house',headline:'Test house ad'}})};};win.navigator.sendBeacon=()=>false;
  const code=new DeliveryService({} as any,{} as any,{} as any,{} as any).getEmbedScript();win.eval(code);await tick();win.document.dispatchEvent(new win.Event('DOMContentLoaded'));await tick();const img=win.document.querySelector('img');expect(img).not.toBeNull();img.dispatchEvent(new win.Event(fail?'error':'load'));await tick();return {dom,win,slot,img,calls};
 }
 test('failed image collapses without a render/impression or paid request',async()=>{const f=await run(728,90,375,true);try{expect(f.slot.style.display).toBe('none');expect(f.slot.style.minHeight).toBe('0px');expect(f.calls.filter((c:any)=>c.url.includes('/interaction'))).toHaveLength(0);}finally{f.win.close();}});
 test('unknown image dimensions retain natural auto sizing without an invented ratio',async()=>{const f=await run(0,0,375);try{expect(f.img.style.aspectRatio).toBe('');expect(f.img.hasAttribute('width')).toBe(false);expect(f.img.hasAttribute('height')).toBe(false);expect(f.img.style.height).toBe('auto');expect(f.img.style.maxHeight).toBe('250px');}finally{f.win.close();}});
 test.each([[1024,682,1200],[728,90,375],[300,600,320]])('metadata %s x %s stays proportional for width %s',(async(width,height,viewport)=>{const f=await run(width,height,viewport);try{expect(f.img.style.objectFit).toBe('contain');expect(f.img.style.height).toBe('auto');expect(f.img.style.aspectRatio).toContain(width+' / '+height);expect(f.img.width).toBe(width);expect(f.img.height).toBe(height);expect(f.slot.style.minHeight).toBe('0px');expect(f.slot.getAttribute('data-cf-state')).toBe('rendered');const events=f.calls.filter((c:any)=>c.url.includes('/interaction')).map((c:any)=>c.body.type);expect(events.sort()).toEqual(['impression','render']);expect(f.calls.filter((c:any)=>c.url.includes('/delivery/ad/'))).toHaveLength(1);}finally{f.win.close();}}));
 test.each([
  [1024,682,1200,'banner','375.367px','250px'],
  [1024,682,375,'banner','375.367px','250px'],
  [1024,682,1200,'unknown','375.367px','250px'],
  [300,600,1200,'sidebar_sticky','300px','600px'],
  [970,250,1200,'billboard','970px','250px'],
  [300,300,375,'large_square','300px','300px'],
  [728,90,375,'leaderboard','728px','90px']
 ])('actual SDK bounds %s x %s in %s-wide %s slot',async(w,h,viewport,format,width,height)=>{const f=await run(w,h,viewport,false,format);try{expect(f.img.style.width).toBe(width);expect(f.img.style.maxWidth).toBe('100%');expect(f.img.style.maxHeight).toBe(height);expect(f.img.parentElement.style.maxWidth).toBe(width);expect(f.slot.style.minHeight).toBe('0px');expect(f.slot.getAttribute('data-cf-state')).toBe('rendered');}finally{f.win.close();}});

});

test('PLAN0133 generated SDK measures parent width, waits for visibility and never re-requests on resize', async () => {
  const previous = process.env.ADS_PUBLIC_URL;
  process.env.ADS_PUBLIC_URL = 'https://ads.example.test';
  const dom = new JSDOM('<div id="parent" style="padding:0 10px"><ins class="crimfig-pub-slot" data-ad-slot="cf-slot-test" data-ad-format="general"></ins></div>', { url: 'https://publisher.example.test', runScripts: 'outside-only' });
  const win = dom.window;
  const parent = win.document.getElementById('parent');
  const slot = parent.firstElementChild;
  let width = 0;
  Object.defineProperty(parent, 'clientWidth', { get: () => width });
  parent.getClientRects = () => width ? [{ width }] : [];
  const calls: Array<{ url: string; body?: string }> = [];
  win.fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, body: init?.body as string });
    return { ok: true, json: async () => ({ data: {
      adType: 'image', format: 'medium_rectangle', width: 300, height: 250, imageUrl: 'https://ads.example.test/image.webp',
      impToken: 'fixture', isHouseAd: true,
    } }) };
  };
  win.navigator.sendBeacon = () => false;
  try {
    const service = new DeliveryService({} as any, {} as any, {} as any, {} as any);
    win.eval(service.getEmbedScript());
    win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
    await tick();
    expect(calls).toHaveLength(0);
    width = 340;
    win.dispatchEvent(new win.Event('resize'));
    await tick();
    expect(new URL(calls[0].url).searchParams.get('containerWidth')).toBe('320');
    win.document.querySelector('img').dispatchEvent(new win.Event('load'));
    await tick();
    expect(slot.getAttribute('data-cf-state')).toBe('rendered');
    width = 220;
    win.dispatchEvent(new win.Event('resize'));
    expect(slot.style.display).toBe('none');
    width = 340;
    win.dispatchEvent(new win.Event('resize'));
    expect(slot.style.display).toBe('block');
    expect(calls.filter(call => call.url.includes('/delivery/ad/'))).toHaveLength(1);
    expect(calls.filter(call => call.body).map(call => JSON.parse(call.body!).type).sort()).toEqual(['impression', 'render']);
    expect(parent.style.padding).toBe('0px 10px');
  } finally {
    win.close();
    if (previous === undefined) delete process.env.ADS_PUBLIC_URL;
    else process.env.ADS_PUBLIC_URL = previous;
  }
});

test('PLAN0134 negative & positive: DeliveryService.recordAdvertRating enforces valid rating, bound token, and slot binding with zero financial writes', async () => {
  const tokenService = {
    verifyToken: jest.fn(),
  };
  let updateSetArg: any = null;
  let storedSnapshot: Record<string, unknown> = { headline: 'Ad', adType: 'image' };
  const priorObservations = [
    { pageViewId: '00000000-0000-4000-8000-000000000011', slotInstanceId: '00000000-0000-4000-8000-000000000022', opportunityId: '00000000-0000-4000-8000-000000000033', sdkInitId: '00000000-0000-4000-8000-000000000044' },
  ];
  let serveFound = true;
  const tx = {
    execute: jest.fn(async () => ({})),
    select: jest.fn((projection?: any) => ({
      from: jest.fn(() => ({
        where: jest.fn(() => {
          if (projection && 'pageViewId' in projection) {
            return Promise.resolve(priorObservations);
          }
          return {
            limit: jest.fn(async () => (serveFound ? [{ id: 'serve-1', contentSnapshot: storedSnapshot }] : [])),
          };
        }),
      })),
    })),
    update: jest.fn(() => ({
      set: jest.fn((val: any) => {
        updateSetArg = val;
        if (val?.contentSnapshot) storedSnapshot = val.contentSnapshot;
        return { where: jest.fn(async () => []) };
      }),
    })),
  };
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: jest.fn(async () => [{ id: 'serve-1', campaignId: 'camp-1', placementId: 'place-1', promoterId: 'prom-1', creativeId: 'cre-1' }]),
        })),
      })),
    })),
    transaction: jest.fn(async (cb: any) => cb(tx)),
  };
  const opportunities = { claim: jest.fn() };
  const service = new DeliveryService(db as any, tokenService as any, {} as any, {} as any, undefined, opportunities as any);
  jest.spyOn(service as any, 'boundServe').mockImplementation(async (payload: any) => payload?.servedId === 'serve-1');

  // Negative 1: invalid rating value rejects before DB access
  await expect(service.recordAdvertRating({ impToken: 'tok', rating: 'neutral' as any })).rejects.toThrow('Unsupported advert rating');
  expect(db.transaction).not.toHaveBeenCalled();

  // Negative 2: invalid impToken returns null without DB write
  tokenService.verifyToken.mockReturnValue(null);
  await expect(service.recordAdvertRating({ impToken: 'forged', rating: 'love' })).resolves.toBeNull();
  expect(tx.update).not.toHaveBeenCalled();

  // Negative 3: unbound serve returns null without DB write
  tokenService.verifyToken.mockReturnValue({ servedId: 'serve-unbound', campaignId: 'camp-1' });
  await expect(service.recordAdvertRating({ impToken: 'unbound', rating: 'love' })).resolves.toBeNull();
  expect(tx.update).not.toHaveBeenCalled();

  // Negative 4: mismatched slotInstanceId rejects and performs no update
  tokenService.verifyToken.mockReturnValue({ servedId: 'serve-1', campaignId: 'camp-1' });
  await expect(
    service.recordAdvertRating({
      impToken: 'valid',
      rating: 'like',
      claims: { pageViewId: '00000000-0000-4000-8000-000000000011', slotInstanceId: '00000000-0000-4000-8000-000000000999' },
    }),
  ).rejects.toThrow();
  expect(tx.update).not.toHaveBeenCalled();

  // Positive: valid love rating, then updated to dislike, zero billing/opportunity claims
  const validClaims = {
    pageViewId: '00000000-0000-4000-8000-000000000011',
    slotInstanceId: '00000000-0000-4000-8000-000000000022',
    opportunityId: '00000000-0000-4000-8000-000000000033',
    sdkInitId: '00000000-0000-4000-8000-000000000044',
  };
  const first = await service.recordAdvertRating({ impToken: 'valid', rating: 'love', claims: validClaims });
  expect(first?.rating).toBe('love');
  expect(updateSetArg?.contentSnapshot?.visitorRating?.rating).toBe('love');

  const second = await service.recordAdvertRating({ impToken: 'valid', rating: 'dislike', claims: validClaims });
  expect(second?.rating).toBe('dislike');
  expect(updateSetArg?.contentSnapshot?.visitorRating?.rating).toBe('dislike');
  expect(opportunities.claim).not.toHaveBeenCalled();
});

test('PLAN0134 SDK DOM: hover reveals Ads by CrimFig, rating overlay offers Love/Like/Dislike + Cancel/Close, Dislike hides ad on close without extra ad/billing calls', async () => {
  const previous = process.env.ADS_PUBLIC_URL;
  process.env.ADS_PUBLIC_URL = 'https://ads.example.test';
  const dom = new JSDOM('<!doctype html><ins class="crimfig-pub-slot" data-ad-slot="cf-slot-test" style="display:block;min-height:250px"></ins>', { url: 'https://publisher.example.test', runScripts: 'outside-only' });
  const win = dom.window;
  const slot = win.document.querySelector('ins');
  slot.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 250, width: 320, height: 250 });
  const calls: Array<{ url: string; body?: any }> = [];
  win.fetch = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body as string) : null });
    return {
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
    };
  };
  win.navigator.sendBeacon = () => false;

  try {
    const service = new DeliveryService({} as any, {} as any, {} as any, {} as any);
    win.eval(service.getEmbedScript());
    win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
    await tick();
    const img = win.document.querySelector('img');
    expect(img).not.toBeNull();
    img.dispatchEvent(new win.Event('load'));
    await tick();

    const trigger = win.document.querySelector('[data-cf-rating-trigger="true"]');
    const label = win.document.querySelector('[data-cf-attribution-label="true"]');
    const overlay = win.document.querySelector('[data-cf-rating-overlay="true"]');
    expect(trigger).not.toBeNull();
    expect(label.textContent).toBe('Ads by CrimFig');
    expect(label.style.display).toBe('none');
    expect(overlay.style.display).toBe('none');

    // Hovering card reveals "Ads by CrimFig"
    const card = trigger.parentElement;
    card.dispatchEvent(new win.Event('mouseenter'));
    expect(label.style.display).toBe('inline');

    // Clicking trigger opens "Rate this advert:" overlay with required icons
    trigger.click();
    expect(overlay.style.display).toBe('flex');
    expect(overlay.querySelector('[data-cf-rating-title="true"]').textContent).toBe('Rate this advert:');
    const loveBtn = overlay.querySelector('[data-cf-rate="love"]');
    const likeBtn = overlay.querySelector('[data-cf-rate="like"]');
    const dislikeBtn = overlay.querySelector('[data-cf-rate="dislike"]');
    const closeBtn = overlay.querySelector('[data-cf-rating-close="true"]');
    expect(loveBtn.querySelector('svg').getAttribute('data-cf-icon-color')).toBe('#D4143A');
    expect(likeBtn.querySelector('svg').getAttribute('data-cf-icon-color')).toBe('#2563EB');
    expect(dislikeBtn.querySelector('svg').getAttribute('data-cf-icon-color')).toBe('#DC2626');
    expect(closeBtn.textContent).toBe('Cancel');

    // Cancel closes without sending rating request
    closeBtn.click();
    expect(overlay.style.display).toBe('none');
    expect(calls.filter((c) => c.url.includes('/delivery/rating'))).toHaveLength(0);

    // Selecting Love it sends /delivery/rating and Close restores ad
    trigger.click();
    loveBtn.click();
    await tick();
    expect(closeBtn.textContent).toBe('Close');
    expect(calls.filter((c) => c.url.includes('/delivery/rating')).map((c) => c.body.rating)).toEqual(['love']);
    closeBtn.click();
    expect(overlay.style.display).toBe('none');

    // Selecting Dislike it + Close hides the ad for remainder of pageview
    trigger.click();
    dislikeBtn.click();
    await tick();
    closeBtn.click();
    expect(overlay.getAttribute('data-cf-disliked-hidden')).toBe('true');
    expect(overlay.style.display).toBe('flex');
    expect(overlay.textContent).toContain('Thanks for your feedback');
    expect(calls.filter((c) => c.url.includes('/delivery/ad/'))).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes('/delivery/interaction') && c.body?.type === 'click')).toHaveLength(0);
    expect(calls.filter((c) => c.url.includes('/delivery/rating')).map((c) => c.body.rating)).toEqual(['love', 'dislike']);
  } finally {
    win.close();
    if (previous === undefined) delete process.env.ADS_PUBLIC_URL;
    else process.env.ADS_PUBLIC_URL = previous;
  }
});
