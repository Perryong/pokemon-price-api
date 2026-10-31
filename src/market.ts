import { readJson } from './upstream.js';
import { createExchangeRates } from './exchange-rate.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MarketBriefSchema, MarketImageSchema, MarketQuerySchema, MarketSearchSchema, type MarketSearchResult, MarketCardSchema, MarketDateSchema, MarketIdSchema, cardmarketMetrics, tcgplayerMetrics, type MarketCard } from './schema.js';

const TTL = 3600_000;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const freshness = (date: string | null): 'unknown' | 'current' | 'stale' => !date ? 'unknown' : Date.now() - Date.parse(date) > 48 * TTL ? 'stale' : 'current';
function updatedAt(value: unknown) {
  const parsed = MarketDateSchema.safeParse(value);
  return parsed.success && Date.parse(parsed.data) <= Date.now() ? parsed.data : null;
}
function normalize(raw: unknown, id: string): MarketCard {
  const data = object(raw);
  if (data.id !== id) throw new Error('Invalid identity');
  const quotes: MarketCard['quotes'] = [];
  const pricing = object(data.pricing);
  for (const provider of ['cardmarket', 'tcgplayer'] as const) {
    const source = object(pricing[provider]);
    const currency = provider === 'cardmarket' ? 'EUR' : 'USD';
    if (source.unit !== currency) continue;
    const date = updatedAt(source.updated);
    const variants = provider === 'cardmarket' ? [['Reference (see metric)', source] as const] : Object.entries(source).slice(0, 32);
    for (const [variant, values] of variants) {
      if (!variant || variant.length > 80) continue;
      const metrics = provider === 'cardmarket' ? cardmarketMetrics : tcgplayerMetrics;
      const prices: Record<string, number> = {};
      for (const metric of metrics) {
        const price = object(values)[metric];
        if (typeof price === 'number' && Number.isFinite(price) && price >= 0) prices[metric] = price;
      }
      if (Object.keys(prices).length) quotes.push({ provider, currency, variant, updatedAt: date, freshness: freshness(date), prices });
    }
  }
  return MarketCardSchema.parse({ schemaVersion: 1, mode: 'reference', source: 'TCGdex', card: { id: data.id, name: data.name }, fetchedAt: new Date().toISOString(), quotes });
}
function normalizeSearch(raw: unknown, query: string): MarketSearchResult {
  if (!Array.isArray(raw) || raw.length > 501) throw new Error('Invalid search data');
  const cards = raw.map(value => {
    const item = object(value);
    return MarketBriefSchema.parse({ id: item.id, name: item.name, ...(MarketImageSchema.safeParse(item.image).success ? { image: item.image } : {}) });
  });
  const rank = (name: string) => name.toLowerCase() === query ? 0 : name.toLowerCase().startsWith(query) ? 1 : 2;
  const matches = [...new Map(cards.filter(card => card.name.toLowerCase().includes(query)).map(card => [card.id, card])).values()];
  matches.sort((a,b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, 'en'));
  return MarketSearchSchema.parse({ schemaVersion: 1, query, cards: matches.slice(0, 500), truncated: raw.length > 500 });
}

export function marketMiddleware() {
  const fx = createExchangeRates();
  // shortcut: cache and cooldown are per instance; add shared storage if cross-replica traffic requires it.
  const cache = new Map<string, { data: MarketCard | MarketSearchResult; expires: number }>();
  const pending = new Map<string, Promise<{ status: number; data: unknown; expires?: number }>>();
  let providerRetryAt = 0;
  const limited = (error: 'rate_limited' | 'provider_rate_limited', until: number) => ({ status: 429, data: { error, retryAfterSeconds: Math.max(1, Math.ceil((until - Date.now()) / 1000)) } });
  async function load(id: string, query?: string) {
    try {
      const url = query ? `https://api.tcgdex.net/v2/en/cards?${new URLSearchParams({ name: `like:${query}`, 'pagination:page': '1', 'pagination:itemsPerPage': '501' })}` : `https://api.tcgdex.net/v2/en/cards/${encodeURIComponent(id)}`;
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
      if (response.status === 429) {
        await response.body?.cancel();
        const header = response.headers.get('Retry-After') ?? '';
        const seconds = /^\d+$/.test(header) ? Number(header) : (Date.parse(header) - Date.now()) / 1000;
        const delay = Number.isFinite(seconds) && seconds > 0 && seconds <= Number.MAX_SAFE_INTEGER / 1000 ? seconds * 1000 : 60_000;
        providerRetryAt = Math.max(providerRetryAt, Date.now() + delay);
        return limited('provider_rate_limited', providerRetryAt);
      }
      if (!response.ok) { await response.body?.cancel(); return { status: response.status === 404 ? 404 : 502, data: { error: response.status === 404 ? 'card_not_found' : 'provider_unavailable' } }; }
      const raw = await readJson(response);
      const data = query ? normalizeSearch(raw, query) : normalize(raw, id);
      if (cache.size >= 256) cache.delete(cache.keys().next().value!);
      const expires = Date.now() + TTL;
      cache.set(id, { data, expires });
      return { status: 200, data, expires };
    } catch (error) {
      const timeout = error instanceof Error && error.name === 'TimeoutError';
      return { status: timeout ? 504 : 502, data: { error: timeout ? 'provider_timeout' : 'provider_unavailable' } };
    }
  }
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const rawPath = req.url ?? '';
    const url = new URL(rawPath, 'http://local');
    const path = rawPath.split('?')[0];
    if (path !== '/api/market' && !path.startsWith('/api/market/')) { next(); return; }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Market-Priority');
    res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
    const send = (status: number, data: unknown, expires = Date.now()) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      const ttl = Math.max(0, Math.min(300, Math.floor((expires - Date.now()) / 1000)));
      res.setHeader('Vercel-CDN-Cache-Control', status === 200 && ttl > 0 ? `public, s-maxage=${ttl}` : 'no-store');
      if (status === 429) res.setHeader('Retry-After', String(object(data).retryAfterSeconds));
      res.end(JSON.stringify(data));
    };
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.setHeader('Cache-Control', 'no-store'); res.end(); return; }
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); send(405, { error: 'method_not_allowed' }); return; }
    if (path === '/api/market/rates' && !url.search) {
      try { const rates = await fx.rates(); send(200, rates, Math.min(rates.EUR.expiresAt, rates.USD.expiresAt)); }
      catch { send(503, { error: 'exchange_rate_unavailable' }); }
      return;
    }
    if (path === '/api/market/health' && !url.search) { send(200, { service: 'market-prices', schemaVersion: 1, mode: 'reference', source: 'TCGdex' }); return; }
    let query: string | undefined;
    if (path === '/api/market/search') {
      const params = url.searchParams;
      const parsed = MarketQuerySchema.safeParse(params.get('q'));
      if (!parsed.success || [...params.keys()].length !== 1 || params.has('q') === false) { send(400, { error: 'invalid_search' }); return; }
      query = parsed.data.toLowerCase();
    }
    const sgd = url.searchParams.get('currency') === 'SGD';
    if (!query && url.search && (!sgd || [...url.searchParams.keys()].length !== 1)) { send(400, { error: 'invalid_currency' }); return; }
    const respond = async (status: number, data: unknown, expires = Date.now()) => {
      if (status === 200 && sgd) {
        try { const converted = await fx.convert(data as MarketCard); send(200, converted.data, Math.min(expires, converted.expires)); }
        catch { send(503, { error: 'exchange_rate_unavailable' }); }
      } else send(status, data, expires);
    };
    const id = query ? `search:${query}` : path.startsWith('/api/market/cards/') ? path.slice('/api/market/cards/'.length) : '';
    if (!query && !MarketIdSchema.safeParse(id).success) { send(400, { error: 'invalid_card_id' }); return; }
    const cached = cache.get(id);
    if (cached && cached.expires > Date.now()) {
      await respond(200, 'quotes' in cached.data ? { ...cached.data, quotes: cached.data.quotes.map(quote => ({ ...quote, freshness: freshness(quote.updatedAt) })) } : cached.data, cached.expires); return;
    }
    cache.delete(id);
    let request = pending.get(id);
    if (!request) {
      if (providerRetryAt > Date.now()) { const result = limited('provider_rate_limited', providerRetryAt); send(result.status, result.data); return; }
      request = load(id, query).finally(() => pending.delete(id));
      pending.set(id, request);
    }
    const result = await request;
    await respond(result.status, result.data, result.expires);
  };
}
