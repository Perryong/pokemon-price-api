# Pokémon Price API

Live service: https://pokemon-price-api-omega.vercel.app

Standalone public, read-only API for Pokémon reference card prices. Runs on Vercel independently of your Mac. Extracted from the validated market service in [pokemon-tracker](https://github.com/Perryong/pokemon-tracker).

Machine-readable contract: [OpenAPI 3.1](https://pokemon-price-api-omega.vercel.app/openapi.json). This is an API service; the homepage is integration documentation.

## Endpoints

| GET endpoint | Response |
| --- | --- |
| `/api/market/health` | Service identity; does not check upstream availability |
| `/api/market/search?q={pokemon_name}` | Partial-name matches, exact names first, up to 500 cards |
| `/api/market/search?q={pokemon_name}&include=prices&limit=3&page=1` | Version 2 matching cards with per-card SGD pricing; paginated, default 3 and maximum 6 cards |
| `/api/market/cards/{card_id}` | Version 1 reference quotes in original EUR/USD; existing tracker contract |
| `/api/market/cards/{card_id}?currency=SGD` | Version 2 SGD quotes, original currency and dated exchange-rate provenance |
| `/api/market/rates` | EUR/USD to SGD rates with observation dates and expiry timestamps |

Search accepts 2–60 characters. Cards without available prices return an empty `quotes` array. Search ordering is relevance, not sales popularity. Prices and 1/7/30-day averages are reference values, not executable offers or daily price history.

SGD values are rounded to two decimals. TCGdex supplies Cardmarket EUR and TCGplayer USD prices. Frankfurter supplies ECB reference exchange rates. FX data older than seven days, missing rates or failed conversion return HTTP 503; native prices are never relabeled as SGD. Native quotes remain available when FX is unavailable. Check `updatedAt`, `fetchedAt`, `freshness` and `exchangeRate.date` before using any quote.

## Use from pokemon-tcg

Any name is supported, for example Charizard, Eevee, Mew, or a partial name. Search results return the card IDs used by the pricing endpoint. There is no Pikachu-specific algorithm.

```js
const origin = 'https://pokemon-price-api-omega.vercel.app';
async function searchCardPrices(pokemonName, page = 1) {
  const query = new URLSearchParams({
    q: pokemonName, include: 'prices', limit: '3', page: String(page)
  });
  const response = await fetch(`${origin}/api/market/search?${query}`);
  if (!response.ok) throw new Error(`Price API: HTTP ${response.status}`);
  return response.json();
}
const result = await searchCardPrices('charizard');
for (const card of result.cards) {
  if (card.pricing.status === 200) {
    // Already SGD. Do not convert these amounts again.
    console.log(card.id, card.pricing.data.quotes);
  } else {
    console.log(card.id, card.pricing.error, card.pricing.retryAfterSeconds);
  }
}
```

Price-enriched search uses `schemaVersion: 2`, `currency: "SGD"`, `page`, `limit`, `total`, `nextPage`, `truncated`, `partial`, and `cards`. Each card retains its ID/name/optional image plus `pricing: {status: 200, data: <SGD card response>}` or `pricing: {status, error, retryAfterSeconds?}`. `quotes: []` means no available quotes; zero is a valid price and is preserved. HTTP 200 may include `partial: true`; always inspect each card's pricing status. Per-card failures are retriable and never CDN-cached as successful pricing.

`page` (1–500) and `limit` (1–6) are allowed only with `include=prices`; no currency parameter is needed because enriched search is always SGD. Default limit is 3. `total` counts retained matches (at most 500), not the entire catalogue. `nextPage: null` means those retained matches are exhausted. If `truncated` is true, refine the search. Ordering is relevance, not price or popularity. Each request fetches prices only for that page, in one batch capped at six cards; it does not fetch all 500 prices. Composite cache expiry never exceeds the earliest source/FX expiry.

For lightweight discovery or loading prices only after selection, keep using `GET /api/market/search?q={name}` followed by `GET /api/market/cards/{id}?currency=SGD`. Existing q-only v1 search/native-price callers continue to work.

### Existing tracker integration

The existing app expects version 1 quotes and converts them for display. Preserve that contract by forwarding its `/api/market/` requests to this service. For a Vercel frontend, place this rewrite **before** its SPA fallback in the frontend's `vercel.json`:

```json
{
  "rewrites": [
    {
      "source": "/api/market/:path*",
      "destination": "https://pokemon-price-api-omega.vercel.app/api/market/:path*"
    }
  ]
}
```

Merge this rule into the existing configuration; don't replace other routes. The tracker currently loads FX independently; it can instead request this service's `/api/market/rates` using the same rate-record shape. Do not feed version 2 SGD quotes through the original EUR/USD conversion hook, or they could be converted twice.

Direct browser calls are also supported with public `Access-Control-Allow-Origin: *`. GET and OPTIONS only; no key or credentials. A local Vite app needs a proxy/base-URL change because its existing middleware still handles relative `/api/market` URLs. This extraction does not change or deploy the tracker frontend.

## Run and deploy

Use Node 24:

```sh
npm ci
npm run check
npm run dev
```

Local API: `http://127.0.0.1:3001/api/market/health`; override `PORT` if needed. The local server serves API routes only. Vercel also serves the static documentation homepage.

Import this repository into Vercel, select **Other**, build command `npm run build`, output directory `public`, Node 24. Native `api/` functions are included automatically. No environment variables, API keys or database are required. Deploy with `vercel deploy` and `vercel deploy --prod`, or use GitHub deployments once linked.

## Caching and availability

Successful card/search responses use a bounded 256-entry, one-hour cache per function instance. Identical in-flight requests share work. FX cache lifetime is at most six hours and never exceeds the seven-day observation cutoff. Vercel CDN caches successful data for up to five minutes, bounded by remaining source/FX cache lifetime. Browser responses are `no-store`; errors are not cached. Health isn't cached.

There is no application-defined 30-requests-per-minute cap. Actual TCGdex 429 responses preserve `Retry-After` and trigger a per-instance cooldown; replicas do not share that cooldown or memory cache. Add shared storage only if measured traffic requires it. Vercel quotas and upstream outages can still affect availability. Hosting moves the API off the Mac; it cannot eliminate provider limitations.

Requests use fixed HTTPS provider hosts, reject redirects and invalid IDs, time out after eight seconds per upstream fetch, and cap JSON bodies at 1 MiB. There are no marketplace writes, collection data, user accounts or secrets in this service.

## Verification

`npm run check` runs the regression suite and strict TypeScript checking. Tests cover partial search, hostile IDs, schema boundaries, bounded responses, provider errors/cooldowns, cache expiry, CORS, more than 30 distinct requests, SGD conversion and FX validation. `npm audit` checks dependency advisories. `npm run smoke -- https://pokemon-price-api-omega.vercel.app` checks public hosted responses and live providers. See `docs/verification.md` for deployment evidence.
