import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { marketMiddleware } from '../src/market.js';
import { MarketCardSchema } from '../src/schema.js';

const now = Date.parse('2026-10-30T04:00:00Z');
const card = (id = 'base1-1') => ({ id, name: 'Alakazam', secret: 'never-return', pricing: {
  cardmarket: { unit: 'EUR', updated: '2026-10-29T10:00:00Z', avg: 48.3, low: 9.99, 'trend-holo': 19.66, idProduct: 273696, unknown: 500, bad: -1 },
  tcgplayer: { unit: 'USD', updated: '2026-10-29T10:00:00Z', holofoil: { marketPrice: 20, lowPrice: null, highPrice: -1, surprise: 99 } },
} });
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
async function request(middleware: ReturnType<typeof marketMiddleware>, path = '/api/market/cards/base1-1', method = 'GET', headers = {}) {
  const response = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() };
  const next = vi.fn();
  await middleware({ url: path, method, headers } as IncomingMessage, response as unknown as ServerResponse, next);
  return { status: response.statusCode, data: response.end.mock.calls[0]?.[0] ? JSON.parse(response.end.mock.calls[0][0]) : null, response, next };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubGlobal('fetch', vi.fn(async () => reply(card()))); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('serves capability health without probing the provider', async () => {
  const result = await request(marketMiddleware(), '/api/market/health');
  expect(result.data).toEqual({ service: 'market-prices', schemaVersion: 1, mode: 'reference', source: 'TCGdex' });
  expect(fetch).not.toHaveBeenCalled();
});
it('returns bounded reference prices with matching identity, timestamps and original currency', async () => {
  const result = await request(marketMiddleware());
  expect(result.status).toBe(200);
  expect(MarketCardSchema.parse(result.data)).toEqual(result.data);
  expect(result.data.card).toEqual({ id: 'base1-1', name: 'Alakazam' });
  expect(result.data.fetchedAt).toBe(new Date(now).toISOString());
  expect(result.data.quotes[0]).toMatchObject({ provider: 'cardmarket', currency: 'EUR', freshness: 'current', prices: { avg: 48.3, low: 9.99, 'trend-holo': 19.66 } });
  expect(result.data.quotes[1].prices).toEqual({ marketPrice: 20 });
  expect(JSON.stringify(result.data)).not.toMatch(/secret|never-return|idProduct|surprise|unknown/);
  expect(fetch).toHaveBeenCalledWith('https://api.tcgdex.net/v2/en/cards/base1-1', expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }));
  expect(result.response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
});
it.each(['/api/market/cards/a%2Fb', '/api/market/cards/base1-1?url=https://evil.test', '/api/market/cards/../health', '/api/market/cards/'+ 'a'.repeat(81), '/api/market/unknown'])('rejects malformed route %s without fetch', async path => {
  expect((await request(marketMiddleware(), path)).status).toBeGreaterThanOrEqual(400);
  expect(fetch).not.toHaveBeenCalled();
});
it('rejects mutations and leaves unrelated paths alone', async () => {
  const middleware = marketMiddleware();
  expect((await request(middleware, '/api/market/health', 'POST')).status).toBe(405);
  expect((await request(middleware, '/api/cardmarket/base1-1')).next).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
});
it.each([null, {}, { id: 'other', name: 'Wrong' }, { id: 'base1-1', name: '' }])('rejects invalid identity/data %j', async data => {
  vi.mocked(fetch).mockResolvedValueOnce(reply(data));
  expect((await request(marketMiddleware())).status).toBe(502);
});
it('distinguishes absent card, empty prices and unsupported currencies', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(reply({}, 404));
  expect((await request(marketMiddleware())).status).toBe(404);
  vi.mocked(fetch).mockResolvedValueOnce(reply({ id: 'base1-1', name: 'Alakazam' }));
  expect((await request(marketMiddleware())).data.quotes).toEqual([]);
  const data = card(); data.pricing.cardmarket.unit = 'GBP'; data.pricing.tcgplayer.unit = 'EUR';
  vi.mocked(fetch).mockResolvedValueOnce(reply(data));
  expect((await request(marketMiddleware())).data.quotes).toEqual([]);
});
it.each(['2026-10-31T00:00:00Z', 'garbage', '2026-02-30T00:00:00Z', '2026-10-29T10:00:00'])('labels invalid/future date %s unknown', async updated => {
  const data = card(); data.pricing.cardmarket.updated = updated;
  vi.mocked(fetch).mockResolvedValueOnce(reply(data));
  expect((await request(marketMiddleware())).data.quotes[0]).toMatchObject({ updatedAt: null, freshness: 'unknown' });
});
it('shares requests, keeps original fetch time and recomputes freshness on cache hits', async () => {
  const data = card(); data.pricing.cardmarket.updated = '2026-10-28T04:10:00Z';
  vi.mocked(fetch).mockImplementation(async () => reply(data));
  const middleware = marketMiddleware();
  const [a,b] = await Promise.all([request(middleware),request(middleware)]);
  expect(fetch).toHaveBeenCalledOnce(); expect(a.data).toEqual(b.data);
  expect(a.data.quotes[0].freshness).toBe('current');
  vi.setSystemTime(now + 20*60_000);
  const cached = await request(middleware);
  expect(cached.data.quotes[0].freshness).toBe('stale');
  expect(cached.data.fetchedAt).toBe(a.data.fetchedAt);
  expect(fetch).toHaveBeenCalledOnce();
  vi.setSystemTime(now + 3600_000);
  await request(middleware); expect(fetch).toHaveBeenCalledTimes(2);
});
it('allows more than thirty unique lookups while retaining cached results', async () => {
  vi.mocked(fetch).mockImplementation(async url => reply(card(String(url).split('/').pop())));
  const middleware = marketMiddleware();
  for(let i=0;i<30;i++) expect((await request(middleware, `/api/market/cards/base1-${i}`)).status).toBe(200);
  expect((await request(middleware, '/api/market/cards/base1-31')).status).toBe(200);
  expect((await request(middleware, '/api/market/cards/base1-0')).status).toBe(200);
  vi.setSystemTime(now+60_000);
  expect((await request(middleware, '/api/market/cards/base1-31')).status).toBe(200);
});
it('bounds cache capacity', async () => {
  vi.mocked(fetch).mockImplementation(async url => reply(card(String(url).split('/').pop())));
  const middleware = marketMiddleware();
  for(let i=0;i<257;i++) { vi.setSystemTime(now + Math.floor(i/30)*60_000); await request(middleware, `/api/market/cards/base1-${i}`); }
  await request(middleware, '/api/market/cards/base1-0'); expect(fetch).toHaveBeenCalledTimes(258);
});
it.each([new DOMException('secret','TimeoutError'), new Error('secret'), new TypeError('redirect failed')])('sanitizes network failures', async error => {
  vi.mocked(fetch).mockRejectedValueOnce(error);
  const result = await request(marketMiddleware());
  expect(result.status).toBe(error.name === 'TimeoutError' ? 504 : 502);
  expect(JSON.stringify(result.data)).not.toContain('secret');
});
it('rejects oversized upstream responses', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response('x'.repeat(1024*1024+1)));
  expect((await request(marketMiddleware())).status).toBe(502);
});
it.each(['sv03.5-199', 'swsh12.5-160'])('accepts real special-set ID %s without broadening the upstream path', async id => {
  vi.mocked(fetch).mockResolvedValueOnce(reply(card(id)));
  const result = await request(marketMiddleware(), `/api/market/cards/${id}`);
  expect(result.status).toBe(200);
  expect(result.data.card.id).toBe(id);
  expect(fetch).toHaveBeenCalledWith(`https://api.tcgdex.net/v2/en/cards/${id}`, expect.objectContaining({ redirect: 'error' }));
});
it('searches partial names at the fixed upstream, ranks results and caches requests', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(reply([
    { id: 'basep-1', name: 'Pikachu', image: 'https://assets.tcgdex.net/en/base/basep/1' },
    { id: 'xy1-1', name: 'Flying Pikachu', image: 'https://evil.test/a' },
    { id: 'tk-hs-r-2', name: 'Pika', image: 'https://assets.tcgdex.net/en/hgss/tk-hs-r/2' },
    { id: 'abc-2', name: 'Pikachu V' },
  ]));
  const middleware = marketMiddleware();
  const result = await request(middleware, '/api/market/search?q=pika');
  expect(result.status).toBe(200);
  expect(result.data.cards.map((item: { name: string }) => item.name)).toEqual(['Pika', 'Pikachu', 'Pikachu V', 'Flying Pikachu']);
  expect(result.data.cards[3].image).toBeUndefined();
  expect(result.data.cards[0].id).toBe('tk-hs-r-2');
  const url = new URL(String(vi.mocked(fetch).mock.calls[0][0]));
  expect(url.origin).toBe('https://api.tcgdex.net'); expect(url.searchParams.get('name')).toBe('like:pika');
  await request(middleware, '/api/market/search?q=PIKA'); expect(fetch).toHaveBeenCalledOnce();
});
it.each(['', 'q=x', 'q=pika&url=https://evil.test', 'q=pika&q=char', 'q=not%3Apika', 'q=pi%7Cka', 'q='+ 'a'.repeat(61)])('rejects unsafe search query %s', async query => {
  expect((await request(marketMiddleware(), '/api/market/search?'+query)).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});
it('caps large search results, handles empty/malformed results and shares rate limits with card lookups', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(reply(Array.from({ length: 501 }, (_,i) => ({ id: `base1-${i}`, name: 'Pikachu' }))));
  const data = (await request(marketMiddleware(), '/api/market/search?q=pika')).data;
  expect(data.cards).toHaveLength(500); expect(data.truncated).toBe(true);
  vi.mocked(fetch).mockResolvedValueOnce(reply([]));
  expect((await request(marketMiddleware(), '/api/market/search?q=absent')).data.cards).toEqual([]);
  vi.mocked(fetch).mockResolvedValueOnce(reply({ unexpected: true }));
  expect((await request(marketMiddleware(), '/api/market/search?q=pika')).status).toBe(502);
  const middleware = marketMiddleware();
  vi.mocked(fetch).mockImplementation(async url => reply(String(url).includes('?') ? [] : card(String(url).split('/').pop())));
  for (let i=0;i<30;i++) await request(middleware, `/api/market/cards/base1-${i}`);
  expect((await request(middleware, '/api/market/search?q=pika')).status).toBe(200);
});
it('loads multi-part set IDs from search safely', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(reply(card('tk-hs-r-2')));
  expect((await request(marketMiddleware(), '/api/market/cards/tk-hs-r-2')).status).toBe(200);
});
it('preserves provider order for equally relevant names instead of grouping one set first', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(reply([{ id: 'basep-1', name: 'Pikachu' }, { id: '30th-023', name: 'Pikachu' }]));
  const result = await request(marketMiddleware(), '/api/market/search?q=pika');
  expect(result.data.cards.map((card: { id: string }) => card.id)).toEqual(['basep-1','30th-023']);
});

it.each([['12', 12], [new Date(now + 20_000).toUTCString(), 20], ['invalid', 60], [null, 60]])('preserves provider throttling and cooldown for Retry-After %s', async (header, seconds) => {
  const middleware = marketMiddleware();
  await request(middleware);
  vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 429, headers: header ? { 'Retry-After': header } : {} }));
  const limited = await request(middleware, '/api/market/cards/base1-2');
  expect(limited.status).toBe(429);
  expect(limited.data).toEqual({ error: 'provider_rate_limited', retryAfterSeconds: seconds });
  expect(limited.response.setHeader).toHaveBeenCalledWith('Retry-After', String(seconds));
  expect((await request(middleware, '/api/market/cards/base1-3')).data.error).toBe('provider_rate_limited');
  expect((await request(middleware)).status).toBe(200);
  expect(fetch).toHaveBeenCalledTimes(2);
  vi.setSystemTime(now + Number(seconds)*1000);
  vi.mocked(fetch).mockResolvedValueOnce(reply(card('base1-3')));
  expect((await request(middleware, '/api/market/cards/base1-3')).status).toBe(200);
});

it('serves public read-only CORS preflight without upstream calls', async () => {
  const result = await request(marketMiddleware(), '/api/market/cards/base1-1', 'OPTIONS');
  expect(result.status).toBe(204);
  expect(result.response.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', '*');
  expect(result.response.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Headers', 'Content-Type, X-Market-Priority');
  expect(fetch).not.toHaveBeenCalled();
});
it('CDN caches only successful prices and never extends a near-expired cache entry', async () => {
  const middleware = marketMiddleware();
  const first = await request(middleware);
  expect(first.response.setHeader).toHaveBeenCalledWith('Vercel-CDN-Cache-Control', 'public, s-maxage=300');
  vi.setSystemTime(now + 3595_000);
  const old = await request(middleware);
  expect(old.response.setHeader).toHaveBeenCalledWith('Vercel-CDN-Cache-Control', 'public, s-maxage=5');
  vi.mocked(fetch).mockResolvedValueOnce(reply({}, 500));
  const failed = await request(middleware, '/api/market/cards/base1-2');
  expect(failed.response.setHeader).toHaveBeenCalledWith('Vercel-CDN-Cache-Control', 'no-store');
});
