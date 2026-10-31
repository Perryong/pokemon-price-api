# Verification record — 2026-10-31

## Local and independent review

- `npm run check`: 64 tests across three source files passed; strict TypeScript check passed.
- Repeated the check after generating development output: still 64 source tests; compiled test copies are excluded.
- `npm audit`: zero vulnerabilities at verification time.
- `npm run smoke -- http://127.0.0.1:3001`: health, partial search, native prices, SGD prices, FX rates, OPTIONS 204 and POST 405 passed with real provider data.
- Independent Superpowers review completed. Fixed a race where the first exchange rate could expire while the other was loading. Both regressions failed before the fix and passed after it. Final targeted review found no remaining important issues.
- Local runtime was Node 26.4.0; Vercel builds and functions use the configured Node 24 runtime.

## Hosted verification

Preview deployment `dpl_4xA9V1xr5kpuriqKqyF7QYJkyrEh` passed real card SGD and partial search requests. Search `pika` returned 243 matching cards at the time of verification. SGD quotes carried original EUR/USD currencies, FX rates dated 2026-10-30 and freshness labels (including a stale source quote).

Hosted checks exposed and fixed two deployment differences: emitted JavaScript requires `.js` import paths, and Vercel adds a matching dynamic `id` query parameter. Added regression coverage for matching, conflicting and duplicate route metadata. The initial deployment was not considered a successful release.

Production deployment `dpl_8ey1PEfBrJ99TwMnxyu9kMbu9YND` reached Ready at `https://pokemon-price-api-omega.vercel.app`.

`npm run smoke -- https://pokemon-price-api-omega.vercel.app` passed all seven checks without credentials: health, partial search, native quotes, SGD quotes, rates, OPTIONS 204 and POST 405. Each API response exposed public CORS. A second SGD GET returned HTTP 200, `x-vercel-cache: HIT`, `age: 5`, and browser `cache-control: no-store`, confirming CDN caching independently of browser caching.

GitHub repository `Perryong/pokemon-price-api` is PUBLIC, default branch main. Vercel project `pokemon-price-api` is connected to that repository for future pushes. This record describes the verified service implementation; subsequent documentation-only commits do not change the runtime.

## Operational boundaries

This service has no app-defined 30/minute limit and runs without the Mac. Provider outages, actual upstream 429 responses and Vercel quotas still apply. Caches/cooldowns are per instance plus Vercel CDN, not globally shared. No traffic/load benchmark or paid capacity guarantee was attempted.

The existing pokemon-tracker repository and deployment were not changed. Its relative `/api/market` routes must be forwarded to this service using the README example before the app uses the new backend. Public read-only source prices are the only data served.

## General card search API update — 2026-10-31

- Added opt-in `include=prices` search, preserving q-only v1 responses. Default three cards, maximum six, explicit per-card failures, SGD conversion and bounded pagination.
- `npm run check`: 83 tests and TypeScript passed, including parallel request sharing, partial-error caching, provider cooldown metadata, oldest-source cache expiry and FX expiring while another card loads.
- `npm audit`: zero vulnerabilities. Independent whole-change review found no actionable issues; OpenAPI references and patterns were checked.
- The homepage remains API documentation. No search UI, frontend dependencies or changes to pokemon-tracker are included.
- The first preview attempt was blocked because its commit author used the Mac's unrecognized local email. Repository-local Git identity now uses the authenticated Perryong account's GitHub noreply address; no deployment permission was bypassed.
