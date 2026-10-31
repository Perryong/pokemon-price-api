# Pokémon Price API

Live service: https://pokemon-price-api-omega.vercel.app

Standalone public, read-only API for Pokémon reference card prices. Runs on Vercel independently of your Mac. Extracted from the validated market service in [pokemon-tracker](https://github.com/Perryong/pokemon-tracker).

## Endpoints

| GET endpoint | Response |
| --- | --- |
| `/api/market/health` | Service identity; does not check upstream availability |
| `/api/market/search?q=pika` | Partial-name matches, exact names first, up to 500 cards |
| `/api/market/cards/base1-58` | Version 1 reference quotes in original EUR/USD; existing tracker contract |
| `/api/market/cards/base1-58?currency=SGD` | Version 2 SGD quotes, original currency and dated exchange-rate provenance |
| `/api/market/rates` | EUR/USD to SGD rates with observation dates and expiry timestamps |

Search accepts 2–60 characters. Cards without available prices return an empty `quotes` array. Search ordering is relevance, not sales popularity. Prices and 1/7/30-day averages are reference values, not executable offers or daily price history.

SGD values are rounded to two decimals. TCGdex supplies Cardmarket EUR and TCGplayer USD prices. Frankfurter supplies ECB reference exchange rates. FX data older than seven days, missing rates or failed conversion return HTTP 503; native prices are never relabeled as SGD. Native quotes remain available when FX is unavailable. Check `updatedAt`, `fetchedAt`, `freshness` and `exchangeRate.date` before using any quote.

## Use from pokemon-tracker

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
