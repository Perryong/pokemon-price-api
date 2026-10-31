import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { marketMiddleware } from '../src/market.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
const now = Date.parse('2026-10-31T04:00:00Z');
const source = { id:'cel25-5', name:'Pikachu', pricing: {
  cardmarket:{unit:'EUR',updated:'2026-10-30T12:00:00Z',trend:10,avg1:0},
  tcgplayer:{unit:'USD',updated:'2026-10-30T12:00:00Z',holofoil:{marketPrice:20}}
}};
const json = (data: unknown) => new Response(JSON.stringify(data));
async function request(path='/api/market/cards/cel25-5?currency=SGD', middleware=marketMiddleware()) {
  const res={statusCode:200,setHeader:vi.fn(),end:vi.fn()};
  await middleware({url:path,method:'GET',headers:{}} as IncomingMessage,res as unknown as ServerResponse,()=>{});
  return {status:res.statusCode,data:JSON.parse(res.end.mock.calls[0][0]),headers:res.setHeader};
}
beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(now);
  vi.stubGlobal('fetch',vi.fn(async url=>String(url).includes('frankfurter') ? json({base:String(url).includes('/EUR/')?'EUR':'USD',quote:'SGD',date:'2026-10-30',rate:String(url).includes('/EUR/')?1.5:1.25}) : json(source)));
});
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
it('keeps native currency v1 compatible and converts explicitly requested SGD with dated provenance',async()=>{
  const middleware=marketMiddleware();
  const native=await request('/api/market/cards/cel25-5',middleware);
  expect(native.data.schemaVersion).toBe(1);expect(native.data.quotes[0].currency).toBe('EUR');
  const converted=await request(undefined,middleware);
  expect(converted.status).toBe(200);expect(converted.data.schemaVersion).toBe(2);
  expect(converted.data.quotes[0]).toMatchObject({currency:'SGD',sourceCurrency:'EUR',prices:{trend:15,avg1:0},exchangeRate:{rate:1.5,date:'2026-10-30'}});
  expect(converted.data.quotes[1]).toMatchObject({currency:'SGD',sourceCurrency:'USD',prices:{marketPrice:25}});
  expect(fetch).toHaveBeenCalledTimes(3);
});
it.each([
  {base:'USD',quote:'SGD',rate:1.5,date:'2026-10-30'},
  {base:'EUR',quote:'USD',rate:1.5,date:'2026-10-30'},
  {base:'EUR',quote:'SGD',rate:0,date:'2026-10-30'},
  {base:'EUR',quote:'SGD',rate:1.5,date:'2026-10-01'},
  {base:'EUR',quote:'SGD',rate:1.5,date:'2026-11-01'},
  {base:'EUR',quote:'SGD',rate:1.5,date:'invalid'},
])('never relabels foreign prices when FX validation fails: %j',async fx=>{
  vi.mocked(fetch).mockImplementation(async url=>String(url).includes('frankfurter')?json(fx):json(source));
  const result=await request();
  expect(result.status).toBe(503);expect(result.data).toEqual({error:'exchange_rate_unavailable'});
  expect(result.headers).toHaveBeenCalledWith('Vercel-CDN-Cache-Control','no-store');
});
it('returns empty SGD quotes without making pointless FX requests',async()=>{
  vi.mocked(fetch).mockResolvedValue(json({id:'cel25-5',name:'Pikachu'}));
  const result=await request();expect(result.status).toBe(200);expect(result.data.quotes).toEqual([]);expect(fetch).toHaveBeenCalledOnce();
});
it('serves validated rates compatible with the tracker FX record',async()=>{
  const result=await request('/api/market/rates');expect(result.status).toBe(200);
  expect(result.data.EUR).toEqual({rate:1.5,date:'2026-10-30',expiresAt:now+6*3600_000});
  expect(result.data.USD.rate).toBe(1.25);
});
it.each(['?currency=USD','?currency=SGD&currency=SGD','?currency=SGD&url=https://evil.test'])('rejects unsupported or ambiguous conversion request %s',async query=>{
  expect((await request('/api/market/cards/cel25-5'+query)).status).toBe(400);expect(fetch).not.toHaveBeenCalled();
});
it('bounds CDN lifetime by FX observation expiry',async()=>{
  vi.setSystemTime(Date.parse('2026-11-05T23:59:55Z'));
  const result=await request();expect(result.status).toBe(200);
  expect(result.headers).toHaveBeenCalledWith('Vercel-CDN-Cache-Control','public, s-maxage=5');
});
it('rejects overflow rather than serializing a null price',async()=>{
  vi.mocked(fetch).mockImplementation(async url=>String(url).includes('frankfurter')?json({base:'EUR',quote:'SGD',rate:2,date:'2026-10-30'}):json({id:'cel25-5',name:'Pikachu',pricing:{cardmarket:{unit:'EUR',trend:Number.MAX_VALUE}}}));
  expect((await request()).status).toBe(503);
});
it.each(['/api/market/rates','/api/market/cards/cel25-5?currency=SGD'])('rejects FX that expires while another currency is loading: %s',async path=>{
  vi.setSystemTime(Date.parse('2026-11-05T23:59:59Z'));
  vi.mocked(fetch).mockImplementation(async url=>{
    if (!String(url).includes('frankfurter')) return json(source);
    const usd=String(url).includes('/USD/');
    if (usd) await new Promise(resolve=>setTimeout(resolve,2000));
    return json({base:usd?'USD':'EUR',quote:'SGD',rate:1.5,date:usd?'2026-11-05':'2026-10-30'});
  });
  const response=request(path);
  await vi.advanceTimersByTimeAsync(2000);
  expect((await response).status).toBe(503);
});
