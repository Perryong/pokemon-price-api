import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {marketMiddleware} from '../src/market.js';
const now=Date.parse('2026-10-31T06:00:00Z');
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
const cards=Array.from({length:9},(_,i)=>({id:`base1-${i+1}`,name:`Eevee ${i+1}`}));
const card=(id:string)=>({id,name:'Eevee',pricing:{cardmarket:{unit:'EUR',updated:'2026-10-30T06:00:00Z',trend:10,low:0}}});
async function request(path='/api/market/search?q=eevee&include=prices',middleware=marketMiddleware()){
 const res={statusCode:200,setHeader:vi.fn(),end:vi.fn()};
 await middleware({url:path,method:'GET'} as IncomingMessage,res as unknown as ServerResponse,()=>{});
 return {status:res.statusCode,data:JSON.parse(res.end.mock.calls[0][0]),headers:res.setHeader};
}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(now);vi.stubGlobal('fetch',vi.fn(async url=>{
 const target=new URL(String(url));
 if(target.hostname==='api.frankfurter.dev')return json({base:'EUR',quote:'SGD',rate:1.5,date:'2026-10-30'});
 if(target.search)return json(cards);
 return json(card(target.pathname.split('/').at(-1)!));
}));});
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
it('returns arbitrary matching cards and SGD prices in one bounded opt-in request',async()=>{
 const result=await request();expect(result.status).toBe(200);
 expect(result.data).toMatchObject({schemaVersion:2,query:'eevee',currency:'SGD',page:1,limit:3,total:9,nextPage:2,partial:false,truncated:false});
 expect(result.data.cards).toHaveLength(3);
 expect(result.data.cards[0]).toMatchObject({id:'base1-1',pricing:{status:200,data:{schemaVersion:2,card:{id:'base1-1'},quotes:[{currency:'SGD',sourceCurrency:'EUR',prices:{trend:15,low:0}}]}}});
 expect(fetch).toHaveBeenCalledTimes(5);
});
it('preserves lightweight v1 search and shares cache with individual lookups',async()=>{
 const middleware=marketMiddleware();
 const native=await request('/api/market/search?q=eevee',middleware);expect(native.data.schemaVersion).toBe(1);expect(native.data.cards).toHaveLength(9);
 await request(undefined,middleware);
 const priced=await request('/api/market/cards/base1-1?currency=SGD',middleware);
 expect(priced.status).toBe(200);expect(fetch).toHaveBeenCalledTimes(5);
});
it('paginates before loading prices and returns an empty final page without extra lookups',async()=>{
 const middleware=marketMiddleware();
 const result=await request('/api/market/search?q=eevee&include=prices&limit=6&page=2',middleware);
 expect(result.data.cards.map((c:{id:string})=>c.id)).toEqual(['base1-7','base1-8','base1-9']);
 expect(result.data.nextPage).toBeNull();expect(fetch).toHaveBeenCalledTimes(5);
 const empty=await request('/api/market/search?q=eevee&include=prices&page=50',middleware);
 expect(empty.data.cards).toEqual([]);expect(fetch).toHaveBeenCalledTimes(5);
});
it.each(['limit=7','limit=0','limit=1.5','page=-1','page=501','page=1e2','limit=2&limit=3','include=anything','currency=USD'])('rejects invalid enriched parameters before contacting providers: %s',async params=>{
 const query=params.startsWith('include=')?params:'include=prices&'+params;
 expect((await request('/api/market/search?q=eevee&'+query)).status).toBe(400);expect(fetch).not.toHaveBeenCalled();
});
it('distinguishes unavailable prices from failed lookups and never CDN caches partial failures',async()=>{
 vi.mocked(fetch).mockImplementation(async url=>{
  const target=new URL(String(url));if(target.search)return json(cards);
  if(target.pathname.endsWith('/base1-1'))return json({id:'base1-1',name:'Eevee'});
  return json({},404);
 });
 const result=await request();expect(result.status).toBe(200);expect(result.data.partial).toBe(true);
 expect(result.data.cards[0].pricing).toMatchObject({status:200,data:{quotes:[]}});
 expect(result.data.cards[1].pricing).toEqual({status:404,error:'card_not_found'});
 expect(result.headers).toHaveBeenCalledWith('Vercel-CDN-Cache-Control','no-store');
});
it('keeps provider search failures at HTTP level',async()=>{
 vi.mocked(fetch).mockResolvedValue(json({},502));expect((await request()).status).toBe(502);
});
it('bounds composite cache lifetime by the oldest nested source',async()=>{
 const middleware=marketMiddleware();await request('/api/market/cards/base1-1',middleware);
 vi.setSystemTime(now+3595_000);const result=await request(undefined,middleware);
 expect(result.headers).toHaveBeenCalledWith('Vercel-CDN-Cache-Control','public, s-maxage=5');
});
it('does not cache an FX error as missing card prices',async()=>{
 vi.mocked(fetch).mockImplementation(async url=>{
  const target=new URL(String(url));if(target.hostname==='api.frankfurter.dev')return json({},503);
  return json(target.search?cards:card(target.pathname.split('/').at(-1)!));
 });
 const result=await request();expect(result.data.partial).toBe(true);
 expect(result.data.cards[0].pricing).toEqual({status:503,error:'exchange_rate_unavailable'});
 expect(result.headers).toHaveBeenCalledWith('Vercel-CDN-Cache-Control','no-store');
});
it('shares simultaneous enriched lookups instead of duplicating provider requests',async()=>{
 const middleware=marketMiddleware();const [a,b]=await Promise.all([request(undefined,middleware),request(undefined,middleware)]);
 expect(a.data).toEqual(b.data);expect(fetch).toHaveBeenCalledTimes(5);
});
it('preserves per-card provider retry metadata and prevents subsequent uncached lookups during cooldown',async()=>{
 const middleware=marketMiddleware();
 vi.mocked(fetch).mockImplementation(async url=>new URL(String(url)).search?json(cards):new Response('{}',{status:429,headers:{'Retry-After':'15'}}));
 const result=await request(undefined,middleware);
 expect(result.data.cards[0].pricing).toEqual({status:429,error:'provider_rate_limited',retryAfterSeconds:15});
 const calls=vi.mocked(fetch).mock.calls.length;
 expect((await request('/api/market/cards/base1-8',middleware)).status).toBe(429);
 expect(fetch).toHaveBeenCalledTimes(calls);
});
it('rejects expired nested FX after another card finishes loading',async()=>{
 vi.setSystemTime(Date.parse('2026-11-05T23:59:59Z'));
 vi.mocked(fetch).mockImplementation(async url=>{
  const target=new URL(String(url));
  if(target.hostname==='api.frankfurter.dev')return json({base:'EUR',quote:'SGD',rate:1.5,date:'2026-10-30'});
  if(target.search)return json(cards);
  if(target.pathname.endsWith('/base1-2')) {await new Promise(resolve=>setTimeout(resolve,2000));return json({id:'base1-2',name:'Eevee'});}
  return json(card(target.pathname.split('/').at(-1)!));
 });
 const pending=request();await vi.advanceTimersByTimeAsync(2000);const result=await pending;
 expect(result.data.partial).toBe(true);
 expect(result.data.cards[0].pricing).toEqual({status:503,error:'exchange_rate_unavailable'});
 expect(result.data.cards[1].pricing).toMatchObject({status:200,data:{quotes:[]}});
 expect(result.headers).toHaveBeenCalledWith('Vercel-CDN-Cache-Control','no-store');
});
