import { DeliveryService } from '../../../api/ads-api/src/modules/delivery/delivery.service';
import { createRequire } from 'module';
import { resolve } from 'path';
const {JSDOM}=createRequire(resolve('../frontend/web/ads/package.json'))('jsdom');
const tick=async()=>{await new Promise(done=>setImmediate(done));await new Promise(done=>setImmediate(done));};
describe('PLAN0079 actual generated SDK DOM integration with synthetic nonbillable delivery',()=>{
 const previous={...process.env};afterEach(()=>{process.env={...previous};});
 async function run(width:number,height:number,viewport:number,fail=false){
  process.env.ADS_PUBLIC_URL='https://ads.example.test';const dom=new JSDOM('<!doctype html><ins class="crimfig-pub-slot" data-ad-slot="cf-slot-test" style="display:block;min-height:250px"></ins>',{url:'https://publisher.example.test',runScripts:'outside-only'});const win=dom.window;
  const slot=win.document.querySelector('ins');slot.getBoundingClientRect=()=>({x:0,y:0,top:0,left:0,right:viewport,bottom:250,width:viewport,height:250});
  const calls:any[]=[];win.fetch=async(url:string,init:any={})=>{calls.push({url,body:init.body?JSON.parse(init.body):null});return {ok:true,json:async()=>({data:{id:'synthetic-house',adType:'image',imageUrl:'https://ads.example.test/api/v1/uploads/media/test',width,height,impToken:'synthetic-impression',isHouseAd:true,inventoryClass:'house',headline:'Test house ad'}})};};win.navigator.sendBeacon=()=>false;
  const code=new DeliveryService({} as any,{} as any,{} as any,{} as any).getEmbedScript();win.eval(code);await tick();win.document.dispatchEvent(new win.Event('DOMContentLoaded'));await tick();const img=win.document.querySelector('img');expect(img).not.toBeNull();img.dispatchEvent(new win.Event(fail?'error':'load'));await tick();return {dom,win,slot,img,calls};
 }
 test('failed image collapses without a render/impression or paid request',async()=>{const f=await run(728,90,375,true);try{expect(f.slot.style.display).toBe('none');expect(f.slot.style.minHeight).toBe('0px');expect(f.calls.filter((c:any)=>c.url.includes('/interaction'))).toHaveLength(0);}finally{f.win.close();}});
 test('unknown image dimensions retain natural auto sizing without an invented ratio',async()=>{const f=await run(0,0,375);try{expect(f.img.style.aspectRatio).toBe('');expect(f.img.hasAttribute('width')).toBe(false);expect(f.img.hasAttribute('height')).toBe(false);expect(f.img.style.height).toBe('auto');}finally{f.win.close();}});
 test.each([[1024,682,1200],[728,90,375],[300,600,320]])('metadata %s x %s stays proportional for width %s',(async(width,height,viewport)=>{const f=await run(width,height,viewport);try{expect(f.img.style.objectFit).toBe('contain');expect(f.img.style.height).toBe('auto');expect(f.img.style.aspectRatio).toContain(width+' / '+height);expect(f.img.width).toBe(width);expect(f.img.height).toBe(height);expect(f.slot.style.minHeight).toBe('0px');expect(f.slot.getAttribute('data-cf-state')).toBe('rendered');const events=f.calls.filter((c:any)=>c.url.includes('/interaction')).map((c:any)=>c.body.type);expect(events.sort()).toEqual(['impression','render']);expect(f.calls.filter((c:any)=>c.url.includes('/delivery/ad/'))).toHaveLength(1);}finally{f.win.close();}}));
});
