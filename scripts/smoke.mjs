import assert from 'node:assert/strict';
const base = new URL(process.argv[2]);
assert(['https:', 'http:'].includes(base.protocol), 'Supply an HTTP(S) service origin');
for (const [path, check] of [
  ['/api/market/health', data => assert.equal(data.service, 'market-prices')],
  ['/api/market/search?q=eevee', data => { assert(data.cards.length > 0); assert(data.cards.every(card => card.name.toLowerCase().includes('eevee'))); }],
  ['/api/market/cards/base1-58', data => { assert.equal(data.schemaVersion, 1); assert(data.quotes.length > 0); assert(data.quotes.every(quote => ['EUR', 'USD'].includes(quote.currency))); }],
  ['/api/market/cards/base1-58?currency=SGD', data => {
    assert.equal(data.schemaVersion, 2); assert(data.quotes.length > 0);
    for (const quote of data.quotes) {
      assert.equal(quote.currency, 'SGD'); assert(quote.exchangeRate.expiresAt > Date.now());
      assert(Object.values(quote.prices).every(price => Number.isFinite(price) && price >= 0));
    }
  }],
  ['/api/market/search?q=charizard&include=prices&limit=2', data => {
    assert.equal(data.schemaVersion, 2); assert.equal(data.currency, 'SGD');
    assert(data.cards.length > 0 && data.cards.length <= 2);
    assert.equal(data.partial, false, 'Live card pricing must be available for smoke verification');
    for (const card of data.cards) {
      assert(card.name.toLowerCase().includes('charizard'));
      assert.equal(card.pricing.status, 200);
      assert.equal(card.pricing.data.card.id, card.id);
      assert(card.pricing.data.quotes.every(quote => quote.currency === 'SGD' && quote.exchangeRate.expiresAt > Date.now()));
    }
  }],
  ['/api/market/rates', data => { assert(data.EUR.rate > 0); assert(data.USD.rate > 0); assert(Math.min(data.EUR.expiresAt, data.USD.expiresAt) > Date.now()); }],
]) {
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, `${path}: ${response.status}`);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  check(await response.json());
  console.log(`PASS ${path} (${response.headers.get('x-vercel-cache') ?? 'local'})`);
}
for (const [method, expected] of [['OPTIONS', 204], ['POST', 405]]) {
  const response = await fetch(new URL('/api/market/cards/base1-58', base), { method, signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, expected);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  console.log(`PASS ${method}: ${expected}`);
}
