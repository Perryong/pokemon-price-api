import { z } from 'zod';
import type { MarketCard } from './schema.js';
import { readJson } from './upstream.js';
type Currency = 'EUR' | 'USD';
type Rate = { rate: number; date: string; expiresAt: number };
const schema = z.object({base:z.enum(['EUR','USD']),quote:z.literal('SGD'),rate:z.number().finite().positive(),date:z.string().date()});
export function createExchangeRates() {
  const cache = new Map<Currency, Rate>();
  const pending = new Map<Currency, Promise<Rate>>();
  function get(currency: Currency): Promise<Rate> {
    const hit = cache.get(currency);
    if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit);
    const existing = pending.get(currency);
    if (existing) return existing;
    const request = (async () => {
      const response = await fetch(`https://api.frankfurter.dev/v2/rate/${currency}/SGD?providers=ecb`, {signal:AbortSignal.timeout(8000),redirect:'error'});
      if (!response.ok) { await response.body?.cancel(); throw new Error('FX unavailable'); }
      const value = schema.parse(await readJson(response));
      const observation = Date.parse(value.date);
      if (value.base !== currency || observation > Date.now() || Date.now() - observation >= 7 * 86400_000) throw new Error('Invalid FX');
      const rate = {rate:value.rate,date:value.date,expiresAt:Math.min(Date.now()+6*3600_000,observation+7*86400_000)};
      cache.set(currency,rate); return rate;
    })().finally(()=>pending.delete(currency));
    pending.set(currency,request); return request;
  }
  return {
    async rates() {
      const [EUR,USD] = await Promise.all([get('EUR'),get('USD')]);
      if (Math.min(EUR.expiresAt,USD.expiresAt) <= Date.now()) throw new Error('Expired FX');
      return {EUR,USD};
    },
    async convert(card: MarketCard) {
      let expires = Infinity;
      const quotes = await Promise.all(card.quotes.map(async quote => {
        const rate = await get(quote.currency);
        if (rate.expiresAt <= Date.now()) throw new Error('Expired FX');
        expires = Math.min(expires,rate.expiresAt);
        const prices = Object.fromEntries(Object.entries(quote.prices).map(([metric,value]) => {
          const amount = Math.round(value! * rate.rate * 100) / 100;
          if (!Number.isFinite(amount)) throw new Error('Invalid converted price');
          return [metric,amount];
        }));
        return {...quote,currency:'SGD' as const,sourceCurrency:quote.currency,exchangeRate:rate,prices};
      }));
      if (expires <= Date.now()) throw new Error('Expired FX');
      return {data:{...card,schemaVersion:2,quotes},expires};
    }
  };
}
